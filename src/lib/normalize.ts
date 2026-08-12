/**
 * Normalisering av e-post och telefonnummer.
 *
 * Poängen är att samma person alltid hamnar på samma rad i medlemstabellen,
 * oavsett om admin skrev "Jonas@Example.com " eller "jonas@example.com", och
 * att jämförelsen mot Googles e-post blir förutsägbar.
 */

/** Avsiktligt tillåtande men förankrad: en @, inga blanksteg, punkt i domänen. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function normalizeEmail(input: string): string | null {
  const email = input.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) return null;
  if (email.length > 254) return null;
  return email;
}

/**
 * Normaliserar svenska nummer till E.164. Lämnar redan internationella
 * nummer i fred. Telefon används inte för inloggning i v1 men lagras så
 * att SMS-koder kan läggas på utan datamigrering.
 */
export function normalizePhone(input: string, defaultCountry = "46"): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const digits = trimmed.replace(/[\s\-().]/g, "");
  let national: string;

  if (digits.startsWith("+")) {
    national = digits.slice(1);
  } else if (digits.startsWith("00")) {
    national = digits.slice(2);
  } else if (digits.startsWith("0")) {
    national = defaultCountry + digits.slice(1);
  } else {
    // Antag att landskoden redan är med om numret är långt nog, annars lägg på.
    national = digits.length >= 11 ? digits : defaultCountry + digits;
  }

  if (!/^[1-9]\d{6,14}$/.test(national)) return null;
  return `+${national}`;
}

/** Delar upp en kommaseparerad miljövariabel till normaliserade e-postadresser. */
export function parseEmailList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => normalizeEmail(part))
    .filter((email): email is string => email !== null);
}
