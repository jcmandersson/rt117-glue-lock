#!/usr/bin/env node
/**
 * Synkar hemligheter från miljön (GitHub-secrets) till Workern.
 *
 * Kör: node scripts/sync-secrets.mjs
 *
 * Tanken är att du bara ska behöva mata in nycklarna på ett ställe, under
 * Settings → Secrets and variables → Actions i GitHub, och att deployen sköter
 * resten. Hemligheter som saknas eller är tomma hoppas över, så du kan lägga
 * till dem en och en utan att radera dem du redan satt.
 *
 * Värdena skickas via stdin och skrivs aldrig ut.
 */

import { spawnSync } from "node:child_process";

/** Namnen måste matcha Env i src/types.ts. */
const SECRETS = [
  // Obligatoriska för att inloggningen ska fungera alls.
  "SESSION_SECRET",
  "OTP_PEPPER",
  // Åtkomstlista som gör dig till admin i ett tomt system.
  "BOOTSTRAP_ADMIN_EMAILS",
  // Google-inloggning. Utan dessa döljs Google-knappen.
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  // E-post. Utan denna skickas inga engångskoder.
  "RESEND_API_KEY",
  // Glue. Utan denna körs ett simulerat lås.
  "GLUE_API_KEY",
  "GLUE_LOCK_ID",
  // Botskydd. Valfritt.
  "TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET_KEY",
];

const REQUIRED = ["SESSION_SECRET", "OTP_PEPPER"];

const set = [];
const skipped = [];
const failed = [];

for (const name of SECRETS) {
  const value = process.env[name];

  if (!value) {
    skipped.push(name);
    continue;
  }

  const result = spawnSync("npx", ["wrangler", "secret", "put", name], {
    input: value,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (result.status === 0) {
    set.push(name);
  } else {
    failed.push(name);
    // Bara felutskriften, aldrig värdet.
    console.error(`Kunde inte sätta ${name}:`);
    console.error((result.stderr || result.stdout || "").slice(0, 500));
  }
}

console.log(`Satta: ${set.join(", ") || "inga"}`);
console.log(`Hoppade över (saknas): ${skipped.join(", ") || "inga"}`);

const missingRequired = REQUIRED.filter((name) => !process.env[name]);
if (missingRequired.length > 0) {
  console.error("");
  console.error(`Saknar obligatoriska hemligheter: ${missingRequired.join(", ")}`);
  console.error("Ingen kan logga in utan dem. Lägg in dem som GitHub-secrets.");
  console.error("Generera värden med: npm run secrets:gen");
  process.exit(1);
}

if (failed.length > 0) {
  console.error("");
  console.error(`Misslyckades: ${failed.join(", ")}`);
  process.exit(1);
}
