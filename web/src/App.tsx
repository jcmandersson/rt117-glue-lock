import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type AppConfig, type Me } from "./api";
import { navigate, usePathname } from "./router";
import { LoginPage } from "./pages/LoginPage";
import { UnlockPage } from "./pages/UnlockPage";
import { AdminPage } from "./pages/AdminPage";

export function App() {
  const pathname = usePathname();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api.me());
    } catch (error) {
      // 401 är det normala läget för en utloggad besökare, inte ett fel.
      if (!(error instanceof ApiError) || error.status !== 401) {
        console.error(error);
      }
      setMe(null);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const [configResult] = await Promise.allSettled([api.config(), refreshMe()]);
      if (configResult.status === "fulfilled") setConfig(configResult.value);
      setLoading(false);
    })();
  }, [refreshMe]);

  // Skicka utloggade till inloggningssidan, och inloggade bort från den.
  useEffect(() => {
    if (loading) return;
    if (!me && pathname !== "/logga-in") navigate("/logga-in");
    if (me && pathname === "/logga-in") navigate("/");
  }, [loading, me, pathname]);

  if (loading) {
    return (
      <div className="app">
        <p className="muted center">Laddar…</p>
      </div>
    );
  }

  if (!me) {
    return <LoginPage config={config} onSignedIn={refreshMe} />;
  }

  if (pathname === "/admin") {
    if (me.member.role !== "admin") {
      return (
        <div className="app">
          <div className="notice notice--error">Du har inte behörighet till adminsidan.</div>
          <button className="btn btn--secondary" onClick={() => navigate("/")}>
            Tillbaka
          </button>
        </div>
      );
    }
    return <AdminPage me={me} onSignedOut={refreshMe} />;
  }

  return <UnlockPage me={me} onSignedOut={refreshMe} />;
}
