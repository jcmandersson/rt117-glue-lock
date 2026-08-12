import { useCallback, useEffect, useState } from "react";
import {
  api,
  ApiError,
  type AdminApplication,
  type AdminMember,
  type AdminSettings,
  type AuditEntry,
  type Me,
} from "../api";
import { navigate } from "../router";
import { ClubSelect } from "../components/ClubSelect";
import { dateInputToTs, formatDateTime, formatWindow, tsToDateInput } from "../dates";

type Tab = "members" | "applications" | "import" | "log" | "settings";

interface Props {
  me: Me;
  onSignedOut: () => Promise<void>;
}

export function AdminPage({ me, onSignedOut }: Props) {
  const [tab, setTab] = useState<Tab>("members");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);

  const notify = useCallback((result: { ok?: string; err?: string }) => {
    setInfo(result.ok ?? null);
    setError(result.err ?? null);
  }, []);

  const fail = useCallback(
    (caught: unknown, fallback: string) => {
      notify({ err: caught instanceof ApiError ? caught.message : fallback });
    },
    [notify],
  );

  const refreshPendingCount = useCallback(async () => {
    try {
      setPendingCount((await api.adminApplications()).applications.length);
    } catch {
      // Räknaren är bara en hint, fel här ska inte störa resten av sidan.
    }
  }, []);

  useEffect(() => {
    void refreshPendingCount();
  }, [refreshPendingCount]);

  return (
    <div className="app app--wide">
      <header className="header">
        <div className="header__brand">
          <img className="header__logo" src="/logo.png" alt="" width={34} height={34} />
          <h1 className="header__title">Administration</h1>
        </div>
        <span className="header__meta">{me.member.email}</span>
      </header>

      <div className="tabs" role="tablist">
        {(
          [
            ["members", "Medlemmar"],
            ["applications", "Ansökningar"],
            ["import", "Importera"],
            ["log", "Logg"],
            ["settings", "Inställningar"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            className="tab"
            aria-selected={tab === key}
            onClick={() => {
              setTab(key);
              notify({});
            }}
          >
            {label}
            {key === "applications" && pendingCount > 0 && (
              <span className="badge">{pendingCount}</span>
            )}
          </button>
        ))}
      </div>

      {error && <div className="notice notice--error">{error}</div>}
      {info && <div className="notice notice--ok">{info}</div>}

      {tab === "members" && <MembersTab me={me} notify={notify} fail={fail} />}
      {tab === "applications" && (
        <ApplicationsTab notify={notify} fail={fail} onDecided={refreshPendingCount} />
      )}
      {tab === "import" && <ImportTab notify={notify} fail={fail} />}
      {tab === "log" && <LogTab fail={fail} />}
      {tab === "settings" && <SettingsTab notify={notify} fail={fail} />}

      <div className="btn-row" style={{ marginTop: 20 }}>
        <button className="btn btn--secondary btn--small" onClick={() => navigate("/")}>
          Till upplåsning
        </button>
        <button
          className="btn btn--ghost btn--small"
          onClick={async () => {
            await api.logout();
            await onSignedOut();
            navigate("/logga-in");
          }}
        >
          Logga ut
        </button>
      </div>
    </div>
  );
}

interface TabProps {
  notify: (result: { ok?: string; err?: string }) => void;
  fail: (caught: unknown, fallback: string) => void;
}

// --- Medlemmar ---

function MembersTab({ me, notify, fail }: TabProps & { me: Me }) {
  const [members, setMembers] = useState<AdminMember[] | null>(null);
  const [editing, setEditing] = useState<AdminMember | null>(null);
  const [form, setForm] = useState({
    email: "",
    name: "",
    club: "RT117",
    phone: "",
    validFrom: "",
    validUntil: "",
  });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setMembers((await api.adminMembers()).members);
    } catch (caught) {
      fail(caught, "Kunde inte hämta medlemmar.");
    }
  }, [fail]);

  useEffect(() => {
    void load();
  }, [load]);

  async function addMember(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api.adminCreateMember({
        email: form.email.trim(),
        name: form.name.trim() || null,
        club: form.club.trim() || null,
        phone: form.phone.trim() || null,
        validFrom: dateInputToTs(form.validFrom, "start"),
        validUntil: dateInputToTs(form.validUntil, "end"),
      });
      setForm({ email: "", name: "", club: form.club, phone: "", validFrom: "", validUntil: "" });
      notify({ ok: "Medlemmen är inlagd." });
      await load();
    } catch (caught) {
      fail(caught, "Kunde inte lägga in medlemmen.");
    } finally {
      setBusy(false);
    }
  }

  async function patch(member: AdminMember, changes: Record<string, unknown>, okMessage: string) {
    try {
      await api.adminUpdateMember(member.id, changes);
      notify({ ok: okMessage });
      await load();
    } catch (caught) {
      fail(caught, "Ändringen gick inte igenom.");
    }
  }

  async function remove(member: AdminMember) {
    const label = member.name ?? member.email ?? member.phone ?? "medlemmen";
    if (!window.confirm(`Ta bort ${label}? Personen kommer inte in i lokalen efter det.`)) return;
    try {
      await api.adminDeleteMember(member.id);
      notify({ ok: "Medlemmen är borttagen." });
      await load();
    } catch (caught) {
      fail(caught, "Kunde inte ta bort medlemmen.");
    }
  }

  return (
    <>
      <div className="card">
        <h2 className="card__title">Lägg in en medlem</h2>
        <p className="card__hint">
          E-postadressen matchas mot Google-kontot eller engångskoden vid inloggning. Sätt start-
          och slutdatum för den som bara ska ha åtkomst en viss period, till exempel vid
          uthyrning.
        </p>
        <form onSubmit={addMember}>
          <div className="field">
            <label htmlFor="new-email">E-postadress</label>
            <input
              id="new-email"
              type="email"
              required
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
              placeholder="namn@example.se"
            />
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="new-name">Namn</label>
              <input
                id="new-name"
                type="text"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="new-club">Klubb</label>
              <ClubSelect
                id="new-club"
                value={form.club}
                onChange={(club) => setForm({ ...form, club })}
              />
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="new-valid-from">Giltig från (valfritt)</label>
              <input
                id="new-valid-from"
                type="date"
                value={form.validFrom}
                onChange={(event) => setForm({ ...form, validFrom: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="new-valid-until">Giltig till (valfritt)</label>
              <input
                id="new-valid-until"
                type="date"
                value={form.validUntil}
                onChange={(event) => setForm({ ...form, validUntil: event.target.value })}
              />
            </div>
          </div>
          <div className="field">
            <label htmlFor="new-phone">Telefon (valfritt, för SMS-koder senare)</label>
            <input
              id="new-phone"
              type="tel"
              value={form.phone}
              onChange={(event) => setForm({ ...form, phone: event.target.value })}
              placeholder="070-123 45 67"
            />
          </div>
          <button className="btn" type="submit" disabled={busy || !form.email.trim()}>
            {busy ? "Sparar…" : "Lägg in medlem"}
          </button>
        </form>
      </div>

      <div className="card">
        <h2 className="card__title">
          Medlemmar {members ? <span className="muted">({members.length})</span> : null}
        </h2>
        {!members ? (
          <p className="muted">Hämtar…</p>
        ) : (
          <ul className="list">
            {members.map((member) => {
              const nowSec = Math.floor(Date.now() / 1000);
              const beforeStart = member.validFrom !== null && nowSec < member.validFrom;
              const afterEnd = member.validUntil !== null && nowSec > member.validUntil;
              const window = formatWindow(member.validFrom, member.validUntil);

              return (
                <li key={member.id} className={`list__item${member.active ? "" : " is-inactive"}`}>
                  <div className="list__head">
                    <span className="list__title">{member.name ?? member.email ?? member.phone}</span>
                    {member.role === "admin" && <span className="pill pill--accent">Admin</span>}
                    {!member.active && <span className="pill pill--error">Pausad</span>}
                    {member.active && afterEnd && <span className="pill pill--error">Utgången</span>}
                    {member.active && beforeStart && <span className="pill pill--warn">Ej startad</span>}
                  </div>
                  <div className="list__meta">
                    {member.email ?? member.phone}
                    {member.club ? ` · ${member.club}` : ""}
                  </div>
                  <div className="list__meta">
                    Senast inne: {member.lastLoginAt ? formatDateTime(member.lastLoginAt) : "aldrig"}
                    {window ? ` · Åtkomst ${window}` : ""}
                  </div>
                  <div className="btn-row list__actions">
                    <button className="btn btn--secondary btn--small" onClick={() => setEditing(member)}>
                      Redigera
                    </button>
                    <button
                      className="btn btn--secondary btn--small"
                      onClick={() =>
                        patch(
                          member,
                          { active: !member.active },
                          member.active ? "Medlemmen är pausad." : "Medlemmen är aktiv igen.",
                        )
                      }
                    >
                      {member.active ? "Pausa" : "Aktivera"}
                    </button>
                    {member.id !== me.member.id && (
                      <button className="btn btn--danger btn--small" onClick={() => remove(member)}>
                        Ta bort
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {editing && (
        <EditMemberModal
          key={editing.id}
          member={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            notify({ ok: "Ändringarna är sparade." });
            await load();
          }}
          fail={fail}
        />
      )}
    </>
  );
}

function EditMemberModal({
  member,
  onClose,
  onSaved,
  fail,
}: {
  member: AdminMember;
  onClose: () => void;
  onSaved: () => Promise<void>;
  fail: (caught: unknown, fallback: string) => void;
}) {
  const [form, setForm] = useState({
    name: member.name ?? "",
    email: member.email ?? "",
    phone: member.phone ?? "",
    club: member.club ?? "",
    role: member.role,
    validFrom: tsToDateInput(member.validFrom),
    validUntil: tsToDateInput(member.validUntil),
    notifyApplications: member.notifyApplications,
    notes: member.notes ?? "",
  });
  const [busy, setBusy] = useState(false);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api.adminUpdateMember(member.id, {
        name: form.name.trim() || null,
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        club: form.club.trim() || null,
        role: form.role,
        validFrom: dateInputToTs(form.validFrom, "start"),
        validUntil: dateInputToTs(form.validUntil, "end"),
        notifyApplications: form.notifyApplications,
        notes: form.notes.trim() || null,
      });
      await onSaved();
    } catch (caught) {
      fail(caught, "Kunde inte spara ändringarna.");
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Redigera ${member.name ?? member.email ?? "medlem"}`}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="card__title">Redigera medlem</h2>
        <form onSubmit={save}>
          <div className="field">
            <label htmlFor="edit-name">Namn</label>
            <input
              id="edit-name"
              type="text"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="edit-email">E-postadress</label>
            <input
              id="edit-email"
              type="email"
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="edit-phone">Telefon</label>
            <input
              id="edit-phone"
              type="tel"
              value={form.phone}
              onChange={(event) => setForm({ ...form, phone: event.target.value })}
            />
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="edit-club">Klubb</label>
              <ClubSelect
                id="edit-club"
                value={form.club}
                onChange={(club) => setForm({ ...form, club })}
              />
            </div>
            <div className="field">
              <label htmlFor="edit-role">Roll</label>
              <select
                id="edit-role"
                value={form.role}
                onChange={(event) =>
                  setForm({ ...form, role: event.target.value as "member" | "admin" })
                }
              >
                <option value="member">Medlem</option>
                <option value="admin">Admin</option>
              </select>
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="edit-valid-from">Giltig från</label>
              <input
                id="edit-valid-from"
                type="date"
                value={form.validFrom}
                onChange={(event) => setForm({ ...form, validFrom: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="edit-valid-until">Giltig till</label>
              <input
                id="edit-valid-until"
                type="date"
                value={form.validUntil}
                onChange={(event) => setForm({ ...form, validUntil: event.target.value })}
              />
            </div>
          </div>
          <p className="muted" style={{ marginTop: 0 }}>
            Lämna datumen tomma för åtkomst utan tidsgräns. Slutdatumet gäller hela dagen ut.
          </p>
          {form.role === "admin" && (
            <div className="field field--checkbox">
              <label>
                <input
                  type="checkbox"
                  checked={form.notifyApplications}
                  onChange={(event) =>
                    setForm({ ...form, notifyApplications: event.target.checked })
                  }
                />{" "}
                Mejla mig när en ny ansökan kommer in
              </label>
            </div>
          )}
          <div className="field">
            <label htmlFor="edit-notes">Anteckningar</label>
            <textarea
              id="edit-notes"
              className="textarea-plain"
              maxLength={1000}
              value={form.notes}
              onChange={(event) => setForm({ ...form, notes: event.target.value })}
            />
          </div>
          <div className="btn-row">
            <button className="btn" type="submit" disabled={busy}>
              {busy ? "Sparar…" : "Spara"}
            </button>
            <button className="btn btn--secondary" type="button" onClick={onClose}>
              Avbryt
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// --- Ansökningar ---

const APPLICATION_STATUS: Record<AdminApplication["status"], { label: string; pill: string }> = {
  pending: { label: "Väntar", pill: "pill pill--warn" },
  approved: { label: "Godkänd", pill: "pill pill--ok" },
  rejected: { label: "Avslagen", pill: "pill pill--error" },
};

function ApplicationsTab({
  notify,
  fail,
  onDecided,
}: TabProps & { onDecided: () => Promise<void> }) {
  const [applications, setApplications] = useState<AdminApplication[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setApplications((await api.adminApplications(showAll)).applications);
    } catch (caught) {
      fail(caught, "Kunde inte hämta ansökningar.");
    }
  }, [fail, showAll]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(application: AdminApplication, approve: boolean) {
    const question = approve
      ? `Godkänn ${application.name}? Personen får mejl och kan logga in direkt.`
      : `Avslå ansökan från ${application.name}? Personen får ett neutralt mejl om beslutet.`;
    if (!window.confirm(question)) return;

    setBusy(true);
    try {
      if (approve) {
        await api.adminApproveApplication(application.id);
        notify({ ok: `${application.name} är nu medlem.` });
      } else {
        await api.adminRejectApplication(application.id);
        notify({ ok: "Ansökan är avslagen." });
      }
      await load();
      await onDecided();
    } catch (caught) {
      fail(caught, "Kunde inte avgöra ansökan.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="card__titlerow">
        <h2 className="card__title">Ansökningar</h2>
        <label className="muted card__toggle">
          <input
            type="checkbox"
            checked={showAll}
            onChange={(event) => setShowAll(event.target.checked)}
          />{" "}
          Visa även avgjorda
        </label>
      </div>
      <p className="card__hint">
        Personer som verifierat sin e-postadress och bett om åtkomst. Vid godkännande blir de
        medlemmar direkt. Behöver de start- och slutdatum sätter du det efteråt under Medlemmar.
      </p>

      {!applications ? (
        <p className="muted">Hämtar…</p>
      ) : applications.length === 0 ? (
        <p className="muted">{showAll ? "Inga ansökningar ännu." : "Inga väntande ansökningar. Skönt!"}</p>
      ) : (
        <ul className="list">
          {applications.map((application) => (
            <li key={application.id} className="list__item">
              <div className="list__head">
                <span className="list__title">{application.name}</span>
                <span className="pill">{application.club}</span>
                {application.status !== "pending" && (
                  <span className={APPLICATION_STATUS[application.status].pill}>
                    {APPLICATION_STATUS[application.status].label}
                  </span>
                )}
              </div>
              <div className="list__meta">
                {application.email} · verifierad via{" "}
                {application.via === "google" ? "Google" : "engångskod"} ·{" "}
                {formatDateTime(application.createdAt)}
              </div>
              {application.message && <div className="list__quote">”{application.message}”</div>}
              {application.status === "pending" && (
                <div className="btn-row list__actions">
                  <button
                    className="btn btn--small"
                    disabled={busy}
                    onClick={() => decide(application, true)}
                  >
                    Godkänn
                  </button>
                  <button
                    className="btn btn--danger btn--small"
                    disabled={busy}
                    onClick={() => decide(application, false)}
                  >
                    Avslå
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- Import ---

function ImportTab({ notify, fail }: TabProps) {
  const [csv, setCsv] = useState("");
  const [club, setClub] = useState("RT117");
  const [busy, setBusy] = useState(false);
  const [skipped, setSkipped] = useState<{ line: number; reason: string }[]>([]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setSkipped([]);
    try {
      const result = await api.adminImport(csv, club);
      notify({ ok: `${result.created} medlemmar inlagda, ${result.skipped.length} överhoppade.` });
      setSkipped(result.skipped);
      if (result.skipped.length === 0) setCsv("");
    } catch (caught) {
      fail(caught, "Importen misslyckades.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2 className="card__title">Importera medlemmar</h2>
      <p className="card__hint">
        En medlem per rad: <span className="mono">epost;namn;klubb;telefon</span>. Bara e-post är
        obligatoriskt. Semikolon, komma eller tabb funkar som avgränsare, så du kan klistra in
        direkt från Excel eller Google Sheets.
      </p>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="club">Klubb för rader utan angiven klubb</label>
          <ClubSelect id="club" value={club} onChange={setClub} />
        </div>
        <div className="field">
          <label htmlFor="csv">Rader</label>
          <textarea
            id="csv"
            value={csv}
            onChange={(event) => setCsv(event.target.value)}
            placeholder={"anders@example.se;Anders Andersson;RT117;070-1234567\nbertil@example.se;Bertil Bertilsson"}
          />
        </div>
        <button className="btn" type="submit" disabled={busy || !csv.trim()}>
          {busy ? "Importerar…" : "Importera"}
        </button>
      </form>

      {skipped.length > 0 && (
        <div className="notice notice--warn" style={{ marginTop: 16 }}>
          <strong>Överhoppade rader</strong>
          <ul style={{ margin: "8px 0 0", paddingLeft: 20 }}>
            {skipped.map((row) => (
              <li key={row.line}>
                Rad {row.line}: {row.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// --- Logg ---

function LogTab({ fail }: Pick<TabProps, "fail">) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setEntries((await api.adminAudit(200)).entries);
      } catch (caught) {
        fail(caught, "Kunde inte hämta loggen.");
      }
    })();
  }, [fail]);

  return (
    <div className="card">
      <h2 className="card__title">Revisionslogg</h2>
      <p className="card__hint">
        Senaste 200 händelserna: vem som loggat in, vem som låst upp dörren och vad admins har
        ändrat.
      </p>
      {!entries ? (
        <p className="muted">Hämtar…</p>
      ) : entries.length === 0 ? (
        <p className="muted">Inget loggat ännu.</p>
      ) : (
        <ul className="list list--tight">
          {entries.map((entry) => (
            <li key={entry.id} className="list__item">
              <div className="list__head">
                <span className="mono">{entry.action}</span>
                {entry.result && (
                  <span
                    className={
                      entry.result === "ok"
                        ? "pill pill--ok"
                        : entry.result === "denied"
                          ? "pill pill--warn"
                          : "pill pill--error"
                    }
                  >
                    {entry.result}
                  </span>
                )}
              </div>
              <div className="list__meta">
                {formatDateTime(entry.ts)}
                {entry.actor_email ? ` · ${entry.actor_email}` : ""}
              </div>
              {entry.detail && entry.detail !== "{}" && (
                <div className="list__detail mono">{entry.detail}</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- Inställningar ---

function SettingsTab({ notify, fail }: TabProps) {
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setSettings(await api.adminSettings());
    } catch (caught) {
      fail(caught, "Kunde inte hämta inställningar.");
    }
  }, [fail]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleUnlock() {
    if (!settings) return;
    setBusy(true);
    try {
      await api.adminSetUnlockEnabled(!settings.unlockEnabled);
      notify({
        ok: settings.unlockEnabled
          ? "Upplåsning är avstängd. Ingen kommer in via sidan nu."
          : "Upplåsning är påslagen igen.",
      });
      await load();
    } catch (caught) {
      fail(caught, "Kunde inte ändra inställningen.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2 className="card__title">Nödstopp</h2>
      <p className="card__hint">
        Stänger av all upplåsning via sidan direkt, utan ny deploy. Låset går fortfarande att
        öppna manuellt och via Glue-appen.
      </p>
      {settings && (
        <>
          <div className={settings.unlockEnabled ? "notice notice--ok" : "notice notice--error"}>
            Upplåsning är {settings.unlockEnabled ? "påslagen" : "avstängd"}.
          </div>
          <button className="btn btn--secondary" onClick={toggleUnlock} disabled={busy}>
            {settings.unlockEnabled ? "Stäng av upplåsning" : "Slå på upplåsning"}
          </button>
        </>
      )}
    </div>
  );
}
