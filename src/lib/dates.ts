/** Formaterar en unix-sekund som svensk lokal tid, t.ex. "15 aug. 2026 00:00". */
export function formatStockholm(ts: number): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ts * 1000));
}
