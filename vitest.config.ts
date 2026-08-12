import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            // Läses av test/setup.ts som kör migrationerna mot test-databasen.
            TEST_MIGRATIONS: migrations,

            // Fasta testvärden. Riktiga hemligheter hör inte hemma här.
            SESSION_SECRET: "test-session-secret-aaaaaaaaaaaaaaaa",
            OTP_PEPPER: "test-otp-pepper-bbbbbbbbbbbbbbbbbbbb",
            APP_URL: "http://localhost:8787",
            APP_NAME: "Testlokalen",
            MAIL_FROM: "test@example.invalid",
            // Simulerat lås, inga anrop mot Glue i testerna.
            GLUE_MOCK: "1",
            BOOTSTRAP_ADMIN_EMAILS: "chef@rt117.se",

            // Testerna får aldrig nå riktiga tjänster, även om .dev.vars har
            // nycklar. Tomma strängar räknas som avstängt i koden.
            RESEND_API_KEY: "",
            GOOGLE_CLIENT_ID: "",
            GOOGLE_CLIENT_SECRET: "",
            TURNSTILE_SITE_KEY: "",
            TURNSTILE_SECRET_KEY: "",
            GLUE_API_KEY: "",
            GLUE_LOCK_ID: "",
          },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/setup.ts"],
    },
  };
});
