import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: {
    // Workern serverar den här katalogen som statiska filer (se wrangler.jsonc).
    outDir: "../dist/client",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // Under utveckling proxas API/auth till `wrangler dev` så cookies och
    // OAuth-redirects fungerar likadant som i produktion.
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/auth": "http://127.0.0.1:8787",
    },
  },
});
