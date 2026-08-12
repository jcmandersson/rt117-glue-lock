import { now } from "./ids";
import { tooManyRequests } from "./http";

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  retryAfter: number;
}

/**
 * Hastighetsbegränsning med fast fönster, lagrad i D1.
 *
 * Hela räkningen sker i en enda `INSERT ... ON CONFLICT ... RETURNING`, så två
 * samtidiga förfrågningar inte kan läsa samma värde och båda släppas igenom.
 */
export async function consumeRateLimit(
  db: D1Database,
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const ts = now();

  const row = await db
    .prepare(
      `INSERT INTO rate_limits (bucket, count, window_start)
       VALUES (?1, 1, ?2)
       ON CONFLICT(bucket) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start + ?3 <= ?2
                      THEN 1 ELSE rate_limits.count + 1 END,
         window_start = CASE WHEN rate_limits.window_start + ?3 <= ?2
                             THEN ?2 ELSE rate_limits.window_start END
       RETURNING count, window_start`,
    )
    .bind(bucket, ts, windowSeconds)
    .first<{ count: number; window_start: number }>();

  const count = row?.count ?? 1;
  const windowStart = row?.window_start ?? ts;

  return {
    allowed: count <= limit,
    count,
    retryAfter: Math.max(1, windowStart + windowSeconds - ts),
  };
}

/** Som `consumeRateLimit` men kastar 429 direkt när taket är nått. */
export async function enforceRateLimit(
  db: D1Database,
  bucket: string,
  limit: number,
  windowSeconds: number,
  message: string,
): Promise<void> {
  const result = await consumeRateLimit(db, bucket, limit, windowSeconds);
  if (!result.allowed) {
    throw tooManyRequests(message, result.retryAfter);
  }
}
