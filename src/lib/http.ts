import type { Context } from "hono";

/** Fel som är säkra att visa för användaren. */
export class AppError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 500 | 502 | 503,
    override readonly message: string,
    readonly code: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function badRequest(message: string, code = "bad_request"): AppError {
  return new AppError(400, message, code);
}

export function unauthorized(message = "Du är inte inloggad.", code = "unauthorized"): AppError {
  return new AppError(401, message, code);
}

export function forbidden(message: string, code = "forbidden"): AppError {
  return new AppError(403, message, code);
}

export function tooManyRequests(message: string, retryAfter: number): AppError {
  return new AppError(429, message, "rate_limited", { retryAfter });
}

export function clientIp(c: Context): string {
  return (
    c.req.header("CF-Connecting-IP") ??
    c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

export function userAgent(c: Context): string {
  return (c.req.header("User-Agent") ?? "").slice(0, 300);
}

/**
 * Läser JSON-body och kastar ett läsbart fel om den är trasig, i stället för
 * att låta ett SyntaxError bubbla upp som 500.
 */
export async function readJson<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw badRequest("Kunde inte läsa förfrågan (ogiltig JSON).", "invalid_json");
  }
}

export function requireString(
  value: unknown,
  field: string,
  { max = 500, min = 1 }: { max?: number; min?: number } = {},
): string {
  if (typeof value !== "string") throw badRequest(`Fältet "${field}" saknas.`, "missing_field");
  const trimmed = value.trim();
  if (trimmed.length < min) throw badRequest(`Fältet "${field}" saknas.`, "missing_field");
  if (trimmed.length > max) throw badRequest(`Fältet "${field}" är för långt.`, "field_too_long");
  return trimmed;
}
