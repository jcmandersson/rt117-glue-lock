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
            // Simulerat lås — inga anrop mot Glue i testerna.
            GLUE_MOCK: "1",
            MEMBER_SOURCE: "admin",
            BOOTSTRAP_ADMIN_EMAILS: "chef@rt117.se",
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
