import type { Env } from "../types";
import { AppError } from "../lib/http";

/**
 * Klient mot Glue Homes API.
 *
 * Kontraktet nedan är verifierat mot Glues officiella klientbibliotek
 * (`gluehome` på PyPI, v0.1.2):
 *   Bas               https://user-api.gluehome.com
 *   Autentisering     Authorization: Api-Key <nyckel>
 *   Lista lås         GET  /v1/locks
 *   Ett lås           GET  /v1/locks/{lockId}
 *   Skapa operation   POST /v1/locks/{lockId}/operations   body {"type":"unlock"}
 *   Läs operation     GET  /v1/locks/{lockId}/operations/{operationId}
 *
 * API-nyckeln hämtas en gång med `npm run glue:api-key` (Basic auth mot
 * POST /v1/api-keys) och läggs som secret. Vi loggar aldrig in med
 * användarnamn/lösenord härifrån.
 */

const BASE_URL = "https://user-api.gluehome.com";
const USER_AGENT = "rt117-glue-lock/0.1";

export type GlueConnectionStatus = "offline" | "disconnected" | "connected" | "busy";
export type GlueOperationStatus = "pending" | "completed" | "timeout" | "failed";
export type GlueOperationType = "lock" | "unlock";

export interface GlueLockEvent {
  eventType: string;
  eventTime: string;
}

export interface GlueLock {
  id: string;
  serialNumber: string;
  description: string;
  firmwareVersion: string;
  batteryStatus: number;
  connectionStatus: GlueConnectionStatus;
  lastLockEvent?: GlueLockEvent | null;
}

export interface GlueOperation {
  id: string;
  status: GlueOperationStatus;
  reason?: string | null;
}

export interface GlueClient {
  listLocks(): Promise<GlueLock[]>;
  getLock(lockId: string): Promise<GlueLock>;
  createOperation(lockId: string, type: GlueOperationType): Promise<GlueOperation>;
  getOperation(lockId: string, operationId: string): Promise<GlueOperation>;
}

class HttpGlueClient implements GlueClient {
  constructor(private readonly apiKey: string) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${BASE_URL}${path}`, {
        ...init,
        headers: {
          Authorization: `Api-Key ${this.apiKey}`,
          "User-Agent": USER_AGENT,
          Accept: "application/json",
          ...(init?.body ? { "Content-Type": "application/json" } : {}),
          ...init?.headers,
        },
      });
    } catch (error) {
      console.error("glue_network_error", path, error);
      throw new AppError(502, "Kunde inte nå låset just nu. Försök igen.", "glue_unreachable");
    }

    if (response.status === 401 || response.status === 403) {
      console.error("glue_auth_failed", path, response.status);
      throw new AppError(
        502,
        "Låset avvisade vår API-nyckel. En admin behöver förnya den.",
        "glue_auth_failed",
      );
    }

    if (response.status === 404) {
      throw new AppError(404, "Låset hittades inte hos Glue.", "glue_lock_not_found");
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error("glue_http_error", path, response.status, body.slice(0, 500));
      throw new AppError(502, "Låset svarade med ett fel. Försök igen.", "glue_error");
    }

    return (await response.json()) as T;
  }

  listLocks(): Promise<GlueLock[]> {
    return this.request<GlueLock[]>("/v1/locks");
  }

  getLock(lockId: string): Promise<GlueLock> {
    return this.request<GlueLock>(`/v1/locks/${encodeURIComponent(lockId)}`);
  }

  createOperation(lockId: string, type: GlueOperationType): Promise<GlueOperation> {
    return this.request<GlueOperation>(`/v1/locks/${encodeURIComponent(lockId)}/operations`, {
      method: "POST",
      body: JSON.stringify({ type }),
    });
  }

  getOperation(lockId: string, operationId: string): Promise<GlueOperation> {
    return this.request<GlueOperation>(
      `/v1/locks/${encodeURIComponent(lockId)}/operations/${encodeURIComponent(operationId)}`,
    );
  }
}

/**
 * Mock som beter sig som API:t utan att röra ett fysiskt lås.
 * Operationen står som `pending` i två sekunder och blir sedan `completed`,
 * så att frontendens pollning kan testas på riktigt.
 */
class MockGlueClient implements GlueClient {
  private static readonly LOCK: GlueLock = {
    id: "mock-lock",
    serialNumber: "MOCK-0001",
    description: "Lokalen (simulerat lås)",
    firmwareVersion: "0.0.0-mock",
    batteryStatus: 87,
    connectionStatus: "connected",
    lastLockEvent: null,
  };

  async listLocks(): Promise<GlueLock[]> {
    return [MockGlueClient.LOCK];
  }

  async getLock(lockId: string): Promise<GlueLock> {
    return { ...MockGlueClient.LOCK, id: lockId };
  }

  async createOperation(_lockId: string, _type: GlueOperationType): Promise<GlueOperation> {
    // Tidsstämpeln bakas in i id:t så getOperation kan avgöra hur lång tid som gått.
    return { id: `mock-${Date.now()}`, status: "pending", reason: null };
  }

  async getOperation(_lockId: string, operationId: string): Promise<GlueOperation> {
    const startedAt = Number(operationId.replace("mock-", ""));
    const elapsed = Number.isFinite(startedAt) ? Date.now() - startedAt : Infinity;
    return {
      id: operationId,
      status: elapsed < 2000 ? "pending" : "completed",
      reason: null,
    };
  }
}

export function isMockMode(env: Env): boolean {
  return env.GLUE_MOCK === "1" || !env.GLUE_API_KEY;
}

export function createGlueClient(env: Env): GlueClient {
  if (isMockMode(env)) {
    console.warn("glue_mock_mode_active");
    return new MockGlueClient();
  }
  return new HttpGlueClient(env.GLUE_API_KEY!);
}

/**
 * Vilket lås ska låsas upp? GLUE_LOCK_ID om den är satt, annars det enda låset
 * på kontot. Finns flera lås utan att ett är valt vägrar vi hellre än att
 * gissa vilken dörr som ska öppnas.
 */
export async function resolveLockId(env: Env, client: GlueClient): Promise<string> {
  if (env.GLUE_LOCK_ID) return env.GLUE_LOCK_ID;

  const locks = await client.listLocks();
  if (locks.length === 0) {
    throw new AppError(503, "Inget lås är kopplat till Glue-kontot.", "no_locks");
  }
  if (locks.length > 1) {
    throw new AppError(
      503,
      "Flera lås finns på kontot. Sätt GLUE_LOCK_ID till rätt lås.",
      "ambiguous_lock",
    );
  }
  return locks[0]!.id;
}
