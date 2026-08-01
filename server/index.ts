/**
 * Entry point: Bun.serve hosting
 *  - /api/*  → routes.ts
 *  - /ws     → WebSocket (ClientMessage/ServerMessage protocol)
 *  - everything else → web/dist static files with SPA fallback (production);
 *    in dev, vite serves the frontend and proxies here.
 */

import type { ClientMessage, ServerMessage } from "@shared/types";
import { config } from "./config";

function main(): void {
  throw new Error("not implemented");
}

main();
