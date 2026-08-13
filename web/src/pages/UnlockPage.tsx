import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  ApiError,
  type LockActivityEvent,
  type LockStatus,
  type Me,
  type OperationType,
} from "../api";
import { navigate } from "../router";
import { formatDate, formatDateTime, formatRelative, formatWindow } from "../dates";

type Phase = "idle" | "working" | "done" | "error";

/** Pollningen: 1,2 s mellan varje fråga i upp till cirka 30 s. */
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

/**
 * Tolkar Glues senaste låshändelse till "Låst" eller "Upplåst". Händelsetyperna
 * heter saker som localLock, remoteUnlock och pressAndGo, så vi tittar bara på
 * om ordet unlock finns med. Läget är en indikation, inte en garanti: låset kan
 * ha vridits manuellt utan att det syns här.
 */
function lastEventLabel(event: { eventType: string; eventTime: string } | null): {
  text: string;
  exact: string;
} | null {
  if (!event) return null;
  const unlocked = /unlock|pressandgo/i.test(event.eventType);
  const ts = Math.floor(new Date(event.eventTime).getTime() / 1000);
  if (!Number.isFinite(ts)) return null;
  return {
    text: `Troligen ${unlocked ? "upplåst" : "låst"} · ${formatRelative(ts)}`,
    exact: formatDateTime(ts),
  };
}

interface Props {
  me: Me;
  onSignedOut: () => Promise<void>;
}

export function UnlockPage({ me, onSignedOut }: Props) {
  const [status, setStatus] = useState<LockStatus | null>(null);
  const [activity, setActivity] = useState<LockActivityEvent[] | null>(null);
  const [action, setAction] = useState<{ type: OperationType; phase: Phase }>({
    type: "unlock",
    phase: "idle",
  });
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
      const [statusResult, activityResult] = await Promise.allSettled([
        api.lockStatus(),
        api.lockActivity(),
      ]);
      if (cancelled.current) return;
      if (statusResult.status === "fulfilled") setStatus(statusResult.value);
      if (activityResult.status === "fulfilled") setActivity(activityResult.value.events);
    } catch (error) {
      console.error(error);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  async function run(type: OperationType) {
    setAction({ type, phase: "working" });
    setMessage(null);

    try {
      const started = type === "unlock" ? await api.unlock() : await api.lock();
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
        setAction({ type, phase: "done" });
        setMessage(null);
        // Tillbaka till utgångsläget så nästa person kan trycka.
        setTimeout(() => {
          if (!cancelled.current) setAction({ type, phase: "idle" });
        }, 6000);
      } else if (current === "pending") {
        setAction({ type, phase: "error" });
        setMessage("Låset svarade inte i tid. Står hubben på och har den nät?");
      } else {
        setAction({ type, phase: "error" });
        setMessage(
          current === "timeout"
            ? "Låset svarade inte i tid. Prova igen, eller använd nyckeln."
            : type === "unlock"
              ? "Låset kunde inte låsas upp. Prova igen."
              : "Dörren kunde inte låsas. Prova igen, eller kontrollera på plats.",
        );
      }

      void loadStatus();
    } catch (error) {
      if (cancelled.current) return;
      setAction({ type, phase: "error" });
      setMessage(error instanceof ApiError ? error.message : "Något gick fel. Försök igen.");
    }
  }

  async function signOut() {
    await api.logout();
    await onSignedOut();
    navigate("/logga-in");
  }

  const lock = status?.lock;
  const lastEvent = lastEventLabel(lock?.lastLockEvent ?? null);

  // Medlemmar med start- och slutdatum kan logga in när som helst men bara
  // styra låset inom sitt fönster. Servern kontrollerar också, det här är bara UI.
  const nowSec = Math.floor(Date.now() / 1000);
  const { validFrom, validUntil } = me.member;
  const beforeStart = validFrom !== null && nowSec < validFrom;
  const afterEnd = validUntil !== null && nowSec > validUntil;
  const outsideWindow = beforeStart || afterEnd;
  const window = formatWindow(validFrom, validUntil);

  const busy = action.phase === "working";
  const disabled = busy || status?.unlockEnabled === false || outsideWindow;
  const unlockPhase = action.type === "unlock" ? action.phase : "idle";
  const lockPhase = action.type === "lock" ? action.phase : "idle";

  return (
    <div className="app">
      <header className="header">
        <div className="header__brand">
          <img className="header__logo" src="/logo.png" alt="" width={34} height={34} />
          <h1 className="header__title">Lokalen</h1>
        </div>
        <span className="header__meta">
          {me.member.name ?? me.member.email}
          {me.member.club ? ` · ${me.member.club}` : ""}
        </span>
      </header>

      {status?.mock && (
        <div className="notice notice--warn">
          Simulerat läge: inget riktigt lås styrs. Sätt <span className="mono">GLUE_API_KEY</span> och{" "}
          <span className="mono">GLUE_MOCK=0</span> för att koppla in låset.
        </div>
      )}

      {status?.unlockEnabled === false && (
        <div className="notice notice--error">
          Fjärrstyrningen av låset är avstängd av en admin just nu.
        </div>
      )}

      {beforeStart && (
        <div className="notice notice--warn">
          Din åtkomst börjar gälla {formatDate(validFrom!)}. Fram till dess går låset inte att
          styra härifrån.
        </div>
      )}

      {afterEnd && (
        <div className="notice notice--error">
          Din åtkomst gick ut {formatDate(validUntil!)}. Hör av dig till klubben om du behöver
          komma in igen.
        </div>
      )}

      {status?.lockError && <div className="notice notice--warn">{status.lockError}</div>}

      <button
        className={
          unlockPhase === "done"
            ? "unlock unlock--done"
            : unlockPhase === "error"
              ? "unlock unlock--error"
              : "unlock"
        }
        onClick={() => run("unlock")}
        disabled={disabled}
      >
        {unlockPhase === "working" && (
          <>
            <span className="spinner" aria-hidden="true" />
            <span>Låser upp…</span>
            <span className="unlock__sub">Håll i dörren</span>
          </>
        )}
        {unlockPhase === "idle" && (
          <>
            <span className="unlock__icon" aria-hidden="true">
              🔓
            </span>
            <span>Lås upp dörren</span>
            <span className="unlock__sub">Tryck en gång</span>
          </>
        )}
        {unlockPhase === "done" && (
          <>
            <span className="unlock__icon" aria-hidden="true">
              ✓
            </span>
            <span>Upplåst</span>
            <span className="unlock__sub">Välkommen in</span>
          </>
        )}
        {unlockPhase === "error" && (
          <>
            <span className="unlock__icon" aria-hidden="true">
              !
            </span>
            <span>Gick inte</span>
            <span className="unlock__sub">Tryck för att försöka igen</span>
          </>
        )}
      </button>

      <button
        className={
          lockPhase === "done"
            ? "btn btn--lock btn--lock-done"
            : lockPhase === "error"
              ? "btn btn--lock btn--lock-error"
              : "btn btn--secondary btn--lock"
        }
        onClick={() => run("lock")}
        disabled={disabled}
      >
        {lockPhase === "working" ? (
          <>
            <span className="spinner" aria-hidden="true" /> Låser…
          </>
        ) : lockPhase === "done" ? (
          <>✓ Dörren är låst</>
        ) : lockPhase === "error" ? (
          <>! Gick inte, tryck för nytt försök</>
        ) : (
          <>🔒 Lås dörren</>
        )}
      </button>

      {message && (
        <div className={`notice ${action.phase === "error" ? "notice--error" : "notice--info"}`} style={{ marginTop: 16 }}>
          {message}
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <div className="status-grid">
          {lock ? (
            <>
              {lastEvent && (
                <span className="pill pill--accent" title={lastEvent.exact}>
                  {lastEvent.text}
                </span>
              )}
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
          {window && !outsideWindow && <span className="pill">Åtkomst {window}</span>}
        </div>

        {activity && activity.length > 0 && (
          <ul className="activity">
            {activity.map((event, index) => (
              <li key={`${event.at}-${index}`} className="activity__row">
                <span>
                  {event.name}
                  {event.club ? `, ${event.club}` : ""}{" "}
                  {event.type === "unlock" ? "låste upp" : "låste"}
                </span>
                <span className="activity__time" title={formatDateTime(event.at)}>
                  {formatRelative(event.at)}
                </span>
              </li>
            ))}
          </ul>
        )}
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
