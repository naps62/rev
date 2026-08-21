/**
 * SQLite persistence (node:sqlite) for comments and seen-state.
 * Schema is created on open; the DB file lives at config.dbPath.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Comment, CommentAnchor, CommentCreateRequest } from "#shared/types";
import { config } from "./config.ts";

/** Thrown for caller errors (unknown id, bad parent) the API maps to 4xx. */
export class DbError extends Error {}

let db: DatabaseSync | null = null;

/** Open (or create) the DB. `path` overrides config.dbPath, for tests. */
export function openDb(path: string = config.dbPath): void {
  if (db) db.close();
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS comments (
      id            TEXT PRIMARY KEY,
      dir           TEXT NOT NULL,
      base          TEXT NOT NULL,
      anchor        TEXT,
      parent_id     TEXT REFERENCES comments(id),
      author        TEXT NOT NULL,
      body          TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      resolved_at   INTEGER,
      seq           INTEGER NOT NULL UNIQUE,
      submitted_seq INTEGER,
      picked_up_at  INTEGER,
      github_id     TEXT
    );
    CREATE INDEX IF NOT EXISTS comments_dir_seq ON comments (dir, seq);
    CREATE TABLE IF NOT EXISTS seen (
      dir          TEXT NOT NULL,
      base         TEXT NOT NULL,
      path         TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      PRIMARY KEY (dir, base, path)
    );
    CREATE TABLE IF NOT EXISTS seen_snapshots (
      dir          TEXT NOT NULL,
      base         TEXT NOT NULL,
      path         TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      content      TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      PRIMARY KEY (dir, base, path)
    );
    DROP TABLE IF EXISTS seen_segments;
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  // Pre-pending-states DBs: add the columns and backfill submitted_seq = seq,
  // so watcher cursor files (which held seq values) stay valid.
  const cols = db.prepare("PRAGMA table_info(comments)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "submitted_seq")) {
    db.exec(`
      ALTER TABLE comments ADD COLUMN submitted_seq INTEGER;
      ALTER TABLE comments ADD COLUMN picked_up_at INTEGER;
      UPDATE comments SET submitted_seq = seq;
    `);
  }
  if (!cols.some((c) => c.name === "github_id")) {
    db.exec("ALTER TABLE comments ADD COLUMN github_id TEXT;");
  }
  // Per dir, not global: the same PR mirrors independently into each checkout
  // (main repo + worktrees) reviewing its branch.
  db.exec(`
    DROP INDEX IF EXISTS comments_github_id;
    CREATE UNIQUE INDEX IF NOT EXISTS comments_dir_github_id
      ON comments (dir, github_id) WHERE github_id IS NOT NULL;
  `);
}

export function closeDb(): void {
  db?.close();
  db = null;
}

function must(): DatabaseSync {
  if (!db) throw new Error("openDb() not called");
  return db;
}

export function getSetting(key: string): string | null {
  const row = must().prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  must()
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value);
}

/** Run `fn` inside BEGIN/COMMIT, rolling back on throw. */
function transaction<T>(d: DatabaseSync, fn: () => T): T {
  d.exec("BEGIN");
  try {
    const result = fn();
    d.exec("COMMIT");
    return result;
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}

interface CommentRow {
  id: string;
  dir: string;
  base: string;
  anchor: string | null;
  parent_id: string | null;
  author: "user" | "agent";
  body: string;
  created_at: number;
  resolved_at: number | null;
  seq: number;
  submitted_seq: number | null;
  picked_up_at: number | null;
  github_id: string | null;
}

function rowToComment(r: CommentRow): Comment {
  return {
    id: r.id,
    dir: r.dir,
    base: r.base,
    anchor: r.anchor ? JSON.parse(r.anchor) : null,
    parentId: r.parent_id,
    author: r.author,
    body: r.body,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    seq: r.seq,
    status:
      r.submitted_seq == null ? "pending" : r.picked_up_at == null ? "submitted" : "picked_up",
    submittedSeq: r.submitted_seq,
  };
}

function getRow(d: DatabaseSync, id: string): CommentRow | null {
  return (d.prepare("SELECT * FROM comments WHERE id = ?").get(id) as CommentRow | undefined) ?? null;
}

/** Next value on the submission axis (independent of the creation axis, seq). */
function nextSubmittedSeq(d: DatabaseSync): number {
  return (
    d.prepare("SELECT COALESCE(MAX(submitted_seq), 0) + 1 AS s FROM comments").get() as {
      s: number;
    }
  ).s;
}

/** Insert; assigns id, seq (monotonic), createdAt. Replies must reference an existing root. */
export function createComment(req: CommentCreateRequest): Comment {
  const d = must();
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  transaction(d, () => {
    let parentId: string | null = null;
    let anchor: string | null = req.anchor ? JSON.stringify(req.anchor) : null;
    if (req.parentId !== undefined) {
      const parent = getRow(d, req.parentId);
      if (!parent) throw new DbError(`parentId not found: ${req.parentId}`);
      // replies always hang off the thread root and carry no anchor
      parentId = parent.parent_id ?? parent.id;
      anchor = null;
    }
    const seq = (d.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM comments").get() as { s: number }).s;
    const submittedSeq = req.pending ? null : nextSubmittedSeq(d);
    d.prepare(
      `INSERT INTO comments (id, dir, base, anchor, parent_id, author, body, created_at, resolved_at, seq, submitted_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(id, req.dir, req.base, anchor, parentId, req.author, req.body, createdAt, seq, submittedSeq);
  });
  return rowToComment(getRow(d, id)!);
}

/**
 * Mirror one GitHub comment into the store for agent delivery
 * (REV_GITHUB_TO_AGENT). Keyed by github_id: an existing row just gets its
 * body and (roots) resolved state refreshed — never re-delivered. Threads
 * already resolved when first seen are not mirrored at all (nothing left for
 * the agent to act on); resolution arriving later lands on the existing row.
 * Mirrored rows are author "reviewer", submitted immediately, and hidden
 * from the UI listing (the review page renders GitHub threads live instead).
 * Returns true when a new row was inserted.
 */
export function mirrorGithubComment(req: {
  dir: string;
  base: string;
  githubId: string;
  body: string;
  createdAt: number;
  anchor?: CommentAnchor;
  /** github_id of the thread root; resolved locally to parent_id. */
  parentGithubId?: string;
  resolved?: boolean;
}): boolean {
  const d = must();
  return transaction(d, () => {
    const existing = d
      .prepare("SELECT id, parent_id, body, resolved_at FROM comments WHERE dir = ? AND github_id = ?")
      .get(req.dir, req.githubId) as
      | { id: string; parent_id: string | null; body: string; resolved_at: number | null }
      | undefined;
    if (existing) {
      if (existing.body !== req.body) {
        d.prepare("UPDATE comments SET body = ? WHERE id = ?").run(req.body, existing.id);
      }
      if (req.resolved !== undefined && existing.parent_id === null) {
        const want = req.resolved ? existing.resolved_at ?? Date.now() : null;
        if (want !== existing.resolved_at) {
          d.prepare("UPDATE comments SET resolved_at = ? WHERE id = ?").run(want, existing.id);
        }
      }
      return false;
    }
    // Already resolved and never delivered: skip. Its replies skip too via
    // the failed parent lookup below, and an unresolve later inserts all.
    if (req.resolved) return false;
    let parentId: string | null = null;
    if (req.parentGithubId !== undefined) {
      const parent = d
        .prepare("SELECT id, parent_id FROM comments WHERE dir = ? AND github_id = ?")
        .get(req.dir, req.parentGithubId) as { id: string; parent_id: string | null } | undefined;
      if (!parent) return false; // root not mirrored (yet); the next sync retries
      parentId = parent.parent_id ?? parent.id;
    }
    const seq = (d.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM comments").get() as { s: number }).s;
    d.prepare(
      `INSERT INTO comments (id, dir, base, anchor, parent_id, author, body, created_at, resolved_at, seq, submitted_seq, github_id)
       VALUES (?, ?, ?, ?, ?, 'reviewer', ?, ?, ?, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(),
      req.dir,
      req.base,
      req.anchor && parentId === null ? JSON.stringify(req.anchor) : null,
      parentId,
      req.body,
      req.createdAt,
      null,
      seq,
      nextSubmittedSeq(d),
      req.githubId,
    );
    return true;
  });
}

/** github_id of `id`'s thread root (null when the thread isn't a GitHub mirror). */
export function rootGithubId(id: string): string | null {
  const d = must();
  const row = getRow(d, id);
  if (!row) return null;
  const root = row.parent_id ? getRow(d, row.parent_id) : row;
  return root?.github_id ?? null;
}

/** Stamp a local comment as existing on GitHub (after forwarding it there). */
export function stampGithubId(id: string, githubId: string): void {
  must().prepare("UPDATE comments SET github_id = ? WHERE id = ?").run(githubId, id);
}

/**
 * Assign submitted_seq to every pending comment under dir, in creation order.
 * Returns the number submitted and the dir's post-submit cursor.
 */
export function submitPending(dir: string): { submitted: number; cursor: number } {
  const d = must();
  return transaction(d, () => {
    const rows = d
      .prepare("SELECT id FROM comments WHERE dir = ? AND submitted_seq IS NULL ORDER BY seq ASC")
      .all(dir) as unknown as Array<{ id: string }>;
    for (const r of rows) {
      d.prepare("UPDATE comments SET submitted_seq = ? WHERE id = ?").run(nextSubmittedSeq(d), r.id);
    }
    return { submitted: rows.length, cursor: submittedCursor(d, dir) };
  });
}

/** Mark submitted comments with submitted_seq ≤ upTo as picked up. Returns count newly marked. */
export function ackPickedUp(dir: string, upTo: number): number {
  const result = must()
    .prepare(
      `UPDATE comments SET picked_up_at = ?
       WHERE dir = ? AND submitted_seq IS NOT NULL AND submitted_seq <= ? AND picked_up_at IS NULL`,
    )
    .run(Date.now(), dir, upTo);
  return Number(result.changes);
}

/** Patch body and/or resolved flag (resolve applies to thread roots). Throws on unknown id. */
export function patchComment(id: string, patch: { body?: string; resolved?: boolean }): Comment {
  const d = must();
  const row = getRow(d, id);
  if (!row) throw new DbError(`unknown comment: ${id}`);
  if (patch.body !== undefined) {
    d.prepare("UPDATE comments SET body = ? WHERE id = ?").run(patch.body, id);
  }
  if (patch.resolved !== undefined) {
    const rootId = row.parent_id ?? row.id;
    d.prepare("UPDATE comments SET resolved_at = ? WHERE id = ?").run(
      patch.resolved ? Date.now() : null,
      rootId,
    );
  }
  return rowToComment(getRow(d, id)!);
}

function submittedCursor(d: DatabaseSync, dir: string): number {
  return (
    d
      .prepare("SELECT COALESCE(MAX(submitted_seq), 0) AS c FROM comments WHERE dir = ?")
      .get(dir) as { c: number }
  ).c;
}

/**
 * Comments for a dir (optionally filtered by base), seq-ascending.
 * `since` returns only seq > since. Also returns the store-wide max seq for
 * this dir as the long-poll cursor.
 *
 * `submittedOnly` (agent polling) switches every axis to submitted_seq:
 * pending comments are excluded, `since` compares submitted_seq, ordering
 * follows submission order, and the cursor is the dir's max submitted_seq.
 */
export function listComments(
  dir: string,
  base?: string,
  since?: number,
  submittedOnly = false,
): { comments: Comment[]; cursor: number } {
  const d = must();
  const axis = submittedOnly ? "submitted_seq" : "seq";
  let sql = "SELECT * FROM comments WHERE dir = ?";
  const params: (string | number)[] = [dir];
  if (submittedOnly) sql += " AND submitted_seq IS NOT NULL";
  // The UI renders GitHub threads live from /api/github; mirrored rows exist
  // only for agent delivery and would duplicate them.
  else sql += " AND github_id IS NULL";
  if (base !== undefined) {
    sql += " AND base = ?";
    params.push(base);
  }
  if (since !== undefined) {
    sql += ` AND ${axis} > ?`;
    params.push(since);
  }
  sql += ` ORDER BY ${axis} ASC`;
  const rows = d.prepare(sql).all(...params) as unknown as CommentRow[];
  const cursor = submittedOnly
    ? submittedCursor(d, dir)
    : (
        d.prepare("SELECT COALESCE(MAX(seq), 0) AS c FROM comments WHERE dir = ?").get(dir) as {
          c: number;
        }
      ).c;
  return { comments: rows.map(rowToComment), cursor };
}

/** Unresolved thread-root count per dir, for RepoInfo.openComments. */
export function openCommentCounts(): Map<string, number> {
  const d = must();
  const rows = d
    .prepare("SELECT dir, COUNT(*) AS n FROM comments WHERE parent_id IS NULL AND resolved_at IS NULL GROUP BY dir")
    .all() as unknown as Array<{ dir: string; n: number }>;
  return new Map(rows.map((r) => [r.dir, r.n]));
}

/** Record/clear seen-state for (dir, base, path) at a contentHash. */
export function setSeen(dir: string, base: string, path: string, contentHash: string, seen: boolean): void {
  const d = must();
  if (seen) {
    d.prepare(
      `INSERT INTO seen (dir, base, path, content_hash) VALUES (?, ?, ?, ?)
       ON CONFLICT (dir, base, path) DO UPDATE SET content_hash = excluded.content_hash`,
    ).run(dir, base, path, contentHash);
  } else {
    d.prepare("DELETE FROM seen WHERE dir = ? AND base = ? AND path = ?").run(dir, base, path);
  }
}

/**
 * Store the reviewed content for (dir, base, path) — the interdiff baseline.
 * One row per key; re-marking seen overwrites.
 */
export function putSeenSnapshot(
  dir: string,
  base: string,
  path: string,
  contentHash: string,
  content: string,
): void {
  must()
    .prepare(
      `INSERT INTO seen_snapshots (dir, base, path, content_hash, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (dir, base, path) DO UPDATE
         SET content_hash = excluded.content_hash,
             content = excluded.content,
             created_at = excluded.created_at`,
    )
    .run(dir, base, path, contentHash, content, Date.now());
}

export function deleteSeenSnapshot(dir: string, base: string, path: string): void {
  must().prepare("DELETE FROM seen_snapshots WHERE dir = ? AND base = ? AND path = ?").run(dir, base, path);
}

export function getSeenSnapshot(
  dir: string,
  base: string,
  path: string,
): { contentHash: string; content: string } | null {
  const row = must()
    .prepare("SELECT content_hash, content FROM seen_snapshots WHERE dir = ? AND base = ? AND path = ?")
    .get(dir, base, path) as { content_hash: string; content: string } | undefined;
  return row ? { contentHash: row.content_hash, content: row.content } : null;
}

/** contentHash each path was marked seen at, for (dir, base). */
export function seenHashes(dir: string, base: string): Map<string, string> {
  const d = must();
  const rows = d
    .prepare("SELECT path, content_hash FROM seen WHERE dir = ? AND base = ?")
    .all(dir, base) as unknown as Array<{ path: string; content_hash: string }>;
  return new Map(rows.map((r) => [r.path, r.content_hash]));
}
