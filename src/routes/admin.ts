import { Hono } from "hono";
import type { AppContext, Member, MemberRole } from "../types";
import { AppError, badRequest, clientIp, readJson, requireString, userAgent } from "../lib/http";
import { normalizeEmail, normalizePhone } from "../lib/normalize";
import { audit } from "../lib/audit";
import { getSetting, setSetting } from "../lib/settings";
import { requireAdmin, requireMember } from "../auth/middleware";
import {
  countAdmins,
  createMember,
  deleteMember,
  findMemberById,
  listMembers,
  revokeMemberSessions,
  updateMember,
} from "../members/repo";
import { syncMembers } from "../members/source";
import { TablerWorldSource } from "../members/tablerworld";

export const adminRoutes = new Hono<AppContext>();

adminRoutes.use("/api/admin/*", requireMember, requireAdmin);

/** Fälten frontenden får se. Interna kolumner som token_version stannar här. */
function present(member: Member) {
  return {
    id: member.id,
    email: member.email,
    phone: member.phone,
    name: member.name,
    club: member.club,
    role: member.role,
    source: member.source,
    active: member.active === 1,
    createdAt: member.created_at,
    lastLoginAt: member.last_login_at,
    notes: member.notes,
  };
}

function parseRole(value: unknown): MemberRole | undefined {
  if (value === undefined) return undefined;
  if (value !== "member" && value !== "admin") {
    throw badRequest("Rollen måste vara 'member' eller 'admin'.", "invalid_role");
  }
  return value;
}

/** Läser e-post/telefon ur en request och kastar tydliga fel vid skräpinmatning. */
function parseIdentifiers(body: { email?: unknown; phone?: unknown }): {
  email?: string | null;
  phone?: string | null;
} {
  const out: { email?: string | null; phone?: string | null } = {};

  if (body.email !== undefined) {
    if (body.email === null || body.email === "") {
      out.email = null;
    } else {
      const email = normalizeEmail(String(body.email));
      if (!email) throw badRequest("E-postadressen ser inte giltig ut.", "invalid_email");
      out.email = email;
    }
  }

  if (body.phone !== undefined) {
    if (body.phone === null || body.phone === "") {
      out.phone = null;
    } else {
      const phone = normalizePhone(String(body.phone));
      if (!phone) throw badRequest("Telefonnummret ser inte giltigt ut.", "invalid_phone");
      out.phone = phone;
    }
  }

  return out;
}

// --- Medlemmar ---

adminRoutes.get("/api/admin/members", async (c) => {
  const members = await listMembers(c.env.DB);
  return c.json({ members: members.map(present) });
});

adminRoutes.post("/api/admin/members", async (c) => {
  const actor = c.get("member");
  const body = await readJson<Record<string, unknown>>(c);
  const { email, phone } = parseIdentifiers(body);

  if (!email && !phone) {
    throw badRequest("Ange e-postadress eller telefonnummer.", "missing_identifier");
  }

  const member = await createMember(c.env.DB, {
    email: email ?? null,
    phone: phone ?? null,
    name: body.name ? String(body.name).trim().slice(0, 200) : null,
    club: body.club ? String(body.club).trim().slice(0, 60) : null,
    role: parseRole(body.role) ?? "member",
    notes: body.notes ? String(body.notes).slice(0, 1000) : null,
    source: "admin",
  });

  await audit(c.env.DB, {
    action: "admin.member.create",
    result: "ok",
    memberId: member.id,
    actorEmail: actor.email,
    detail: { email: member.email, club: member.club, role: member.role },
    ip: clientIp(c),
    userAgent: userAgent(c),
  });

  return c.json({ member: present(member) }, 201);
});

adminRoutes.patch("/api/admin/members/:id", async (c) => {
  const actor = c.get("member");
  const id = c.req.param("id");
  const body = await readJson<Record<string, unknown>>(c);

  const target = await findMemberById(c.env.DB, id);
  if (!target) throw new AppError(404, "Medlemmen finns inte.", "not_found");

  const role = parseRole(body.role);
  const active = body.active === undefined ? undefined : Boolean(body.active);

  // Systemet måste alltid ha minst en aktiv admin kvar, annars låser vi ut oss själva.
  const losesAdmin =
    target.role === "admin" && ((role !== undefined && role !== "admin") || active === false);
  if (losesAdmin && (await countAdmins(c.env.DB)) <= 1) {
    throw badRequest(
      "Det måste finnas minst en aktiv admin. Utse någon annan först.",
      "last_admin",
    );
  }

  const { email, phone } = parseIdentifiers(body);

  const member = await updateMember(c.env.DB, id, {
    ...(email !== undefined ? { email } : {}),
    ...(phone !== undefined ? { phone } : {}),
    ...(body.name !== undefined
      ? { name: body.name === null ? null : String(body.name).trim().slice(0, 200) }
      : {}),
    ...(body.club !== undefined
      ? { club: body.club === null ? null : String(body.club).trim().slice(0, 60) }
      : {}),
    ...(role !== undefined ? { role } : {}),
    ...(body.notes !== undefined
      ? { notes: body.notes === null ? null : String(body.notes).slice(0, 1000) }
      : {}),
    ...(active !== undefined ? { active } : {}),
  });

  // Tas behörigheten bort ska befintliga inloggningar dö direkt.
  if (active === false || (role !== undefined && role !== target.role)) {
    await revokeMemberSessions(c.env.DB, id);
  }

  await audit(c.env.DB, {
    action: "admin.member.update",
    result: "ok",
    memberId: id,
    actorEmail: actor.email,
    detail: { changes: Object.keys(body) },
    ip: clientIp(c),
    userAgent: userAgent(c),
  });

  return c.json({ member: present(member) });
});

adminRoutes.delete("/api/admin/members/:id", async (c) => {
  const actor = c.get("member");
  const id = c.req.param("id");

  if (id === actor.id) {
    throw badRequest("Du kan inte ta bort dig själv.", "self_delete");
  }

  const target = await findMemberById(c.env.DB, id);
  if (!target) throw new AppError(404, "Medlemmen finns inte.", "not_found");

  if (target.role === "admin" && (await countAdmins(c.env.DB)) <= 1) {
    throw badRequest("Det måste finnas minst en aktiv admin.", "last_admin");
  }

  await deleteMember(c.env.DB, id);

  await audit(c.env.DB, {
    action: "admin.member.delete",
    result: "ok",
    memberId: id,
    actorEmail: actor.email,
    detail: { email: target.email },
    ip: clientIp(c),
    userAgent: userAgent(c),
  });

  return c.json({ ok: true });
});

adminRoutes.post("/api/admin/members/:id/revoke", async (c) => {
  const actor = c.get("member");
  const id = c.req.param("id");

  const target = await findMemberById(c.env.DB, id);
  if (!target) throw new AppError(404, "Medlemmen finns inte.", "not_found");

  await revokeMemberSessions(c.env.DB, id);

  await audit(c.env.DB, {
    action: "admin.member.revoke_sessions",
    result: "ok",
    memberId: id,
    actorEmail: actor.email,
    ip: clientIp(c),
    userAgent: userAgent(c),
  });

  return c.json({ ok: true });
});

/**
 * Import från urklipp eller fil. En medlem per rad:
 *   epost;namn;klubb;telefon
 * Semikolon, komma eller tabb fungerar som avgränsare. Rader som redan finns
 * hoppas över i stället för att fälla hela importen.
 */
adminRoutes.post("/api/admin/members/import", async (c) => {
  const actor = c.get("member");
  const body = await readJson<{ csv?: unknown; club?: unknown }>(c);
  const csv = requireString(body.csv, "csv", { max: 200_000 });
  const defaultClub = body.club ? String(body.club).trim().slice(0, 60) : null;

  const created: string[] = [];
  const skipped: { line: number; reason: string }[] = [];

  const lines = csv.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (!line) continue;

    const cells = line.split(/[;,\t]/).map((cell) => cell.trim());
    const emailCell = cells[0] ?? "";

    // Hoppa över en eventuell rubrikrad.
    if (index === 0 && /^(e-?post|email|mail)$/i.test(emailCell)) continue;

    const email = normalizeEmail(emailCell);
    if (!email) {
      skipped.push({ line: index + 1, reason: `Ogiltig e-postadress: "${emailCell}"` });
      continue;
    }

    const phoneCell = cells[3] ?? "";
    const phone = phoneCell ? normalizePhone(phoneCell) : null;

    try {
      await createMember(c.env.DB, {
        email,
        phone,
        name: cells[1] || null,
        club: cells[2] || defaultClub,
        role: "member",
        source: "admin",
      });
      created.push(email);
    } catch (error) {
      const reason =
        error instanceof AppError && error.code === "duplicate_member"
          ? "Finns redan"
          : error instanceof Error
            ? error.message
            : "Okänt fel";
      skipped.push({ line: index + 1, reason });
    }
  }

  await audit(c.env.DB, {
    action: "admin.members.import",
    result: "ok",
    actorEmail: actor.email,
    detail: { created: created.length, skipped: skipped.length },
    ip: clientIp(c),
    userAgent: userAgent(c),
  });

  return c.json({ created: created.length, skipped });
});

// --- Revisionslogg ---

adminRoutes.get("/api/admin/audit", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 500);
  const action = c.req.query("action");

  const query = action
    ? c.env.DB.prepare(
        `SELECT id, ts, member_id, actor_email, action, result, detail, ip
         FROM audit_log WHERE action = ? ORDER BY ts DESC LIMIT ?`,
      ).bind(action, limit)
    : c.env.DB.prepare(
        `SELECT id, ts, member_id, actor_email, action, result, detail, ip
         FROM audit_log ORDER BY ts DESC LIMIT ?`,
      ).bind(limit);

  const { results } = await query.all();
  return c.json({ entries: results });
});

// --- Inställningar ---

adminRoutes.get("/api/admin/settings", async (c) => {
  return c.json({
    unlockEnabled: (await getSetting(c.env.DB, "unlock_enabled", "1")) === "1",
    memberSource: c.env.MEMBER_SOURCE,
    tablerWorldConfigured: Boolean(c.env.TABLERWORLD_TOKEN && c.env.TABLERWORLD_CLUB_IDS),
  });
});

adminRoutes.put("/api/admin/settings", async (c) => {
  const actor = c.get("member");
  const body = await readJson<{ unlockEnabled?: unknown }>(c);

  if (body.unlockEnabled !== undefined) {
    const value = body.unlockEnabled ? "1" : "0";
    await setSetting(c.env.DB, "unlock_enabled", value);
    await audit(c.env.DB, {
      action: "admin.setting.update",
      result: "ok",
      actorEmail: actor.email,
      detail: { unlock_enabled: value },
      ip: clientIp(c),
      userAgent: userAgent(c),
    });
  }

  return c.json({
    unlockEnabled: (await getSetting(c.env.DB, "unlock_enabled", "1")) === "1",
  });
});

// --- tabler.world ---

/** Testanrop som inte skriver något: används för att verifiera sökväg och fältnamn. */
adminRoutes.get("/api/admin/tablerworld/probe", async (c) => {
  const source = new TablerWorldSource(c.env);
  return c.json({ probe: await source.probe() });
});

adminRoutes.post("/api/admin/tablerworld/sync", async (c) => {
  const actor = c.get("member");
  const source = new TablerWorldSource(c.env);

  try {
    const result = await syncMembers(c.env.DB, source);
    await audit(c.env.DB, {
      action: "tablerworld.sync",
      result: "ok",
      actorEmail: actor.email,
      detail: { ...result },
      ip: clientIp(c),
      userAgent: userAgent(c),
    });
    return c.json({ result });
  } catch (error) {
    await audit(c.env.DB, {
      action: "tablerworld.sync",
      result: "error",
      actorEmail: actor.email,
      detail: { message: error instanceof Error ? error.message : "okänt fel" },
      ip: clientIp(c),
      userAgent: userAgent(c),
    });
    throw error;
  }
});
