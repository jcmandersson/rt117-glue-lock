import { newId, now } from "./ids";

export type AuditAction =
  | "login.otp.request"
  | "login.otp.verify"
  | "login.google.start"
  | "login.google.callback"
  | "logout"
  | "unlock.request"
  | "unlock.result"
  | "lock.request"
  | "lock.result"
  | "apply.submit"
  | "admin.member.create"
  | "admin.member.update"
  | "admin.member.delete"
  | "admin.member.revoke_sessions"
  | "admin.members.import"
  | "admin.application.approve"
  | "admin.application.reject"
  | "admin.setting.update";

export interface AuditEntry {
  action: AuditAction;
  result: "ok" | "denied" | "error";
  memberId?: string | null;
  actorEmail?: string | null;
  detail?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}

/**
 * Skriver en rad i revisionsloggen.
 *
 * Loggning får aldrig sänka ett anrop: om skrivningen misslyckas rapporterar vi
 * till konsolen (syns i `wrangler tail`) och går vidare.
 */
export async function audit(db: D1Database, entry: AuditEntry): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO audit_log (id, ts, member_id, actor_email, action, result, detail, ip, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        newId(),
        now(),
        entry.memberId ?? null,
        entry.actorEmail ?? null,
        entry.action,
        entry.result,
        entry.detail ? JSON.stringify(entry.detail) : null,
        entry.ip ?? null,
        entry.userAgent ?? null,
      )
      .run();
  } catch (error) {
    console.error("audit_write_failed", entry.action, error);
  }
}
