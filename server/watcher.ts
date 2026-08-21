/**
 * Filesystem watching for repos with live viewers.
 *
 * Reference-counted: first WS subscriber to a dir starts watchers (ignoring
 * WATCH_IGNORE names, everything git ignores, and .git internals except
 * HEAD/index/refs, which signal commits/checkouts); last unsubscribe stops
 * them. Events are debounced (WATCH_DEBOUNCE_MS) and delivered as one
 * callback with the batch of repo-relative paths. For linked worktrees the
 * real gitdir lives under the main repo's .git/worktrees/<name>; a second
 * watcher covers its HEAD/index.
 *
 * Repos with more than WATCH_MAX_FILES watchable files get .git-only
 * watching: the diff refreshes on commits/checkouts but not on plain edits.
 * Watching such trees once wedged the daemon with ~70k inotify fds.
 */

import { join, relative, sep } from "node:path";
import { type FSWatcher, watch } from "chokidar";
import { TUNING } from "#shared/tuning";
import { ignoredPrefixes, resolveGitDir, watchableFileCount } from "./git.ts";

export type WatchCallback = (dir: string, paths: string[]) => void;

const IGNORE_NAMES = new Set<string>(
  TUNING.WATCH_IGNORE.filter((n) => n !== ".git"),
);
const GIT_ALLOWED = new Set(["HEAD", "index", "refs", "packed-refs"]);

interface Entry {
  refs: number;
  watchers: FSWatcher[];
  pending: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
}

const entries = new Map<string, Entry>();
let sink: WatchCallback | null = null;

/** Register the single global sink for change events (index.ts wires this to WS broadcast). */
export function onRepoChange(cb: WatchCallback): void {
  sink = cb;
}

/** chokidar v4 has no globs; ignore via callback. */
function makeIgnored(root: string, gitIgnored: Set<string>) {
  return (p: string): boolean => {
    const rel = relative(root, p);
    if (!rel || rel.startsWith("..")) return false;
    const parts = rel.split(sep);
    const gi = parts.indexOf(".git");
    if (gi >= 0) {
      const inside = parts.slice(gi + 1);
      if (inside.length === 0) return false; // .git itself (dir to descend, or worktree pointer file)
      return !GIT_ALLOWED.has(inside[0]!);
    }
    if (parts.some((seg) => IGNORE_NAMES.has(seg))) return true;
    // any ancestor prefix (or the path itself) being git-ignored prunes the subtree
    let prefix = "";
    for (const seg of parts) {
      prefix = prefix ? `${prefix}/${seg}` : seg;
      if (gitIgnored.has(prefix)) return true;
    }
    return false;
  };
}

/** For a gitdir watcher: only HEAD/index/refs matter. */
function makeGitdirIgnored(gitdir: string) {
  return (p: string): boolean => {
    const rel = relative(gitdir, p);
    if (!rel || rel.startsWith("..")) return false;
    return !GIT_ALLOWED.has(rel.split(sep)[0]!);
  };
}

/** Increment watch refcount for dir, starting watchers (async) if first. */
export function subscribe(dir: string): void {
  const existing = entries.get(dir);
  if (existing) {
    existing.refs++;
    return;
  }
  const entry: Entry = {
    refs: 1,
    watchers: [],
    pending: new Set(),
    timer: null,
  };
  entries.set(dir, entry);
  void start(dir, entry);
}

async function start(dir: string, entry: Entry): Promise<void> {
  const onEvent = (p: string) => {
    const rel = relative(dir, p);
    // git-internal churn invalidates the diff but is not a working-tree path
    if (rel && !rel.startsWith("..") && !rel.split(sep).includes(".git"))
      entry.pending.add(rel);
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      const paths = [...entry.pending].sort();
      entry.pending.clear();
      sink?.(dir, paths);
    }, TUNING.WATCH_DEBOUNCE_MS);
  };
  // unsubscribe may race the async git calls below; adopt() closes late watchers
  const adopt = (w: FSWatcher): boolean => {
    if (entries.get(dir) !== entry) {
      void w.close();
      return false;
    }
    entry.watchers.push(w);
    return true;
  };

  let gitOnly = false;
  let gitIgnored = new Set<string>();
  try {
    const count = await watchableFileCount(dir);
    if (count > TUNING.WATCH_MAX_FILES) {
      gitOnly = true;
      console.warn(
        `watch ${dir}: ${count} watchable files > ${TUNING.WATCH_MAX_FILES}, ` +
          `falling back to .git-only watching (no live edit updates)`,
      );
    } else {
      gitIgnored = new Set(await ignoredPrefixes(dir));
    }
  } catch {
    // not fatal: fall through with name-based ignores only
  }
  if (entries.get(dir) !== entry) return;

  if (gitOnly) {
    const gitdir = resolveGitDir(dir) ?? join(dir, ".git");
    const gw = watch(gitdir, {
      ignored: makeGitdirIgnored(gitdir),
      ignoreInitial: true,
    });
    gw.on("all", (_event, p) => onEvent(p));
    adopt(gw);
    return;
  }

  const main = watch(dir, {
    ignored: makeIgnored(dir, gitIgnored),
    ignoreInitial: true,
  });
  main.on("all", (_event, p) => onEvent(p));
  if (!adopt(main)) return;

  const gitdir = resolveGitDir(dir);
  if (
    gitdir &&
    (relative(dir, gitdir).startsWith("..") || relative(dir, gitdir) === "")
  ) {
    const gw = watch(gitdir, {
      ignored: makeGitdirIgnored(gitdir),
      ignoreInitial: true,
    });
    gw.on("all", (_event, p) => onEvent(p));
    adopt(gw);
  }
}

/** Decrement refcount, stopping the watcher when it hits zero. */
export function unsubscribe(dir: string): void {
  const entry = entries.get(dir);
  if (!entry) return;
  entry.refs--;
  if (entry.refs > 0) return;
  entries.delete(dir);
  if (entry.timer) clearTimeout(entry.timer);
  for (const w of entry.watchers) void w.close();
}
