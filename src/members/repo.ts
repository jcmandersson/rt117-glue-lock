import type { Member, MemberRole } from "../types";
import { newId, now } from "../lib/ids";
import { AppError } from "../lib/http";

const COLUMNS = `id, email, phone, name, club, role, active, token_version,
                 valid_from, valid_until, notify_applications, notes,
                 created_at, updated_at, last_login_at`;

export interface CreateMemberInput {
  email?: string | null;
  phone?: string | null;
  name?: string | null;
  club?: string | null;
  role?: MemberRole;
  notes?: string | null;
  active?: boolean;
  validFrom?: number | null;
  validUntil?: number | null;
}

export interface UpdateMemberInput {
  email?: string | null;
  phone?: string | null;
  name?: string | null;
  club?: string | null;
  role?: MemberRole;
  notes?: string | null;
  active?: boolean;
  validFrom?: number | null;
  validUntil?: number | null;
  notifyApplications?: boolean;
}

/** Sant om medlemmens åtkomst gäller vid tidpunkten, med hänsyn till start- och slutdatum. */
export function withinValidity(member: Member, ts: number): boolean {
  if (member.valid_from !== null && ts < member.valid_from) return false;
  if (member.valid_until !== null && ts > member.valid_until) return false;
  return true;
}

export async function findMemberById(db: D1Database, id: string): Promise<Member | null> {
  return db
    .prepare(`SELECT ${COLUMNS} FROM members WHERE id = ?`)
    .bind(id)
    .first<Member>();
}

/** E-posten måste vara normaliserad (gemener) innan den skickas hit. */
export async function findMemberByEmail(db: D1Database, email: string): Promise<Member | null> {
  return db
    .prepare(`SELECT ${COLUMNS} FROM members WHERE email = ?`)
    .bind(email)
    .first<Member>();
}

export async function listMembers(
  db: D1Database,
  { includeInactive = true }: { includeInactive?: boolean } = {},
): Promise<Member[]> {
  const where = includeInactive ? "" : "WHERE active = 1";
  const { results } = await db
    .prepare(
      `SELECT ${COLUMNS} FROM members ${where}
       ORDER BY active DESC, COALESCE(name, email, phone) COLLATE NOCASE`,
    )
    .all<Member>();
  return results;
}

export async function createMember(
  db: D1Database,
  input: CreateMemberInput,
): Promise<Member> {
  if (!input.email && !input.phone) {
    throw new AppError(400, "En medlem behöver e-postadress eller telefonnummer.", "missing_identifier");
  }

  const id = newId();
  const ts = now();

  try {
    await db
      .prepare(
        `INSERT INTO members
           (id, email, phone, name, club, role, source, active,
            token_version, valid_from, valid_until, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'admin', ?, 1, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.email ?? null,
        input.phone ?? null,
        input.name ?? null,
        input.club ?? null,
        input.role ?? "member",
        input.active === false ? 0 : 1,
        input.validFrom ?? null,
        input.validUntil ?? null,
        input.notes ?? null,
        ts,
        ts,
      )
      .run();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AppError(409, "Den e-postadressen eller telefonnumret finns redan.", "duplicate_member");
    }
    throw error;
  }

  const created = await findMemberById(db, id);
  if (!created) throw new AppError(500, "Kunde inte läsa tillbaka medlemmen.", "create_failed");
  return created;
}

export async function updateMember(
  db: D1Database,
  id: string,
  input: UpdateMemberInput,
): Promise<Member> {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  const assign = (column: string, value: string | number | null) => {
    fields.push(`${column} = ?`);
    values.push(value);
  };

  if (input.email !== undefined) assign("email", input.email);
  if (input.phone !== undefined) assign("phone", input.phone);
  if (input.name !== undefined) assign("name", input.name);
  if (input.club !== undefined) assign("club", input.club);
  if (input.role !== undefined) assign("role", input.role);
  if (input.notes !== undefined) assign("notes", input.notes);
  if (input.active !== undefined) assign("active", input.active ? 1 : 0);
  if (input.validFrom !== undefined) assign("valid_from", input.validFrom);
  if (input.validUntil !== undefined) assign("valid_until", input.validUntil);
  if (input.notifyApplications !== undefined) {
    assign("notify_applications", input.notifyApplications ? 1 : 0);
  }

  if (fields.length === 0) {
    const existing = await findMemberById(db, id);
    if (!existing) throw new AppError(404, "Medlemmen finns inte.", "not_found");
    return existing;
  }

  assign("updated_at", now());
  values.push(id);

  try {
    await db.prepare(`UPDATE members SET ${fields.join(", ")} WHERE id = ?`).bind(...values).run();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AppError(409, "Den e-postadressen eller telefonnumret finns redan.", "duplicate_member");
    }
    throw error;
  }

  const updated = await findMemberById(db, id);
  if (!updated) throw new AppError(404, "Medlemmen finns inte.", "not_found");
  return updated;
}

export async function deleteMember(db: D1Database, id: string): Promise<void> {
  const result = await db.prepare(`DELETE FROM members WHERE id = ?`).bind(id).run();
  if (result.meta.changes === 0) {
    throw new AppError(404, "Medlemmen finns inte.", "not_found");
  }
}

/**
 * Höjer token_version, vilket gör alla utfärdade sessionscookies för medlemmen
 * ogiltiga vid nästa anrop. Används när någon lämnar klubben eller tappar sin telefon.
 */
export async function revokeMemberSessions(db: D1Database, id: string): Promise<void> {
  await db
    .prepare(`UPDATE members SET token_version = token_version + 1, updated_at = ? WHERE id = ?`)
    .bind(now(), id)
    .run();
}

export async function touchLastLogin(db: D1Database, id: string): Promise<void> {
  await db.prepare(`UPDATE members SET last_login_at = ? WHERE id = ?`).bind(now(), id).run();
}

export async function countAdmins(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM members WHERE role = 'admin' AND active = 1`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Aktiva admins med e-post som vill ha mejl när en ny ansökan kommer in. */
export async function listApplicationRecipients(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT email FROM members
       WHERE role = 'admin' AND active = 1 AND notify_applications = 1 AND email IS NOT NULL`,
    )
    .all<{ email: string }>();
  return results.map((row) => row.email);
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}
