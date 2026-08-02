// Gitea webhook listener: on push to main, deploy the prod checkout.
//
// Runs as the rev-deploy systemd user service. Verifies the Gitea HMAC
// signature, then launches the deploy detached via `systemd-run --user` so it
// survives this listener being restarted (deploys restart this service too).
import http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const PORT = Number(process.env.REV_DEPLOY_PORT ?? 7374);
const SECRET = process.env.REV_WEBHOOK_SECRET;
const PROD_DIR = process.env.REV_PROD_DIR ?? path.join(homedir(), "tea/yolo/rev");
const LOCK_DIR = path.join(homedir(), ".local/share/rev");
const LOCK_FILE = path.join(LOCK_DIR, "deploy.lock");

if (!SECRET) {
  console.error("REV_WEBHOOK_SECRET is not set");
  process.exit(1);
}
mkdirSync(LOCK_DIR, { recursive: true });

function verify(body: Buffer, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", SECRET!).update(body).digest("hex");
  const got = Buffer.from(signature);
  const want = Buffer.from(expected);
  return got.length === want.length && timingSafeEqual(got, want);
}

function deploy() {
  // flock serializes concurrent pushes; each run resets to the latest
  // origin/main, so a queued run after a newer push is a no-op rebuild.
  const cmd = [
    `cd ${PROD_DIR}`,
    "git fetch origin main",
    "git reset --hard origin/main",
    "./scripts/deploy.sh",
  ].join(" && ");
  const child = spawn(
    "systemd-run",
    ["--user", "--collect", "flock", LOCK_FILE, "bash", "-c", cmd],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}

http
  .createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/hook") {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (!verify(body, req.headers["x-gitea-signature"] as string | undefined)) {
        console.error("rejected: bad signature");
        res.writeHead(403).end();
        return;
      }
      let ref: string | undefined;
      try {
        ref = JSON.parse(body.toString()).ref;
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (ref !== "refs/heads/main") {
        console.log(`ignored: ${ref}`);
        res.writeHead(200).end("ignored");
        return;
      }
      console.log("push to main — deploying");
      deploy();
      res.writeHead(202).end("deploying");
    });
  })
  .listen(PORT, "0.0.0.0", () => console.log(`rev-deploy listening on :${PORT}`));
