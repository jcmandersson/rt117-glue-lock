import { Hono } from "hono";
import type { AppContext } from "../types";
import { badRequest, clientIp, readJson, requireString, userAgent } from "../lib/http";
import { audit } from "../lib/audit";
import { enforceRateLimit } from "../lib/ratelimit";
import { requireApplicant } from "../auth/middleware";
import { findMemberByEmail, listApplicationRecipients } from "../members/repo";
import { findPendingByEmail, upsertPendingApplication } from "../applications/repo";
import { sendApplicationNotice } from "../lib/email";

export const applyRoutes = new Hono<AppContext>();

applyRoutes.use("/api/apply", requireApplicant);
applyRoutes.use("/api/apply/*", requireApplicant);

/** Vad ansökningssidan behöver: verifierad adress, ev. namn och ev. väntande ansökan. */
applyRoutes.get("/api/apply/me", async (c) => {
  const applicant = c.get("applicant");

  // Blev personen medlem medan cookien levde (godkänd eller manuellt inlagd)?
  const member = await findMemberByEmail(c.env.DB, applicant.email);
  if (member?.active === 1) {
    return c.json({ email: applicant.email, name: applicant.name, member: true, pending: null });
  }

  const pending = await findPendingByEmail(c.env.DB, applicant.email);
  return c.json({
    email: applicant.email,
    name: applicant.name,
    member: false,
    pending: pending
      ? { name: pending.name, club: pending.club, message: pending.message, createdAt: pending.created_at }
      : null,
  });
});

applyRoutes.post("/api/apply", async (c) => {
  const applicant = c.get("applicant");
  const ip = clientIp(c);

  await enforceRateLimit(
    c.env.DB,
    `apply:email:${applicant.email}`,
    5,
    60 * 60,
    "Du har skickat in för många gånger. Vänta en stund.",
  );
  await enforceRateLimit(
    c.env.DB,
    `apply:ip:${ip}`,
    10,
    60 * 60,
    "För många ansökningar från din anslutning. Vänta en stund.",
  );

  const body = await readJson<{ name?: unknown; club?: unknown; message?: unknown }>(c);
  const name = requireString(body.name, "name", { max: 120 });
  const club = requireString(body.club, "club", { max: 60 });
  const message =
    body.message === undefined || body.message === null || body.message === ""
      ? null
      : String(body.message).trim().slice(0, 500) || null;

  // Redan medlem? Då är ansökan onödig, be personen logga in i stället.
  const member = await findMemberByEmail(c.env.DB, applicant.email);
  if (member?.active === 1) {
    throw badRequest("Du är redan medlem. Logga in i stället.", "already_member");
  }

  const { application, created } = await upsertPendingApplication(c.env.DB, {
    email: applicant.email,
    name,
    club,
    message,
    via: applicant.via,
    ip,
    userAgent: userAgent(c),
  });

  await audit(c.env.DB, {
    action: "apply.submit",
    result: "ok",
    actorEmail: applicant.email,
    detail: { club: application.club, updated: !created },
    ip,
    userAgent: userAgent(c),
  });

  // Mejla admins i bakgrunden så svaret inte väntar på Resend. Bara vid ny
  // ansökan; en rättad ansökan ska inte ge ett mejl till.
  if (created) {
    const recipients = await listApplicationRecipients(c.env.DB);
    for (const to of recipients) {
      c.executionCtx.waitUntil(
        sendApplicationNotice(c.env, to, application).catch((error) => {
          console.error("application_notice_failed", error);
        }),
      );
    }
  }

  return c.json({
    ok: true,
    pending: {
      name: application.name,
      club: application.club,
      message: application.message,
      createdAt: application.created_at,
    },
  });
});
