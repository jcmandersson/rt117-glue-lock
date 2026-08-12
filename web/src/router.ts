import { useEffect, useState } from "react";

const ROUTE_CHANGE = "rt117:route";

/** Byter sida utan omladdning. SPA-fallbacken i Workern gör att djuplänkar också fungerar. */
export function navigate(path: string): void {
  if (path === window.location.pathname + window.location.search) return;
  window.history.pushState({}, "", path);
  window.dispatchEvent(new Event(ROUTE_CHANGE));
}

/** Aktuell sökväg, som uppdateras vid både navigate() och bakåtknappen. */
export function usePathname(): string {
  const [pathname, setPathname] = useState(() => window.location.pathname);

  useEffect(() => {
    const update = () => setPathname(window.location.pathname);
    window.addEventListener(ROUTE_CHANGE, update);
    window.addEventListener("popstate", update);
    return () => {
      window.removeEventListener(ROUTE_CHANGE, update);
      window.removeEventListener("popstate", update);
    };
  }, []);

  return pathname;
}
