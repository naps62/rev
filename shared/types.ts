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
  /** Lines added vs defaultBase (untracked files count as all-added), null if unknown. */
  additions: number | null;
  /** Lines deleted vs defaultBase, null if unknown. */
  deletions: number | null;
  /**
   * Review progress: additions+deletions of changed files currently marked
   * seen at their working-tree contentHash. Denominator is
   * additions+deletions. Null when additions is null.
   */
  seenLines: number | null;
  /** Open (unresolved) review comments recorded for this dir, across bases. */
  openComments: number;
  /** Last time the working tree or HEAD changed, best-effort. */
  lastActivity: number | null;
  /** `origin` remote URL, null when the repo has no origin. */
  remoteUrl: string | null;
  /**
   * Grouping bucket derived from remoteUrl: "personal" for remotes on a
   * personal host (REV_PERSONAL_HOSTS) or no remote at all, otherwise the
   * remote owner org (e.g. "subvisual").
   */
  scope: string;
  /** Commits HEAD has that defaultBase doesn't. Null when unknown (no base, detached mishaps). */
  aheadBase: number | null;
  /** Commits defaultBase has that HEAD doesn't — >0 means the checkout needs a rebase/merge. */
  behindBase: number | null;
}

// ---------------------------------------------------------------------------
// Pull requests & worktree creation
// ---------------------------------------------------------------------------

export type PrState = "open" | "merged" | "closed";

/**
 * A PR on the repo's origin forge whose head branch lives on origin: every
 * open PR, plus recently-updated merged/closed ones so a local worktree can
 * be matched to its finished PR.
 */
export interface PrInfo {
  number: number;
  title: string;
  /** Head branch name on origin. */
  branch: string;
  /** Forge web URL of the PR. */
  url: string;
  author: string | null;
  draft: boolean;
  state: PrState;
  /** Checkout (main or worktree) currently on `branch`, null when none. */
  checkoutDir: string | null;
}

export interface PrListResponse {
  dir: string;
  /**
   * Null when origin's PRs can't be listed: no remote, unsupported forge, or
   * the API rejected the request (missing/expired token). The UI treats null
   * as "feature unavailable", not an error.
   */
  prs: PrInfo[] | null;
}

export interface WorktreeCreateRequest {
  /** Any checkout of the repo; the worktree is created off its main checkout. */
  dir: string;
  /** Branch to check out; may exist only on origin. */
  branch: string;
}

export interface WorktreeCreateResponse {
  /**
   * Checkout now on the branch, null when the configured command created
   * something outside `git worktree list` (e.g. a separate clone) — those
   * appear in /api/repos after the rescan this endpoint triggers.
   */
  dir: string | null;
  branch: string;
}

export interface WorktreeRemoveRequest {
  /** The linked worktree checkout to remove (never a main checkout). */
  dir: string;
}

export interface WorktreeRemoveResponse {
  dir: string;
}

/** The UI-configurable command templates the server runs; see shared/commands.ts. */
export interface CommandsResponse {
  /** Argv template run by POST /api/worktrees ({dir}, {branch}, {remoteUrl}). */
  worktreeCreate: string;
  /** Argv template run by DELETE /api/worktrees ({dir}, {mainDir}, {branch}). */
  worktreeRemove: string;
  /**
   * Argv template run by POST /api/comments/submit when no agent session is
   * listening on the dir ({dir}, {branch}). Empty string = never spawn.
   */
  sessionSpawn: string;
}

/** PUT /api/commands body: only the present fields are updated. */
export interface CommandsUpdateRequest {
  worktreeCreate?: string;
  worktreeRemove?: string;
  sessionSpawn?: string;
}

/** Whether an agent session is listening for submitted comments on a dir. */
export interface AgentStatusResponse {
  dir: string;
  /** A watcher is long-polling the submitted channel, or agent activity was seen recently. */
  listening: boolean;
  /** The session-spawn template is non-empty, so submit can start a session. */
  spawnConfigured: boolean;
}

/**
 * UI preferences, stored server-side (settings table) and shared by every
 * browser that uses this rev instance. All fields optional: absent = the
 * client's default. `features` keys are the web FeatureFlags names; unknown
 * keys are dropped on write.
 */
export interface UiSettings {
  features?: Record<string, boolean>;
  diffMode?: "unified" | "split" | "mixed";
  theme?: "light" | "dark" | "auto";
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

/** Per-file diff metadata without hunks — cheap to compute and ship. */
export interface FileSummary {
  /** New path, repo-relative. For deletes, the old path. */
  path: string;
  /** Old path when renamed. */
  oldPath?: string;
  status: FileStatus;
  binary: boolean;
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

export interface FileDiff extends FileSummary {
  hunks: DiffHunk[];
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
  /**
   * Commits the local base ref is behind its upstream (e.g. main..origin/main),
   * so the UI can offer "fetch base". Null when base has no upstream or the
   * count failed; 0 when up to date.
   */
  baseBehind: number | null;
}

/** Hunk-less diff overview: file list + stats, loaded before any hunks. */
export interface DiffSummaryResponse extends Omit<DiffResponse, "files"> {
  files: FileSummary[];
}

/** One file's full diff, fetched lazily per file. */
export interface FileDiffResponse {
  dir: string;
  base: string;
  file: FileDiff;
  computedAt: number;
}

/** Base-ref candidates for a checkout; defaultBase (when present) is first. */
export interface RefsResponse {
  dir: string;
  refs: string[];
}

/**
 * Who has dir's review page open. `viewers` counts live review-page sockets;
 * `lastSeen` is when one last opened or closed it (0 = never in this server's
 * lifetime). Hooks use it to tell "the user is reviewing" from "nobody is".
 */
export interface PresenceResponse {
  dir: string;
  viewers: number;
  lastSeen: number;
}

// ---------------------------------------------------------------------------
// Branch stacks
// ---------------------------------------------------------------------------

/** One branch of a stack: the commits between its tip and the next tip down. */
export interface StackSegment {
  branch: string;
  /** Short sha of the segment's tip. */
  head: string;
  /** First-parent commits belonging to this segment. */
  commits: number;
  /** Checkout of this branch (any worktree of the repo), null when not checked out. */
  checkoutDir: string | null;
  /**
   * Ref this segment sits on: the next segment's branch, or the stack base
   * for the bottom segment. Reviewing `checkoutDir` against `parent` shows
   * this segment's isolated diff.
   */
  parent: string;
}

/**
 * The stack `dir`'s HEAD sits on: first-parent history down to
 * merge-base(base, HEAD), split at commits that are tips of other local
 * branches. segments[0] is HEAD's branch; a plain (unstacked) branch yields
 * exactly one segment; empty when detached or HEAD == merge-base.
 */
export interface StackResponse {
  dir: string;
  base: string;
  segments: StackSegment[];
  computedAt: number;
}

// ---------------------------------------------------------------------------
// Semantic entities (sem CLI)
// ---------------------------------------------------------------------------

export type EntityChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "moved"
  | "reordered";

/** One entity-level change from `sem diff`: a function/class/method, not a line range. */
export interface EntityChange {
  /** sem's entity kind: "function", "method", "class", "struct", "test", … */
  entityType: string;
  name: string;
  change: EntityChangeKind;
  /** New-side file range (1-based, inclusive); null when deleted. */
  startLine: number | null;
  endLine: number | null;
  /** Old-side file range; null when added. */
  oldStartLine: number | null;
  oldEndLine: number | null;
  /** Previous name when renamed. */
  oldName: string | null;
}

export interface SemanticFileEntities {
  /** Repo-relative path, new side (old path for deleted files). */
  path: string;
  entities: EntityChange[];
}

/**
 * Entity-level view of the diff (merge-base → working tree), computed by the
 * optional `sem` CLI. `available: false` — binary missing, parse failure,
 * timeout — is a normal response, never an error: the client falls back to
 * its text heuristics. Untracked files are never included (sem skips them).
 */
export interface SemanticDiffResponse {
  dir: string;
  base: string;
  /** Resolved merge-base sha; "" when sem is unavailable. */
  mergeBase: string;
  available: boolean;
  /** Set when available is false: "sem-missing" | "sem-failed". */
  reason?: string;
  files: SemanticFileEntities[];
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

type Author = "user" | "agent" | "reviewer";

/**
 * Delivery lifecycle toward the agent: "pending" = invisible to agent polling
 * until submitted; "submitted" = visible, not yet delivered; "picked_up" = a
 * watcher acked delivery.
 */
type CommentStatus = "pending" | "submitted" | "picked_up";

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
  /**
   * Trimmed neighbor lines at comment time (up to 3 each way), used to
   * disambiguate when the snippet matches several lines. Optional — old
   * comments and terse API callers omit it.
   */
  context?: { before: string[]; after: string[] };
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
  /** Monotonic per-server creation sequence. UI ordering; NOT the agent cursor. */
  seq: number;
  status: CommentStatus;
  /**
   * Monotonic per-server sequence assigned at submission — the `since` cursor
   * for agent polling (`submitted=1`). Null while pending. Distinct from
   * `seq` because submission order differs from creation order.
   */
  submittedSeq: number | null;
  /**
   * Where the anchored line lives in the CURRENT working tree, re-located by
   * the server at read time ("new"-side anchors only). Equal to anchor.line
   * when the file hasn't moved, a different line after edits above it, null
   * when the line no longer exists (orphaned). Absent on replies and
   * review-level notes; "old"-side anchors echo anchor.line.
   */
  resolvedLine?: number | null;
  /**
   * Set on comments synthesized from a GitHub PR (web-side adapter; never
   * stored server-side). Such comments ride the same thread plumbing but
   * reply/resolve through the /api/github routes.
   */
  source?: "github";
  /** GitHub login of the comment's author. */
  ghLogin?: string;
  /** Link to this comment on github.com. */
  ghUrl?: string;
  /** Review-thread GraphQL id (roots only) — resolve target. Absent on conversation comments. */
  ghThreadId?: string;
  /** Root review comment databaseId (roots only) — reply target. */
  ghRootId?: number;
}

export interface CommentCreateRequest {
  dir: string;
  base: string;
  anchor?: CommentAnchor;
  parentId?: string;
  author: Author;
  body: string;
  /**
   * true → created as "pending" (invisible to agent polling until submitted).
   * Default false: submitted immediately — agents and API callers keep the
   * old fire-and-forget behavior.
   */
  pending?: boolean;
}

/** Submits every pending comment under `dir`, in creation order. */
export interface CommentsSubmitRequest {
  dir: string;
}

export interface CommentsSubmitResponse {
  submitted: number;
  cursor: number;
  /** true when submit started an agent session first (session-spawn command). */
  spawned: boolean;
}

/** Watcher delivery ack: marks submitted comments ≤ upTo as picked up. */
export interface CommentsAckRequest {
  dir: string;
  /** The submittedSeq cursor the watcher delivered through. */
  upTo: number;
}

export interface CommentPatchRequest {
  resolved?: boolean;
  body?: string;
}

export interface CommentListResponse {
  comments: Comment[];
  /**
   * Highest seq in the full store for this dir (not just this page). With
   * `submitted=1` it is the highest submittedSeq instead — the value to pass
   * back as `since` and to ack after delivering.
   */
  cursor: number;
}

// ---------------------------------------------------------------------------
// GitHub PR conversations
// ---------------------------------------------------------------------------

/** The open PR whose head is dir's checked-out branch. */
export interface GithubPrInfo {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  /** PR head sha — the commit new review comments are attached to. */
  headRefOid: string;
  baseRefName: string;
}

/** One comment in a GitHub review thread or the PR conversation tab. */
export interface GithubComment {
  /** REST databaseId — what reply calls reference. */
  id: number;
  login: string;
  body: string;
  createdAt: number;
  url: string;
}

export interface GithubThread {
  /** GraphQL node id, used by resolve/unresolve. */
  id: string;
  isResolved: boolean;
  /** True when the PR head moved past the commented diff. */
  isOutdated: boolean;
  /**
   * Synthesized from the thread's path/line/diffHunk so GitHub threads ride
   * the same placement machinery as local comments; null when unmappable.
   */
  anchor: CommentAnchor | null;
  /** Same semantics as Comment.resolvedLine: anchor re-located in the working tree. */
  resolvedLine?: number | null;
  comments: GithubComment[];
}

export type GithubUnavailableReason =
  | "gh-missing"
  | "not-github"
  | "no-pr"
  | "gh-failed";

/**
 * GitHub conversations for dir's checked-out branch. `available: false` —
 * gh missing, non-GitHub remote, no open PR, API failure — is a normal
 * response, never an error: the review simply shows local comments only.
 */
export interface GithubConvosResponse {
  dir: string;
  available: boolean;
  reason?: GithubUnavailableReason;
  pr: GithubPrInfo | null;
  threads: GithubThread[];
  /** Conversation-tab (issue) comments. */
  discussion: GithubComment[];
  /** True when a first page came back full — more may exist on GitHub. */
  truncated: boolean;
  computedAt: number;
}

export interface GithubReplyRequest {
  dir: string;
  /** Root review comment id (GithubComment.id); omit to post a conversation comment. */
  rootId?: number;
  body: string;
}

/** Opt-in "comment on GitHub instead of locally" from the composer. */
export interface GithubCommentRequest {
  dir: string;
  /** Line-anchored review comment; omit for a conversation (issue) comment. */
  anchor?: CommentAnchor;
  body: string;
}

export interface GithubResolveRequest {
  dir: string;
  threadId: string;
  resolved: boolean;
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
// REST surface (JSON except /api/file/raw; errors are { error: string } with 4xx/5xx)
// ---------------------------------------------------------------------------
//
// GET    /api/repos                          → RepoInfo[]
// POST   /api/repos/rescan                   → RepoInfo[]      (force re-discovery)
// GET    /api/diff?dir&base                  → DiffResponse    (full, all hunks)
// GET    /api/diff/summary?dir&base          → DiffSummaryResponse (no hunks, fast)
// GET    /api/diff/file?dir&base&path[&oldPath] → FileDiffResponse (one file's hunks)
// GET    /api/refs?dir                       → RefsResponse   (base-ref candidates)
// GET    /api/stack?dir&base                 → StackResponse  (branch-stack detection)
// GET    /api/semantic?dir&base              → SemanticDiffResponse (entity-level
//        diff via the optional sem CLI; available:false when sem can't deliver)
// GET    /api/file?dir&path[&rev]            → FileContentResponse
// GET    /api/file/raw?dir&path[&rev]        → raw file bytes (used by image previews)
// PUT    /api/file                           ← FileWriteRequest → FileContentResponse
// GET    /api/comments?dir[&base][&since][&submitted=1] → CommentListResponse
//        Agent polling passes submitted=1: only submitted comments, `since`
//        and `cursor` on the submittedSeq axis. Without it (UI): every
//        comment including pending, seq axis. Add `wait=1` to long-poll up
//        to LONG_POLL_MS when nothing is newer than `since`.
// POST   /api/comments                       ← CommentCreateRequest → Comment
// POST   /api/comments/submit                ← CommentsSubmitRequest
//        → CommentsSubmitResponse. When no agent session is listening on the
//        dir and the session-spawn command is configured, runs it and waits
//        for the new session's watcher before releasing the batch (504 and
//        comments stay pending if it never arrives).
// GET    /api/agent?dir                      → AgentStatusResponse
// POST   /api/comments/ack                   ← CommentsAckRequest → { acked: number }
// PATCH  /api/comments/:id                   ← CommentPatchRequest  → Comment
// GET    /api/github?dir[&refresh=1]         → GithubConvosResponse (open-PR review
//        threads + conversation for dir's branch; available:false when gh, a
//        GitHub remote, or an open PR is absent. refresh=1 busts the cache.)
// POST   /api/github/reply                   ← GithubReplyRequest → { ok: true }
// POST   /api/github/comment                 ← GithubCommentRequest → { ok: true }
// POST   /api/github/resolve                 ← GithubResolveRequest → { ok: true }
// PUT    /api/seen                           ← SeenRequest → { ok: true }
// GET    /api/prs?dir                        → PrListResponse (open + recently
//        closed PRs on the repo's origin forge, annotated with the local
//        checkout on each branch; prs:null when the forge can't be queried)
// POST   /api/worktrees                      ← WorktreeCreateRequest
//        → WorktreeCreateResponse (201). Runs the configured worktree-create
//        command for the branch, then re-scans discovery.
// DELETE /api/worktrees?dir                  → WorktreeRemoveResponse. Runs the
//        configured worktree-remove command; if the worktree is still
//        registered afterwards (e.g. the command only closed a session),
//        falls back to `git worktree remove`. Then re-scans discovery.
// GET    /api/commands                       → CommandsResponse
// PUT    /api/commands                       ← CommandsUpdateRequest → CommandsResponse
//        Persists the command templates (settings table).
// GET    /api/settings                       → UiSettings
// PUT    /api/settings                       ← UiSettings → UiSettings
//        Persists shared UI preferences (settings table); unknown fields
//        and wrongly-typed values are dropped, not rejected.
// POST   /api/fetch                          ← { dir, base } → { ok, baseBehind }
//        Runs `git fetch` for base's upstream remote so the review can be
//        re-based against origin's truth without leaving the page.
//
// The review page URL agents hand to the user:
//   /review?dir=<abs path>&base=<ref>
