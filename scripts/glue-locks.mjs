#!/usr/bin/env node
/**
 * Listar låsen på Glue-kontot, så du kan välja vilket id som ska låsas upp.
 *
 * Kör: GLUE_API_KEY=... npm run glue:locks
 */

const apiKey = process.env.GLUE_API_KEY ?? process.argv[2];

if (!apiKey) {
  console.error("Sätt GLUE_API_KEY (miljövariabel eller första argumentet).");
  console.error("Har du ingen nyckel? Kör: npm run glue:api-key");
  process.exit(1);
}

const response = await fetch("https://user-api.gluehome.com/v1/locks", {
  headers: {
    Authorization: `Api-Key ${apiKey}`,
    Accept: "application/json",
    "User-Agent": "rt117-glue-lock/0.1",
  },
});

if (!response.ok) {
  console.error(`Glue svarade ${response.status}:`);
  console.error((await response.text()).slice(0, 1000));
  process.exit(1);
}

const locks = await response.json();

if (!Array.isArray(locks) || locks.length === 0) {
  console.log("Inga lås hittades på kontot.");
  process.exit(0);
}

for (const lock of locks) {
  console.log("");
  console.log(`  ${lock.description || "(utan namn)"}`);
  console.log(`  id            ${lock.id}`);
  console.log(`  serienummer   ${lock.serialNumber}`);
  console.log(`  batteri       ${lock.batteryStatus}%`);
  console.log(`  uppkoppling   ${lock.connectionStatus}`);
  if (lock.lastLockEvent) {
    console.log(`  senast        ${lock.lastLockEvent.eventType} @ ${lock.lastLockEvent.eventTime}`);
  }
}

console.log("");
if (locks.length === 1) {
  console.log("Ett lås — GLUE_LOCK_ID behöver inte sättas, men går bra att låsa fast:");
  console.log(`  npx wrangler secret put GLUE_LOCK_ID   # ${locks[0].id}`);
} else {
  console.log("Flera lås — sätt GLUE_LOCK_ID till rätt id:");
  console.log("  npx wrangler secret put GLUE_LOCK_ID");
}
