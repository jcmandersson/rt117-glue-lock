/** Bindningar och miljövariabler som Workern får av Cloudflare. */
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;

  // Vars (wrangler.jsonc, inte hemliga)
  APP_URL: string;
  APP_NAME: string;
  MAIL_FROM: string;
  /** '1' betyder att Glue aldrig anropas utan att låset simuleras. Bra innan låset är kopplat. */
  GLUE_MOCK: string;

  // Secrets (wrangler secret put eller GitHub-secrets)
  SESSION_SECRET: string;
  OTP_PEPPER: string;
  /**
   * Kommaseparerade e-postadresser som alltid är admin, så att du kommer in i
   * ett tomt system. Hålls som secret och inte som var: det är en åtkomstlista
   * med personuppgifter och hör inte hemma i repot.
   */
  BOOTSTRAP_ADMIN_EMAILS?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  RESEND_API_KEY?: string;
  GLUE_API_KEY?: string;
  GLUE_LOCK_ID?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
}

export type MemberRole = "member" | "admin";

export interface Member {
  id: string;
  email: string | null;
  phone: string | null;
  name: string | null;
  club: string | null;
  role: MemberRole;
  active: number;
  token_version: number;
  /** Unix-sekunder. NULL betyder att åtkomsten inte har någon startgräns. */
  valid_from: number | null;
  /** Unix-sekunder. NULL betyder att åtkomsten inte har någon slutgräns. */
  valid_until: number | null;
  /** 1 om medlemmen (som admin) vill ha mejl när en ny ansökan kommer in. */
  notify_applications: number;
  notes: string | null;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
}

export type ApplicationStatus = "pending" | "approved" | "rejected";
export type VerifiedVia = "google" | "otp";

/** En ansökan om åtkomst från någon som inte finns i medlemslistan. */
export interface Application {
  id: string;
  email: string;
  name: string;
  club: string;
  message: string | null;
  via: VerifiedVia;
  status: ApplicationStatus;
  created_at: number;
  decided_at: number | null;
  decided_by: string | null;
  ip: string | null;
  user_agent: string | null;
}

/** Innehållet i sessionscookien. Hålls litet, cookies har storleksgräns. */
export interface SessionPayload {
  /** member id */
  sub: string;
  /** token_version vid utfärdandet, så admins kan tvinga utloggning */
  tv: number;
  /** hur inloggningen skedde, för revisionsloggen */
  via: VerifiedVia;
  /** utgår (unix-sekunder) */
  exp: number;
}

/**
 * Innehållet i ansökningscookien: en kortlivad, signerad kvittens på att
 * personen har verifierat sin e-postadress men inte är medlem. Ger bara
 * tillgång till ansökningsformuläret, inget annat.
 */
export interface ApplicantPayload {
  email: string;
  name: string | null;
  via: VerifiedVia;
  exp: number;
}

/** Hono-variabler som sätts av auth-middleware. */
export interface AppVariables {
  member: Member;
  session: SessionPayload;
  applicant: ApplicantPayload;
}

export interface AppContext {
  Bindings: Env;
  Variables: AppVariables;
}
