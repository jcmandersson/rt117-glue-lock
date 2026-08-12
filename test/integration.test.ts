import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signSession } from "../src/auth/session";
import { createMember } from "../src/members/repo";
import { now } from "../src/lib/ids";

const BASE = "http://localhost:8787";

/** Skapar en medlem och en giltig sessionscookie för den. */
async function signIn(overrides: { email: string; role?: "member" | "admin" }) {
  const member = await createMember(env.DB, {
    email: overrides.email,
    name: "Testperson",
    club: "RT117",
    role: overrides.role ?? "member",
  });

  const token = await signSession(env, {
    sub: member.id,
    tv: member.token_version,
    via: "otp",
    exp: now() + 3600,
  });

  return { member, cookie: `rt117_session=${token}` };
}

function jsonRequest(path: string, init: RequestInit & { cookie?: string } = {}) {
  const { cookie, ...rest } = init;
  return SELF.fetch(`${BASE}${path}`, {
    ...rest,
    headers: {
      ...(rest.body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...rest.headers,
    },
  });
}

/**
 * Utan RESEND_API_KEY skriver e-postlagret koden till konsolen i stället för
 * att skicka den. Det är den kroken vi använder för att läsa koden i testerna.
 */
let consoleWarn: ReturnType<typeof vi.spyOn>;

/**
 * Nollställer databasen mellan testerna.
 *
 * Lagringen delas inom en testfil, så utan detta läcker tillstånd vidare:
 * nödstoppet från ett test slår ut nästa, och extra admins gör
 * sista-admin-skyddet overksamt. Schemat lämnas orört, bara raderna rensas.
 */
async function resetDatabase(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM members`),
    env.DB.prepare(`DELETE FROM otp_codes`),
    env.DB.prepare(`DELETE FROM oauth_states`),
    env.DB.prepare(`DELETE FROM rate_limits`),
    env.DB.prepare(`DELETE FROM audit_log`),
    env.DB.prepare(`DELETE FROM unlock_operations`),
    env.DB.prepare(`DELETE FROM applications`),
    env.DB.prepare(`UPDATE settings SET value = '1' WHERE key = 'unlock_enabled'`),
  ]);
}

beforeEach(async () => {
  await resetDatabase();
  consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  consoleWarn.mockRestore();
});

function capturedCode(): string | null {
  for (const call of consoleWarn.mock.calls) {
    const text = String(call[0] ?? "");
    const match = text.match(/Din engångskod är: (\d{6})/);
    if (match) return match[1]!;
  }
  return null;
}

describe("konfiguration och identitet", () => {
  it("berättar vilka inloggningssätt som är påslagna", async () => {
    const response = await jsonRequest("/api/config");
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.appName).toBe("Testlokalen");
    // Inga Google-uppgifter i testmiljön, så knappen ska vara dold.
    expect(body.googleEnabled).toBe(false);
    expect(body.turnstileSiteKey).toBeNull();
  });

  it("nekar /api/me utan cookie", async () => {
    const response = await jsonRequest("/api/me");
    expect(response.status).toBe(401);
  });

  it("returnerar medlemmen med en giltig cookie", async () => {
    const { cookie } = await signIn({ email: "medlem@rt117.se" });
    const response = await jsonRequest("/api/me", { cookie });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { member: { email: string; role: string } };
    expect(body.member.email).toBe("medlem@rt117.se");
    expect(body.member.role).toBe("member");
  });

  it("avvisar en session vars token_version har bumpats", async () => {
    const { member, cookie } = await signIn({ email: "utkastad@rt117.se" });
    await env.DB
      .prepare(`UPDATE members SET token_version = token_version + 1 WHERE id = ?`)
      .bind(member.id)
      .run();

    const response = await jsonRequest("/api/me", { cookie });
    expect(response.status).toBe(401);
    expect((await response.json() as { code: string }).code).toBe("session_revoked");
  });

  it("avvisar en session för en avaktiverad medlem", async () => {
    const { member, cookie } = await signIn({ email: "pausad@rt117.se" });
    await env.DB.prepare(`UPDATE members SET active = 0 WHERE id = ?`).bind(member.id).run();

    const response = await jsonRequest("/api/me", { cookie });
    expect(response.status).toBe(401);
    expect((await response.json() as { code: string }).code).toBe("member_inactive");
  });
});

describe("inloggning med engångskod", () => {
  it("lägger in en bootstrap-admin och loggar in med koden", async () => {
    const email = "chef@rt117.se"; // BOOTSTRAP_ADMIN_EMAILS i vitest.config.ts

    const requested = await jsonRequest("/api/auth/otp/request", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
    expect(requested.status).toBe(200);

    const code = capturedCode();
    expect(code).toMatch(/^\d{6}$/);

    const verified = await jsonRequest("/api/auth/otp/verify", {
      method: "POST",
      body: JSON.stringify({ email, code }),
    });
    expect(verified.status).toBe(200);
    expect((await verified.json() as { member: boolean }).member).toBe(true);

    // Sessionscookien ska vara HttpOnly och SameSite=Lax.
    const setCookie = verified.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("rt117_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");

    // Och medlemmen ska ha skapats som admin.
    const row = await env.DB
      .prepare(`SELECT role, active FROM members WHERE email = ?`)
      .bind(email)
      .first<{ role: string; active: number }>();
    expect(row?.role).toBe("admin");
    expect(row?.active).toBe(1);
  });

  it("avvisar fel kod", async () => {
    const email = "chef@rt117.se";
    await jsonRequest("/api/auth/otp/request", {
      method: "POST",
      body: JSON.stringify({ email }),
    });

    const response = await jsonRequest("/api/auth/otp/verify", {
      method: "POST",
      body: JSON.stringify({ email, code: "000000" }),
    });
    expect(response.status).toBe(400);
    expect((await response.json() as { code: string }).code).toBe("invalid_code");
  });

  it("låter inte samma kod användas två gånger", async () => {
    const email = "chef@rt117.se";
    await jsonRequest("/api/auth/otp/request", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
    const code = capturedCode();

    const first = await jsonRequest("/api/auth/otp/verify", {
      method: "POST",
      body: JSON.stringify({ email, code }),
    });
    expect(first.status).toBe(200);

    const second = await jsonRequest("/api/auth/otp/verify", {
      method: "POST",
      body: JSON.stringify({ email, code }),
    });
    expect(second.status).toBe(400);
  });

  it("avvisar trasiga adresser", async () => {
    const response = await jsonRequest("/api/auth/otp/request", {
      method: "POST",
      body: JSON.stringify({ email: "inte-en-adress" }),
    });
    expect(response.status).toBe(400);
  });

  it("bromsar upprepade förfrågningar för samma adress", async () => {
    const email = "chef@rt117.se";
    const statuses: number[] = [];

    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await jsonRequest("/api/auth/otp/request", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      statuses.push(response.status);
    }

    // Taket är 3 per 15 minuter.
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe("ansökningar", () => {
  /** Kör hela vägen: kod till okänd adress, verifiering, ansökan. Returnerar ansökningscookien. */
  async function applyAs(email: string, name: string, club: string, message?: string) {
    await jsonRequest("/api/auth/otp/request", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
    const code = capturedCode();
    expect(code).toMatch(/^\d{6}$/);

    const verified = await jsonRequest("/api/auth/otp/verify", {
      method: "POST",
      body: JSON.stringify({ email, code }),
    });
    expect(verified.status).toBe(200);
    expect((await verified.json() as { member: boolean }).member).toBe(false);

    const setCookie = verified.headers.get("Set-Cookie") ?? "";
    const match = setCookie.match(/rt117_applicant=[^;]+/);
    expect(match).not.toBeNull();
    const cookie = match![0];

    const applied = await jsonRequest("/api/apply", {
      method: "POST",
      cookie,
      body: JSON.stringify({ name, club, message: message ?? null }),
    });
    expect(applied.status).toBe(200);

    return cookie;
  }

  it("skickar kod till okända adresser och tar emot en ansökan", async () => {
    const cookie = await applyAs("gast@example.com", "Gösta Gäst", "LC17", "Hyr lokalen i helgen");

    // Formulärsidan ser den väntande ansökan.
    const me = await jsonRequest("/api/apply/me", { cookie });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { pending: { club: string } | null };
    expect(body.pending?.club).toBe("LC17");
  });

  it("nekar ansökan utan verifierad adress", async () => {
    const response = await jsonRequest("/api/apply", {
      method: "POST",
      body: JSON.stringify({ name: "Någon", club: "RT117" }),
    });
    expect(response.status).toBe(401);
  });

  it("godkännande skapar en aktiv medlem", async () => {
    await applyAs("blivande@example.com", "Blivande Medlem", "OT36");

    const admin = await signIn({ email: "beslutare@rt117.se", role: "admin" });
    const list = await jsonRequest("/api/admin/applications", { cookie: admin.cookie });
    const { applications } = (await list.json()) as { applications: { id: string }[] };
    expect(applications).toHaveLength(1);

    const approved = await jsonRequest(`/api/admin/applications/${applications[0]!.id}/approve`, {
      method: "POST",
      cookie: admin.cookie,
    });
    expect(approved.status).toBe(200);

    const row = await env.DB
      .prepare(`SELECT active, club, name FROM members WHERE email = ?`)
      .bind("blivande@example.com")
      .first<{ active: number; club: string; name: string }>();
    expect(row?.active).toBe(1);
    expect(row?.club).toBe("OT36");
    expect(row?.name).toBe("Blivande Medlem");

    // Samma ansökan kan inte avgöras två gånger.
    const again = await jsonRequest(`/api/admin/applications/${applications[0]!.id}/reject`, {
      method: "POST",
      cookie: admin.cookie,
    });
    expect(again.status).toBe(404);
  });

  it("avslag skapar ingen medlem", async () => {
    await applyAs("nekad@example.com", "Nekad Person", "Gäst");

    const admin = await signIn({ email: "beslutare2@rt117.se", role: "admin" });
    const list = await jsonRequest("/api/admin/applications", { cookie: admin.cookie });
    const { applications } = (await list.json()) as { applications: { id: string }[] };

    const rejected = await jsonRequest(`/api/admin/applications/${applications[0]!.id}/reject`, {
      method: "POST",
      cookie: admin.cookie,
    });
    expect(rejected.status).toBe(200);

    const row = await env.DB
      .prepare(`SELECT id FROM members WHERE email = ?`)
      .bind("nekad@example.com")
      .first();
    expect(row).toBeNull();
  });
});

describe("upplåsning", () => {
  it("kräver inloggning", async () => {
    const response = await jsonRequest("/api/unlock", { method: "POST" });
    expect(response.status).toBe(401);
  });

  it("låser upp och blir klar när operationen är färdig", async () => {
    const { cookie } = await signIn({ email: "oppnare@rt117.se" });

    const started = await jsonRequest("/api/unlock", { method: "POST", cookie });
    expect(started.status).toBe(200);

    const body = (await started.json()) as { operationId: string; status: string };
    expect(body.operationId).toBeTruthy();
    expect(body.status).toBe("pending");

    // Mock-låset står i 'pending' i två sekunder och blir sedan 'completed'.
    await vi.waitFor(
      async () => {
        const polled = await jsonRequest(`/api/unlock/${body.operationId}`, { cookie });
        expect(polled.status).toBe(200);
        expect((await polled.json() as { status: string }).status).toBe("completed");
      },
      { timeout: 8000, interval: 400 },
    );
  });

  it("visar låsets status", async () => {
    const { cookie } = await signIn({ email: "kollare@rt117.se" });
    const response = await jsonRequest("/api/lock/status", { cookie });
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      mock: boolean;
      unlockEnabled: boolean;
      lock: { connectionStatus: string } | null;
    };
    expect(body.mock).toBe(true);
    expect(body.unlockEnabled).toBe(true);
    expect(body.lock?.connectionStatus).toBe("connected");
  });

  it("nekar upplåsning när nödstoppet är på", async () => {
    const { cookie } = await signIn({ email: "stoppad@rt117.se" });
    await env.DB
      .prepare(`UPDATE settings SET value = '0' WHERE key = 'unlock_enabled'`)
      .run();

    const response = await jsonRequest("/api/unlock", { method: "POST", cookie });
    expect(response.status).toBe(503);
    expect((await response.json() as { code: string }).code).toBe("unlock_disabled");
  });

  it("nekar upplåsning efter slutdatumet men låter medlemmen logga in", async () => {
    const { member, cookie } = await signIn({ email: "hyresgast@example.com" });
    await env.DB
      .prepare(`UPDATE members SET valid_until = ? WHERE id = ?`)
      .bind(now() - 3600, member.id)
      .run();

    // Inloggningen fungerar och /api/me visar fönstret.
    const me = await jsonRequest("/api/me", { cookie });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { member: { validUntil: number | null } };
    expect(meBody.member.validUntil).not.toBeNull();

    // Men upplåsning är spärrad.
    const response = await jsonRequest("/api/unlock", { method: "POST", cookie });
    expect(response.status).toBe(403);
    expect((await response.json() as { code: string }).code).toBe("outside_validity");
  });

  it("nekar upplåsning före startdatumet", async () => {
    const { member, cookie } = await signIn({ email: "framtida@example.com" });
    await env.DB
      .prepare(`UPDATE members SET valid_from = ? WHERE id = ?`)
      .bind(now() + 86400, member.id)
      .run();

    const response = await jsonRequest("/api/unlock", { method: "POST", cookie });
    expect(response.status).toBe(403);
    expect((await response.json() as { code: string }).code).toBe("outside_validity");
  });

  it("låter inte en medlem läsa någon annans upplåsning", async () => {
    const first = await signIn({ email: "en@rt117.se" });
    const second = await signIn({ email: "tva@rt117.se" });

    const started = await jsonRequest("/api/unlock", { method: "POST", cookie: first.cookie });
    const { operationId } = (await started.json()) as { operationId: string };

    const peek = await jsonRequest(`/api/unlock/${operationId}`, { cookie: second.cookie });
    expect(peek.status).toBe(404);
  });

  it("loggar upplåsningen i revisionsloggen", async () => {
    const { member, cookie } = await signIn({ email: "loggad@rt117.se" });
    await jsonRequest("/api/unlock", { method: "POST", cookie });

    const row = await env.DB
      .prepare(`SELECT action, result FROM audit_log WHERE member_id = ? AND action = 'unlock.request'`)
      .bind(member.id)
      .first<{ action: string; result: string }>();

    expect(row?.result).toBe("ok");
  });
});

describe("administration", () => {
  it("nekar vanliga medlemmar", async () => {
    const { cookie } = await signIn({ email: "vanlig@rt117.se" });
    const response = await jsonRequest("/api/admin/members", { cookie });
    expect(response.status).toBe(403);
  });

  it("listar och lägger in medlemmar", async () => {
    const { cookie } = await signIn({ email: "admin@rt117.se", role: "admin" });

    const created = await jsonRequest("/api/admin/members", {
      method: "POST",
      cookie,
      body: JSON.stringify({ email: "NY@rt36.se", name: "Ny Medlem", club: "RT36" }),
    });
    expect(created.status).toBe(201);
    // E-posten ska ha normaliserats till gemener.
    expect((await created.json() as { member: { email: string } }).member.email).toBe("ny@rt36.se");

    const list = await jsonRequest("/api/admin/members", { cookie });
    const body = (await list.json()) as { members: { email: string }[] };
    expect(body.members.map((m) => m.email)).toContain("ny@rt36.se");
  });

  it("uppdaterar giltighet, klubb och mejlinställning", async () => {
    const { cookie } = await signIn({ email: "adminx@rt117.se", role: "admin" });

    const created = await jsonRequest("/api/admin/members", {
      method: "POST",
      cookie,
      body: JSON.stringify({ email: "hyres@example.com" }),
    });
    const { member } = (await created.json()) as { member: { id: string } };

    const from = now() + 3600;
    const until = now() + 7200;
    const patched = await jsonRequest(`/api/admin/members/${member.id}`, {
      method: "PATCH",
      cookie,
      body: JSON.stringify({
        validFrom: from,
        validUntil: until,
        club: "Snickeriet",
        notifyApplications: false,
      }),
    });
    expect(patched.status).toBe(200);

    const body = (await patched.json()) as {
      member: { validFrom: number; validUntil: number; club: string; notifyApplications: boolean };
    };
    expect(body.member.validFrom).toBe(from);
    expect(body.member.validUntil).toBe(until);
    expect(body.member.club).toBe("Snickeriet");
    expect(body.member.notifyApplications).toBe(false);
  });

  it("avvisar ett bakvänt giltighetsfönster", async () => {
    const { cookie } = await signIn({ email: "adminy@rt117.se", role: "admin" });

    const created = await jsonRequest("/api/admin/members", {
      method: "POST",
      cookie,
      body: JSON.stringify({ email: "bakvand@example.com" }),
    });
    const { member } = (await created.json()) as { member: { id: string } };

    const response = await jsonRequest(`/api/admin/members/${member.id}`, {
      method: "PATCH",
      cookie,
      body: JSON.stringify({ validFrom: now() + 7200, validUntil: now() + 3600 }),
    });
    expect(response.status).toBe(400);
    expect((await response.json() as { code: string }).code).toBe("invalid_window");
  });

  it("avvisar dubbletter", async () => {
    const { cookie } = await signIn({ email: "admin2@rt117.se", role: "admin" });
    const payload = JSON.stringify({ email: "dubbel@rt117.se" });

    expect((await jsonRequest("/api/admin/members", { method: "POST", cookie, body: payload })).status).toBe(201);

    const again = await jsonRequest("/api/admin/members", { method: "POST", cookie, body: payload });
    expect(again.status).toBe(409);
    expect((await again.json() as { code: string }).code).toBe("duplicate_member");
  });

  it("avvisar ogiltig e-post", async () => {
    const { cookie } = await signIn({ email: "admin3@rt117.se", role: "admin" });
    const response = await jsonRequest("/api/admin/members", {
      method: "POST",
      cookie,
      body: JSON.stringify({ email: "trasig" }),
    });
    expect(response.status).toBe(400);
  });

  it("hindrar att den sista adminen degraderas", async () => {
    const { member, cookie } = await signIn({ email: "enda@rt117.se", role: "admin" });

    const response = await jsonRequest(`/api/admin/members/${member.id}`, {
      method: "PATCH",
      cookie,
      body: JSON.stringify({ role: "member" }),
    });
    expect(response.status).toBe(400);
    expect((await response.json() as { code: string }).code).toBe("last_admin");
  });

  it("hindrar att man tar bort sig själv", async () => {
    const { member, cookie } = await signIn({ email: "sjalv@rt117.se", role: "admin" });
    const response = await jsonRequest(`/api/admin/members/${member.id}`, {
      method: "DELETE",
      cookie,
    });
    expect(response.status).toBe(400);
    expect((await response.json() as { code: string }).code).toBe("self_delete");
  });

  it("importerar flera rader och rapporterar de överhoppade", async () => {
    const { cookie } = await signIn({ email: "importor@rt117.se", role: "admin" });

    const response = await jsonRequest("/api/admin/members/import", {
      method: "POST",
      cookie,
      body: JSON.stringify({
        csv: [
          "epost;namn;klubb;telefon",
          "anders@rt117.se;Anders Andersson;RT117;070-1234567",
          "bertil@rt36.se;Bertil Bertilsson",
          "trasig-rad",
        ].join("\n"),
        club: "RT117",
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      created: number;
      skipped: { line: number; reason: string }[];
    };
    expect(body.created).toBe(2);
    expect(body.skipped).toHaveLength(1);

    // Rubrikraden ska ha hoppats över utan att räknas som fel.
    const anders = await env.DB
      .prepare(`SELECT phone, club FROM members WHERE email = ?`)
      .bind("anders@rt117.se")
      .first<{ phone: string; club: string }>();
    expect(anders?.phone).toBe("+46701234567");
    expect(anders?.club).toBe("RT117");

    // Raden utan klubb ska ha fått standardklubben.
    const bertil = await env.DB
      .prepare(`SELECT club FROM members WHERE email = ?`)
      .bind("bertil@rt36.se")
      .first<{ club: string }>();
    expect(bertil?.club).toBe("RT117");
  });

  it("slår av och på nödstoppet", async () => {
    const { cookie } = await signIn({ email: "stoppare@rt117.se", role: "admin" });

    const off = await jsonRequest("/api/admin/settings", {
      method: "PUT",
      cookie,
      body: JSON.stringify({ unlockEnabled: false }),
    });
    expect((await off.json() as { unlockEnabled: boolean }).unlockEnabled).toBe(false);

    const blocked = await jsonRequest("/api/unlock", { method: "POST", cookie });
    expect(blocked.status).toBe(503);
  });
});
