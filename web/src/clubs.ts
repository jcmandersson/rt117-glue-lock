/** Klubbarna i huset. "Annan" i formulären ger fritext utöver de här. */
export const CLUBS = ["RT117", "RT36", "OT117", "OT36", "LC17", "LC76", "LC166", "Gäst"] as const;

export const ANNAN = "Annan";

export function isPresetClub(value: string): boolean {
  return (CLUBS as readonly string[]).includes(value);
}
