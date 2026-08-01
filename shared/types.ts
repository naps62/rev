/**
 * The API contract between server and web UI (and agents talking to the REST
 * API). This file is the single source of truth — both sides import it.
 *
 * Conventions:
 * - `dir` is always the absolute path of a repo or worktree checkout.
 * - `base` is a git ref name (branch, tag, sha). The server resolves
 *   `merge-base(base, HEAD)` per request; callers never pass shas of
 *   merge-bases around.
 * - All timestamps are epoch milliseconds.
 */

// ---------------------------------------------------------------------------
// Repos & discovery
// ---------------------------------------------------------------------------

export interface RepoInfo {
  /** Absolute path of the checkout (worktree or main repo). */
  dir: string;
  /** Short display name, e.g. "maestro" or "maestro/fix-auth" for worktrees. */
  name: string;
  /** Currently checked-out branch, or null when detached. */
  branch: string | null;
  /** HEAD sha (short). */
  head: string;
  /** True when this is a linked worktree rather than the main checkout. */
  isWorktree: boolean;
  /** Absolute path of the main checkout this worktree belongs to (self for main). */
  mainDir: string;
  /** Default base ref the UI should preselect (repo's main/master, if found). */
  defaultBase: string | null;
  /** True when the working tree has uncommitted changes. */
  dirty: boolean;
  /** Count of files changed vs defaultBase (committed + working tree), null if unknown. */
  changedFiles: number | null;
  /** Open (unresolved) review comments recorded for this dir, across bases. */
  openComments: number;
  /** Last time the working tree or HEAD changed, best-effort. */
  lastActivity: number | null;
}

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

export type FileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked";

export type LineKind = "context" | "add" | "del";

export interface DiffLine {
  kind: LineKind;
  /** Line number in the old file; undefined for "add". */
  oldLine?: number;
  /** Line number in the new file; undefined for "del". */
  newLine?: number;
  /** Line content without trailing newline and without the +/-/space prefix. */
  text: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The `@@ … @@ <context>` trailer, often a function name. */
  header: string;
  lines: DiffLine[];
}

export interface FileDiff {
  /** New path, repo-relative. For deletes, the old path. */
  path: string;
  /** Old path when renamed. */
  oldPath?: string;
  status: FileStatus;
  binary: boolean;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  /**
   * Hash of the new-side content (working tree for existing files, empty for
   * deletes). Seen-state is recorded against this; a mismatch marks the file
   * stale in the UI.
   */
  contentHash: string;
  /** True when the user marked this file seen at exactly this contentHash. */
  seen: boolean;
  /** True when the file was marked seen at a different (older) contentHash. */
  stale: boolean;
}

export interface DiffResponse {
  dir: string;
  base: string;
  /** Resolved merge-base sha the diff was computed from. */
  mergeBase: string;
  head: string;
  branch: string | null;
  files: FileDiff[];
  /** Server time the diff was computed; clients treat it as a version marker. */
  computedAt: number;
}

// ---------------------------------------------------------------------------
// File content & edits
// ---------------------------------------------------------------------------

export interface FileContentResponse {
  dir: string;
  path: string;
  /** null → read from working tree; otherwise a ref/sha. */
  rev: string | null;
  content: string;
  contentHash: string;
}

export interface FileWriteRequest {
  dir: string;
  path: string;
  content: string;
  /**
   * contentHash the client last saw. Server rejects with 409 when the
   * working-tree file no longer matches — quick edits must not clobber
   * concurrent agent writes.
   */
  baseHash: string;
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export type Author = "user" | "agent";

export interface CommentAnchor {
  /** Repo-relative path the comment is attached to. */
  file: string;
  /** Which side of the diff the line number refers to. */
  side: "old" | "new";
  line: number;
  /**
   * Trimmed text of the anchored line at comment time. Used to re-anchor
   * best-effort after the file changes, and shown as fallback context when
   * re-anchoring fails.
   */
  snippet: string;
}

export interface Comment {
  id: string;
  dir: string;
  base: string;
  /** null for replies (they inherit the root's anchor) and review-level notes. */
  anchor: CommentAnchor | null;
  /** Root comment id when this is a reply. */
  parentId: string | null;
  author: Author;
  body: string;
  createdAt: number;
  /** Set when the thread root is resolved. Only meaningful on roots. */
  resolvedAt: number | null;
  /** Monotonic per-server sequence, the `since` cursor for agent polling. */
  seq: number;
}

export interface CommentCreateRequest {
  dir: string;
  base: string;
  anchor?: CommentAnchor;
  parentId?: string;
  author: Author;
  body: string;
}

export interface CommentPatchRequest {
  resolved?: boolean;
  body?: string;
}

export interface CommentListResponse {
  comments: Comment[];
  /** Highest seq in the full store for this dir (not just this page). */
  cursor: number;
}

// ---------------------------------------------------------------------------
// Seen state
// ---------------------------------------------------------------------------

export interface SeenRequest {
  dir: string;
  base: string;
  path: string;
  /** contentHash from the FileDiff the user reviewed. */
  contentHash: string;
  /** false → un-mark. */
  seen: boolean;
}

// ---------------------------------------------------------------------------
// WebSocket protocol  (path: /ws)
// ---------------------------------------------------------------------------

/** Client → server. */
export type ClientMessage =
  /** Start watching a dir; server begins fs-watching it and sends events. */
  | { type: "watch"; dir: string }
  /** Stop watching (leaving the page). */
  | { type: "unwatch"; dir: string };

/** Server → client. */
export type ServerMessage =
  /**
   * The working tree or HEAD of `dir` changed. `paths` is repo-relative,
   * best-effort (may be empty when only HEAD moved). Clients refetch the diff.
   */
  | { type: "diff-invalidated"; dir: string; paths: string[] }
  /** A comment was created or patched anywhere under `dir`. */
  | { type: "comments-changed"; dir: string; seq: number }
  /** The discovered repo list changed. */
  | { type: "repos-changed" };

// ---------------------------------------------------------------------------
// REST surface (all JSON; errors are { error: string } with 4xx/5xx)
// ---------------------------------------------------------------------------
//
// GET    /api/repos                          → RepoInfo[]
// POST   /api/repos/rescan                   → RepoInfo[]      (force re-discovery)
// GET    /api/diff?dir&base                  → DiffResponse
// GET    /api/file?dir&path[&rev]            → FileContentResponse
// PUT    /api/file                           ← FileWriteRequest → FileContentResponse
// GET    /api/comments?dir[&base][&since]    → CommentListResponse
//        `since` compares against seq; use for agent polling. Add `wait=1`
//        to long-poll up to LONG_POLL_MS when nothing is newer than `since`.
// POST   /api/comments                       ← CommentCreateRequest → Comment
// PATCH  /api/comments/:id                   ← CommentPatchRequest  → Comment
// PUT    /api/seen                           ← SeenRequest → { ok: true }
//
// The review page URL agents hand to the user:
//   /review?dir=<abs path>&base=<ref>
