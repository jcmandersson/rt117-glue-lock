import type { Env, Member, MemberSourceKind } from "../types";
import { newId, now } from "../lib/ids";
import { normalizeEmail, normalizePhone, parseEmailList } from "../lib/normalize";
import { findMemberByEmail } from "./repo";

/**
 * En medlem som den ser ut i en uppströms källa (i praktiken tabler.world).
 * Admin-listan har ingen uppströms källa — där är D1 sanningen.
 */
export interface UpstreamMember {
  externalId: string;
  email: string | null;
  phone: string | null;
  name: string | null;
  club: string | null;
}

/**
 * Abstraktionen som gör att tabler.world kan kopplas på utan att röra
 * inloggningen. Uppslagning vid inloggning sker alltid mot D1 — en källa
 * fyller bara på tabellen.
 */
export interface MemberSource {
  readonly kind: MemberSourceKind;
  fetchAll(): Promise<UpstreamMember[]>;
}

export interface SyncResult {
  created: number;
  updated: number;
  deactivated: number;
  skipped: number;
}

/**
 * Synkar en uppströms källa in i medlemstabellen.
 *
 * Rör aldrig rader med `source = 'admin'`: manuellt inlagda medlemmar ska inte
 * kunna försvinna för att en extern källa inte känner dem. Medlemmar som
 * tidigare kom från källan men inte längre finns där avaktiveras (inte raderas)
 * och deras sessioner återkallas.
 */
export async function syncMembers(
  db: D1Database,
  source: MemberSource,
): Promise<SyncResult> {
  const upstream = await source.fetchAll();
  const result: SyncResult = { created: 0, updated: 0, deactivated: 0, skipped: 0 };
  const ts = now();

  const seen = new Set<string>();

  for (const raw of upstream) {
    const email = raw.email ? normalizeEmail(raw.email) : null;
    const phone = raw.phone ? normalizePhone(raw.phone) : null;

    if (!raw.externalId || (!email && !phone)) {
      result.skipped++;
      continue;
    }
    seen.add(raw.externalId);

    const existing = await db
      .prepare(
        `SELECT id, active FROM members WHERE source = ? AND external_id = ?`,
      )
      .bind(source.kind, raw.externalId)
      .first<{ id: string; active: number }>();

    if (existing) {
      await db
        .prepare(
          `UPDATE members
             SET email = ?, phone = ?, name = ?, club = ?, active = 1, updated_at = ?
           WHERE id = ?`,
        )
        .bind(email, phone, raw.name, raw.club, ts, existing.id)
        .run();
      result.updated++;
      continue;
    }

    // Kolliderar e-posten med en manuellt inlagd medlem? Låt admin-raden stå
    // kvar och märk den bara med externt id, så vi inte bryter unik-indexet.
    const byEmail = email ? await findMemberByEmail(db, email) : null;
    if (byEmail) {
      await db
        .prepare(
          `UPDATE members SET external_id = ?, name = COALESCE(name, ?),
                              club = COALESCE(club, ?), updated_at = ?
           WHERE id = ? AND source = ?`,
        )
        .bind(raw.externalId, raw.name, raw.club, ts, byEmail.id, source.kind)
        .run();
      result.skipped++;
      continue;
    }

    await db
      .prepare(
        `INSERT INTO members
           (id, email, phone, name, club, role, source, external_id, active,
            token_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'member', ?, ?, 1, 1, ?, ?)`,
      )
      .bind(newId(), email, phone, raw.name, raw.club, source.kind, raw.externalId, ts, ts)
      .run();
    result.created++;
  }

  // Avaktivera dem som försvunnit uppströms.
  const { results: current } = await db
    .prepare(`SELECT id, external_id FROM members WHERE source = ? AND active = 1`)
    .bind(source.kind)
    .all<{ id: string; external_id: string | null }>();

  for (const row of current) {
    if (row.external_id && !seen.has(row.external_id)) {
      await db
        .prepare(
          `UPDATE members
             SET active = 0, token_version = token_version + 1, updated_at = ?
           WHERE id = ?`,
        )
        .bind(ts, row.id)
        .run();
      result.deactivated++;
    }
  }

  return result;
}

/**
 * Slår upp medlemmen som hör till en e-postadress vid inloggning.
 *
 * Adresser i BOOTSTRAP_ADMIN_EMAILS läggs in och befordras till admin
 * automatiskt. Det är vad som gör att du kommer in i ett tomt system — utan det
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
