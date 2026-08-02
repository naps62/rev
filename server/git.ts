/**
 * All git interaction. Shells out to the `git` CLI; nothing else in the
 * server touches git directly.
 *
 * Every function takes `dir` = absolute path of a checkout (main repo or
 * linked worktree) and must work in both. Paths returned are repo-relative.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { readFile as readFileBytes } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type {
  DiffLine,
  DiffResponse,
  DiffSummaryResponse,
  FileContentResponse,
  FileDiff,
  FileStatus,
  FileSummary,
} from "#shared/types";
import { TUNING } from "#shared/tuning";
import { parseUnifiedDiff } from "./diff-parser.ts";

/** Thrown for git failures the API should surface as 400 (bad ref, not a repo). */
export class GitError extends Error {
  /** The git command that failed, for logs. */
  readonly command: string;

  constructor(message: string, command: string) {
    super(message);
    this.command = command;
  }
}

/** Run git in `dir`; throws GitError on non-zero exit. */
export function run(dir: string, args: string[]): Promise<string> {
  return new Promise((res, rej) => {
    const proc = spawn("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
    proc.stderr.setEncoding("utf8").on("data", (chunk: string) => (err += chunk));
    proc.on("error", rej);
    proc.on("close", (code) => {
      if (code !== 0) {
        rej(new GitError(err.trim() || `git ${args[0]} failed (exit ${code})`, `git ${args.join(" ")}`));
      } else {
        res(out);
      }
    });
  });
}

/** sha256 (hex, first 16 chars) of content — the contentHash everywhere. */
export function hashContent(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

const decoder = new TextDecoder();

async function hashWorkingFile(dir: string, path: string): Promise<string> {
  try {
    return hashContent(await readFileBytes(join(dir, path)));
  } catch {
    return "";
  }
}

function isBinaryBytes(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

/** Untracked paths from `git status --porcelain=v1 -z` output. */
function untrackedFromStatusZ(z: string): string[] {
  const out: string[] = [];
  const parts = z.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    const x = entry[0]!;
    if (x === "R" || x === "C") i++; // rename/copy entries carry a second NUL-separated path
    if (entry.startsWith("?? ")) out.push(entry.slice(3));
  }
  return out.sort();
}

/**
 * Untracked file → all-add FileDiff. Files over MAX_UNTRACKED_BYTES are
 * listed with no hunks and contentHash "" (hashing artifacts is wasted work);
 * binary files get binary: true and no hunks.
 */
async function untrackedFileDiff(dir: string, path: string, withHunks: boolean): Promise<FileDiff> {
  const base: FileDiff = {
    path,
    status: "untracked",
    binary: false,
    hunks: [],
    additions: 0,
    deletions: 0,
    contentHash: "",
    seen: false,
    stale: false,
  };
  let size: number;
  try {
    size = statSync(join(dir, path)).size;
  } catch {
    return base;
  }
  if (size > TUNING.MAX_UNTRACKED_BYTES) return base;
  let bytes: Uint8Array;
  try {
    bytes = await readFileBytes(join(dir, path));
  } catch {
    return base;
  }
  const contentHash = hashContent(bytes);
  if (isBinaryBytes(bytes)) return { ...base, binary: true, contentHash };
  const textLines = decoder.decode(bytes).split("\n");
  if (textLines.at(-1) === "") textLines.pop(); // trailing newline artifact
  if (!withHunks) return { ...base, additions: textLines.length, contentHash };
  const lines: DiffLine[] = textLines.map((text, i) => ({ kind: "add", newLine: i + 1, text }));
  const hunks =
    lines.length === 0
      ? []
      : [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, header: "", lines }];
  return { ...base, hunks, additions: lines.length, contentHash };
}

/**
 * Compute the full diff of `dir`'s working tree against merge-base(base, HEAD):
 * committed changes since the merge-base AND uncommitted edits, plus untracked
 * files (as status "untracked", skipping files over MAX_UNTRACKED_BYTES).
 * Rename detection on. `seen`/`stale` are filled by the caller (routes), not
 * here — git.ts stays stateless.
 *
 * Mode-only changes come through as status "modified" with zero hunks.
 */
export async function computeDiff(dir: string, base: string): Promise<DiffResponse> {
  const mergeBase = (await run(dir, ["merge-base", base, "HEAD"])).trim();
  const [diffText, statusZ, hi, behind] = await Promise.all([
    // no second rev: diff merge-base against the working tree, catching uncommitted edits
    run(dir, ["diff", mergeBase, "--find-renames", "--no-color", `-U${TUNING.DIFF_CONTEXT_LINES}`]),
    run(dir, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    headInfo(dir),
    baseBehind(dir, base),
  ]);

  const files: FileDiff[] = [];
  for (const p of parseUnifiedDiff(diffText)) {
    const contentHash = p.status === "deleted" ? "" : await hashWorkingFile(dir, p.path);
    files.push({ ...p, contentHash, seen: false, stale: false });
  }
  for (const path of untrackedFromStatusZ(statusZ)) {
    files.push(await untrackedFileDiff(dir, path, true));
  }

  return {
    dir,
    base,
    mergeBase,
    head: hi.head,
    branch: hi.branch,
    files,
    computedAt: Date.now(),
    baseBehind: behind,
  };
}

/** `-z` numstat entry. Rename entries put "" in the inline slot and carry two path tokens after. */
function parseNumstatZ(z: string): Array<{ additions: number; deletions: number; path: string; oldPath?: string; binary: boolean }> {
  const out: Array<{ additions: number; deletions: number; path: string; oldPath?: string; binary: boolean }> = [];
  const tokens = z.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(tokens[i]!);
    if (!m) continue;
    const binary = m[1] === "-";
    const additions = binary ? 0 : Number(m[1]);
    const deletions = binary ? 0 : Number(m[2]);
    if (m[3] !== "") {
      out.push({ additions, deletions, path: m[3]!, binary });
    } else {
      const oldPath = tokens[++i] ?? "";
      const path = tokens[++i] ?? "";
      out.push({ additions, deletions, path, oldPath, binary });
    }
  }
  return out;
}

/** `-z` name-status entries → path → status letter (path = new path for renames). */
function parseNameStatusZ(z: string): Map<string, string> {
  const out = new Map<string, string>();
  const tokens = z.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i]!;
    if (!/^[A-Z]/.test(status)) continue;
    const kind = status[0]!;
    if (kind === "R" || kind === "C") {
      i++; // old path
      out.set(tokens[++i] ?? "", kind);
    } else {
      out.set(tokens[++i] ?? "", kind);
    }
  }
  return out;
}

function statusFromLetter(letter: string | undefined, hasOldPath: boolean): FileStatus {
  if (hasOldPath || letter === "R") return "renamed";
  if (letter === "A") return "added";
  if (letter === "D") return "deleted";
  return "modified";
}

/**
 * Hunk-less counterpart of computeDiff: same file list, stats from
 * `--numstat` so no diff content is ever generated or parsed. Cost stays
 * near-constant as the diff grows; hunks are served per file by
 * computeFileDiff. `seen`/`stale` are filled by routes.
 */
export async function computeDiffSummary(dir: string, base: string): Promise<DiffSummaryResponse> {
  const mergeBase = (await run(dir, ["merge-base", base, "HEAD"])).trim();
  const [numstatZ, nameStatusZ, statusZ, hi, behind] = await Promise.all([
    run(dir, ["diff", mergeBase, "--find-renames", "--numstat", "-z"]),
    run(dir, ["diff", mergeBase, "--find-renames", "--name-status", "-z"]),
    run(dir, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    headInfo(dir),
    baseBehind(dir, base),
  ]);

  const letters = parseNameStatusZ(nameStatusZ);
  const files: FileSummary[] = [];
  for (const e of parseNumstatZ(numstatZ)) {
    const status = statusFromLetter(letters.get(e.path), e.oldPath !== undefined);
    const contentHash = status === "deleted" ? "" : await hashWorkingFile(dir, e.path);
    files.push({
      path: e.path,
      ...(e.oldPath !== undefined && e.oldPath !== e.path ? { oldPath: e.oldPath } : {}),
      status,
      binary: e.binary,
      additions: e.additions,
      deletions: e.deletions,
      contentHash,
      seen: false,
      stale: false,
    });
  }
  for (const path of untrackedFromStatusZ(statusZ)) {
    const { hunks: _hunks, ...summary } = await untrackedFileDiff(dir, path, false);
    files.push(summary);
  }

  return {
    dir,
    base,
    mergeBase,
    head: hi.head,
    branch: hi.branch,
    files,
    computedAt: Date.now(),
    baseBehind: behind,
  };
}

/**
 * Full diff of a single file against merge-base(base, HEAD), untracked files
 * included. `oldPath` (from the summary) must be passed for renamed files —
 * pathspec-limited diffs can't pair a rename without the old side. Null when
 * the path has no changes.
 */
export async function computeFileDiff(
  dir: string,
  base: string,
  path: string,
  oldPath?: string,
): Promise<FileDiff | null> {
  const untracked = (
    await run(dir, ["ls-files", "--others", "--exclude-standard", "-z", "--", path])
  )
    .split("\0")
    .includes(path);
  if (untracked) return untrackedFileDiff(dir, path, true);

  const mergeBase = (await run(dir, ["merge-base", base, "HEAD"])).trim();
  const pathspec = oldPath && oldPath !== path ? [path, oldPath] : [path];
  const diffText = await run(dir, [
    "diff",
    mergeBase,
    "--find-renames",
    "--no-color",
    `-U${TUNING.DIFF_CONTEXT_LINES}`,
    "--",
    ...pathspec,
  ]);
  const parsed = parseUnifiedDiff(diffText).find((p) => p.path === path);
  if (!parsed) return null;
  const contentHash = parsed.status === "deleted" ? "" : await hashWorkingFile(dir, path);
  return { ...parsed, contentHash, seen: false, stale: false };
}

/** Read a file at a rev (null → working tree). 404s become GitError. */
export async function readFile(dir: string, path: string, rev: string | null): Promise<FileContentResponse> {
  if (rev === null) {
    let bytes: Uint8Array;
    try {
      bytes = await readFileBytes(join(dir, path));
    } catch {
      throw new GitError(`no such file in working tree: ${path}`, "read");
    }
    return { dir, path, rev, content: decoder.decode(bytes), contentHash: hashContent(bytes) };
  }
  const content = await run(dir, ["show", `${rev}:${path}`]);
  return { dir, path, rev, content, contentHash: hashContent(content) };
}

/** Current branch (null when detached) and short HEAD sha ("" before first commit). */
export async function headInfo(dir: string): Promise<{ branch: string | null; head: string }> {
  const branch = (await run(dir, ["branch", "--show-current"])).trim() || null;
  let head = "";
  try {
    head = (await run(dir, ["rev-parse", "--short", "HEAD"])).trim();
  } catch {
    // unborn HEAD (no commits yet)
  }
  return { branch, head };
}

/** True when the working tree differs from HEAD (tracked files only). */
export async function isDirty(dir: string): Promise<boolean> {
  // --no-optional-locks: status must not rewrite the index — discovery reads
  // its mtime as lastActivity, and a plain status would bump it on every scan.
  return (await run(dir, ["--no-optional-locks", "status", "--porcelain", "-uno"])).trim().length > 0;
}

/**
 * Pick the ref reviews should default to, among main, master, origin/main,
 * origin/master. When several exist, prefer the one sharing the NEWEST
 * merge-base with HEAD: worktree branches are usually cut from origin/main
 * while the local main sits stale, and diffing against stale main drags all
 * of main's history since the fork point into the review. Null when none
 * exist (fresh repo).
 */
export async function defaultBase(dir: string): Promise<string | null> {
  const existing: string[] = [];
  for (const ref of ["main", "master", "origin/main", "origin/master"]) {
    try {
      await run(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      existing.push(ref);
    } catch {
      // try next
    }
  }
  if (existing.length <= 1) return existing[0] ?? null;
  let best = existing[0]!;
  let bestTime = -1;
  for (const ref of existing) {
    try {
      const mb = (await run(dir, ["merge-base", ref, "HEAD"])).trim();
      const t = Number((await run(dir, ["show", "-s", "--format=%ct", mb])).trim());
      if (t > bestTime) {
        bestTime = t;
        best = ref;
      }
    } catch {
      // unborn HEAD or unrelated histories: keep the first existing ref
    }
  }
  return best;
}

/**
 * Upstream counterpart of `base`: its configured upstream when it's a local
 * branch, itself when it's already remote-tracking (origin/x), null otherwise.
 */
async function baseUpstream(dir: string, base: string): Promise<string | null> {
  try {
    return (await run(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${base}@{upstream}`])).trim();
  } catch {
    // no upstream configured
  }
  const remotes = (await run(dir, ["remote"])).split("\n").filter(Boolean);
  const prefix = base.split("/")[0];
  if (prefix && remotes.includes(prefix)) return base;
  for (const r of remotes) {
    try {
      await run(dir, ["rev-parse", "--verify", "--quiet", `${r}/${base}^{commit}`]);
      return `${r}/${base}`;
    } catch {
      // try next remote
    }
  }
  return null;
}

/** Commits `base` is behind its upstream; null when no upstream / count fails; 0 when current. */
export async function baseBehind(dir: string, base: string): Promise<number | null> {
  const up = await baseUpstream(dir, base);
  if (up === null || up === base) return up === base ? 0 : null;
  try {
    return Number((await run(dir, ["rev-list", "--count", `${base}..${up}`])).trim());
  } catch {
    return null;
  }
}

/** `origin` remote URL, null when unset. */
export async function remoteUrl(dir: string): Promise<string | null> {
  try {
    return (await run(dir, ["remote", "get-url", "origin"])).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Commit divergence between HEAD and `base`: how many commits each side has
 * that the other doesn't. behind > 0 → the checkout needs a rebase/merge.
 * Null when the count fails (unborn HEAD, bad ref).
 */
export async function divergence(
  dir: string,
  base: string,
): Promise<{ ahead: number; behind: number } | null> {
  try {
    const out = (await run(dir, ["rev-list", "--left-right", "--count", `${base}...HEAD`])).trim();
    const [behind, ahead] = out.split(/\s+/).map(Number);
    if (behind === undefined || ahead === undefined || Number.isNaN(behind) || Number.isNaN(ahead)) {
      return null;
    }
    return { ahead, behind };
  } catch {
    return null;
  }
}

/** `git fetch` the remote behind `base`'s upstream. Throws GitError when base has no remote. */
export async function fetchBase(dir: string, base: string): Promise<void> {
  const up = await baseUpstream(dir, base);
  if (up === null) throw new GitError(`base ${base} has no upstream remote to fetch`, "fetch");
  const remote = up.split("/")[0]!;
  await run(dir, ["fetch", remote]);
}

/** `git worktree list` from any checkout: absolute paths of all linked checkouts (main first). */
export async function listWorktrees(dir: string): Promise<string[]> {
  const out = await run(dir, ["worktree", "list", "--porcelain"]);
  return out
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length));
}

/** Changed-file count vs merge-base(base, HEAD): tracked names + untracked. Null on failure. */
export async function changedFileCount(dir: string, base: string): Promise<number | null> {
  try {
    const mb = (await run(dir, ["merge-base", base, "HEAD"])).trim();
    const [names, untracked] = await Promise.all([
      run(dir, ["diff", "--name-only", mb]),
      run(dir, ["ls-files", "--others", "--exclude-standard"]),
    ]);
    const count = (s: string) => s.split("\n").filter(Boolean).length;
    return count(names) + count(untracked);
  } catch {
    return null;
  }
}

/**
 * Repo-relative prefixes git ignores (dirs come collapsed with a trailing
 * slash, stripped here). Watchers prune these subtrees; .venv/out/cache-style
 * artifact dirs would otherwise cost tens of thousands of inotify watches.
 */
export async function ignoredPrefixes(dir: string): Promise<string[]> {
  const z = await run(dir, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
    "-z",
  ]);
  return z
    .split("\0")
    .filter(Boolean)
    .map((p) => (p.endsWith("/") ? p.slice(0, -1) : p));
}

/** Tracked + untracked (non-ignored) file count — what a working-tree watcher would cover. */
export async function watchableFileCount(dir: string): Promise<number> {
  const [tracked, untracked] = await Promise.all([
    run(dir, ["ls-files", "-z"]),
    run(dir, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const count = (z: string) => z.split("\0").filter(Boolean).length;
  return count(tracked) + count(untracked);
}

/**
 * Absolute path of the gitdir backing `dir`: `.git` itself for main
 * checkouts, the `gitdir:` target for linked worktrees. Null when not a repo.
 */
export function resolveGitDir(dir: string): string | null {
  const dotGit = join(dir, ".git");
  let st;
  try {
    st = statSync(dotGit);
  } catch {
    return null;
  }
  if (st.isDirectory()) return dotGit;
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
  if (!m) return null;
  const p = m[1]!;
  return isAbsolute(p) ? p : resolve(dir, p);
}

/**
 * Ref names usable as a review base: local branches then remote-tracking
 * refs, symbolic entries (origin/HEAD) excluded, current defaultBase first.
 */
export async function listRefs(dir: string): Promise<string[]> {
  const out = await run(dir, [
    "for-each-ref",
    "--format=%(refname:short)%09%(symref)",
    "refs/heads",
    "refs/remotes",
  ]);
  const refs: string[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [name, symref] = line.split("\t");
    if (!name || symref) continue; // origin/HEAD and friends
    refs.push(name);
  }
  const base = await defaultBase(dir);
  if (base !== null) {
    const i = refs.indexOf(base);
    if (i > 0) {
      refs.splice(i, 1);
      refs.unshift(base);
    }
  }
  return refs;
}
