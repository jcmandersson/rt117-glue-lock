import { createMiddleware } from "hono/factory";
import type { AppContext } from "../types";
import { forbidden, unauthorized } from "../lib/http";
import { findMemberById } from "../members/repo";
import { clearSessionCookie, readApplicantCookie, readSessionCookie, verifySession } from "./session";

/**
 * Kräver en giltig session.
 *
 * Medlemsraden läses om vid varje förfrågan. Det kostar en D1-läsning men gör
 * att en avaktiverad eller raderad medlem tappar åtkomst omedelbart, i stället
 * för när cookien råkar gå ut.
 */
export const requireMember = createMiddleware<AppContext>(async (c, next) => {
  const token = readSessionCookie(c);
  if (!token) throw unauthorized();

  const session = await verifySession(c.env, token);
  if (!session) {
    clearSessionCookie(c);
    throw unauthorized("Din session har gått ut. Logga in igen.", "session_expired");
  }

  const member = await findMemberById(c.env.DB, session.sub);
  if (!member || member.active !== 1) {
    clearSessionCookie(c);
    throw unauthorized("Ditt konto är inte aktivt längre.", "member_inactive");
  }

  if (member.token_version !== session.tv) {
    clearSessionCookie(c);
    throw unauthorized("Din session har återkallats. Logga in igen.", "session_revoked");
  }

  c.set("member", member);
  c.set("session", session);
  await next();
});

/** Kräver adminbehörighet. Måste kedjas efter `requireMember`. */
export const requireAdmin = createMiddleware<AppContext>(async (c, next) => {
  const member = c.get("member");
  if (member.role !== "admin") {
    throw forbidden("Bara admins kan göra det här.", "admin_required");
  }
  await next();
});

/**
 * Kräver en giltig ansökningscookie, alltså en verifierad e-postadress som
 * inte hör till någon medlem. Används bara av ansökningsformulärets endpoints.
 */
export const requireApplicant = createMiddleware<AppContext>(async (c, next) => {
  const applicant = await readApplicantCookie(c);
  if (!applicant) {
    throw unauthorized("Verifiera din e-postadress först.", "applicant_required");
  }
  c.set("applicant", applicant);
  await next();
});
