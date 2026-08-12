import { useEffect, useState } from "react";
import { api, ApiError, type AppConfig } from "../api";
import { Turnstile } from "../components/Turnstile";

/** Felkoder som Google-återhoppet kan lägga i URL:en. */
const CALLBACK_ERRORS: Record<string, string> = {
  ej_medlem:
    "Den e-postadressen finns inte i medlemslistan. Hör av dig till en admin så lägger de in dig.",
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
      await api.verifyCode(email.trim(), code.trim());
      await onSignedIn();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Kunde inte verifiera koden.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <header className="header">
        <h1 className="header__title">{config?.appName ?? "Lokalen"}</h1>
        <span className="header__meta">RT117 &amp; RT36</span>
      </header>

      {error && <div className="notice notice--error">{error}</div>}
      {info && <div className="notice notice--ok">{info}</div>}

      <div className="card">
        <h2 className="card__title">Logga in för att låsa upp</h2>
        <p className="card__hint">
          Bara bröder i medlemslistan kommer in. Har du inte tillgång — hör av dig till en admin.
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

        {step === "email" ? (
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
                placeholder="broder@example.se"
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
        ) : (
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
        )}
      </div>
    </div>
  );
}
