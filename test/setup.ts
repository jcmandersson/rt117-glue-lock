import { applyD1Migrations, env } from "cloudflare:test";

// Kör schemat innan testerna. Skrivningar härifrån ligger utanför varje tests
// isolerade lagring, så alla tester startar från samma migrerade grundtillstånd.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
