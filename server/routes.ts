/**
 * REST routes per the contract at the bottom of shared/types.ts.
 * Pure HTTP glue: validation + composition of git/db/discovery. Every dir
 * param must pass discovery.isKnownRepo before any git call — the server
 * runs unauthenticated on the LAN and must not run git against arbitrary
 * attacker-supplied paths outside real checkouts.
 *
 * Addition to the documented surface: GET /api/health → { ok, version },
 * for systemd liveness checks and the web dev proxy.
 */

import { Hono } from "hono";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import type {
  CommentCreateRequest,
  CommentListResponse,
  CommentPatchRequest,
  FileWriteRequest,
  SeenRequest,
  ServerMessage,
} from "@shared/types";
import { TUNING } from "@shared/tuning";
import {
  createComment,
  DbError,
  listComments,
  patchComment,
  seenHashes,
  setSeen,
} from "./db";
import { isKnownRepo, listRepos, rescan } from "./discovery";
import { computeDiff, GitError, hashContent, readFile } from "./git";

/**
 * Resolve a repo-relative path inside `dir`, or null when it escapes
 * (absolute, ..-traversal, or a symlink pointing outside the repo).
 */
export function resolveInRepo(dir: string, rel: string): string | null {
  if (!rel || isAbsolute(rel) || rel.includes("\0")) return null;
  let realDir: string;
  try {
    realDir = realpathSync(dir);
  } catch {
    return null;
  }
  const target = resolve(realDir, rel);
  if (target !== realDir && !target.startsWith(realDir + sep)) return null;
  // symlink escape: realpath the nearest existing ancestor of the target
  let probe = target;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return null;
    probe = parent;
  }
  let realProbe: string;
  try {
    realProbe = realpathSync(probe);
  } catch {
    return null;
  }
  if (realProbe !== realDir && !realProbe.startsWith(realDir + sep)) return null;
  return target;
}

interface Waiter {
  dir: string;
  base?: string;
  since: number;
  resolve: (r: CommentListResponse) => void;
}

/** Build the /api sub-app. `broadcast` sends a ServerMessage to all WS clients. */
export function buildApi(broadcast: (msg: ServerMessage) => void): Hono {
  const app = new Hono();
  const waiters = new Set<Waiter>();

  function notifyWaiters(dir: string): void {
    for (const w of [...waiters]) {
      if (w.dir !== dir) continue;
      const res = listComments(w.dir, w.base, w.since);
      if (res.comments.length > 0) w.resolve(res);
    }
  }

  function waitForComments(dir: string, base: string | undefined, since: number): Promise<CommentListResponse> {
    return new Promise((resolvePromise) => {
      const w: Waiter = {
        dir,
        base,
        since,
        resolve: (r) => {
          waiters.delete(w);
          clearTimeout(timer);
          resolvePromise(r);
        },
      };
      const timer = setTimeout(() => w.resolve(listComments(dir, base, since)), TUNING.LONG_POLL_MS);
      waiters.add(w);
    });
  }

  app.onError((err, c) => {
    if (err instanceof GitError) return c.json({ error: err.message }, 400);
    if (err instanceof DbError) return c.json({ error: err.message }, 400);
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true, version: "spike" }));

  app.get("/repos", async (c) => c.json(await listRepos()));

  app.post("/repos/rescan", async (c) => {
    const repos = await rescan();
    broadcast({ type: "repos-changed" });
    return c.json(repos);
  });

  app.get("/diff", async (c) => {
    const dir = c.req.query("dir");
    const base = c.req.query("base");
    if (!dir || !base) return c.json({ error: "dir and base are required" }, 400);
    if (!(await isKnownRepo(dir))) return c.json({ error: `not a known repo: ${dir}` }, 400);
    const diff = await computeDiff(dir, base);
    const seen = seenHashes(dir, base);
    for (const f of diff.files) {
      const h = seen.get(f.path);
      if (h === undefined) continue;
      f.seen = h === f.contentHash;
      f.stale = !f.seen;
    }
    return c.json(diff);
  });

  app.get("/file", async (c) => {
    const dir = c.req.query("dir");
    const path = c.req.query("path");
    const rev = c.req.query("rev") ?? null;
    if (!dir || !path) return c.json({ error: "dir and path are required" }, 400);
    if (!(await isKnownRepo(dir))) return c.json({ error: `not a known repo: ${dir}` }, 400);
    if (resolveInRepo(dir, path) === null) return c.json({ error: `path escapes repo: ${path}` }, 400);
    return c.json(await readFile(dir, path, rev));
  });

  app.put("/file", async (c) => {
    const body = (await c.req.json().catch(() => null)) as FileWriteRequest | null;
    if (
      !body ||
      typeof body.dir !== "string" ||
      typeof body.path !== "string" ||
      typeof body.content !== "string" ||
      typeof body.baseHash !== "string"
    ) {
      return c.json({ error: "dir, path, content, baseHash are required" }, 400);
    }
    if (!(await isKnownRepo(body.dir))) return c.json({ error: `not a known repo: ${body.dir}` }, 400);
    const target = resolveInRepo(body.dir, body.path);
    if (target === null) return c.json({ error: `path escapes repo: ${body.path}` }, 400);
    const file = Bun.file(target);
    const currentHash = (await file.exists()) ? hashContent(await file.bytes()) : "";
    if (currentHash !== body.baseHash) {
      return c.json({ error: `baseHash mismatch: file is at ${currentHash || "(missing)"}` }, 409);
    }
    await Bun.write(target, body.content);
    return c.json({
      dir: body.dir,
      path: body.path,
      rev: null,
      content: body.content,
      contentHash: hashContent(body.content),
    });
  });

  app.get("/comments", async (c) => {
    const dir = c.req.query("dir");
    if (!dir) return c.json({ error: "dir is required" }, 400);
    if (!(await isKnownRepo(dir))) return c.json({ error: `not a known repo: ${dir}` }, 400);
    const base = c.req.query("base") || undefined;
    const sinceRaw = c.req.query("since");
    const since = sinceRaw === undefined ? undefined : Number(sinceRaw);
    if (since !== undefined && !Number.isFinite(since)) return c.json({ error: "bad since" }, 400);
    let res = listComments(dir, base, since);
    if (c.req.query("wait") === "1" && res.comments.length === 0) {
      res = await waitForComments(dir, base, since ?? res.cursor);
    }
    return c.json(res);
  });

  app.post("/comments", async (c) => {
    const b = (await c.req.json().catch(() => null)) as CommentCreateRequest | null;
    if (
      !b ||
      typeof b.dir !== "string" ||
      typeof b.base !== "string" ||
      typeof b.body !== "string" ||
      b.body.trim() === "" ||
      (b.author !== "user" && b.author !== "agent")
    ) {
      return c.json({ error: "dir, base, author (user|agent), non-empty body are required" }, 400);
    }
    if (b.parentId !== undefined && typeof b.parentId !== "string") {
      return c.json({ error: "parentId must be a string" }, 400);
    }
    if (
      b.anchor !== undefined &&
      (typeof b.anchor !== "object" ||
        b.anchor === null ||
        typeof b.anchor.file !== "string" ||
        (b.anchor.side !== "old" && b.anchor.side !== "new") ||
        typeof b.anchor.line !== "number" ||
        typeof b.anchor.snippet !== "string")
    ) {
      return c.json({ error: "malformed anchor" }, 400);
    }
    if (!(await isKnownRepo(b.dir))) return c.json({ error: `not a known repo: ${b.dir}` }, 400);
    const comment = createComment(b);
    broadcast({ type: "comments-changed", dir: comment.dir, seq: comment.seq });
    notifyWaiters(comment.dir);
    return c.json(comment, 201);
  });

  app.patch("/comments/:id", async (c) => {
    const id = c.req.param("id");
    const b = (await c.req.json().catch(() => null)) as CommentPatchRequest | null;
    if (!b || (b.resolved === undefined && b.body === undefined)) {
      return c.json({ error: "resolved and/or body required" }, 400);
    }
    if (b.resolved !== undefined && typeof b.resolved !== "boolean") {
      return c.json({ error: "resolved must be boolean" }, 400);
    }
    if (b.body !== undefined && (typeof b.body !== "string" || b.body.trim() === "")) {
      return c.json({ error: "body must be a non-empty string" }, 400);
    }
    let comment;
    try {
      comment = patchComment(id, { body: b.body, resolved: b.resolved });
    } catch (err) {
      if (err instanceof DbError) return c.json({ error: err.message }, 404);
      throw err;
    }
    broadcast({ type: "comments-changed", dir: comment.dir, seq: comment.seq });
    notifyWaiters(comment.dir);
    return c.json(comment);
  });

  app.put("/seen", async (c) => {
    const b = (await c.req.json().catch(() => null)) as SeenRequest | null;
    if (
      !b ||
      typeof b.dir !== "string" ||
      typeof b.base !== "string" ||
      typeof b.path !== "string" ||
      typeof b.contentHash !== "string" ||
      typeof b.seen !== "boolean"
    ) {
      return c.json({ error: "dir, base, path, contentHash, seen are required" }, 400);
    }
    if (!(await isKnownRepo(b.dir))) return c.json({ error: `not a known repo: ${b.dir}` }, 400);
    setSeen(b.dir, b.base, b.path, b.contentHash, b.seen);
    return c.json({ ok: true });
  });

  return app;
}
