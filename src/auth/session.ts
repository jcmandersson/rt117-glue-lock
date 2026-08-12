import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppContext, Env, Member, SessionPayload } from "../types";
import { base64UrlDecode, base64UrlEncode, hmacSha256Hex, timingSafeEqual } from "../lib/crypto";
import { now } from "../lib/ids";

export const SESSION_COOKIE = "rt117_session";

/** 30 dagar — bröderna ska inte behöva logga in varje torsdag. */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Signerad, tillståndslös sessionscookie: base64url(payload).base64url(HMAC).
 *
 * Vi sparar ingen sessionstabell. Återkallning sker i stället via
 * `token_version` på medlemmen — bumpas den blir alla utfärdade cookies
 * ogiltiga vid nästa anrop, och en avaktiverad medlem stoppas ändå av att
 * middleware läser om medlemsraden vid varje förfrågan.
 */
export async function signSession(env: Env, payload: SessionPayload): Promise<string> {
  const body = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await hmacSha256Hex(env.SESSION_SECRET, body);
  return `${body}.${signature}`;
}

export async function verifySession(env: Env, token: string): Promise<SessionPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts as [string, string];

  const expected = await hmacSha256Hex(env.SESSION_SECRET, body);
  if (!timingSafeEqual(signature, expected)) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(decoder.decode(base64UrlDecode(body))) as SessionPayload;
  } catch {
    return null;
  }

  if (typeof payload.sub !== "string" || typeof payload.exp !== "number") return null;
  if (payload.exp <= now()) return null;

  return payload;
}

/**
 * Cookie-hjälparna tar `Context<AppContext>` snarare än bara bindningarna.
 * Honos Context är invariant i `Variables` (den bär en `Set<>`), så en
 * lösare signatur går inte att skicka in ett AppContext till.
 */
export async function issueSessionCookie(
  c: Context<AppContext>,
  member: Member,
  via: "google" | "otp",
): Promise<void> {
  const payload: SessionPayload = {
    sub: member.id,
    tv: member.token_version,
    via,
    exp: now() + SESSION_TTL_SECONDS,
  };

  const token = await signSession(c.env, payload);
  const isLocalhost = new URL(c.req.url).hostname === "localhost" ||
    new URL(c.req.url).hostname === "127.0.0.1";

  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    // Secure kan inte sättas över http://localhost — då skulle cookien tappas
    // under lokal utveckling.
    secure: !isLocalhost,
    // Lax krävs för att cookien ska följa med när Google skickar tillbaka
    // användaren via en top-level redirect.
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function readSessionCookie(c: Context<AppContext>): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}

export function clearSessionCookie(c: Context<AppContext>): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}
