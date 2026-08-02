/**
 * Finds every repo and worktree on the machine worth reviewing.
 *
 * Scan config.roots for `.git` (dir or file — worktrees have a .git file)
 * up to config.depth (REV_DEPTH), skipping WATCH_IGNORE dirs. From each hit, also
 * `git worktree list` to catch worktrees living outside the roots. Results
 * are cached; `rescan()` forces a refresh and a slow timer
 * (DISCOVERY_INTERVAL_MS) keeps it eventually fresh.
 *
 * Scanning stops descending once a repo is found (nested independent repos
 * are not discovered; linked worktrees still are, via `git worktree list`).
 * Hidden directories are skipped.
 */

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";
import type { RepoInfo } from "@shared/types";
import { TUNING } from "@shared/tuning";
import { config } from "./config";
import { openCommentCounts } from "./db";
import {
  changedFileCount,
  defaultBase,
  divergence,
  headInfo,
  isDirty,
  listWorktrees,
  remoteUrl,
  resolveGitDir,
  run,
} from "./git";

/** Enriching a repo spawns several git processes; /api/repos may be polled, so cache briefly. */
const CACHE_TTL_MS = 5_000;
/** Repos enriched concurrently during a rescan. */
const ENRICH_CONCURRENCY = 8;

const IGNORED = new Set<string>(TUNING.WATCH_IGNORE);

let cache: { at: number; repos: RepoInfo[] } | null = null;
/**
 * Per-repo enrich results, reused while the repo's git-state fingerprint is
 * unchanged and the entry is younger than DISCOVERY_STATS_TTL_MS. Git
 * operations invalidate instantly (mtimes move); working-tree-only edits
 * (dirty/changedFiles) surface within the TTL. openComments is re-applied
 * fresh on every read.
 */
const enrichCache = new Map<string, { fp: string; at: number; info: RepoInfo }>();
let inFlight: Promise<RepoInfo[]> | null = null;
/** Dirs from the last scan; isKnownRepo fast path. */
const knownDirs = new Set<string>();
/** Dirs validated via git rev-parse (review URLs outside the roots). */
const validated = new Set<string>();

function walk(dir: string, depth: number, found: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((e) => e.name === ".git")) {
    try {
      found.push(realpathSync(dir)); // match `git worktree list` output, which prints real paths
    } catch {
      found.push(dir);
    }
    return;
  }
  if (depth >= config.depth) return;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith(".") || IGNORED.has(e.name)) continue;
    walk(join(dir, e.name), depth + 1, found);
  }
}

/** dir → mainDir for every checkout: scanned repos ∪ their linked worktrees. */
async function discover(): Promise<Map<string, string>> {
  const scanned: string[] = [];
  for (const root of config.roots) walk(root, 0, scanned);
  const map = new Map<string, string>();
  for (const repo of scanned) {
    if (map.has(repo)) continue;
    try {
      const wts = await listWorktrees(repo);
      const main = wts[0] ?? repo;
      for (const wt of wts) if (!map.has(wt)) map.set(wt, main);
      if (!map.has(repo)) map.set(repo, main);
    } catch {
      map.set(repo, repo); // bare/broken repo: list it un-worktreed
    }
  }
  return map;
}

/** Path relative to the containing root ("bullish/mvp"), so equal basenames stay distinguishable. */
function nameFor(dir: string, mainDir: string, isWorktree: boolean): string {
  if (isWorktree) return `${basename(mainDir)}/${basename(dir)}`;
  for (const root of config.roots) {
    const real = (() => {
      try {
        return realpathSync(root);
      } catch {
        return root;
      }
    })();
    if (dir.startsWith(real + sep)) return dir.slice(real.length + 1);
  }
  return basename(dir);
}

/**
 * Host and owner from a git remote URL. Handles https (with optional
 * credentials) and scp-like ssh (git@host:owner/repo.git).
 */
function parseRemote(url: string): { host: string; owner: string } | null {
  const ssh = /^(?:ssh:\/\/)?(?:[\w.-]+@)?([\w.-]+)[:/]([^/:]+)\/[^/]+?(?:\.git)?\/?$/;
  const http = /^https?:\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/([^/]+)\/[^/]+?(?:\.git)?\/?$/;
  const m = http.exec(url) ?? ssh.exec(url);
  return m ? { host: m[1]!, owner: m[2]! } : null;
}

/** Grouping bucket: "personal" for personal-host or missing remotes, else the remote owner org. */
export function scopeFor(url: string | null): string {
  if (!url) return "personal";
  const parsed = parseRemote(url);
  if (!parsed) return "personal";
  if (config.personalHosts.includes(parsed.host)) return "personal";
  const owner = parsed.owner.toLowerCase();
  if (config.personalOwners.includes(owner)) return "personal";
  return owner;
}

/**
 * Mtime fingerprint of the git state feeding enrich(): per-checkout HEAD and
 * index, plus the shared refs (commondir for linked worktrees — refs and
 * packed-refs live with the main repo). Any commit, checkout, fetch, or
 * branch update moves one of these.
 */
export function gitStateFingerprint(dir: string): string {
  const gd = resolveGitDir(dir);
  if (!gd) return "";
  let common = gd;
  try {
    const rel = readFileSync(join(gd, "commondir"), "utf8").trim();
    common = join(gd, rel);
  } catch {
    // main checkout: gitdir is the commondir
  }
  const parts: string[] = [];
  for (const p of [
    join(gd, "HEAD"),
    join(gd, "index"),
    join(common, "packed-refs"),
    join(common, "refs"),
    join(common, "refs", "heads"),
    join(common, "refs", "remotes"),
    join(common, "FETCH_HEAD"),
  ]) {
    try {
      parts.push(String(statSync(p).mtimeMs));
    } catch {
      parts.push("-");
    }
  }
  return parts.join(",");
}

async function enrich(dir: string, mainDir: string, openMap: Map<string, number>): Promise<RepoInfo> {
  const isWorktree = dir !== mainDir;
  const [hi, base, dirty, remote] = await Promise.all([
    headInfo(dir),
    defaultBase(dir),
    isDirty(dir),
    remoteUrl(dir),
  ]);
  const [changedFiles, div] = await Promise.all([
    base === null ? null : changedFileCount(dir, base),
    base === null ? null : divergence(dir, base),
  ]);

  let lastActivity: number | null = null;
  const gd = resolveGitDir(dir);
  if (gd) {
    for (const f of ["HEAD", "index"]) {
      try {
        const m = statSync(join(gd, f)).mtimeMs;
        if (lastActivity === null || m > lastActivity) lastActivity = m;
      } catch {
        // index may not exist yet
      }
    }
  }

  return {
    dir,
    name: nameFor(dir, mainDir, isWorktree),
    branch: hi.branch,
    head: hi.head,
    isWorktree,
    mainDir,
    defaultBase: base,
    dirty,
    changedFiles,
    openComments: openMap.get(dir) ?? 0,
    lastActivity: lastActivity === null ? null : Math.round(lastActivity),
    remoteUrl: remote,
    scope: scopeFor(remote),
    aheadBase: div?.ahead ?? null,
    behindBase: div?.behind ?? null,
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

async function doRescan(force: boolean): Promise<RepoInfo[]> {
  const map = await discover();
  let openMap: Map<string, number>;
  try {
    openMap = openCommentCounts();
  } catch {
    openMap = new Map(); // DB not opened (tests)
  }
  const now = Date.now();
  const enriched = await mapLimit([...map.entries()], ENRICH_CONCURRENCY, async ([dir, main]) => {
    const fp = gitStateFingerprint(dir);
    const hit = enrichCache.get(dir);
    if (
      !force &&
      hit &&
      hit.fp === fp &&
      fp !== "" &&
      now - hit.at < TUNING.DISCOVERY_STATS_TTL_MS
    ) {
      return { ...hit.info, openComments: openMap.get(dir) ?? 0 };
    }
    try {
      const info = await enrich(dir, main, openMap);
      // pre-enrich fp: state moving DURING enrich must invalidate next scan
      enrichCache.set(dir, { fp, at: now, info });
      return info;
    } catch {
      enrichCache.delete(dir);
      return null; // broken checkout: drop from the list rather than failing all repos
    }
  });
  for (const dir of enrichCache.keys()) if (!map.has(dir)) enrichCache.delete(dir);
  const repos = enriched.filter((r) => r !== null);
  repos.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
  knownDirs.clear();
  for (const r of repos) knownDirs.add(r.dir);
  cache = { at: Date.now(), repos };
  return repos;
}

/** Cached list, enriched (branch, dirty, changedFiles, openComments). */
export async function listRepos(): Promise<RepoInfo[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.repos;
  return rescan();
}

/**
 * Filesystem re-scan, returns the fresh list. `force` bypasses the per-repo
 * stats cache (the UI's Rescan button); the slow timer and listRepos reuse
 * cached stats while each repo's git state is unchanged.
 */
export async function rescan(force = false): Promise<RepoInfo[]> {
  inFlight ??= doRescan(force).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

function within(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + sep);
}

/**
 * True when `dir` is a discovered repo OR a valid git checkout anywhere on
 * disk — review URLs may point at dirs discovery hasn't seen; validate with
 * git, not the cache. Dirs outside the user's home (or an explicitly
 * configured root) are always rejected.
 */
export async function isKnownRepo(dir: string): Promise<boolean> {
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return false;
  }
  const allowed = [homedir(), ...config.roots].map((p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  });
  if (!allowed.some((p) => within(real, p))) return false;
  if (knownDirs.has(real) || knownDirs.has(dir) || validated.has(real)) return true;
  try {
    const top = (await run(dir, ["rev-parse", "--show-toplevel"])).trim();
    if (realpathSync(top) === real) {
      validated.add(real);
      return true;
    }
  } catch {
    // not a git checkout
  }
  return false;
}

/** Called by the timer and rescan endpoint; broadcasts repos-changed when the set differs. */
export function startDiscoveryTimer(onChange: () => void): void {
  setInterval(async () => {
    const before = new Set(knownDirs);
    try {
      await rescan();
    } catch {
      return;
    }
    const changed = before.size !== knownDirs.size || [...knownDirs].some((d) => !before.has(d));
    if (changed) onChange();
  }, TUNING.DISCOVERY_INTERVAL_MS);
}
