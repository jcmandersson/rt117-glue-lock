import type { Env } from "../types";
import { badRequest } from "./http";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Verifierar en Turnstile-token (Cloudflares gratis-CAPTCHA).
 *
 * Är TURNSTILE_SECRET_KEY inte satt är skyddet avstängt och vi släpper igenom.
 * Hastighetsbegränsningen i `ratelimit.ts` gäller oavsett.
 */
export async function verifyTurnstile(
  env: Env,
  token: string | undefined,
  ip: string,
): Promise<void> {
  if (!env.TURNSTILE_SECRET_KEY) return;

  if (!token) {
    throw badRequest("Bot-kontrollen saknas. Ladda om sidan och försök igen.", "turnstile_missing");
  }

  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET_KEY);
  body.append("response", token);
  if (ip !== "unknown") body.append("remoteip", ip);

  const response = await fetch(VERIFY_URL, { method: "POST", body });
  const result = (await response.json().catch(() => null)) as { success?: boolean } | null;

  if (!result?.success) {
    throw badRequest("Bot-kontrollen gick inte igenom. Försök igen.", "turnstile_failed");
  }
}
