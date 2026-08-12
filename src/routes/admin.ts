import { Hono } from "hono";
import type { Application, AppContext, Member, MemberRole } from "../types";
import { AppError, badRequest, clientIp, readJson, requireString, userAgent } from "../lib/http";
import { normalizeEmail, normalizePhone } from "../lib/normalize";
import { audit } from "../lib/audit";
import { getSetting, setSetting } from "../lib/settings";
import { requireAdmin, requireMember } from "../auth/middleware";
import {
  countAdmins,
  createMember,
  deleteMember,
  findMemberByEmail,
  findMemberById,
  listMembers,
  revokeMemberSessions,
  updateMember,
} from "../members/repo";
import { decideApplication, findApplicationById, listApplications } from "../applications/repo";
import { sendApplicationApproved, sendApplicationRejected } from "../lib/email";

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
    active: member.active === 1,
    validFrom: member.valid_from,
    validUntil: member.valid_until,
    notifyApplications: member.notify_applications === 1,
    createdAt: member.created_at,
    lastLoginAt: member.last_login_at,
    notes: member.notes,
  };
}

function presentApplication(application: Application) {
  return {
    id: application.id,
    email: application.email,
    name: application.name,
    club: application.club,
    message: application.message,
    via: application.via,
    status: application.status,
    createdAt: application.created_at,
    decidedAt: application.decided_at,
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

/**
 * Läser ett giltighetsdatum ur en request. undefined betyder "rör inte",
 * null eller tom sträng betyder "ta bort gränsen".
 */
function parseTimestamp(value: unknown, field: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;

  const ts = Number(value);
  if (!Number.isInteger(ts) || ts < 0 || ts > 4_102_444_800) {
    throw badRequest(`Fältet "${field}" måste vara en tidpunkt i unix-sekunder.`, "invalid_timestamp");
  }
  return ts;
}

/** Start före slut, annars blir åtkomstfönstret omöjligt att uppfylla. */
function assertValidWindow(from: number | null, until: number | null): void {
  if (from !== null && until !== null && from > until) {
    throw badRequest("Startdatumet måste ligga före slutdatumet.", "invalid_window");
  }
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

  const validFrom = parseTimestamp(body.validFrom, "validFrom") ?? null;
  const validUntil = parseTimestamp(body.validUntil, "validUntil") ?? null;
  assertValidWindow(validFrom, validUntil);

  const member = await createMember(c.env.DB, {
    email: email ?? null,
    phone: phone ?? null,
    name: body.name ? String(body.name).trim().slice(0, 200) : null,
    club: body.club ? String(body.club).trim().slice(0, 60) : null,
    role: parseRole(body.role) ?? "member",
    notes: body.notes ? String(body.notes).slice(0, 1000) : null,
    validFrom,
    validUntil,
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

  const validFrom = parseTimestamp(body.validFrom, "validFrom");
  const validUntil = parseTimestamp(body.validUntil, "validUntil");
  assertValidWindow(
    validFrom === undefined ? target.valid_from : validFrom,
    validUntil === undefined ? target.valid_until : validUntil,
  );

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
    ...(validFrom !== undefined ? { validFrom } : {}),
    ...(validUntil !== undefined ? { validUntil } : {}),
    ...(body.notifyApplications !== undefined
      ? { notifyApplications: Boolean(body.notifyApplications) }
      : {}),
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

// --- Ansökningar ---

adminRoutes.get("/api/admin/applications", async (c) => {
  const all = c.req.query("all") === "1";
  const applications = await listApplications(c.env.DB, all ? {} : { status: "pending" });
  return c.json({ applications: applications.map(presentApplication) });
});

adminRoutes.post("/api/admin/applications/:id/approve", async (c) => {
  const actor = c.get("member");
  const id = c.req.param("id");

  const application = await findApplicationById(c.env.DB, id);
  if (!application || application.status !== "pending") {
    throw new AppError(404, "Ansökan finns inte eller är redan avgjord.", "application_not_pending");
  }

  // Finns adressen redan (inlagd manuellt under tiden)? Återanvänd raden och
  // se till att den är aktiv, i stället för att krocka med unik-indexet.
  let member = await findMemberByEmail(c.env.DB, application.email);
  if (member) {
    member = await updateMember(c.env.DB, member.id, {
      active: true,
      ...(member.name ? {} : { name: application.name }),
      ...(member.club ? {} : { club: application.club }),
    });
  } else {
    member = await createMember(c.env.DB, {
      email: application.email,
      name: application.name,
      club: application.club,
      notes: application.message ? `Från ansökan: ${application.message}` : null,
    });
  }

  await decideApplication(c.env.DB, id, "approved", actor.id);

  c.executionCtx.waitUntil(
    sendApplicationApproved(c.env, application.email, application.name).catch((error) => {
      console.error("application_approved_mail_failed", error);
    }),
  );

  await audit(c.env.DB, {
    action: "admin.application.approve",
    result: "ok",
    memberId: member.id,
    actorEmail: actor.email,
    detail: { email: application.email, club: application.club },
    ip: clientIp(c),
    userAgent: userAgent(c),
  });

  return c.json({ member: present(member) });
});

adminRoutes.post("/api/admin/applications/:id/reject", async (c) => {
  const actor = c.get("member");
  const id = c.req.param("id");

  const application = await findApplicationById(c.env.DB, id);
  if (!application || application.status !== "pending") {
    throw new AppError(404, "Ansökan finns inte eller är redan avgjord.", "application_not_pending");
  }

  await decideApplication(c.env.DB, id, "rejected", actor.id);

  c.executionCtx.waitUntil(
    sendApplicationRejected(c.env, application.email, application.name).catch((error) => {
      console.error("application_rejected_mail_failed", error);
    }),
  );

  await audit(c.env.DB, {
    action: "admin.application.reject",
    result: "ok",
    actorEmail: actor.email,
    detail: { email: application.email },
    ip: clientIp(c),
    userAgent: userAgent(c),
  });

  return c.json({ ok: true });
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
