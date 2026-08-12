#!/usr/bin/env node
/**
 * Ser till att D1-databasen finns och att wrangler.jsonc pekar på den.
 *
 * Kör: node scripts/ensure-d1.mjs
 *
 * Databasens id är kontospecifikt och kan inte checkas in i förväg. I stället
 * slår vi upp det vid deploy: finns databasen används den, annars skapas den.
 * Sedan skrivs id:t in i wrangler.jsonc i arbetskopian — den ändringen är
 * avsedd att inte committas, den behövs bara för `wrangler deploy`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const DATABASE_NAME = "rt117-glue-lock";
const CONFIG_PATH = new URL("../wrangler.jsonc", import.meta.url);

function wrangler(args, { allowFailure = false } = {}) {
  const result = spawnSync("npx", ["wrangler", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0 && !allowFailure) {
    console.error(`wrangler ${args.join(" ")} misslyckades:`);
    console.error(result.stderr || result.stdout);
    process.exit(1);
  }

  return result;
}

/** Läser databaslistan och plockar ut id:t för vår databas, om den finns. */
function findDatabaseId() {
  const result = wrangler(["d1", "list", "--json"], { allowFailure: true });
  if (result.status !== 0) {
    console.error("Kunde inte lista D1-databaser. Är CLOUDFLARE_API_TOKEN giltig?");
    console.error(result.stderr || result.stdout);
    process.exit(1);
  }

  let databases;
  try {
    // Wrangler kan skriva loggrader före JSON-blocket.
    const start = result.stdout.indexOf("[");
    databases = JSON.parse(start === -1 ? result.stdout : result.stdout.slice(start));
  } catch {
    console.error("Kunde inte tolka svaret från `wrangler d1 list --json`:");
    console.error(result.stdout.slice(0, 500));
    process.exit(1);
  }

  const match = databases.find((database) => database.name === DATABASE_NAME);
  // Fältnamnet har hetat både uuid och database_id genom åren.
  return match ? (match.uuid ?? match.database_id ?? null) : null;
}

let databaseId = findDatabaseId();

if (databaseId) {
  console.log(`D1-databasen "${DATABASE_NAME}" finns redan.`);
} else {
  console.log(`Skapar D1-databasen "${DATABASE_NAME}"…`);
  wrangler(["d1", "create", DATABASE_NAME]);

  databaseId = findDatabaseId();
  if (!databaseId) {
    console.error("Databasen skapades men gick inte att hitta i listan efteråt.");
    process.exit(1);
  }
}

// Skriv in id:t i konfigurationen. Vi kräver exakt en träff, så en framtida
// ändring av filen inte tyst patchar fel rad.
const config = readFileSync(CONFIG_PATH, "utf8");
const occurrences = config.match(/"database_id"\s*:\s*"[^"]*"/g) ?? [];

if (occurrences.length !== 1) {
  console.error(
    `Förväntade exakt en "database_id" i wrangler.jsonc, hittade ${occurrences.length}.`,
  );
  process.exit(1);
}

const updated = config.replace(
  /"database_id"\s*:\s*"[^"]*"/,
  `"database_id": "${databaseId}"`,
);

if (updated !== config) {
  writeFileSync(CONFIG_PATH, updated);
  console.log(`wrangler.jsonc pekar nu på ${databaseId}.`);
} else {
  console.log(`wrangler.jsonc pekade redan på ${databaseId}.`);
}
