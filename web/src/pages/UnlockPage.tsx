import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type LockStatus, type Me } from "../api";
import { navigate } from "../router";

type Phase = "idle" | "working" | "done" | "error";

/** Pollningen: 1,2 s mellan varje fråga i upp till ~30 s. */
const POLL_INTERVAL_MS = 1200;
const MAX_POLLS = 25;

function connectionLabel(status: string): { text: string; className: string } {
  switch (status) {
    case "connected":
      return { text: "Låset är online", className: "pill pill--ok" };
    case "busy":
      return { text: "Låset är upptaget", className: "pill pill--warn" };
    case "disconnected":
      return { text: "Låset är inte anslutet", className: "pill pill--warn" };
    default:
      return { text: "Låset är offline", className: "pill pill--error" };
  }
}

interface Props {
  me: Me;
  onSignedOut: () => Promise<void>;
}

export function UnlockPage({ me, onSignedOut }: Props) {
  const [status, setStatus] = useState<LockStatus | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const result = await api.lockStatus();
      if (!cancelled.current) setStatus(result);
    } catch (error) {
      console.error(error);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  async function unlock() {
    setPhase("working");
    setMessage(null);

    try {
      const started = await api.unlock();
      let current = started.status;

      for (let attempt = 0; attempt < MAX_POLLS && current === "pending"; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        if (cancelled.current) return;
        const polled = await api.operation(started.operationId);
        current = polled.status;
        if (current !== "pending" && polled.reason) setMessage(polled.reason);
      }

      if (cancelled.current) return;

      if (current === "completed") {
        setPhase("done");
        setMessage(null);
        // Tillbaka till utgångsläget så nästa broder kan trycka.
        setTimeout(() => {
          if (!cancelled.current) setPhase("idle");
        }, 6000);
      } else if (current === "pending") {
        setPhase("error");
        setMessage("Låset svarade inte i tid. Står hubben på och har den nät?");
      } else {
        setPhase("error");
        setMessage(
          current === "timeout"
            ? "Låset svarade inte i tid. Prova igen, eller lås upp manuellt."
            : "Låset kunde inte låsas upp. Prova igen.",
        );
      }

      void loadStatus();
    } catch (error) {
      if (cancelled.current) return;
      setPhase("error");
      setMessage(error instanceof ApiError ? error.message : "Något gick fel. Försök igen.");
    }
  }

  async function signOut() {
    await api.logout();
    await onSignedOut();
    navigate("/logga-in");
  }

  const lock = status?.lock;
  const disabled = phase === "working" || status?.unlockEnabled === false;

  return (
    <div className="app">
      <header className="header">
        <h1 className="header__title">Lokalen</h1>
        <span className="header__meta">
          {me.member.name ?? me.member.email}
          {me.member.club ? ` · ${me.member.club}` : ""}
        </span>
      </header>

      {status?.mock && (
        <div className="notice notice--warn">
          Simulerat läge: inget riktigt lås öppnas. Sätt <span className="mono">GLUE_API_KEY</span> och{" "}
          <span className="mono">GLUE_MOCK=0</span> för att koppla in låset.
        </div>
      )}

      {status?.unlockEnabled === false && (
        <div className="notice notice--error">
          Upplåsning är avstängd av en admin just nu.
        </div>
      )}

      {status?.lockError && <div className="notice notice--warn">{status.lockError}</div>}

      <button
        className={
          phase === "done"
            ? "unlock unlock--done"
            : phase === "error"
              ? "unlock unlock--error"
              : "unlock"
        }
        onClick={unlock}
        disabled={disabled}
      >
        {phase === "working" && (
          <>
            <span className="spinner" aria-hidden="true" />
            <span>Låser upp…</span>
            <span className="unlock__sub">Håll i dörren</span>
          </>
        )}
        {phase === "idle" && (
          <>
            <span className="unlock__icon" aria-hidden="true">
              🔓
            </span>
            <span>Lås upp dörren</span>
            <span className="unlock__sub">Tryck en gång</span>
          </>
        )}
        {phase === "done" && (
          <>
            <span className="unlock__icon" aria-hidden="true">
              ✓
            </span>
            <span>Upplåst</span>
            <span className="unlock__sub">Välkommen in</span>
          </>
        )}
        {phase === "error" && (
          <>
            <span className="unlock__icon" aria-hidden="true">
              !
            </span>
            <span>Gick inte</span>
            <span className="unlock__sub">Tryck för att försöka igen</span>
          </>
        )}
      </button>

      {message && (
        <div className={`notice ${phase === "error" ? "notice--error" : "notice--info"}`} style={{ marginTop: 16 }}>
          {message}
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <div className="status-grid">
          {lock ? (
            <>
              <span className={connectionLabel(lock.connectionStatus).className}>
                {connectionLabel(lock.connectionStatus).text}
              </span>
              <span
                className={
                  lock.batteryStatus <= 20
                    ? "pill pill--error"
                    : lock.batteryStatus <= 40
                      ? "pill pill--warn"
                      : "pill"
                }
              >
                Batteri {lock.batteryStatus}%
              </span>
            </>
          ) : (
            <span className="muted">Låsets status är okänd.</span>
          )}
        </div>
      </div>

      <div className="btn-row">
        {me.member.role === "admin" && (
          <button className="btn btn--secondary btn--small" onClick={() => navigate("/admin")}>
            Admin
          </button>
        )}
        <button className="btn btn--ghost btn--small" onClick={signOut}>
          Logga ut
        </button>
      </div>
    </div>
  );
}
