import { now } from "./ids";

export async function getSetting(
  db: D1Database,
  key: string,
  fallback: string,
): Promise<string> {
  const row = await db
    .prepare(`SELECT value FROM settings WHERE key = ?`)
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? fallback;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, value, now())
    .run();
}

export async function isUnlockEnabled(db: D1Database): Promise<boolean> {
  return (await getSetting(db, "unlock_enabled", "1")) === "1";
}
