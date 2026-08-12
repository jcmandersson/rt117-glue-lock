import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppContext, ApplicantPayload, Env, Member, SessionPayload, VerifiedVia } from "../types";
import { base64UrlDecode, base64UrlEncode, hmacSha256Hex, timingSafeEqual } from "../lib/crypto";
import { now } from "../lib/ids";

export const SESSION_COOKIE = "rt117_session";
export const APPLICANT_COOKIE = "rt117_applicant";

/** 30 dagar. Medlemmarna ska inte behöva logga in varje torsdag. */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** 45 minuter. Lagom för att hinna fylla i ansökningsformuläret. */
export const APPLICANT_TTL_SECONDS = 45 * 60;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Signerad, tillståndslös sessionscookie: base64url(payload).base64url(HMAC).
 *
 * Vi sparar ingen sessionstabell. Återkallning sker i stället via
 * `token_version` på medlemmen. Bumpas den blir alla utfärdade cookies
 * ogiltiga vid nästa anrop, och en avaktiverad medlem stoppas ändå av att
 * middleware läser om medlemsraden vid varje förfrågan.
 *
 * Ansökningscookien signeras med prefixet "applicant:" i HMAC-indatat, så att
 * en ansökningstoken aldrig kan spelas upp som sessionstoken eller tvärtom.
 */
export async function signSession(env: Env, payload: SessionPayload): Promise<string> {
  const body = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await hmacSha256Hex(env.SESSION_SECRET, body);
  return `${body}.${signature}`;
}

export async function verifySession(env: Env, token: string): Promise<SessionPayload | null> {
  const body = await verifiedBody(env, token, "");
  if (body === null) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(body) as SessionPayload;
  } catch {
    return null;
  }

  if (typeof payload.sub !== "string" || typeof payload.exp !== "number") return null;
  if (payload.exp <= now()) return null;

  return payload;
}

async function signApplicant(env: Env, payload: ApplicantPayload): Promise<string> {
  const body = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await hmacSha256Hex(env.SESSION_SECRET, `applicant:${body}`);
  return `${body}.${signature}`;
}

export async function verifyApplicant(env: Env, token: string): Promise<ApplicantPayload | null> {
  const body = await verifiedBody(env, token, "applicant:");
  if (body === null) return null;

  let payload: ApplicantPayload;
  try {
    payload = JSON.parse(body) as ApplicantPayload;
  } catch {
    return null;
  }

  if (typeof payload.email !== "string" || typeof payload.exp !== "number") return null;
  if (payload.exp <= now()) return null;

  return payload;
}

/** Kontrollerar signaturen och returnerar payload-texten, eller null. */
async function verifiedBody(env: Env, token: string, hmacPrefix: string): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts as [string, string];

  const expected = await hmacSha256Hex(env.SESSION_SECRET, `${hmacPrefix}${body}`);
  if (!timingSafeEqual(signature, expected)) return null;

  try {
    return decoder.decode(base64UrlDecode(body));
  } catch {
    return null;
  }
}

/**
 * Cookie-hjälparna tar `Context<AppContext>` snarare än bara bindningarna.
 * Honos Context är invariant i `Variables` (den bär en `Set<>`), så det går
 * inte att skicka in ett AppContext till en lösare signatur.
 */
export async function issueSessionCookie(
  c: Context<AppContext>,
  member: Member,
  via: VerifiedVia,
): Promise<void> {
  const payload: SessionPayload = {
    sub: member.id,
    tv: member.token_version,
    via,
    exp: now() + SESSION_TTL_SECONDS,
  };

  const token = await signSession(c.env, payload);
  setCookie(c, SESSION_COOKIE, token, cookieOptions(c, SESSION_TTL_SECONDS));

  // En färsk medlemssession gör ansökningscookien överflödig.
  deleteCookie(c, APPLICANT_COOKIE, { path: "/" });
}

export async function issueApplicantCookie(
  c: Context<AppContext>,
  applicant: Omit<ApplicantPayload, "exp">,
): Promise<void> {
  const payload: ApplicantPayload = { ...applicant, exp: now() + APPLICANT_TTL_SECONDS };
  const token = await signApplicant(c.env, payload);
  setCookie(c, APPLICANT_COOKIE, token, cookieOptions(c, APPLICANT_TTL_SECONDS));
}

export async function readApplicantCookie(
  c: Context<AppContext>,
): Promise<ApplicantPayload | null> {
  const token = getCookie(c, APPLICANT_COOKIE);
  if (!token) return null;
  return verifyApplicant(c.env, token);
}

export function readSessionCookie(c: Context<AppContext>): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}

export function clearSessionCookie(c: Context<AppContext>): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  deleteCookie(c, APPLICANT_COOKIE, { path: "/" });
}

function cookieOptions(c: Context<AppContext>, maxAge: number) {
  const hostname = new URL(c.req.url).hostname;
  const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1";

  return {
    httpOnly: true,
    // Secure kan inte sättas över http://localhost, då skulle cookien tappas
    // under lokal utveckling.
    secure: !isLocalhost,
    // Lax krävs för att cookien ska följa med när Google skickar tillbaka
    // användaren via en top-level redirect.
    sameSite: "Lax" as const,
    path: "/",
    maxAge,
  };
}
