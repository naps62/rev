/**
 * Entry point: node:http (via @hono/node-server) hosting
 *  - /api/*  → routes.ts
 *  - /ws     → WebSocket (ClientMessage/ServerMessage protocol)
 *  - everything else → web/dist static files with SPA fallback (production);
 *    in dev, vite serves the frontend and proxies here.
 */

import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "#shared/types";
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { isKnownRepo, startDiscoveryTimer } from "./discovery.ts";
import * as presence from "./presence.ts";
import { buildApi } from "./routes.ts";
import * as watcher from "./watcher.ts";

function main(): void {
  openDb();

  const socketDirs = new Map<WebSocket, Set<string>>();
  const broadcast = (msg: ServerMessage): void => {
    const json = JSON.stringify(msg);
    for (const ws of socketDirs.keys()) ws.send(json);
  };

  watcher.onRepoChange((dir, paths) => broadcast({ type: "diff-invalidated", dir, paths }));
  startDiscoveryTimer(() => broadcast({ type: "repos-changed" }));

  const app = new Hono().route("/api", buildApi(broadcast));
  app.notFound((c) => c.json({ error: "not found" }, 404));

  // checkout: server/index.ts → ../web/dist. Release: rev.js → ./web/dist.
  const webDist = [
    join(import.meta.dirname, "..", "web", "dist"),
    join(import.meta.dirname, "web", "dist"),
  ].find((p) => existsSync(join(p, "index.html")));
  if (webDist) {
    // serveStatic resolves root against cwd, not this file
    const root = relative(process.cwd(), webDist);
    app.get("*", serveStatic({ root }));
    app.get("*", serveStatic({ root, path: "index.html" })); // SPA fallback
  }

  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws) => {
    const dirs = new Set<string>();
    socketDirs.set(ws, dirs);
    // an 'error' with no listener would throw and take the process down
    ws.on("error", () => {});
    ws.on("message", async (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === "watch" && typeof msg.dir === "string") {
        if (dirs.has(msg.dir)) return;
        if (!(await isKnownRepo(msg.dir))) return;
        dirs.add(msg.dir);
        watcher.subscribe(msg.dir);
        presence.enter(msg.dir);
      } else if (msg.type === "unwatch" && typeof msg.dir === "string") {
        if (dirs.delete(msg.dir)) {
          watcher.unsubscribe(msg.dir);
          presence.leave(msg.dir);
        }
      }
    });
    ws.on("close", () => {
      socketDirs.delete(ws);
      for (const dir of dirs) {
        watcher.unsubscribe(dir);
        presence.leave(dir);
      }
    });
  });

  console.log(`rev listening on http://${config.host}:${config.port}`);
}

main();
