import type { Application, ApplicationStatus, VerifiedVia } from "../types";
import { newId, now } from "../lib/ids";
import { AppError } from "../lib/http";

const COLUMNS = `id, email, name, club, message, via, status,
                 created_at, decided_at, decided_by, ip, user_agent`;

export interface ApplicationInput {
  email: string;
  name: string;
  club: string;
  message: string | null;
  via: VerifiedVia;
  ip: string | null;
  userAgent: string | null;
}

export async function findApplicationById(
  db: D1Database,
  id: string,
): Promise<Application | null> {
  return db
    .prepare(`SELECT ${COLUMNS} FROM applications WHERE id = ?`)
    .bind(id)
    .first<Application>();
}

export async function findPendingByEmail(
  db: D1Database,
  email: string,
): Promise<Application | null> {
  return db
    .prepare(`SELECT ${COLUMNS} FROM applications WHERE email = ? AND status = 'pending'`)
    .bind(email)
    .first<Application>();
}

/**
 * Skapar en väntande ansökan, eller uppdaterar den befintliga om personen
 * skickar in formuläret igen. `created` avgör om admins ska notifieras:
 * en rättad ansökan ska inte ge ett mejl till.
 */
export async function upsertPendingApplication(
  db: D1Database,
  input: ApplicationInput,
): Promise<{ application: Application; created: boolean }> {
  const existing = await findPendingByEmail(db, input.email);
  const ts = now();

  if (existing) {
    await db
      .prepare(
        `UPDATE applications SET name = ?, club = ?, message = ?, via = ?, ip = ?, user_agent = ?
         WHERE id = ?`,
      )
      .bind(input.name, input.club, input.message, input.via, input.ip, input.userAgent, existing.id)
      .run();
    const updated = await findApplicationById(db, existing.id);
    if (!updated) throw new AppError(500, "Kunde inte läsa tillbaka ansökan.", "application_failed");
    return { application: updated, created: false };
  }

  const id = newId();
  await db
    .prepare(
      `INSERT INTO applications (id, email, name, club, message, via, status, created_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    )
    .bind(id, input.email, input.name, input.club, input.message, input.via, ts, input.ip, input.userAgent)
    .run();

  const created = await findApplicationById(db, id);
  if (!created) throw new AppError(500, "Kunde inte läsa tillbaka ansökan.", "application_failed");
  return { application: created, created: true };
}

export async function listApplications(
  db: D1Database,
  { status }: { status?: ApplicationStatus } = {},
): Promise<Application[]> {
  const query = status
    ? db
        .prepare(`SELECT ${COLUMNS} FROM applications WHERE status = ? ORDER BY created_at DESC`)
        .bind(status)
    : db.prepare(
        `SELECT ${COLUMNS} FROM applications
         ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC`,
      );

  const { results } = await query.all<Application>();
  return results;
}

/**
 * Markerar en väntande ansökan som avgjord. Kastar om ansökan inte finns
 * eller redan är avgjord, så två admins inte kan avgöra samma ansökan två gånger.
 */
export async function decideApplication(
  db: D1Database,
  id: string,
  status: "approved" | "rejected",
  decidedBy: string,
): Promise<Application> {
  const result = await db
    .prepare(
      `UPDATE applications SET status = ?, decided_at = ?, decided_by = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .bind(status, now(), decidedBy, id)
    .run();

  if (result.meta.changes === 0) {
    throw new AppError(404, "Ansökan finns inte eller är redan avgjord.", "application_not_pending");
  }

  const decided = await findApplicationById(db, id);
  if (!decided) throw new AppError(404, "Ansökan finns inte.", "not_found");
  return decided;
}
