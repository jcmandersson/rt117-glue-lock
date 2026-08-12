/** Datumhjälpare. Allt visas i webbläsarens tidszon, i praktiken svensk tid. */

export function formatDateTime(ts: number | null): string {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" });
}

export function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("sv-SE", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Unix-sekunder till värdet i ett <input type="date">. */
export function tsToDateInput(ts: number | null): string {
  if (!ts) return "";
  const date = new Date(ts * 1000);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Värdet i ett <input type="date"> till unix-sekunder. Startdatum tolkas som
 * dygnets början och slutdatum som dygnets slut, så hela dagarna räknas.
 */
export function dateInputToTs(value: string, edge: "start" | "end"): number | null {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  const date =
    edge === "start"
      ? new Date(year, month - 1, day, 0, 0, 0)
      : new Date(year, month - 1, day, 23, 59, 59);
  return Math.floor(date.getTime() / 1000);
}

/** Beskriver ett giltighetsfönster i löptext, eller null om inget är satt. */
export function formatWindow(from: number | null, until: number | null): string | null {
  if (from && until) return `${formatDate(from)} till ${formatDate(until)}`;
  if (from) return `från ${formatDate(from)}`;
  if (until) return `till ${formatDate(until)}`;
  return null;
}
