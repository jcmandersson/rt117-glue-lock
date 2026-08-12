import type { Env, Member } from "../types";
import { newId, now } from "../lib/ids";
import { parseEmailList } from "../lib/normalize";
import { findMemberByEmail } from "./repo";

/**
 * Slår upp medlemmen som hör till en e-postadress vid inloggning.
 *
 * Adresser i BOOTSTRAP_ADMIN_EMAILS läggs in och befordras till admin
 * automatiskt. Det är vad som gör att du kommer in i ett tomt system. Utan det
 * finns ingen som kan lägga in den första medlemmen.
 */
export async function resolveMemberForLogin(
  env: Env,
  email: string,
): Promise<Member | null> {
  const bootstrapAdmins = parseEmailList(env.BOOTSTRAP_ADMIN_EMAILS);
  const isBootstrapAdmin = bootstrapAdmins.includes(email);
  const existing = await findMemberByEmail(env.DB, email);

  if (existing) {
    if (isBootstrapAdmin && (existing.role !== "admin" || existing.active !== 1)) {
      await env.DB
        .prepare(`UPDATE members SET role = 'admin', active = 1, updated_at = ? WHERE id = ?`)
        .bind(now(), existing.id)
        .run();
      return { ...existing, role: "admin", active: 1 };
    }
    return existing.active === 1 ? existing : null;
  }

  if (!isBootstrapAdmin) return null;

  const ts = now();
  const id = newId();
  await env.DB
    .prepare(
      `INSERT INTO members (id, email, name, role, source, active, token_version, notes, created_at, updated_at)
       VALUES (?, ?, NULL, 'admin', 'admin', 1, 1, ?, ?, ?)`,
    )
    .bind(id, email, "Skapad automatiskt via BOOTSTRAP_ADMIN_EMAILS", ts, ts)
    .run();

  return findMemberByEmail(env.DB, email);
}
