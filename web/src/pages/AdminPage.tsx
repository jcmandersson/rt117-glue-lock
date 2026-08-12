import { useCallback, useEffect, useState } from "react";
import {
  api,
  ApiError,
  type AdminMember,
  type AdminSettings,
  type AuditEntry,
  type Me,
} from "../api";
import { navigate } from "../router";

type Tab = "members" | "import" | "log" | "settings";

function formatTime(seconds: number | null): string {
  if (!seconds) return "—";
  return new Date(seconds * 1000).toLocaleString("sv-SE", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

interface Props {
  me: Me;
  onSignedOut: () => Promise<void>;
}

export function AdminPage({ me, onSignedOut }: Props) {
  const [tab, setTab] = useState<Tab>("members");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

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

  return (
    <div className="app app--wide">
      <header className="header">
        <h1 className="header__title">Administration</h1>
        <span className="header__meta">{me.member.email}</span>
      </header>

      <div className="tabs" role="tablist">
        {(
          [
            ["members", "Medlemmar"],
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
          </button>
        ))}
      </div>

      {error && <div className="notice notice--error">{error}</div>}
      {info && <div className="notice notice--ok">{info}</div>}

      {tab === "members" && <MembersTab me={me} notify={notify} fail={fail} />}
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

// --- Medlemmar ---

interface TabProps {
  notify: (result: { ok?: string; err?: string }) => void;
  fail: (caught: unknown, fallback: string) => void;
}

function MembersTab({ me, notify, fail }: TabProps & { me: Me }) {
  const [members, setMembers] = useState<AdminMember[] | null>(null);
  const [form, setForm] = useState({ email: "", name: "", club: "RT117", phone: "" });
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
      });
      setForm({ email: "", name: "", club: form.club, phone: "" });
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
          E-postadressen är den som matchas mot Google-kontot eller engångskoden.
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
              placeholder="broder@example.se"
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
              <select
                id="new-club"
                value={form.club}
                onChange={(event) => setForm({ ...form, club: event.target.value })}
              >
                <option value="RT117">RT117</option>
                <option value="RT36">RT36</option>
                <option value="Gäst">Gäst</option>
              </select>
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
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Namn</th>
                  <th>E-post</th>
                  <th>Klubb</th>
                  <th>Roll</th>
                  <th>Källa</th>
                  <th>Senast inne</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <tr key={member.id} className={member.active ? "" : "is-inactive"}>
                    <td>{member.name ?? "—"}</td>
                    <td>{member.email ?? member.phone ?? "—"}</td>
                    <td>{member.club ?? "—"}</td>
                    <td>{member.role === "admin" ? "Admin" : "Medlem"}</td>
                    <td>{member.source === "tablerworld" ? "tabler.world" : "Manuell"}</td>
                    <td>{formatTime(member.lastLoginAt)}</td>
                    <td>
                      <div className="btn-row">
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
                        <button
                          className="btn btn--secondary btn--small"
                          onClick={() =>
                            patch(
                              member,
                              { role: member.role === "admin" ? "member" : "admin" },
                              "Rollen är ändrad.",
                            )
                          }
                        >
                          {member.role === "admin" ? "Gör medlem" : "Gör admin"}
                        </button>
                        {member.id !== me.member.id && (
                          <button className="btn btn--danger btn--small" onClick={() => remove(member)}>
                            Ta bort
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
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
          <select id="club" value={club} onChange={(event) => setClub(event.target.value)}>
            <option value="RT117">RT117</option>
            <option value="RT36">RT36</option>
          </select>
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
        Senaste 200 händelserna. Visar vem som loggat in och vem som låst upp dörren.
      </p>
      {!entries ? (
        <p className="muted">Hämtar…</p>
      ) : entries.length === 0 ? (
        <p className="muted">Inget loggat ännu.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Tid</th>
                <th>Händelse</th>
                <th>Utfall</th>
                <th>Vem</th>
                <th>Detaljer</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td>{formatTime(entry.ts)}</td>
                  <td className="mono">{entry.action}</td>
                  <td>{entry.result ?? "—"}</td>
                  <td>{entry.actor_email ?? "—"}</td>
                  <td className="mono">{entry.detail ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// --- Inställningar ---

function SettingsTab({ notify, fail }: TabProps) {
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState<
    { clubId: string; url: string; count: number; sampleKeys: string[] }[] | null
  >(null);

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
    <>
      <div className="card">
        <h2 className="card__title">Nödstopp</h2>
        <p className="card__hint">
          Stänger av all upplåsning via sidan direkt, utan att deploya om. Låset går fortfarande att
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

      <div className="card">
        <h2 className="card__title">tabler.world</h2>
        <p className="card__hint">
          Hämtar medlemmar från Round Tables register i stället för att mata in dem manuellt. Kräver
          en token från OVF/RTI, och att sökväg och fältnamn stämmer — testa med Testanrop först,
          det skriver ingenting.
        </p>
        {settings && !settings.tablerWorldConfigured ? (
          <div className="notice notice--info">
            Inte konfigurerat. Sätt <span className="mono">TABLERWORLD_TOKEN</span> och{" "}
            <span className="mono">TABLERWORLD_CLUB_IDS</span> som secrets först.
          </div>
        ) : (
          <div className="btn-row">
            <button
              className="btn btn--secondary btn--small"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  setProbe((await api.adminTablerWorldProbe()).probe);
                  notify({ ok: "Testanropet gick igenom." });
                } catch (caught) {
                  fail(caught, "Testanropet misslyckades.");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Testanrop
            </button>
            <button
              className="btn btn--secondary btn--small"
              disabled={busy}
              onClick={async () => {
                if (!window.confirm("Synka medlemmar från tabler.world nu?")) return;
                setBusy(true);
                try {
                  const { result } = await api.adminTablerWorldSync();
                  notify({
                    ok: `Synk klar: ${result.created} nya, ${result.updated} uppdaterade, ${result.deactivated} avaktiverade, ${result.skipped} överhoppade.`,
                  });
                } catch (caught) {
                  fail(caught, "Synken misslyckades.");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Synka nu
            </button>
          </div>
        )}

        {probe && (
          <div className="notice notice--info" style={{ marginTop: 16 }}>
            {probe.map((row) => (
              <div key={row.clubId} style={{ marginBottom: 8 }}>
                <strong>{row.clubId}</strong> — {row.count} rader
                <div className="mono">{row.url}</div>
                <div className="mono">{row.sampleKeys.join(", ") || "inga fält hittade"}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
