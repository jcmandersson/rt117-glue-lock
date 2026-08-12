import { Hono } from "hono";
import type { AppContext, Env } from "./types";
import { AppError } from "./lib/http";
import { requireMember } from "./auth/middleware";
import { authRoutes } from "./routes/auth";
import { applyRoutes } from "./routes/apply";
import { unlockRoutes } from "./routes/unlock";
import { adminRoutes } from "./routes/admin";
import { isMockMode } from "./glue/client";
import { now } from "./lib/ids";

const app = new Hono<AppContext>();

/**
 * Säkerhetsheaders för Workerns svar. Statiska filer får sina headers via
 * web/public/_headers, eftersom de serveras av Cloudflares assets-hanterare
 * utan att gå genom den här koden.
 */
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("X-Frame-Options", "DENY");
  // Svar från API:t ska aldrig cachas, de är personliga.
  if (new URL(c.req.url).pathname.startsWith("/api/")) {
    c.header("Cache-Control", "no-store");
  }
});

/** Den inloggade medlemmen, som frontenden bygger gränssnittet utifrån. */
app.get("/api/me", requireMember, (c) => {
  const member = c.get("member");
  return c.json({
    member: {
      id: member.id,
      email: member.email,
      name: member.name,
      club: member.club,
      role: member.role,
      validFrom: member.valid_from,
      validUntil: member.valid_until,
    },
    mock: isMockMode(c.env),
  });
});

app.route("/", authRoutes);
app.route("/", applyRoutes);
app.route("/", unlockRoutes);
app.route("/", adminRoutes);

/**
 * API-vägar som inte finns svarar med JSON. Allt annat är en djuplänk till
 * React-appen (/logga-in, /admin) och ska få index.html.
 *
 * Assets-hanterarens SPA-fallback täcker normalt det här utan att Workern körs,
 * men vi gör det även här så djuplänkar fungerar oavsett hur routningen landar.
 */
app.notFound(async (c) => {
  const { pathname } = new URL(c.req.url);

  if (pathname.startsWith("/api/") || pathname.startsWith("/auth/")) {
    return c.json({ error: "Sidan finns inte.", code: "not_found" }, 404);
  }

  return c.env.ASSETS.fetch(new Request(new URL("/index.html", c.req.url), { method: "GET" }));
});

app.onError((error, c) => {
  if (error instanceof AppError) {
    if (error.status === 429) {
      const retryAfter = error.extra?.retryAfter;
      if (typeof retryAfter === "number") c.header("Retry-After", String(retryAfter));
    }
    return c.json({ error: error.message, code: error.code, ...error.extra }, error.status);
  }

  // Oväntade fel: logga detaljerna, visa inget internt för användaren.
  console.error("unhandled_error", c.req.method, new URL(c.req.url).pathname, error);
  return c.json({ error: "Något gick fel. Försök igen.", code: "internal_error" }, 500);
});

/**
 * Nattlig städning. Kortlivade tabeller rensas, och gamla loggrader gallras.
 *
 * Gallringstiderna nedan är ett förslag, inte ett juridiskt beslut:
 * revisionsloggen kopplar person till tidpunkt och plats, så hur länge den får
 * sparas behöver ägargranskas (GDPR).
 */
const RETENTION = {
  auditLogDays: 365,
  unlockOperationsDays: 90,
  decidedApplicationsDays: 180,
} as const;

async function cleanup(env: Env): Promise<void> {
  const ts = now();
  const day = 24 * 60 * 60;

  const statements = [
    env.DB.prepare(`DELETE FROM oauth_states WHERE expires_at < ?`).bind(ts),
    env.DB.prepare(`DELETE FROM otp_codes WHERE expires_at < ?`).bind(ts - day),
    env.DB.prepare(`DELETE FROM rate_limits WHERE window_start < ?`).bind(ts - day),
    env.DB
      .prepare(`DELETE FROM unlock_operations WHERE created_at < ?`)
      .bind(ts - RETENTION.unlockOperationsDays * day),
    env.DB
      .prepare(`DELETE FROM audit_log WHERE ts < ?`)
      .bind(ts - RETENTION.auditLogDays * day),
    env.DB
      .prepare(`DELETE FROM applications WHERE status != 'pending' AND decided_at < ?`)
      .bind(ts - RETENTION.decidedApplicationsDays * day),
  ];

  await env.DB.batch(statements);
}

export default {
  fetch: app.fetch,

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      cleanup(env).catch((error) => {
        console.error("cleanup_failed", error);
      }),
    );
  },
} satisfies ExportedHandler<Env>;
