import { useEffect, useState } from "react";
import { api, ApiError, type AppConfig } from "../api";
import { navigate } from "../router";
import { Turnstile } from "../components/Turnstile";

/** Felkoder som Google-återhoppet kan lägga i URL:en. */
const CALLBACK_ERRORS: Record<string, string> = {
  google_avbruten: "Inloggningen avbröts.",
  google_overifierad:
    "Google-kontots e-postadress är inte verifierad, så vi kan inte lita på den.",
};

interface Props {
  config: AppConfig | null;
  onSignedIn: () => Promise<void>;
}

export function LoginPage({ config, onSignedIn }: Props) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);

  // Läs och städa bort ?fel= ur adressfältet.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("fel");
    if (!code) return;
    setError(CALLBACK_ERRORS[code] ?? "Inloggningen misslyckades. Försök igen.");
    window.history.replaceState({}, "", window.location.pathname);
  }, []);

  const needsTurnstile = Boolean(config?.turnstileSiteKey);

  async function submitEmail(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      const result = await api.requestCode(email.trim(), turnstileToken ?? undefined);
      setInfo(result.message);
      setStep("code");
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Kunde inte skicka koden.");
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await api.verifyCode(email.trim(), code.trim());
      if (result.member) {
        await onSignedIn();
      } else {
        // Verifierad adress utan medlemskap: vidare till ansökan.
        navigate("/ansok");
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Kunde inte verifiera koden.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="login__inner">
        <header className="login__header">
          <img className="login__logo" src="/logo.png" alt="" width={96} height={96} />
          <h1 className="login__title">{config?.appName ?? "Lokalen"}</h1>
          <p className="login__subtitle">Round Table 117 och 36, Linköping</p>
        </header>

        {error && <div className="notice notice--error">{error}</div>}
        {info && <div className="notice notice--ok">{info}</div>}

        <div className="card">
          {step === "email" ? (
            <>
              <h2 className="card__title">Logga in</h2>
              <p className="card__hint">
                Medlemmar loggar in och låser upp direkt. Ny här? Verifiera din e-postadress så
                får du ansöka om åtkomst.
              </p>

              {config?.googleEnabled && (
                <>
                  <a
                    className="btn"
                    href={`/auth/google/start?redirect=${encodeURIComponent("/")}`}
                    style={{ textDecoration: "none" }}
                  >
                    Fortsätt med Google
                  </a>
                  <div className="divider">eller</div>
                </>
              )}

              <form onSubmit={submitEmail}>
                <div className="field">
                  <label htmlFor="email">E-postadress</label>
                  <input
                    id="email"
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="namn@example.se"
                  />
                </div>

                {config?.turnstileSiteKey && (
                  <Turnstile siteKey={config.turnstileSiteKey} onToken={setTurnstileToken} />
                )}

                <button
                  className="btn"
                  type="submit"
                  disabled={busy || !email.trim() || (needsTurnstile && !turnstileToken)}
                >
                  {busy ? "Skickar…" : "Skicka engångskod"}
                </button>
              </form>
            </>
          ) : (
            <>
              <h2 className="card__title">Skriv in koden</h2>
              <p className="card__hint">
                Vi har mejlat en sexsiffrig kod till {email.trim()}. Den gäller i 10 minuter.
              </p>

              <form onSubmit={submitCode}>
                <div className="field">
                  <label htmlFor="code">Kod från mejlet</label>
                  <input
                    id="code"
                    className="code-input"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]*"
                    maxLength={6}
                    required
                    autoFocus
                    value={code}
                    onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
                    placeholder="000000"
                  />
                </div>

                <button className="btn" type="submit" disabled={busy || code.length < 6}>
                  {busy ? "Kontrollerar…" : "Logga in"}
                </button>

                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => {
                    setStep("email");
                    setCode("");
                    setInfo(null);
                    setError(null);
                  }}
                >
                  Använd en annan adress
                </button>
              </form>
            </>
          )}
        </div>

        <p className="login__footer">Frågor om åtkomst? Hör av dig till någon i klubben.</p>
      </div>
    </div>
  );
}
