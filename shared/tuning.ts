/** Every tunable in one place. Change here, not inline. */

export const TUNING = {
  /** Default HTTP port. 7373 is unregistered and easy to remember; override with REV_PORT. */
  PORT: 7373,

  /** Bind address. Loopback by default — rev has no auth. Set REV_HOST=0.0.0.0 to expose it to your LAN. */
  HOST: "127.0.0.1",

  /** Roots scanned for git repos. Override with REV_ROOTS (colon-separated). */
  DEFAULT_ROOTS: ["~/tea"],

  /** Max directory depth under a root when scanning for .git. Deeper repos exist but scanning cost grows fast. */
  DISCOVERY_MAX_DEPTH: 4,

  /** Re-run discovery this often even without a rescan request; repos appear rarely, so keep it slow. */
  DISCOVERY_INTERVAL_MS: 5 * 60_000,

  /**
   * Per-repo enrich results are reused while the repo's git-state mtimes are
   * unchanged AND the entry is younger than this. Git operations invalidate
   * instantly; only working-tree-only edits (dirty, changed count) can lag,
   * bounded by this window.
   */
  DISCOVERY_STATS_TTL_MS: 60_000,

  /** Checkouts with git activity newer than this count as active on the homepage. */
  ACTIVE_WINDOW_MS: 7 * 24 * 60 * 60_000,

  /** Remote hosts whose repos land in the "personal" scope. Override with REV_PERSONAL_HOSTS (comma-separated). */
  PERSONAL_HOSTS: ["git.naps.pt"],

  /** Remote owners treated as personal on any host (your own github org). Override with REV_PERSONAL_OWNERS. */
  PERSONAL_OWNERS: ["naps62"],

  /** Watcher debounce: coalesce bursts (git checkout, pnpm install) into one diff-invalidated event. */
  WATCH_DEBOUNCE_MS: 150,

  /** Dir names never watched or diffed: churn without review value. */
  WATCH_IGNORE: ["node_modules", ".git", "dist", "build", "target", ".next", ".turbo", "coverage"],

  /**
   * Dir names skipped when found directly in the user's home. The installed
   * service scans all of home, and on macOS merely reading these pops a system
   * permission dialog (Desktop, Documents, Downloads, Photos). Point REV_ROOTS
   * at one to scan it anyway.
   */
  HOME_IGNORE: [
    "Desktop",
    "Documents",
    "Downloads",
    "Pictures",
    "Movies",
    "Music",
    "Videos",
    "Library",
    "Applications",
    "Public",
  ],

  /**
   * Repos with more watchable files than this get .git-only watching (diff
   * refreshes on commit/checkout, not on every edit). Guards against trees
   * that would need tens of thousands of inotify watches.
   */
  WATCH_MAX_FILES: 30_000,

  /** Long-poll ceiling for GET /api/comments?wait=1. Below common proxy/idle timeouts. */
  LONG_POLL_MS: 25_000,

  /** Pending comments auto-submit after this long without a new comment (page focused). */
  PENDING_IDLE_SUBMIT_MS: 2 * 60_000,

  /**
   * Pending comments auto-submit this long after the page loses visibility.
   * Long enough that alt-tabbing to an editor to check something doesn't
   * ship a half-finished review.
   */
  PENDING_BLUR_SUBMIT_MS: 30_000,

  /** Diff context lines, matching git's default so hunks look familiar. */
  DIFF_CONTEXT_LINES: 3,

  /** Expanded files start fetching their hunks this many px before entering the viewport. */
  HUNK_PREFETCH_MARGIN_PX: 1200,

  /** Untracked files above this size are listed but not inlined (probably artifacts, and hashing them is wasted work). */
  MAX_UNTRACKED_BYTES: 512 * 1024,

  /** Kill a sem invocation after this long; the client falls back to text heuristics. Measured ~20ms on medium repos — this is a hang guard, not a budget. */
  SEM_TIMEOUT_MS: 10_000,

  /** SQLite location, under XDG data dir. */
  DB_PATH: "~/.local/share/rev/rev.db",

  /** Optional KEY=value file read at startup for per-machine overrides. */
  ENV_FILE: "~/.config/rev/env",
} as const;
