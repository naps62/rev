/**
 * SQLite persistence (node:sqlite) for comments and seen-state.
 * Schema is created on open; the DB file lives at config.dbPath.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Comment, CommentCreateRequest } from "#shared/types";
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
      id          TEXT PRIMARY KEY,
      dir         TEXT NOT NULL,
      base        TEXT NOT NULL,
      anchor      TEXT,
      parent_id   TEXT REFERENCES comments(id),
      author      TEXT NOT NULL,
      body        TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      resolved_at INTEGER,
      seq         INTEGER NOT NULL UNIQUE
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
    CREATE TABLE IF NOT EXISTS seen_segments (
      dir           TEXT NOT NULL,
      base          TEXT NOT NULL,
      path          TEXT NOT NULL,
      segment_hash  TEXT NOT NULL,
      add_del_lines INTEGER NOT NULL,
      created_at    INTEGER NOT NULL,
      PRIMARY KEY (dir, base, path, segment_hash)
    );
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
  };
}

function getRow(d: DatabaseSync, id: string): CommentRow | null {
  return (d.prepare("SELECT * FROM comments WHERE id = ?").get(id) as CommentRow | undefined) ?? null;
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
    d.prepare(
      `INSERT INTO comments (id, dir, base, anchor, parent_id, author, body, created_at, resolved_at, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run(id, req.dir, req.base, anchor, parentId, req.author, req.body, createdAt, seq);
  });
  return rowToComment(getRow(d, id)!);
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

/**
 * Comments for a dir (optionally filtered by base), seq-ascending.
 * `since` returns only seq > since. Also returns the store-wide max seq for
 * this dir as the long-poll cursor.
 */
export function listComments(dir: string, base?: string, since?: number): { comments: Comment[]; cursor: number } {
  const d = must();
  let sql = "SELECT * FROM comments WHERE dir = ?";
  const params: (string | number)[] = [dir];
  if (base !== undefined) {
    sql += " AND base = ?";
    params.push(base);
  }
  if (since !== undefined) {
    sql += " AND seq > ?";
    params.push(since);
  }
  sql += " ORDER BY seq ASC";
  const rows = d.prepare(sql).all(...params) as unknown as CommentRow[];
  const cursor = (
    d.prepare("SELECT COALESCE(MAX(seq), 0) AS c FROM comments WHERE dir = ?").get(dir) as { c: number }
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

/**
 * Mark/unmark sub-file segments for (dir, base, path). Hashes are opaque to
 * the server — the client detects segments and hashes them; rows whose hash
 * no longer matches anything on screen are simply never rendered.
 */
export function setSeenSegments(
  dir: string,
  base: string,
  path: string,
  segments: Array<{ hash: string; addDelLines: number }>,
  seen: boolean,
): void {
  const d = must();
  transaction(d, () => {
    if (seen) {
      const ins = d.prepare(
        `INSERT INTO seen_segments (dir, base, path, segment_hash, add_del_lines, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (dir, base, path, segment_hash) DO UPDATE
           SET add_del_lines = excluded.add_del_lines, created_at = excluded.created_at`,
      );
      const now = Date.now();
      for (const s of segments) ins.run(dir, base, path, s.hash, s.addDelLines, now);
    } else {
      const del = d.prepare(
        "DELETE FROM seen_segments WHERE dir = ? AND base = ? AND path = ? AND segment_hash = ?",
      );
      for (const s of segments) del.run(dir, base, path, s.hash);
    }
  });
}

export function seenSegmentHashes(dir: string, base: string, path: string): string[] {
  const rows = must()
    .prepare("SELECT segment_hash FROM seen_segments WHERE dir = ? AND base = ? AND path = ?")
    .all(dir, base, path) as unknown as Array<{ segment_hash: string }>;
  return rows.map((r) => r.segment_hash);
}

/**
 * Sum of add_del_lines per path for (dir, base) — partial review progress.
 * Optimistic: includes rows whose segment no longer matches the working tree
 * (the server can't detect segments); callers cap at the file's own total.
 */
export function seenSegmentLineTotals(dir: string, base: string): Map<string, number> {
  const rows = must()
    .prepare(
      "SELECT path, SUM(add_del_lines) AS n FROM seen_segments WHERE dir = ? AND base = ? GROUP BY path",
    )
    .all(dir, base) as unknown as Array<{ path: string; n: number }>;
  return new Map(rows.map((r) => [r.path, r.n]));
}

/** contentHash each path was marked seen at, for (dir, base). */
export function seenHashes(dir: string, base: string): Map<string, string> {
  const d = must();
  const rows = d
    .prepare("SELECT path, content_hash FROM seen WHERE dir = ? AND base = ?")
    .all(dir, base) as unknown as Array<{ path: string; content_hash: string }>;
  return new Map(rows.map((r) => [r.path, r.content_hash]));
}
