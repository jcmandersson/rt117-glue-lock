/** Bindningar och miljövariabler som Workern får av Cloudflare. */
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;

  // --- Vars (wrangler.jsonc, inte hemliga) ---
  APP_URL: string;
  APP_NAME: string;
  MAIL_FROM: string;
  /** '1' = anropa aldrig Glue, simulera i stället. Bra före att låset är kopplat. */
  GLUE_MOCK: string;
  /** 'admin' | 'tablerworld' */
  MEMBER_SOURCE: string;

  // --- Secrets (wrangler secret put / GitHub-secrets) ---
  SESSION_SECRET: string;
  OTP_PEPPER: string;
  /**
   * Kommaseparerade e-postadresser som alltid är admin — så du kommer in i ett
   * tomt system. Hålls som secret, inte var: det är en åtkomstlista med
   * personuppgifter och hör inte hemma i repot.
   */
  BOOTSTRAP_ADMIN_EMAILS?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  RESEND_API_KEY?: string;
  GLUE_API_KEY?: string;
  GLUE_LOCK_ID?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;

  // --- tabler.world (av som standard, se src/members/tablerworld.ts) ---
  TABLERWORLD_TOKEN?: string;
  /** Kommaseparerade klubb-id, t.ex. RT117 och RT36. */
  TABLERWORLD_CLUB_IDS?: string;
  TABLERWORLD_BASE_URL?: string;
  /** Prefix i Authorization-headern. Default 'Bearer'. */
  TABLERWORLD_AUTH_SCHEME?: string;
  /** Sökväg till medlemslistan, med {clubId} som platshållare. [verify] */
  TABLERWORLD_MEMBERS_PATH?: string;
}

export type MemberRole = "member" | "admin";
export type MemberSourceKind = "admin" | "tablerworld";

export interface Member {
  id: string;
  email: string | null;
  phone: string | null;
  name: string | null;
  club: string | null;
  role: MemberRole;
  source: MemberSourceKind;
  external_id: string | null;
  active: number;
  token_version: number;
  notes: string | null;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
}

/** Innehållet i sessionscookien. Hålls litet — cookies har storleksgräns. */
export interface SessionPayload {
  /** member id */
  sub: string;
  /** token_version vid utfärdandet, så admins kan tvinga utloggning */
  tv: number;
  /** hur inloggningen skedde, för revisionsloggen */
  via: "google" | "otp";
  /** utgår (unix-sekunder) */
  exp: number;
}

/** Hono-variabler som sätts av auth-middleware. */
export interface AppVariables {
  member: Member;
  session: SessionPayload;
}

export interface AppContext {
  Bindings: Env;
  Variables: AppVariables;
}
