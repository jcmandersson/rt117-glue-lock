/**
 * Kryptohjälpare byggda på Web Crypto, som finns inbyggt i Workers.
 * Ingen extern dependency, det håller bundlen liten nog för Workers free tier.
 */

const encoder = new TextEncoder();

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return new Uint8Array(signature);
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  return toHex(await hmacSha256(secret, message));
}

export async function sha256(message: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(message));
  return new Uint8Array(digest);
}

/**
 * Jämförelse i konstant tid. Viktigt för att inte läcka information om
 * signaturer och engångskoder via svarstider.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  // Längden är inte hemlig här (hex-strängar av känd längd), men vi jämför
  // ändå hela vägen för att undvika tidig utgång.
  let diff = aBytes.length ^ bBytes.length;
  const max = Math.max(aBytes.length, bBytes.length);
  for (let i = 0; i < max; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** URL-säker slumptoken, t.ex. för OAuth-state och PKCE-verifier. */
export function randomToken(byteLength = 32): string {
  return base64UrlEncode(randomBytes(byteLength));
}

/**
 * Likformigt fördelad numerisk kod med `digits` siffror.
 * Avvisningssampling så att t.ex. `% 1000000` inte gör låga koder vanligare.
 */
export function randomDigits(digits: number): string {
  const max = 10 ** digits;
  const limit = Math.floor(0xffffffff / max) * max;
  const buffer = new Uint32Array(1);
  let value: number;
  do {
    crypto.getRandomValues(buffer);
    value = buffer[0]!;
  } while (value >= limit);
  return String(value % max).padStart(digits, "0");
}

/** PKCE-utmaning: base64url(SHA256(verifier)). */
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64UrlEncode(await sha256(verifier));
}
