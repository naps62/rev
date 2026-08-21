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
import { readFile as readFileBytes, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, resolve, sep } from "node:path";
import type {
  CommentCreateRequest,
  CommentListResponse,
  CommentPatchRequest,
  CommentsAckRequest,
  CommentsSubmitRequest,
  FileWriteRequest,
  PresenceResponse,
  SeenRequest,
  ServerMessage,
  WorktreeCreateRequest,
} from "#shared/types";
import { TUNING } from "#shared/tuning";
import {
  ackPickedUp,
  createComment,
  DbError,
  deleteSeenSnapshot,
  getSeenSnapshot,
  listComments,
  patchComment,
  putSeenSnapshot,
  seenHashes,
  setSeen,
  submitPending,
} from "./db.ts";
import { resolveComments } from "./anchor.ts";
import { presence } from "./presence.ts";
import { computeSemanticDiff } from "./semantic.ts";
import { computeStack } from "./stack.ts";
import {
  CommandError,
  runWorktreeCommand,
  setWorktreeCommand,
  validBranch,
  worktreeCommand,
} from "./commands.ts";
import { invalidateRepoList, isKnownRepo, listRepos, rescan } from "./discovery.ts";
import { listOpenPrs } from "./forge.ts";
import {
  baseBehind,
  computeDiff,
  computeDiffSummary,
  computeFileDiff,
  diffBlobVsWorkingFile,
  fetchBase,
  GitError,
  hashContent,
  isBinaryBytes,
  listRefs,
  readFile,
  readRawFile,
} from "./git.ts";

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  ".apng": "image/apng",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

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
  submittedOnly: boolean;
  resolve: (r: CommentListResponse) => void;
}

/** Build the /api sub-app. `broadcast` sends a ServerMessage to all WS clients. */
export function buildApi(broadcast: (msg: ServerMessage) => void): Hono {
  const app = new Hono();
  const waiters = new Set<Waiter>();

  function notifyWaiters(dir: string): void {
    for (const w of [...waiters]) {
      if (w.dir !== dir) continue;
      const res = listComments(w.dir, w.base, w.since, w.submittedOnly);
      if (res.comments.length > 0) w.resolve(res);
    }
  }

  function waitForComments(
    dir: string,
    base: string | undefined,
    since: number,
    submittedOnly: boolean,
  ): Promise<CommentListResponse> {
    return new Promise((resolvePromise) => {
      const w: Waiter = {
        dir,
        base,
        since,
        submittedOnly,
        resolve: (r) => {
          waiters.delete(w);
          clearTimeout(timer);
          resolvePromise(r);
        },
      };
      const timer = setTimeout(
        () => w.resolve(listComments(dir, base, since, submittedOnly)),
        TUNING.LONG_POLL_MS,
      );
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
    const repos = await rescan(true); // user-forced: bypass per-repo stats cache
    broadcast({ type: "repos-changed" });
    return c.json(repos);
  });

  app.get("/prs", async (c) => {
    const dir = c.req.query("dir");
    if (!dir) return c.json({ error: "dir is required" }, 400);
    if (!(await isKnownRepo(dir))) return c.json({ error: `not a known repo: ${dir}` }, 400);
    const repos = await listRepos();
    const me = repos.find((r) => r.dir === dir);
    const mainDir = me?.mainDir ?? dir;
    const remote = repos.find((r) => r.dir === mainDir)?.remoteUrl ?? me?.remoteUrl ?? null;
    if (remote === null) return c.json({ dir, prs: null });
    const prs = await listOpenPrs(remote);
    if (prs === null) return c.json({ dir, prs: null });
    const checkouts = new Map<string, string>();
    for (const r of repos) {
      if (r.mainDir === mainDir && r.branch !== null) checkouts.set(r.branch, r.dir);
    }
    return c.json({
      dir,
      prs: prs.map((p) => ({ ...p, checkoutDir: checkouts.get(p.branch) ?? null })),
    });
  });

  app.post("/worktrees", async (c) => {
    const b = (await c.req.json().catch(() => null)) as WorktreeCreateRequest | null;
    if (!b || typeof b.dir !== "string" || typeof b.branch !== "string") {
      return c.json({ error: "dir and branch are required" }, 400);
    }
    if (!(await isKnownRepo(b.dir))) return c.json({ error: `not a known repo: ${b.dir}` }, 400);
    if (!validBranch(b.branch)) return c.json({ error: `invalid branch name: ${b.branch}` }, 400);
    const repos = await listRepos();
    const me = repos.find((r) => r.dir === b.dir);
    const mainDir = me?.mainDir ?? b.dir;
    const remote = repos.find((r) => r.dir === mainDir)?.remoteUrl ?? me?.remoteUrl ?? null;
    let created;
    try {
      created = await runWorktreeCommand(mainDir, b.branch, remote);
    } catch (err) {
      if (err instanceof CommandError) return c.json({ error: err.message }, 400);
      throw err;
    }
    await rescan(true);
    broadcast({ type: "repos-changed" });
    return c.json({ dir: created.dir, branch: b.branch }, 201);
  });

  app.get("/commands", (c) => c.json({ worktreeCreate: worktreeCommand() }));

  app.put("/commands", async (c) => {
    const b = (await c.req.json().catch(() => null)) as { worktreeCreate?: unknown } | null;
    if (!b || typeof b.worktreeCreate !== "string") {
      return c.json({ error: "worktreeCreate is required" }, 400);
    }
    try {
      setWorktreeCommand(b.worktreeCreate);
    } catch (err) {
      if (err instanceof CommandError) return c.json({ error: err.message }, 400);
      throw err;
    }
    return c.json({ worktreeCreate: worktreeCommand() });
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

  app.get("/diff/summary", async (c) => {
    const dir = c.req.query("dir");
    const base = c.req.query("base");
    if (!dir || !base) return c.json({ error: "dir and base are required" }, 400);
    if (!(await isKnownRepo(dir))) return c.json({ error: `not a known repo: ${dir}` }, 400);
    const summary = await computeDiffSummary(dir, base);
    const seen = seenHashes(dir, base);
    for (const f of summary.files) {
      const h = seen.get(f.path);
      if (h === undefined) continue;
      f.seen = h === f.contentHash;
      f.stale = !f.seen;
    }
    return c.json(summary);
  });

  app.get("/diff/file", async (c) => {
    const dir = c.req.query("dir");
    const base = c.req.query("base");
    const path = c.req.query("path");
    const oldPath = c.req.query("oldPath") || undefined;
    if (!dir || !base || !path) return c.json({ error: "dir, base and path are required" }, 400);
    if (!(await isKnownRepo(dir))) return c.json({ error: `not a known repo: ${dir}` }, 400);
    if (resolveInRepo(dir, path) === null) return c.json({ error: `path escapes repo: ${path}` }, 400);
    if (oldPath !== undefined && resolveInRepo(dir, oldPath) === null) {
      return c.json({ error: `path escapes repo: ${oldPath}` }, 400);
    }
    const file = await computeFileDiff(dir, base, path, oldPath);
    if (file === null) return c.json({ error: `no changes for ${path}` }, 404);
    const h = seenHashes(dir, base).get(file.path);
    if (h !== undefined) {
      file.seen = h === file.contentHash;
      file.stale = !file.seen;
    }
    return c.json({ dir, base, file, computedAt: Date.now() });
  });

  app.get("/diff/interdiff", async (c) => {
    const dir = c.req.query("dir");
    const base = c.req.query("base");
    const path = c.req.query("path");
    if (!dir || !base || !path) return c.json({ error: "dir, base and path are required" }, 400);
    if (!(await isKnownRepo(dir))) return c.json({ error: `not a known repo: ${dir}` }, 400);
    const target = resolveInRepo(dir, path);
    if (target === null) return c.json({ error: `path escapes repo: ${path}` }, 400);
    const snap = getSeenSnapshot(dir, base, path);
    if (snap === null) return c.json({ error: `no seen snapshot for ${path}` }, 404);
    const delta = await diffBlobVsWorkingFile(dir, path, snap.content);
    const contentHash = existsSync(target) ? hashContent(await readFileBytes(target)) : "";
    const file = {
      path,
      status: "modified" as const,
      binary: delta.binary,
      hunks: delta.hunks,
      additions: delta.additions,
      deletions: delta.deletions,
      contentHash,
      seen: false,
      stale: true,
    };
    return c.json({ dir, base, path, sinceHash: snap.contentHash, file });
  });

  app.get("/semantic", async (c) => {
    const dir = c.req.query("dir");
    const base = c.req.query("base");
    if (!dir || !base) return c.json({ error: "dir and base are required" }, 400);
    if (!(await isKnownRepo(dir))) return c.json({ error: `not a known repo: ${dir}` }, 400);
    return c.json(await computeSemanticDiff(dir, base));
  });

  app.get("/refs", async (c) => {
    const dir = c.req.query("dir");
    if (!dir) return c.json({ error: "dir is required" }, 400);
    if (!(await isKnownRepo(dir))) return c.json({ error: `not a known repo: ${dir}` }, 400);
    return c.json({ dir, refs: await listRefs(dir) });
  });

  app.get("/presence", async (c) => {
    const dir = c.req.query("dir");
    if (!dir) return c.json({ error: "dir is required" }, 400);
    if (!(await isKnownRepo(dir))) return c.json({ error: `not a known repo: ${dir}` }, 400);
    return c.json({ dir, ...presence(dir) } satisfies PresenceResponse);
  });

  app.get("/stack", async (c) => {
    const dir = c.req.query("dir");
    const base = c.req.query("base");
    if (!dir || !base) return c.json({ error: "dir and base are required" }, 400);
    if (!(await isKnownRepo(dir))) return c.json({ error: `not a known repo: ${dir}` }, 400);
    // branch → checkout across this repo's worktrees, so stack segments can
    // link to the checkout that reviews them.
    const repos = await listRepos();
    const mainDir = repos.find((r) => r.dir === dir)?.mainDir;
    const checkouts = new Map<string, string>();
    for (const r of repos) {
      if (r.mainDir === mainDir && r.branch !== null) checkouts.set(r.branch, r.dir);
    }
    return c.json(await computeStack(dir, base, checkouts));
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

  app.get("/file/raw", async (c) => {
    const dir = c.req.query("dir");
    const path = c.req.query("path");
    const rev = c.req.query("rev") ?? null;
    if (!dir || !path) return c.json({ error: "dir and path are required" }, 400);
    if (!(await isKnownRepo(dir))) return c.json({ error: `not a known repo: ${dir}` }, 400);
    if (resolveInRepo(dir, path) === null) return c.json({ error: `path escapes repo: ${path}` }, 400);
    const bytes = await readRawFile(dir, path, rev);
    const contentType = IMAGE_CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
    return c.body(Uint8Array.from(bytes), 200, {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
    });
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
    let currentHash = "";
    try {
      currentHash = hashContent(await readFileBytes(target));
    } catch {
      // missing file: baseHash "" means "create"
    }
    if (currentHash !== body.baseHash) {
      return c.json({ error: `baseHash mismatch: file is at ${currentHash || "(missing)"}` }, 409);
    }
    await writeFile(target, body.content);
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
    const submittedOnly = c.req.query("submitted") === "1";
    let res = listComments(dir, base, since, submittedOnly);
    if (c.req.query("wait") === "1" && res.comments.length === 0) {
      res = await waitForComments(dir, base, since ?? res.cursor, submittedOnly);
    }
    await resolveComments(dir, res.comments);
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
      (b.author !== "user" && b.author !== "agent" && b.author !== "reviewer")
    ) {
      return c.json({ error: "dir, base, author (user|agent|reviewer), non-empty body are required" }, 400);
    }
    if (b.parentId !== undefined && typeof b.parentId !== "string") {
      return c.json({ error: "parentId must be a string" }, 400);
    }
    if (b.pending !== undefined && typeof b.pending !== "boolean") {
      return c.json({ error: "pending must be a boolean" }, 400);
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

  app.post("/comments/submit", async (c) => {
    const b = (await c.req.json().catch(() => null)) as CommentsSubmitRequest | null;
    if (!b || typeof b.dir !== "string") return c.json({ error: "dir is required" }, 400);
    if (!(await isKnownRepo(b.dir))) return c.json({ error: `not a known repo: ${b.dir}` }, 400);
    const res = submitPending(b.dir);
    if (res.submitted > 0) {
      broadcast({ type: "comments-changed", dir: b.dir, seq: res.cursor });
      notifyWaiters(b.dir);
    }
    return c.json(res);
  });

  app.post("/comments/ack", async (c) => {
    const b = (await c.req.json().catch(() => null)) as CommentsAckRequest | null;
    if (!b || typeof b.dir !== "string" || typeof b.upTo !== "number" || !Number.isFinite(b.upTo)) {
      return c.json({ error: "dir and numeric upTo are required" }, 400);
    }
    if (!(await isKnownRepo(b.dir))) return c.json({ error: `not a known repo: ${b.dir}` }, 400);
    const acked = ackPickedUp(b.dir, b.upTo);
    if (acked > 0) broadcast({ type: "comments-changed", dir: b.dir, seq: b.upTo });
    return c.json({ acked });
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

  app.post("/fetch", async (c) => {
    const b = (await c.req.json().catch(() => null)) as { dir?: unknown; base?: unknown } | null;
    if (!b || typeof b.dir !== "string" || typeof b.base !== "string") {
      return c.json({ error: "dir and base are required" }, 400);
    }
    if (!(await isKnownRepo(b.dir))) return c.json({ error: `not a known repo: ${b.dir}` }, 400);
    await fetchBase(b.dir, b.base);
    return c.json({ ok: true, baseBehind: await baseBehind(b.dir, b.base) });
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
    const target = resolveInRepo(b.dir, b.path);
    if (target === null) return c.json({ error: `path escapes repo: ${b.path}` }, 400);
    setSeen(b.dir, b.base, b.path, b.contentHash, b.seen);
    // Snapshot the reviewed content as the future interdiff baseline. Only
    // when the on-disk content still matches what the client marked seen —
    // and never for binaries or oversized files. Otherwise drop any old
    // snapshot so a stale baseline can't produce a wrong delta.
    let snapshotted = false;
    if (b.seen) {
      try {
        const bytes = await readFileBytes(target);
        if (
          bytes.length <= TUNING.MAX_UNTRACKED_BYTES &&
          hashContent(bytes) === b.contentHash &&
          !isBinaryBytes(bytes)
        ) {
          // fatal decoder: an invalid-UTF-8 snapshot would diff its U+FFFD
          // replacements against the real bytes forever after
          putSeenSnapshot(
            b.dir,
            b.base,
            b.path,
            b.contentHash,
            new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          );
          snapshotted = true;
        }
      } catch {
        // vanished mid-read or undecodable: seen is recorded, baseline isn't
      }
    }
    if (!snapshotted) deleteSeenSnapshot(b.dir, b.base, b.path);
    // Review progress on the projects page counts seen lines; make it refetch.
    invalidateRepoList();
    broadcast({ type: "repos-changed" });
    return c.json({ ok: true });
  });

  return app;
}
