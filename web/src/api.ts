export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError("Ingen kontakt med servern. Kolla nätet.", "network_error", 0);
  }

  const payload = (await response.json().catch(() => null)) as
    | (Record<string, unknown> & { error?: string; code?: string; retryAfter?: number })
    | null;

  if (!response.ok) {
    throw new ApiError(
      payload?.error ?? "Något gick fel.",
      payload?.code ?? "unknown",
      response.status,
      payload?.retryAfter,
    );
  }

  return payload as T;
}

const get = <T,>(path: string) => request<T>(path);
const post = <T,>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

// --- Typer ---

export interface AppConfig {
  appName: string;
  googleEnabled: boolean;
  turnstileSiteKey: string | null;
}

export interface Me {
  member: {
    id: string;
    email: string | null;
    name: string | null;
    club: string | null;
    role: "member" | "admin";
  };
  mock: boolean;
}

export type OperationStatus = "pending" | "completed" | "timeout" | "failed";

export interface LockStatus {
  unlockEnabled: boolean;
  mock: boolean;
  lock: {
    id: string;
    description: string;
    batteryStatus: number;
    connectionStatus: "offline" | "disconnected" | "connected" | "busy";
    lastLockEvent: { eventType: string; eventTime: string } | null;
  } | null;
  lockError?: string;
}

export interface AdminMember {
  id: string;
  email: string | null;
  phone: string | null;
  name: string | null;
  club: string | null;
  role: "member" | "admin";
  source: "admin" | "tablerworld";
  active: boolean;
  createdAt: number;
  lastLoginAt: number | null;
  notes: string | null;
}

export interface AuditEntry {
  id: string;
  ts: number;
  member_id: string | null;
  actor_email: string | null;
  action: string;
  result: string | null;
  detail: string | null;
  ip: string | null;
}

export interface AdminSettings {
  unlockEnabled: boolean;
  memberSource: string;
  tablerWorldConfigured: boolean;
}

// --- Anrop ---

export const api = {
  config: () => get<AppConfig>("/api/config"),
  me: () => get<Me>("/api/me"),
  logout: () => post<{ ok: true }>("/api/auth/logout"),

  requestCode: (email: string, turnstileToken?: string) =>
    post<{ ok: true; message: string }>("/api/auth/otp/request", { email, turnstileToken }),
  verifyCode: (email: string, code: string) =>
    post<{ ok: true }>("/api/auth/otp/verify", { email, code }),

  lockStatus: () => get<LockStatus>("/api/lock/status"),
  unlock: () => post<{ operationId: string; status: OperationStatus; reason: string | null }>("/api/unlock"),
  operation: (id: string) =>
    get<{ operationId: string; status: OperationStatus; reason: string | null }>(`/api/unlock/${id}`),

  adminMembers: () => get<{ members: AdminMember[] }>("/api/admin/members"),
  adminCreateMember: (input: Record<string, unknown>) =>
    post<{ member: AdminMember }>("/api/admin/members", input),
  adminUpdateMember: (id: string, input: Record<string, unknown>) =>
    request<{ member: AdminMember }>(`/api/admin/members/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  adminDeleteMember: (id: string) =>
    request<{ ok: true }>(`/api/admin/members/${id}`, { method: "DELETE" }),
  adminImport: (csv: string, club?: string) =>
    post<{ created: number; skipped: { line: number; reason: string }[] }>(
      "/api/admin/members/import",
      { csv, club },
    ),
  adminAudit: (limit = 100) => get<{ entries: AuditEntry[] }>(`/api/admin/audit?limit=${limit}`),
  adminSettings: () => get<AdminSettings>("/api/admin/settings"),
  adminSetUnlockEnabled: (unlockEnabled: boolean) =>
    request<{ unlockEnabled: boolean }>("/api/admin/settings", {
      method: "PUT",
      body: JSON.stringify({ unlockEnabled }),
    }),
  adminTablerWorldProbe: () =>
    get<{ probe: { clubId: string; url: string; count: number; sampleKeys: string[] }[] }>(
      "/api/admin/tablerworld/probe",
    ),
  adminTablerWorldSync: () =>
    post<{ result: { created: number; updated: number; deactivated: number; skipped: number } }>(
      "/api/admin/tablerworld/sync",
    ),
};
