/**
 * All git interaction. Shells out to the `git` CLI; nothing else in the
 * server touches git directly.
 *
 * Every function takes `dir` = absolute path of a checkout (main repo or
 * linked worktree) and must work in both. Paths returned are repo-relative.
 */

import type { DiffResponse, FileContentResponse } from "@shared/types";

/** Thrown for git failures the API should surface as 400 (bad ref, not a repo). */
export class GitError extends Error {
  constructor(
    message: string,
    /** The git command that failed, for logs. */
    public readonly command: string,
  ) {
    super(message);
  }
}

/**
 * Compute the full diff of `dir`'s working tree against merge-base(base, HEAD):
 * committed changes since the merge-base AND uncommitted edits, plus untracked
 * files (as status "untracked", skipping files over MAX_UNTRACKED_BYTES).
 * Rename detection on. `seen`/`stale` are filled by the caller (routes), not
 * here — git.ts stays stateless.
 */
export async function computeDiff(dir: string, base: string): Promise<DiffResponse> {
  throw new Error("not implemented");
}

/** Read a file at a rev (null → working tree). 404s become GitError. */
export async function readFile(dir: string, path: string, rev: string | null): Promise<FileContentResponse> {
  throw new Error("not implemented");
}

/** sha256 (hex, first 16 chars) of content — the contentHash everywhere. */
export function hashContent(content: string | Uint8Array): string {
  throw new Error("not implemented");
}

/** Current branch (null when detached) and short HEAD sha. */
export async function headInfo(dir: string): Promise<{ branch: string | null; head: string }> {
  throw new Error("not implemented");
}

/** True when the working tree differs from HEAD (tracked files only). */
export async function isDirty(dir: string): Promise<boolean> {
  throw new Error("not implemented");
}

/**
 * Pick the ref reviews should default to: first existing of main, master,
 * origin/main, origin/master. Null when none exist (fresh repo).
 */
export async function defaultBase(dir: string): Promise<string | null> {
  throw new Error("not implemented");
}

/** `git worktree list` from any checkout: absolute paths of all linked checkouts. */
export async function listWorktrees(dir: string): Promise<string[]> {
  throw new Error("not implemented");
}
