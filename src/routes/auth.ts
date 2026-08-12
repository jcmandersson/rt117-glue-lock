import { Hono } from "hono";
import type { AppContext } from "../types";
import { badRequest, clientIp, readJson, requireString, userAgent } from "../lib/http";
import { normalizeEmail } from "../lib/normalize";
import { audit } from "../lib/audit";
import { verifyTurnstile } from "../lib/turnstile";
import { requestLoginCode, verifyLoginCode } from "../auth/otp";
import {
  beginGoogleLogin,
  completeGoogleLogin,
  consumeOAuthState,
  googleConfigured,
  safeRedirectPath,
} from "../auth/google";
import { clearSessionCookie, issueApplicantCookie, issueSessionCookie } from "../auth/session";
import { resolveMemberForLogin } from "../members/source";
import { touchLastLogin } from "../members/repo";
import { findPendingByEmail } from "../applications/repo";

export const authRoutes = new Hono<AppContext>();

/** Vad frontenden behöver veta innan inloggning. */
authRoutes.get("/api/config", (c) =>
  c.json({
    appName: c.env.APP_NAME,
    googleEnabled: googleConfigured(c.env),
    turnstileSiteKey: c.env.TURNSTILE_SITE_KEY || null,
  }),
);

// --- Engångskod via e-post ---

authRoutes.post("/api/auth/otp/request", async (c) => {
  const body = await readJson<{ email?: unknown; turnstileToken?: unknown }>(c);
  const raw = requireString(body.email, "email", { max: 254 });
  const email = normalizeEmail(raw);
  const ip = clientIp(c);

  if (!email) throw badRequest("Det där ser inte ut som en e-postadress.", "invalid_email");

  await verifyTurnstile(
    c.env,
    typeof body.turnstileToken === "string" ? body.turnstileToken : undefined,
    ip,
  );

  await requestLoginCode(c.env, email, ip);

  await audit(c.env.DB, {
    action: "login.otp.request",
    result: "ok",
    actorEmail: email,
    ip,
    userAgent: userAgent(c),
  });

  return c.json({
    ok: true,
    message: "En kod är på väg till din inkorg. Den gäller i 10 minuter.",
  });
});

authRoutes.post("/api/auth/otp/verify", async (c) => {
  const body = await readJson<{ email?: unknown; code?: unknown }>(c);
  const raw = requireString(body.email, "email", { max: 254 });
  const code = requireString(body.code, "code", { max: 12 });
  const email = normalizeEmail(raw);
  const ip = clientIp(c);

  if (!email) throw badRequest("Det där ser inte ut som en e-postadress.", "invalid_email");

  try {
    const member = await verifyLoginCode(c.env, email, code, ip);

    if (member) {
      await issueSessionCookie(c, member, "otp");
      await touchLastLogin(c.env.DB, member.id);

      await audit(c.env.DB, {
        action: "login.otp.verify",
        result: "ok",
        memberId: member.id,
        actorEmail: email,
        ip,
        userAgent: userAgent(c),
      });

      return c.json({ ok: true, member: true });
    }

    // Verifierad adress utan medlemskap: skicka vidare till ansökan.
    await issueApplicantCookie(c, { email, name: null, via: "otp" });
    const pending = await findPendingByEmail(c.env.DB, email);

    await audit(c.env.DB, {
      action: "login.otp.verify",
      result: "ok",
      actorEmail: email,
      detail: { applicant: true },
      ip,
      userAgent: userAgent(c),
    });

    return c.json({ ok: true, member: false, pending: Boolean(pending) });
  } catch (error) {
    await audit(c.env.DB, {
      action: "login.otp.verify",
      result: "denied",
      actorEmail: email,
      ip,
      userAgent: userAgent(c),
    });
    throw error;
  }
});

// --- Google ---

authRoutes.get("/auth/google/start", async (c) => {
  const redirectTo = safeRedirectPath(c.req.query("redirect"));
  const url = await beginGoogleLogin(c.env, redirectTo);

  await audit(c.env.DB, {
    action: "login.google.start",
    result: "ok",
    ip: clientIp(c),
    userAgent: userAgent(c),
  });

  return c.redirect(url, 302);
});

authRoutes.get("/auth/google/callback", async (c) => {
  const ip = clientIp(c);
  const errorParam = c.req.query("error");
  if (errorParam) {
    // Användaren avbröt i Googles dialog. Inget fel att larma om.
    return c.redirect("/logga-in?fel=google_avbruten", 302);
  }

  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) throw badRequest("Ofullständigt svar från Google.", "google_bad_callback");

  const { codeVerifier, redirectTo } = await consumeOAuthState(c.env, state);
  const identity = await completeGoogleLogin(c.env, code, codeVerifier);

  const email = normalizeEmail(identity.email);
  if (!email || !identity.emailVerified) {
    await audit(c.env.DB, {
      action: "login.google.callback",
      result: "denied",
      actorEmail: identity.email,
      detail: { reason: identity.emailVerified ? "invalid_email" : "email_not_verified" },
      ip,
      userAgent: userAgent(c),
    });
    return c.redirect("/logga-in?fel=google_overifierad", 302);
  }

  const member = await resolveMemberForLogin(c.env, email);

  if (!member) {
    // Verifierad adress utan medlemskap: skicka vidare till ansökan.
    await issueApplicantCookie(c, { email, name: identity.name, via: "google" });

    await audit(c.env.DB, {
      action: "login.google.callback",
      result: "ok",
      actorEmail: email,
      detail: { applicant: true },
      ip,
      userAgent: userAgent(c),
    });

    return c.redirect("/ansok", 302);
  }

  // Fyll i namnet från Google om admin inte skrivit något.
  if (!member.name && identity.name) {
    await c.env.DB
      .prepare(`UPDATE members SET name = ? WHERE id = ? AND name IS NULL`)
      .bind(identity.name, member.id)
      .run();
  }

  await issueSessionCookie(c, member, "google");
  await touchLastLogin(c.env.DB, member.id);

  await audit(c.env.DB, {
    action: "login.google.callback",
    result: "ok",
    memberId: member.id,
    actorEmail: email,
    ip,
    userAgent: userAgent(c),
  });

  return c.redirect(safeRedirectPath(redirectTo), 302);
});

// --- Logga ut ---

authRoutes.post("/api/auth/logout", async (c) => {
  clearSessionCookie(c);
  await audit(c.env.DB, {
    action: "logout",
    result: "ok",
    ip: clientIp(c),
    userAgent: userAgent(c),
  });
  return c.json({ ok: true });
});
