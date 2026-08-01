/**
 * SQLite persistence (bun:sqlite) for comments and seen-state.
 * Schema is created on open; the DB file lives at config.dbPath.
 */

import type { Comment, CommentCreateRequest } from "@shared/types";

export function openDb(): void {
  throw new Error("not implemented");
}

/** Insert; assigns id, seq (monotonic), createdAt. Replies must reference an existing root. */
export function createComment(req: CommentCreateRequest): Comment {
  throw new Error("not implemented");
}

/** Patch body and/or resolved flag (resolve applies to thread roots). Throws on unknown id. */
export function patchComment(id: string, patch: { body?: string; resolved?: boolean }): Comment {
  throw new Error("not implemented");
}

/**
 * Comments for a dir (optionally filtered by base), seq-ascending.
 * `since` returns only seq > since. Also returns the store-wide max seq for
 * this dir as the long-poll cursor.
 */
export function listComments(dir: string, base?: string, since?: number): { comments: Comment[]; cursor: number } {
  throw new Error("not implemented");
}

/** Unresolved thread-root count per dir, for RepoInfo.openComments. */
export function openCommentCounts(): Map<string, number> {
  throw new Error("not implemented");
}

/** Record/clear seen-state for (dir, base, path) at a contentHash. */
export function setSeen(dir: string, base: string, path: string, contentHash: string, seen: boolean): void {
  throw new Error("not implemented");
}

/** contentHash each path was marked seen at, for (dir, base). */
export function seenHashes(dir: string, base: string): Map<string, string> {
  throw new Error("not implemented");
}
