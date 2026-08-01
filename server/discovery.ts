/**
 * Finds every repo and worktree on the machine worth reviewing.
 *
 * Scan config.roots for `.git` (dir or file — worktrees have a .git file)
 * up to DISCOVERY_MAX_DEPTH, skipping WATCH_IGNORE dirs. From each hit, also
 * `git worktree list` to catch worktrees living outside the roots. Results
 * are cached; `rescan()` forces a refresh and a slow timer
 * (DISCOVERY_INTERVAL_MS) keeps it eventually fresh.
 */

import type { RepoInfo } from "@shared/types";

/** Cached list, enriched (branch, dirty, changedFiles, openComments). */
export async function listRepos(): Promise<RepoInfo[]> {
  throw new Error("not implemented");
}

/** Force a filesystem re-scan, returns the fresh list. */
export async function rescan(): Promise<RepoInfo[]> {
  throw new Error("not implemented");
}

/**
 * True when `dir` is a discovered repo OR a valid git checkout anywhere on
 * disk — review URLs may point at dirs discovery hasn't seen; validate with
 * git, not the cache.
 */
export async function isKnownRepo(dir: string): Promise<boolean> {
  throw new Error("not implemented");
}

/** Called by the timer and rescan endpoint; broadcasts repos-changed when the set differs. */
export function startDiscoveryTimer(onChange: () => void): void {
  throw new Error("not implemented");
}
