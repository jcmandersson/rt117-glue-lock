import { Hono } from "hono";
import type { AppContext } from "../types";
import { AppError, clientIp, userAgent } from "../lib/http";
import { newId, now } from "../lib/ids";
import { audit } from "../lib/audit";
import { enforceRateLimit } from "../lib/ratelimit";
import { isUnlockEnabled } from "../lib/settings";
import { requireMember } from "../auth/middleware";
import {
  createGlueClient,
  isMockMode,
  resolveLockId,
  type GlueOperationStatus,
} from "../glue/client";

export const unlockRoutes = new Hono<AppContext>();

/** Efter så lång tid i 'pending' ger vi upp och kallar det timeout. */
const OPERATION_TIMEOUT_SECONDS = 90;

unlockRoutes.use("/api/lock/*", requireMember);
unlockRoutes.use("/api/unlock", requireMember);
unlockRoutes.use("/api/unlock/*", requireMember);

/** Låsets tillstånd: batteri, uppkoppling och om upplåsning är påslagen. */
unlockRoutes.get("/api/lock/status", async (c) => {
  const unlockEnabled = await isUnlockEnabled(c.env.DB);
  const mock = isMockMode(c.env);

  try {
    const client = createGlueClient(c.env);
    const lockId = await resolveLockId(c.env, client);
    const lock = await client.getLock(lockId);

    return c.json({
      unlockEnabled,
      mock,
      lock: {
        id: lock.id,
        description: lock.description,
        batteryStatus: lock.batteryStatus,
        connectionStatus: lock.connectionStatus,
        lastLockEvent: lock.lastLockEvent ?? null,
      },
    });
  } catch (error) {
    // Statusen får inte fälla hela sidan — knappen ska fungera ändå.
    const message = error instanceof AppError ? error.message : "Kunde inte läsa låsets status.";
    return c.json({ unlockEnabled, mock, lock: null, lockError: message });
  }
});

unlockRoutes.post("/api/unlock", async (c) => {
  const member = c.get("member");
  const ip = clientIp(c);
  const ua = userAgent(c);

  if (!(await isUnlockEnabled(c.env.DB))) {
    await audit(c.env.DB, {
      action: "unlock.request",
      result: "denied",
      memberId: member.id,
      actorEmail: member.email,
      detail: { reason: "unlock_disabled" },
      ip,
      userAgent: ua,
    });
    throw new AppError(
      503,
      "Upplåsning är tillfälligt avstängd av en admin.",
      "unlock_disabled",
    );
  }

  // Per medlem: stoppar en tappad telefon i fickan från att mala på.
  await enforceRateLimit(
    c.env.DB,
    `unlock:member:${member.id}`,
    10,
    5 * 60,
    "Du har låst upp många gånger på kort tid. Vänta en stund.",
  );
  // Globalt: skyddar Glue-kontot mot att bli utestängt vid ett skenande fel.
  await enforceRateLimit(
    c.env.DB,
    "unlock:global",
    60,
    60,
    "Ovanligt många upplåsningar just nu. Försök igen om en stund.",
  );

  await audit(c.env.DB, {
    action: "unlock.request",
    result: "ok",
    memberId: member.id,
    actorEmail: member.email,
    ip,
    userAgent: ua,
  });

  const client = createGlueClient(c.env);
  const lockId = await resolveLockId(c.env, client);

  let operationId: string | null = null;
  let status: GlueOperationStatus = "pending";
  let reason: string | null = null;

  try {
    const operation = await client.createOperation(lockId, "unlock");
    operationId = operation.id;
    status = operation.status;
    reason = operation.reason ?? null;
  } catch (error) {
    await audit(c.env.DB, {
      action: "unlock.result",
      result: "error",
      memberId: member.id,
      actorEmail: member.email,
      detail: { message: error instanceof Error ? error.message : "okänt fel" },
      ip,
      userAgent: ua,
    });
    throw error;
  }

  const id = newId();
  const ts = now();
  await c.env.DB
    .prepare(
      `INSERT INTO unlock_operations
         (id, glue_operation_id, lock_id, member_id, type, status, reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'unlock', ?, ?, ?, ?)`,
    )
    .bind(id, operationId, lockId, member.id, status, reason, ts, ts)
    .run();

  if (status !== "pending") {
    await audit(c.env.DB, {
      action: "unlock.result",
      result: status === "completed" ? "ok" : "error",
      memberId: member.id,
      actorEmail: member.email,
      detail: { status, reason },
      ip,
      userAgent: ua,
    });
  }

  return c.json({ operationId: id, status, reason });
});

/**
 * Pollas av frontenden. Vi frågar Glue om status bara så länge operationen är
 * öppen, så en gammal operation inte kan användas för att mala anrop mot Glue.
 */
unlockRoutes.get("/api/unlock/:id", async (c) => {
  const member = c.get("member");
  const id = c.req.param("id");

  const row = await c.env.DB
    .prepare(
      `SELECT id, glue_operation_id, lock_id, member_id, status, reason, created_at
       FROM unlock_operations WHERE id = ?`,
    )
    .bind(id)
    .first<{
      id: string;
      glue_operation_id: string | null;
      lock_id: string;
      member_id: string;
      status: GlueOperationStatus;
      reason: string | null;
      created_at: number;
    }>();

  if (!row) throw new AppError(404, "Upplåsningen hittades inte.", "operation_not_found");

  // Egna operationer, eller alla om man är admin.
  if (row.member_id !== member.id && member.role !== "admin") {
    throw new AppError(404, "Upplåsningen hittades inte.", "operation_not_found");
  }

  if (row.status !== "pending") {
    return c.json({ operationId: row.id, status: row.status, reason: row.reason });
  }

  if (now() - row.created_at > OPERATION_TIMEOUT_SECONDS) {
    await updateOperation(c.env.DB, row.id, "timeout", "Låset svarade inte i tid.");
    return c.json({
      operationId: row.id,
      status: "timeout" as GlueOperationStatus,
      reason: "Låset svarade inte i tid.",
    });
  }

  if (!row.glue_operation_id) {
    return c.json({ operationId: row.id, status: row.status, reason: row.reason });
  }

  const client = createGlueClient(c.env);
  const operation = await client.getOperation(row.lock_id, row.glue_operation_id);

  // Raden är per definition 'pending' här (annars returnerade vi ovan), så en
  // avvikelse betyder att operationen precis blev klar.
  if (operation.status !== row.status) {
    await updateOperation(c.env.DB, row.id, operation.status, operation.reason ?? null);

    await audit(c.env.DB, {
      action: "unlock.result",
      result: operation.status === "completed" ? "ok" : "error",
      memberId: row.member_id,
      actorEmail: member.email,
      detail: { status: operation.status, reason: operation.reason ?? null },
      ip: clientIp(c),
      userAgent: userAgent(c),
    });
  }

  return c.json({
    operationId: row.id,
    status: operation.status,
    reason: operation.reason ?? null,
  });
});

async function updateOperation(
  db: D1Database,
  id: string,
  status: GlueOperationStatus,
  reason: string | null,
): Promise<void> {
  await db
    .prepare(`UPDATE unlock_operations SET status = ?, reason = ?, updated_at = ? WHERE id = ?`)
    .bind(status, reason, now(), id)
    .run();
}
