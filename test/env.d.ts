import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import type { Env as AppEnv } from "../src/types";

/**
 * `env` från "cloudflare:test" är typad som `Cloudflare.Env`. Vi utökar den med
 * appens egna bindningar plus migrationerna som test/setup.ts kör.
 */
declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
