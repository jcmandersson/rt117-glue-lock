import type { Env } from "../types";
import { AppError, badRequest } from "../lib/http";
import { now } from "../lib/ids";
import { pkceChallenge, randomToken } from "../lib/crypto";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";

/** OAuth-state lever kort — bara tillräckligt för att hinna klicka i Googles dialog. */
const STATE_TTL_SECONDS = 10 * 60;

export interface GoogleIdentity {
  email: string;
  emailVerified: boolean;
  name: string | null;
}

export function googleConfigured(env: Env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

export function googleRedirectUri(env: Env): string {
  return `${env.APP_URL.replace(/\/+$/, "")}/auth/google/callback`;
}

/**
 * Startar inloggningen: sparar PKCE-verifier kopplad till ett slumpat state och
 * returnerar URL:en användaren ska skickas till.
 */
export async function beginGoogleLogin(
  env: Env,
  redirectTo: string | null,
): Promise<string> {
  if (!googleConfigured(env)) {
    throw new AppError(503, "Google-inloggning är inte konfigurerad.", "google_not_configured");
  }

  const state = randomToken(32);
  const verifier = randomToken(32);
  const challenge = await pkceChallenge(verifier);
  const ts = now();

  await env.DB
    .prepare(
      `INSERT INTO oauth_states (state, code_verifier, redirect_to, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(state, verifier, redirectTo, ts + STATE_TTL_SECONDS, ts)
    .run();

  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID!);
  url.searchParams.set("redirect_uri", googleRedirectUri(env));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  // Be Google visa kontoväljaren, så fel konto inte återanvänds tyst.
  url.searchParams.set("prompt", "select_account");

  return url.toString();
}

/** Hämtar och förbrukar ett state. Ett state kan bara användas en gång. */
export async function consumeOAuthState(
  env: Env,
  state: string,
): Promise<{ codeVerifier: string; redirectTo: string | null }> {
  const row = await env.DB
    .prepare(`SELECT code_verifier, redirect_to, expires_at FROM oauth_states WHERE state = ?`)
    .bind(state)
    .first<{ code_verifier: string; redirect_to: string | null; expires_at: number }>();

  // Radera direkt, oavsett om den var giltig, så samma state inte kan spelas upp igen.
  await env.DB.prepare(`DELETE FROM oauth_states WHERE state = ?`).bind(state).run();

  if (!row) {
    throw badRequest("Inloggningen gick ut eller kunde inte verifieras. Försök igen.", "bad_state");
  }
  if (row.expires_at <= now()) {
    throw badRequest("Inloggningen tog för lång tid. Försök igen.", "state_expired");
  }

  return { codeVerifier: row.code_verifier, redirectTo: row.redirect_to };
}

/**
 * Byter auktoriseringskoden mot en access token och läser användarens identitet.
 *
 * Vi läser identiteten från userinfo-endpointen med den access token vi precis
 * fick direkt från Google över TLS. Då behöver vi inte verifiera id_token-
 * signaturen mot Googles JWKS själva.
 */
export async function completeGoogleLogin(
  env: Env,
  code: string,
  codeVerifier: string,
): Promise<GoogleIdentity> {
  const tokenResponse = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: googleRedirectUri(env),
    }),
  });

  if (!tokenResponse.ok) {
    const body = await tokenResponse.text().catch(() => "");
    console.error("google_token_failed", tokenResponse.status, body.slice(0, 500));
    throw new AppError(502, "Google-inloggningen misslyckades. Försök igen.", "google_token_failed");
  }

  const tokens = (await tokenResponse.json()) as { access_token?: string };
  if (!tokens.access_token) {
    throw new AppError(502, "Google svarade utan access token.", "google_token_missing");
  }

  const userResponse = await fetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  if (!userResponse.ok) {
    console.error("google_userinfo_failed", userResponse.status);
    throw new AppError(502, "Kunde inte läsa din Google-profil.", "google_userinfo_failed");
  }

  const profile = (await userResponse.json()) as {
    email?: string;
    email_verified?: boolean;
    name?: string;
  };

  if (!profile.email) {
    throw badRequest("Google-kontot saknar e-postadress.", "google_no_email");
  }

  return {
    email: profile.email,
    // Ovverifierad adress duger inte: annars kan någon lägga upp ett konto med
    // en broders adress utan att äga den.
    emailVerified: profile.email_verified === true,
    name: profile.name ?? null,
  };
}

/** Interna redirects bara — annars blir inloggningen en öppen vidarebefordran. */
export function safeRedirectPath(value: string | null | undefined): string {
  if (!value) return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}
