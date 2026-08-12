import type { Env, Member } from "../types";
import { badRequest } from "../lib/http";
import { hmacSha256Hex, randomDigits, timingSafeEqual } from "../lib/crypto";
import { newId, now } from "../lib/ids";
import { enforceRateLimit } from "../lib/ratelimit";
import { sendLoginCode } from "../lib/email";
import { resolveMemberForLogin } from "../members/source";

const CODE_LENGTH = 6;
export const CODE_TTL_SECONDS = 10 * 60;
const MAX_ATTEMPTS = 5;

async function hashCode(env: Env, identifier: string, code: string): Promise<string> {
  // Identifieraren bakas in så att en kod inte kan återanvändas för en annan adress.
  return hmacSha256Hex(env.OTP_PEPPER, `${identifier}:${code}`);
}

/**
 * Begär en engångskod.
 *
 * Svaret är alltid detsamma oavsett om adressen finns i medlemslistan. Två skäl:
 * utomstående ska inte kunna kartlägga vilka som är medlemmar, och vi vill inte
 * kunna luras att skicka mejl till adresser som inte finns i registret — det
 * skulle göra vårt Resend-konto till ett spamverktyg.
 */
export async function requestLoginCode(
  env: Env,
  email: string,
  ip: string,
): Promise<void> {
  // Två tak: per adress (mot att spamma en broders inkorg) och per IP
  // (mot att någon betar av hela medlemslistan).
  await enforceRateLimit(
    env.DB,
    `otp:req:email:${email}`,
    3,
    15 * 60,
    "Du har begärt för många koder. Vänta en stund innan du försöker igen.",
  );
  await enforceRateLimit(
    env.DB,
    `otp:req:ip:${ip}`,
    10,
    15 * 60,
    "För många försök från din anslutning. Vänta en stund.",
  );

  const member = await resolveMemberForLogin(env, email);
  if (!member) return;

  const code = randomDigits(CODE_LENGTH);
  const ts = now();

  // Ogiltigförklara tidigare koder, så bara den senaste fungerar.
  await env.DB
    .prepare(
      `UPDATE otp_codes SET consumed_at = ?
       WHERE identifier = ? AND consumed_at IS NULL`,
    )
    .bind(ts, email)
    .run();

  await env.DB
    .prepare(
      `INSERT INTO otp_codes (id, identifier, code_hash, expires_at, attempts, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
    )
    .bind(newId(), email, await hashCode(env, email, code), ts + CODE_TTL_SECONDS, ts)
    .run();

  await sendLoginCode(env, email, code, Math.floor(CODE_TTL_SECONDS / 60));
}

/**
 * Kontrollerar en kod och returnerar medlemmen den hör till.
 *
 * Felmeddelandet skiljer inte på "fel kod" och "ingen kod begärd" — annars går
 * det att avgöra vilka adresser som finns i registret.
 */
export async function verifyLoginCode(
  env: Env,
  email: string,
  code: string,
  ip: string,
): Promise<Member> {
  await enforceRateLimit(
    env.DB,
    `otp:verify:ip:${ip}`,
    20,
    15 * 60,
    "För många försök. Vänta en stund innan du försöker igen.",
  );

  const invalid = badRequest("Koden stämmer inte eller har gått ut.", "invalid_code");

  const row = await env.DB
    .prepare(
      `SELECT id, code_hash, expires_at, attempts FROM otp_codes
       WHERE identifier = ? AND consumed_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(email)
    .first<{ id: string; code_hash: string; expires_at: number; attempts: number }>();

  if (!row || row.expires_at <= now()) throw invalid;

  if (row.attempts + 1 >= MAX_ATTEMPTS) {
    // Sista tillåtna försöket förbrukar koden, oavsett om den var rätt.
    await env.DB
      .prepare(`UPDATE otp_codes SET attempts = attempts + 1, consumed_at = ? WHERE id = ?`)
      .bind(now(), row.id)
      .run();
  } else {
    await env.DB
      .prepare(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?`)
      .bind(row.id)
      .run();
  }

  const candidate = await hashCode(env, email, code.trim());
  if (!timingSafeEqual(candidate, row.code_hash)) throw invalid;

  // Rätt kod: förbruka den så den inte kan användas igen.
  await env.DB
    .prepare(`UPDATE otp_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`)
    .bind(now(), row.id)
    .run();

  const member = await resolveMemberForLogin(env, email);
  if (!member) throw invalid;

  return member;
}
