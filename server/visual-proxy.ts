/**
 * Visual-review sessions per the VisualSession contract in shared/types.ts:
 * one injecting reverse proxy per target URL, each owning a port from
 * TUNING.VISUAL_PROXY_PORTS. Everything is forwarded to the target origin;
 * only text/html responses are rewritten (overlay <script> injected,
 * CSP / X-Frame-Options stripped so the dashboard can frame the page).
 * Targets are restricted to loopback/private addresses — the daemon is
 * LAN-trusted and must not be an open proxy.
 */

import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFile, stat } from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from "node:https";
import { connect as netConnect, isIP } from "node:net";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import { fileURLToPath } from "node:url";
import type { VisualSession } from "#shared/types";
import { TUNING } from "#shared/tuning";
import { config } from "./config.ts";

/** Session-manager failure the route maps to its status (400 bad target, 409 exhausted). */
export class VisualError extends Error {
  readonly status: 400 | 409;
  constructor(message: string, status: 400 | 409 = 400) {
    super(message);
    this.name = "VisualError";
    this.status = status;
  }
}

/** True for loopback/private addresses: 127/8, ::1, 10/8, 172.16/12, 192.168/16, fc00::/7, fe80::/10 (and their IPv4-mapped forms). */
export function isPrivateAddress(ip: string): boolean {
  const bare = ip.split("%")[0]!; // strip zone id (fe80::1%eth0)
  const kind = isIP(bare);
  if (kind === 4) return isPrivateV4(bare);
  if (kind !== 6) return false;
  const lower = bare.toLowerCase();
  if (lower === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPrivateV4(mapped[1]!);
  const first = lower.startsWith("::") ? 0 : Number.parseInt(lower.split(":")[0]!, 16);
  if (Number.isNaN(first)) return false;
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

function isPrivateV4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts as [number, number];
  if (a === 127 || a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return a === 192 && b === 168;
}

const OVERLAY_TAG = '<script src="/__rev-overlay.js"></script>';

/** Inject the overlay tag right after <head>, else before </body>, else append. */
export function injectOverlay(html: string): string {
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + OVERLAY_TAG + html.slice(at);
  }
  const body = /<\/body>/i.exec(html);
  if (body) return html.slice(0, body.index) + OVERLAY_TAG + html.slice(body.index);
  return html + OVERLAY_TAG;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

interface Session {
  info: VisualSession;
  /** Normalized target URL (the sessions-map key). */
  key: string;
  target: URL;
  /** target hostname without IPv6 brackets. */
  targetHostname: string;
  targetPort: number;
  /** IP resolved at creation; connections go here, not through DNS again (rebinding guard). */
  address: string;
  idleMs: number;
  lastActivity: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  server: Server;
  upgradeSockets: Set<Duplex>;
  closed: boolean;
}

const sessions = new Map<string, Session>();
const byPort = new Map<number, Session>();
const pending = new Map<string, Promise<VisualSession>>();

function portRange(): [number, number] {
  const env = process.env.REV_VISUAL_PORTS;
  if (env) {
    const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(env);
    if (m) {
      const lo = Number(m[1]);
      const hi = Number(m[2]);
      if (lo >= 1 && hi >= lo && hi <= 65535) return [lo, hi];
    }
  }
  return [TUNING.VISUAL_PROXY_PORTS[0], TUNING.VISUAL_PROXY_PORTS[1]];
}

/**
 * Start (or return, keyed by normalized URL) the injecting proxy for `url`.
 * Re-requesting a live session refreshes its idle deadline. `idleMs` only
 * applies to newly created sessions (tests use short values).
 */
export async function getOrCreateSession(
  url: string,
  opts: { idleMs?: number } = {},
): Promise<VisualSession> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new VisualError(`invalid url: ${url}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new VisualError(`only http/https targets are supported: ${url}`);
  }
  const key = u.href;
  const existing = sessions.get(key);
  if (existing) {
    touch(existing);
    return existing.info;
  }
  const inflight = pending.get(key);
  if (inflight) return inflight;
  const created = createSession(u, key, opts.idleMs ?? TUNING.VISUAL_SESSION_IDLE_MS).finally(() =>
    pending.delete(key),
  );
  pending.set(key, created);
  return created;
}

export async function closeAllSessions(): Promise<void> {
  await Promise.all([...sessions.values()].map(destroySession));
}

async function createSession(u: URL, key: string, idleMs: number): Promise<VisualSession> {
  const targetHostname = u.hostname.replace(/^\[|\]$/g, "");
  const address = await resolveTarget(targetHostname);
  const session: Session = {
    info: { id: randomUUID(), targetUrl: key, port: 0, expiresAt: 0 },
    key,
    target: u,
    targetHostname,
    targetPort: Number(u.port) || (u.protocol === "https:" ? 443 : 80),
    address,
    idleMs,
    lastActivity: Date.now(),
    timer: undefined,
    server: undefined as unknown as Server,
    upgradeSockets: new Set(),
    closed: false,
  };
  session.server = createServer((req, res) => {
    touch(session);
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/__rev-overlay.js") {
      void serveOverlay(res);
      return;
    }
    proxyRequest(session, req, res);
  });
  session.server.on("upgrade", (req, socket, head) => proxyUpgrade(session, req, socket, head));
  try {
    session.info.port = await allocatePort(session.server);
  } catch (err) {
    session.server.close(() => {});
    throw err;
  }
  sessions.set(key, session);
  byPort.set(session.info.port, session);
  touch(session);
  return session.info;
}

/** Resolve + guard the target host. Returns the IP every connection will use. */
async function resolveTarget(hostname: string): Promise<string> {
  if (isIP(hostname)) {
    if (!isPrivateAddress(hostname)) {
      throw new VisualError(`target address is not loopback/private: ${hostname}`);
    }
    return hostname;
  }
  let address: string;
  try {
    ({ address } = await lookup(hostname));
  } catch {
    throw new VisualError(`cannot resolve target host: ${hostname}`);
  }
  if (!isPrivateAddress(address)) {
    throw new VisualError(`target resolves to a non-private address: ${hostname} → ${address}`);
  }
  return address;
}

/** Bind `server` to the next free port in the range, evicting the oldest-idle session when full. */
async function allocatePort(server: Server): Promise<number> {
  const [lo, hi] = portRange();
  for (let port = lo; port <= hi; port++) {
    if (byPort.has(port)) continue;
    if (await listenOn(server, port)) return port;
  }
  let oldest: Session | undefined;
  for (const s of sessions.values()) {
    if (s.info.port >= lo && s.info.port <= hi && (!oldest || s.lastActivity < oldest.lastActivity)) {
      oldest = s;
    }
  }
  if (oldest) {
    const port = oldest.info.port;
    await destroySession(oldest);
    if (await listenOn(server, port)) return port;
  }
  throw new VisualError(`no free visual-proxy port in ${lo}-${hi}`, 409);
}

/** listen() resolving false on EADDRINUSE (port taken by someone outside our maps). */
function listenOn(server: Server, port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      if (err.code === "EADDRINUSE" || err.code === "EACCES") resolve(false);
      else reject(err);
    };
    server.once("error", onError);
    server.listen(port, config.host, () => {
      server.removeListener("error", onError);
      resolve(true);
    });
  });
}

function touch(s: Session): void {
  if (s.closed) return;
  s.lastActivity = Date.now();
  s.info.expiresAt = s.lastActivity + s.idleMs;
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => void destroySession(s), s.idleMs);
  s.timer.unref();
}

function destroySession(s: Session): Promise<void> {
  if (s.closed) return Promise.resolve();
  s.closed = true;
  if (s.timer) clearTimeout(s.timer);
  sessions.delete(s.key);
  byPort.delete(s.info.port);
  for (const sock of s.upgradeSockets) sock.destroy();
  s.upgradeSockets.clear();
  return new Promise((resolve) => {
    s.server.close(() => resolve());
    s.server.closeAllConnections();
  });
}

// --- overlay script ---------------------------------------------------------

const OVERLAY_PATH = join(dirname(fileURLToPath(import.meta.url)), "overlay.js");
let overlayCache: { mtimeMs: number; body: Buffer } | null = null;

/** mtime-checked cache: the overlay is iterated on while the daemon runs. */
async function readOverlay(): Promise<Buffer> {
  const st = await stat(OVERLAY_PATH);
  if (!overlayCache || overlayCache.mtimeMs !== st.mtimeMs) {
    overlayCache = { mtimeMs: st.mtimeMs, body: await readFile(OVERLAY_PATH) };
  }
  return overlayCache.body;
}

async function serveOverlay(res: ServerResponse): Promise<void> {
  try {
    const body = await readOverlay();
    res.writeHead(200, {
      "cache-control": "no-store",
      "content-length": body.byteLength,
      "content-type": "text/javascript",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("rev visual proxy: overlay script not found");
  }
}

// --- forwarding -------------------------------------------------------------

function forwardHeaders(req: IncomingMessage, targetHost: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    out[name] = value;
  }
  out.host = targetHost;
  out["accept-encoding"] = "identity"; // HTML must arrive uncompressed for injection
  return out;
}

function responseHeaders(ures: IncomingMessage, html: boolean): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(ures.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    if (
      html &&
      (name === "content-security-policy" ||
        name === "content-security-policy-report-only" ||
        name === "x-frame-options" ||
        name === "content-length")
    ) {
      continue;
    }
    out[name] = value;
  }
  return out;
}

function proxyRequest(s: Session, req: IncomingMessage, res: ServerResponse): void {
  const https = s.target.protocol === "https:";
  const options: HttpsRequestOptions = {
    host: s.address,
    port: s.targetPort,
    method: req.method,
    path: req.url,
    headers: forwardHeaders(req, s.target.host),
  };
  if (https) {
    if (!isIP(s.targetHostname)) options.servername = s.targetHostname;
    options.rejectUnauthorized = false; // dev servers self-sign; targets are private-only anyway
  }
  const upstream = (https ? httpsRequest : httpRequest)(options, (ures) => {
    const status = ures.statusCode ?? 502;
    const contentType = String(ures.headers["content-type"] ?? "").toLowerCase();
    if (contentType.includes("text/html")) {
      const chunks: Buffer[] = [];
      ures.on("data", (chunk: Buffer) => chunks.push(chunk));
      ures.on("error", () => res.destroy());
      ures.on("end", () => {
        const body = Buffer.from(injectOverlay(Buffer.concat(chunks).toString("utf8")), "utf8");
        const headers = responseHeaders(ures, true);
        headers["content-length"] = String(body.byteLength);
        res.writeHead(status, headers);
        res.end(body);
      });
    } else {
      res.writeHead(status, responseHeaders(ures, false));
      ures.pipe(res);
    }
  });
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(`rev visual proxy: target unreachable (${s.info.targetUrl})`);
  });
  req.pipe(upstream);
}

/** Raw socket pipe for websocket upgrades (vite HMR). */
function proxyUpgrade(s: Session, req: IncomingMessage, socket: Duplex, head: Buffer): void {
  touch(s);
  const https = s.target.protocol === "https:";
  const onConnect = (): void => {
    const lines = [`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1`];
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i]!;
      const value = name.toLowerCase() === "host" ? s.target.host : req.rawHeaders[i + 1]!;
      lines.push(`${name}: ${value}`);
    }
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head.byteLength > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  };
  const upstream = https
    ? tlsConnect(
        {
          host: s.address,
          port: s.targetPort,
          ...(isIP(s.targetHostname) ? {} : { servername: s.targetHostname }),
          rejectUnauthorized: false,
        },
        onConnect,
      )
    : netConnect({ host: s.address, port: s.targetPort }, onConnect);
  s.upgradeSockets.add(socket);
  s.upgradeSockets.add(upstream);
  const drop = (): void => {
    s.upgradeSockets.delete(socket);
    s.upgradeSockets.delete(upstream);
    socket.destroy();
    upstream.destroy();
  };
  upstream.on("error", drop);
  upstream.on("close", drop);
  socket.on("error", drop);
  socket.on("close", drop);
  socket.on("data", () => touch(s));
  upstream.on("data", () => touch(s));
}
