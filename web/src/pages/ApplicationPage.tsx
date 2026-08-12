import { useEffect, useState } from "react";
import { api, ApiError, type ApplyMe, type PendingApplication } from "../api";
import { navigate } from "../router";
import { ClubSelect } from "../components/ClubSelect";
import { formatDateTime } from "../dates";

type State =
  | { kind: "loading" }
  | { kind: "member" }
  | { kind: "form"; email: string }
  | { kind: "waiting"; email: string; pending: PendingApplication }
  | { kind: "sent"; email: string };

/**
 * Ansökningssidan. Hit kommer den som verifierat sin e-postadress via Google
 * eller engångskod men inte finns i medlemslistan.
 */
export function ApplicationPage() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [name, setName] = useState("");
  const [club, setClub] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const result: ApplyMe = await api.applyMe();
        if (result.member) {
          setState({ kind: "member" });
        } else if (result.pending) {
          setState({ kind: "waiting", email: result.email, pending: result.pending });
        } else {
          if (result.name) setName(result.name);
          setState({ kind: "form", email: result.email });
        }
      } catch (caught) {
        if (caught instanceof ApiError && caught.status === 401) {
          // Ingen verifierad adress, alltså inget att ansöka med.
          navigate("/logga-in");
          return;
        }
        setError("Kunde inte hämta dina uppgifter. Ladda om sidan och försök igen.");
      }
    })();
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (state.kind !== "form") return;
    setError(null);
    setBusy(true);
    try {
      await api.applySubmit({
        name: name.trim(),
        club: club.trim(),
        message: message.trim() || null,
      });
      setState({ kind: "sent", email: state.email });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Kunde inte skicka ansökan.");
    } finally {
      setBusy(false);
    }
  }

  async function backToLogin() {
    await api.logout().catch(() => {});
    navigate("/logga-in");
  }

  return (
    <div className="login">
      <div className="login__inner">
        <header className="login__header">
          <img className="login__logo" src="/logo.png" alt="" width={96} height={96} />
          <h1 className="login__title">Ansök om åtkomst</h1>
          <p className="login__subtitle">RT117/RT36 Lokalen</p>
        </header>

        {error && <div className="notice notice--error">{error}</div>}

        {state.kind === "loading" && <p className="muted center">Laddar…</p>}

        {state.kind === "member" && (
          <div className="card">
            <h2 className="card__title">Du är redan medlem</h2>
            <p className="card__hint">Din adress finns i medlemslistan, så det är bara att logga in.</p>
            <button className="btn" onClick={backToLogin}>
              Till inloggningen
            </button>
          </div>
        )}

        {state.kind === "waiting" && (
          <div className="card">
            <h2 className="card__title">Din ansökan väntar på svar</h2>
            <p className="card__hint">
              Skickad {formatDateTime(state.pending.createdAt)} för {state.email}. En admin tittar
              på den så snart som möjligt, och du får mejl när den är behandlad.
            </p>
            <div className="notice notice--info">
              {state.pending.name}, {state.pending.club}
              {state.pending.message ? <><br />”{state.pending.message}”</> : null}
            </div>
            <button className="btn btn--secondary" onClick={backToLogin}>
              Tillbaka till inloggningen
            </button>
          </div>
        )}

        {state.kind === "sent" && (
          <div className="card">
            <h2 className="card__title">Tack, ansökan är skickad</h2>
            <p className="card__hint">
              En admin tittar på den så snart som möjligt. Du får mejl till {state.email} när den
              är behandlad.
            </p>
            <button className="btn btn--secondary" onClick={backToLogin}>
              Tillbaka till inloggningen
            </button>
          </div>
        )}

        {state.kind === "form" && (
          <div className="card">
            <h2 className="card__title">Berätta vem du är</h2>
            <p className="card__hint">
              Din adress {state.email} är verifierad men finns inte i medlemslistan. Fyll i
              uppgifterna nedan så tar en admin ställning till din ansökan.
            </p>

            <form onSubmit={submit}>
              <div className="field">
                <label htmlFor="apply-name">Namn</label>
                <input
                  id="apply-name"
                  type="text"
                  autoComplete="name"
                  required
                  maxLength={120}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="För- och efternamn"
                />
              </div>

              <div className="field">
                <label htmlFor="apply-club">Klubb</label>
                <ClubSelect id="apply-club" value={club} onChange={setClub} required />
              </div>

              <div className="field">
                <label htmlFor="apply-message">Meddelande (valfritt)</label>
                <textarea
                  id="apply-message"
                  className="textarea-plain"
                  maxLength={500}
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder="Skriv gärna en rad om varför du behöver komma in i lokalen."
                />
              </div>

              <button className="btn" type="submit" disabled={busy || !name.trim() || !club.trim()}>
                {busy ? "Skickar…" : "Skicka ansökan"}
              </button>

              <button type="button" className="btn btn--ghost" onClick={backToLogin}>
                Avbryt
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
