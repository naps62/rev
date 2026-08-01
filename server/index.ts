/**
 * Entry point: Bun.serve hosting
 *  - /api/*  → routes.ts
 *  - /ws     → WebSocket (ClientMessage/ServerMessage protocol)
 *  - everything else → web/dist static files with SPA fallback (production);
 *    in dev, vite serves the frontend and proxies here.
 */

import { existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { Hono } from "hono";
import type { ServerWebSocket } from "bun";
import type { ClientMessage, ServerMessage } from "@shared/types";
import { config } from "./config";
import { openDb } from "./db";
import { isKnownRepo, startDiscoveryTimer } from "./discovery";
import { buildApi } from "./routes";
import * as watcher from "./watcher";

interface WsData {
  dirs: Set<string>;
}

function main(): void {
  openDb();

  const sockets = new Set<ServerWebSocket<WsData>>();
  const broadcast = (msg: ServerMessage): void => {
    const json = JSON.stringify(msg);
    for (const ws of sockets) ws.send(json);
  };

  watcher.onRepoChange((dir, paths) => broadcast({ type: "diff-invalidated", dir, paths }));
  startDiscoveryTimer(() => broadcast({ type: "repos-changed" }));

  const app = new Hono().route("/api", buildApi(broadcast));

  const webDist = join(import.meta.dir, "..", "web", "dist");
  const hasDist = existsSync(join(webDist, "index.html"));

  const server = Bun.serve<WsData>({
    hostname: "0.0.0.0",
    port: config.port,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const upgraded = srv.upgrade(req, { data: { dirs: new Set<string>() } });
        return upgraded ? undefined : new Response("expected websocket upgrade", { status: 400 });
      }
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return app.fetch(req);
      if (hasDist && req.method === "GET") {
        const rel = normalize(decodeURIComponent(url.pathname));
        if (!rel.includes("..")) {
          const file = Bun.file(join(webDist, rel === "/" ? "index.html" : rel));
          if (await file.exists()) return new Response(file);
        }
        return new Response(Bun.file(join(webDist, "index.html"))); // SPA fallback
      }
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
      },
      async message(ws, raw) {
        let msg: ClientMessage;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (msg.type === "watch" && typeof msg.dir === "string") {
          if (ws.data.dirs.has(msg.dir)) return;
          if (!(await isKnownRepo(msg.dir))) return;
          ws.data.dirs.add(msg.dir);
          watcher.subscribe(msg.dir);
        } else if (msg.type === "unwatch" && typeof msg.dir === "string") {
          if (ws.data.dirs.delete(msg.dir)) watcher.unsubscribe(msg.dir);
        }
      },
      close(ws) {
        sockets.delete(ws);
        for (const dir of ws.data.dirs) watcher.unsubscribe(dir);
      },
    },
  });

  console.log(`rev listening on http://0.0.0.0:${server.port}`);
}

main();
