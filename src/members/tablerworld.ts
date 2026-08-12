import type { Env } from "../types";
import type { MemberSource, UpstreamMember } from "./source";
import { AppError } from "../lib/http";

/**
 * tabler.world-koppling (Round Table Internationals medlemsregister).
 *
 * VERIFIERA INNAN DU SLÅR PÅ DEN HÄR. Bas-URL och att autentiseringen sker med
 * en API-token i Authorization-headern är bekräftat, men det exakta
 * ändpunktsnamnet för "medlemmar i en klubb" och fältnamnen i svaret är
 * [verify] — de står i dokumentationen på https://developer.roundtable.world/
 * som inte gick att nå härifrån. Därför är sökvägen konfigurerbar och
 * fältmappningen tolerant, och `MEMBER_SOURCE` är 'admin' som standard.
 *
 * Praktiska förbehåll:
 *  - Token av typen `global_auth_token` krävs för andra endpoints än ens egen
 *    profil, och den beviljas av OVF/RTI. Det är inte något som går att ordna
 *    från koden.
 *  - Att hämta hem brödernas e-post och telefonnummer är behandling av
 *    personuppgifter. Rättslig grund och lagringstid behöver ägargranskas
 *    (GDPR) innan detta slås på i skarpt läge.
 */

const DEFAULT_BASE_URL = "https://api.roundtable.world/v1/app";

/** Plockar första fältet som finns, så mappningen tål olika fältnamn. */
function pick(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return null;
}

function mapMember(record: Record<string, unknown>, fallbackClub: string): UpstreamMember {
  const first = pick(record, ["firstname", "firstName", "first_name", "givenName"]);
  const last = pick(record, ["lastname", "lastName", "last_name", "familyName"]);
  const fullName = pick(record, ["name", "fullName", "full_name", "displayName"]);

  return {
    externalId: pick(record, ["id", "memberId", "member_id", "uuid"]) ?? "",
    email: pick(record, ["email", "emailAddress", "email_address", "primaryEmail"]),
    phone: pick(record, ["phone", "phoneNumber", "phone_number", "mobile", "cellphone"]),
    name: fullName ?? ([first, last].filter(Boolean).join(" ") || null),
    club: pick(record, ["club", "clubName", "club_name", "table"]) ?? fallbackClub,
  };
}

/** Hittar medlemslistan oavsett om svaret är en array eller ett paginerat objekt. */
function extractList(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  if (payload && typeof payload === "object") {
    for (const key of ["results", "members", "data", "items"]) {
      const value = (payload as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value as Record<string, unknown>[];
    }
  }
  return [];
}

export class TablerWorldSource implements MemberSource {
  readonly kind = "tablerworld" as const;

  private readonly token: string;
  private readonly baseUrl: string;
  private readonly authScheme: string;
  private readonly pathTemplate: string;
  private readonly clubIds: string[];

  constructor(env: Env) {
    if (!env.TABLERWORLD_TOKEN) {
      throw new AppError(
        503,
        "tabler.world är inte konfigurerat (TABLERWORLD_TOKEN saknas).",
        "tablerworld_not_configured",
      );
    }
    this.token = env.TABLERWORLD_TOKEN;
    this.baseUrl = (env.TABLERWORLD_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.authScheme = env.TABLERWORLD_AUTH_SCHEME ?? "Bearer";
    this.pathTemplate = env.TABLERWORLD_MEMBERS_PATH ?? "/clubs/{clubId}/members";
    this.clubIds = (env.TABLERWORLD_CLUB_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);

    if (this.clubIds.length === 0) {
      throw new AppError(
        503,
        "Inga klubbar angivna (TABLERWORLD_CLUB_IDS saknas) — ange id för RT117 och RT36.",
        "tablerworld_no_clubs",
      );
    }
  }

  private url(clubId: string): string {
    const path = this.pathTemplate.replace("{clubId}", encodeURIComponent(clubId));
    return `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  }

  private async request(clubId: string): Promise<unknown> {
    const response = await fetch(this.url(clubId), {
      headers: {
        Authorization: `${this.authScheme} ${this.token}`.trim(),
        Accept: "application/json",
      },
    });

    if (response.status === 429) {
      throw new AppError(
        429,
        "tabler.world begränsade anropen (100/minut). Försök igen om en stund.",
        "tablerworld_rate_limited",
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error("tablerworld_failed", clubId, response.status, body.slice(0, 500));
      throw new AppError(
        502,
        `tabler.world svarade ${response.status}. Kontrollera token och sökväg.`,
        "tablerworld_failed",
      );
    }

    return response.json();
  }

  async fetchAll(): Promise<UpstreamMember[]> {
    const members: UpstreamMember[] = [];
    for (const clubId of this.clubIds) {
      const payload = await this.request(clubId);
      for (const record of extractList(payload)) {
        const mapped = mapMember(record, clubId);
        if (mapped.externalId) members.push(mapped);
      }
    }
    return members;
  }

  /**
   * Testanrop för admin-gränssnittet: visar hur många rader vi hittar och vilka
   * fältnamn första raden har, så sökvägen och mappningen kan verifieras utan
   * att skriva något till databasen.
   */
  async probe(): Promise<{ clubId: string; url: string; count: number; sampleKeys: string[] }[]> {
    const report = [];
    for (const clubId of this.clubIds) {
      const payload = await this.request(clubId);
      const list = extractList(payload);
      report.push({
        clubId,
        url: this.url(clubId),
        count: list.length,
        sampleKeys: list[0] ? Object.keys(list[0]).slice(0, 40) : [],
      });
    }
    return report;
  }
}
