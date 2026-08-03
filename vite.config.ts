import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Defaults kept in sync with shared/tuning.ts by hand: importing it here would
// drag the #shared subpath resolution into vite's config load. Same
// ~/.config/rev/env the server reads, so dev matches the service.
const envFile = join(homedir(), ".config", "rev", "env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const port = Number(process.env.REV_PORT ?? 7373);
const host = process.env.REV_HOST ?? "127.0.0.1";

export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "#shared": fileURLToPath(new URL("./shared", import.meta.url)),
    },
  },
  server: {
    host,
    port: 5173,
    proxy: {
      "/api": `http://localhost:${port}`,
      "/ws": { target: `ws://localhost:${port}`, ws: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
