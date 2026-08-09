import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.ts";
import { buildApi } from "./routes.ts";
import {
  closeAllSessions,
  getOrCreateSession,
  injectOverlay,
  isPrivateAddress,
  VisualError,
} from "./visual-proxy.ts";

// The proxy binds config.host; connect via loopback when that's a wildcard.
const clientHost = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body><main>hello</main></body></html>';
const CSS_BYTES = Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256));

function appHandler(req: IncomingMessage, res: ServerResponse): void {
  if (req.url?.startsWith("/style.css")) {
    res.writeHead(200, { "content-type": "text/css", "content-length": CSS_BYTES.byteLength });
    res.end(CSS_BYTES);
    return;
  }
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "default-src 'self'",
    "content-security-policy-report-only": "default-src 'self'",
    "x-frame-options": "DENY",
  });
  res.end(HTML);
}

const targets: Server[] = [];

function startTarget(
  handler: (req: IncomingMessage, res: ServerResponse) => void = appHandler,
): Promise<{ server: Server; port: number; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    targets.push(server);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, port, url: `http://127.0.0.1:${port}/` });
    });
  });
}

afterEach(async () => {
  delete process.env.REV_VISUAL_PORTS;
  await closeAllSessions();
  await Promise.all(
    targets.splice(0).map(
      (s) =>
        new Promise<void>((r) => {
          s.close(() => r());
          s.closeAllConnections();
        }),
    ),
  );
});

test("isPrivateAddress accepts loopback/private, rejects public", () => {
  for (const ip of [
    "127.0.0.1",
    "127.255.255.255",
    "10.0.0.1",
    "192.168.1.5",
    "172.16.0.1",
    "172.31.255.255",
    "::1",
    "fd12:3456::1",
    "fe80::1",
    "fe80::1%eth0",
    "::ffff:10.0.0.1",
  ]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of [
    "8.8.8.8",
    "1.1.1.1",
    "172.32.0.1",
    "172.15.0.1",
    "11.0.0.1",
    "2001:db8::1",
    "::ffff:8.8.8.8",
    "example.com",
    "",
  ]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test("injectOverlay: after <head>, else before </body>, else appended", () => {
  const tag = '<script src="/__rev-overlay.js"></script>';
  assert.equal(
    injectOverlay('<html><head lang="en"><title>x</title></head></html>'),
    `<html><head lang="en">${tag}<title>x</title></head></html>`,
  );
  // <header> must not be mistaken for <head>
  assert.equal(
    injectOverlay("<html><header>x</header><p>y</p></body></html>"),
    `<html><header>x</header><p>y</p>${tag}</body></html>`,
  );
  assert.equal(injectOverlay("plain"), `plain${tag}`);
});

test("proxies HTML with overlay injected and framing headers stripped; assets pass through byte-identical", async () => {
  process.env.REV_VISUAL_PORTS = "27460-27463";
  const target = await startTarget();
  const session = await getOrCreateSession(target.url);
  assert.ok(session.port >= 27460 && session.port <= 27463);
  assert.equal(session.targetUrl, target.url);
  assert.ok(session.expiresAt > Date.now());

  const res = await fetch(`http://${clientHost}:${session.port}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<head[^>]*><script src="\/__rev-overlay\.js"><\/script>/);
  assert.equal(res.headers.get("content-security-policy"), null);
  assert.equal(res.headers.get("content-security-policy-report-only"), null);
  assert.equal(res.headers.get("x-frame-options"), null);
  assert.equal(Number(res.headers.get("content-length")), Buffer.byteLength(html));

  const css = await fetch(`http://${clientHost}:${session.port}/style.css`);
  assert.equal(css.status, 200);
  assert.equal(css.headers.get("content-type"), "text/css");
  assert.deepEqual(Buffer.from(await css.arrayBuffer()), CSS_BYTES);
});

test("session reuse: same URL → same session; different URL → different port", async () => {
  process.env.REV_VISUAL_PORTS = "27460-27463";
  const a = await startTarget();
  const b = await startTarget();
  const s1 = await getOrCreateSession(a.url);
  const firstDeadline = s1.expiresAt;
  await sleep(30);
  const s2 = await getOrCreateSession(a.url);
  assert.equal(s2.id, s1.id);
  assert.equal(s2.port, s1.port);
  assert.ok(s2.expiresAt > firstDeadline, "re-request refreshes the idle deadline");
  // URL normalization: origin without trailing slash keys the same session
  const s3 = await getOrCreateSession(a.url.slice(0, -1));
  assert.equal(s3.id, s1.id);
  const s4 = await getOrCreateSession(b.url);
  assert.notEqual(s4.port, s1.port);
});

test("rejects public, non-http, malformed, and unresolvable targets", async () => {
  const rejects400 = (e: unknown) => e instanceof VisualError && e.status === 400;
  await assert.rejects(getOrCreateSession("http://8.8.8.8/"), rejects400);
  await assert.rejects(getOrCreateSession("ftp://127.0.0.1/"), rejects400);
  await assert.rejects(getOrCreateSession("not a url"), rejects400);
  await assert.rejects(getOrCreateSession("http://nope.invalid/"), rejects400);
});

const overlayPath = join(dirname(fileURLToPath(import.meta.url)), "overlay.js");

test(
  "GET /__rev-overlay.js serves the on-disk server/overlay.js",
  { skip: !existsSync(overlayPath) && "server/overlay.js not on disk yet (owned by the overlay agent)" },
  async () => {
    process.env.REV_VISUAL_PORTS = "27460-27463";
    const target = await startTarget();
    const session = await getOrCreateSession(target.url);
    const res = await fetch(`http://${clientHost}:${session.port}/__rev-overlay.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/javascript/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(await res.text(), readFileSync(overlayPath, "utf8"));
  },
);

test("idle expiry with a short override: after expiry the port refuses connections", async () => {
  process.env.REV_VISUAL_PORTS = "27464-27464";
  const target = await startTarget();
  const session = await getOrCreateSession(target.url, { idleMs: 150 });
  const url = `http://${clientHost}:${session.port}/`;
  const res = await fetch(url);
  assert.equal(res.status, 200);
  await res.text(); // release the connection so only the idle timer holds the server
  await sleep(800); // generous slack: this machine's event loop stalls under load
  await assert.rejects(fetch(url));
});

test("port exhaustion evicts the oldest-idle session", async () => {
  process.env.REV_VISUAL_PORTS = "27465-27465";
  const a = await startTarget();
  const b = await startTarget((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("target-b");
  });
  const sa = await getOrCreateSession(a.url);
  const sb = await getOrCreateSession(b.url);
  assert.equal(sb.port, sa.port);
  const res = await fetch(`http://${clientHost}:${sb.port}/x`);
  assert.equal(await res.text(), "target-b");
});

test("exhausted range with nothing to evict → VisualError 409", async () => {
  process.env.REV_VISUAL_PORTS = "27466-27466";
  const blocker = createServer(() => {});
  targets.push(blocker);
  await new Promise<void>((r) => blocker.listen(27466, config.host, r));
  await assert.rejects(
    getOrCreateSession("http://127.0.0.1:1/"),
    (e: unknown) => e instanceof VisualError && e.status === 409,
  );
});

test("dead target → 502 plain text, not a crash", async () => {
  process.env.REV_VISUAL_PORTS = "27467-27467";
  const target = await startTarget();
  const session = await getOrCreateSession(target.url);
  await new Promise<void>((r) => target.server.close(() => r()));
  const res = await fetch(`http://${clientHost}:${session.port}/`);
  assert.equal(res.status, 502);
  assert.match(await res.text(), /target unreachable/);
});

test("POST /visual/sessions: 400 on bad body/target, 409 on exhaustion, else VisualSession", async () => {
  process.env.REV_VISUAL_PORTS = "27468-27468";
  const app = buildApi(() => {});
  const post = (body: unknown) =>
    app.request("/visual/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  assert.equal((await post({})).status, 400);
  assert.equal((await post({ url: 42 })).status, 400);
  assert.equal((await post({ url: "http://8.8.8.8/" })).status, 400);

  const target = await startTarget();
  const ok = await post({ url: target.url });
  assert.equal(ok.status, 200);
  const session = (await ok.json()) as { id: string; targetUrl: string; port: number; expiresAt: number };
  assert.equal(session.targetUrl, target.url);
  assert.equal(session.port, 27468);
  assert.ok(session.id.length > 0);
  assert.ok(session.expiresAt > Date.now());

  await closeAllSessions();
  const blocker = createServer(() => {});
  targets.push(blocker);
  await new Promise<void>((r) => blocker.listen(27468, config.host, r));
  const full = await post({ url: target.url });
  assert.equal(full.status, 409);
});
