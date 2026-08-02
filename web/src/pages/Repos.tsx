import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import type { RepoInfo } from "@shared/types";
import { TUNING } from "@shared/tuning";
import * as api from "../api";
import { LiveDot } from "../components/LiveDot";
import { basename, cx, relativeTime } from "../util";
import { useRevSocket } from "../ws";

interface RepoEntry {
  repo: RepoInfo;
  /** Worktrees with review-worthy work, most recent first. */
  activeWorktrees: RepoInfo[];
  /** Worktrees with nothing going on, hidden behind a per-repo toggle. */
  staleWorktrees: RepoInfo[];
  active: boolean;
}

interface Group {
  /** Path segments between the common root and the repo, "" for top-level. */
  label: string;
  entries: RepoEntry[];
}

/**
 * A checkout counts as active when work is in flight: uncommitted edits, open
 * comment threads, or git activity inside ACTIVE_WINDOW_MS. Unmerged commits
 * alone don't qualify — an abandoned branch stays stale however far ahead of
 * base it sits.
 */
function isActive(r: RepoInfo, now: number): boolean {
  return (
    r.dirty ||
    r.openComments > 0 ||
    (r.lastActivity != null && now - r.lastActivity < TUNING.ACTIVE_WINDOW_MS)
  );
}

const parentDir = (dir: string) =>
  dir.replace(/\/+$/, "").split("/").slice(0, -1).join("/");

/**
 * Groups repos by their parent path relative to the common root (e.g.
 * "yolo/", "bullish/") and nests worktrees under their main checkout via
 * RepoInfo.mainDir. Worktrees whose main repo wasn't discovered stay top-level.
 */
function groupRepos(repos: RepoInfo[], now: number): Group[] {
  const byDir = new Map(repos.map((r) => [r.dir, r]));
  const worktreesByMain = new Map<string, RepoInfo[]>();
  const tops: RepoInfo[] = [];
  for (const r of repos) {
    if (r.isWorktree && r.mainDir !== r.dir && byDir.has(r.mainDir)) {
      worktreesByMain.set(r.mainDir, [...(worktreesByMain.get(r.mainDir) ?? []), r]);
    } else {
      tops.push(r);
    }
  }

  const parents = tops.map((r) => parentDir(r.dir).split("/"));
  let prefixLen = parents[0]?.length ?? 0;
  for (const p of parents) {
    let i = 0;
    while (i < prefixLen && i < p.length && p[i] === parents[0]![i]) i++;
    prefixLen = Math.min(prefixLen, i);
  }

  const groups = new Map<string, RepoEntry[]>();
  for (const r of tops) {
    const rel = parentDir(r.dir).split("/").slice(prefixLen).join("/");
    const worktrees = (worktreesByMain.get(r.dir) ?? []).sort(
      (a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0),
    );
    const entry: RepoEntry = {
      repo: r,
      activeWorktrees: worktrees.filter((w) => isActive(w, now)),
      staleWorktrees: worktrees.filter((w) => !isActive(w, now)),
      active: isActive(r, now) || worktrees.some((w) => isActive(w, now)),
    };
    groups.set(rel, [...(groups.get(rel) ?? []), entry]);
  }
  const activityOf = (e: RepoEntry) =>
    Math.max(
      e.repo.lastActivity ?? 0,
      ...[...e.activeWorktrees, ...e.staleWorktrees].map((w) => w.lastActivity ?? 0),
    );
  return [...groups.entries()]
    .map(([label, entries]) => ({
      label,
      entries: entries.sort((a, b) => activityOf(b) - activityOf(a)),
    }))
    .sort(
      (a, b) =>
        Math.max(...b.entries.map(activityOf), 0) - Math.max(...a.entries.map(activityOf), 0),
    );
}

/** Scope names ordered by their most recent activity, so the busiest context leads. */
function scopeOrder(repos: RepoInfo[]): string[] {
  const latest = new Map<string, number>();
  for (const r of repos) {
    const t = Math.max(latest.get(r.scope) ?? 0, r.lastActivity ?? 0);
    latest.set(r.scope, t);
  }
  return [...latest.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
}

const SCOPE_KEY = "rev.scope";

const GRID = "grid grid-cols-[minmax(14rem,2fr)_minmax(12rem,1.5fr)_6rem_7rem_7rem] items-center gap-x-4";

export function Repos() {
  const qc = useQueryClient();
  const reposQ = useQuery({ queryKey: ["repos"], queryFn: api.getRepos });

  const status = useRevSocket(undefined, (msg) => {
    if (msg.type === "repos-changed") qc.invalidateQueries({ queryKey: ["repos"] });
  });

  const rescan = useMutation({
    mutationFn: api.rescanRepos,
    onSuccess: (repos) => qc.setQueryData(["repos"], repos),
  });

  const now = useMemo(() => Date.now(), [reposQ.data]);
  const repos = reposQ.data ?? [];
  const scopes = useMemo(() => scopeOrder(repos), [repos]);

  const [scope, setScope] = useState<string | null>(() => localStorage.getItem(SCOPE_KEY));
  const [showInactive, setShowInactive] = useState(false);
  const [staleOpen, setStaleOpen] = useState<Set<string>>(new Set);

  // Fall back to the busiest scope when nothing (or a vanished scope) is saved.
  const currentScope =
    scope != null && scopes.includes(scope) ? scope : scopes[0] ?? null;

  const selectScope = (s: string) => {
    setScope(s);
    localStorage.setItem(SCOPE_KEY, s);
    setShowInactive(false);
    setStaleOpen(new Set());
  };

  const activeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of scopes) {
      counts.set(s, groupRepos(repos.filter((r) => r.scope === s), now)
        .flatMap((g) => g.entries)
        .filter((e) => e.active).length);
    }
    return counts;
  }, [repos, scopes, now]);

  const groups = useMemo(
    () => groupRepos(repos.filter((r) => r.scope === currentScope), now),
    [repos, currentScope, now],
  );
  const inactiveCount = groups.flatMap((g) => g.entries).filter((e) => !e.active).length;
  const visibleGroups = showInactive
    ? groups
    : groups
        .map((g) => ({ ...g, entries: g.entries.filter((e) => e.active) }))
        .filter((g) => g.entries.length > 0);

  const toggleStale = (dir: string) =>
    setStaleOpen((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });

  return (
    <div className="w-full px-4 pb-8">
      <header className="flex h-14 items-center gap-3">
        <h1 className="font-mono text-[15px] font-bold text-fg">
          rev<span className="text-accent">_</span>
        </h1>
        <p className="text-[12px] text-faint">always-on review</p>
        <div className="ml-auto flex items-center gap-3">
          <LiveDot status={status} />
          <button
            type="button"
            onClick={() => rescan.mutate()}
            disabled={rescan.isPending}
            className="rounded-sm border border-edge px-2.5 py-1 text-[12px] text-mute transition-colors duration-150 hover:border-accent/50 hover:text-fg disabled:text-faint"
          >
            {rescan.isPending ? "Scanning…" : "Rescan"}
          </button>
        </div>
      </header>

      {scopes.length > 1 && (
        <nav aria-label="Project scope" className="mb-3 flex items-end gap-1 border-b border-edge">
          {scopes.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => selectScope(s)}
              aria-current={s === currentScope ? "page" : undefined}
              className={cx(
                "-mb-px flex items-baseline gap-1.5 border-b-2 px-2.5 pb-1.5 pt-1 font-mono text-[12px] transition-colors duration-150",
                s === currentScope
                  ? "border-accent text-fg"
                  : "border-transparent text-mute hover:text-fg",
              )}
            >
              {s}
              <span
                className={cx(
                  "font-mono text-[10.5px] tabular-nums",
                  s === currentScope ? "text-accent" : "text-faint",
                )}
              >
                {activeCounts.get(s) ?? 0}
              </span>
            </button>
          ))}
        </nav>
      )}

      {reposQ.isPending && (
        <ul className="divide-y divide-edge-soft rounded-md border border-edge bg-panel">
          {[0, 1, 2].map((i) => (
            <li key={i} className="animate-pulse px-3 py-3">
              <div className="h-3.5 w-40 rounded-sm bg-raise" />
              <div className="mt-2 h-2.5 w-64 rounded-sm bg-raise/70" />
            </li>
          ))}
        </ul>
      )}

      {reposQ.error && (
        <div className="rounded-md border border-del/40 bg-panel px-4 py-3">
          <p className="text-[13px] text-del">{(reposQ.error as Error).message}</p>
          <button
            type="button"
            onClick={() => reposQ.refetch()}
            className="mt-2 text-[12px] text-mute hover:text-fg"
          >
            Retry
          </button>
        </div>
      )}

      {reposQ.data && groups.length === 0 && (
        <div className="rounded-md border border-edge bg-panel px-4 py-8 text-center">
          <p className="text-[13px] text-mute">No git repos discovered under the configured roots.</p>
          <p className="mt-1 text-[12px] text-faint">
            Set REV_ROOTS on the server, then rescan.
          </p>
        </div>
      )}

      {groups.length > 0 && (
        <div className="overflow-hidden rounded-md border border-edge bg-panel">
          <div
            className={cx(
              GRID,
              "border-b border-edge px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-faint",
            )}
          >
            <span>Repo</span>
            <span>Branch → base</span>
            <span className="text-right">Changed</span>
            <span className="text-right">Comments</span>
            <span className="text-right">Activity</span>
          </div>
          {visibleGroups.length === 0 && (
            <p className="px-3 py-6 text-center text-[12.5px] text-mute">
              Nothing in active development here right now.
            </p>
          )}
          <div className="divide-y divide-edge-soft">
            {visibleGroups.map((g) => (
              <div key={g.label || "(root)"}>
                {g.label && (
                  <p className="px-3 pb-0.5 pt-2 font-mono text-[11px] text-faint">
                    {g.label}/
                  </p>
                )}
                {g.entries.map((e) => (
                  <div key={e.repo.dir} className={cx(!e.active && "opacity-55")}>
                    <RepoRow repo={e.repo} indent={g.label ? 1 : 0} />
                    {e.activeWorktrees.map((w) => (
                      <RepoRow key={w.dir} repo={w} indent={(g.label ? 1 : 0) + 1} isWorktree />
                    ))}
                    {e.staleWorktrees.length > 0 && (
                      <button
                        type="button"
                        onClick={() => toggleStale(e.repo.dir)}
                        className="block w-full px-3 py-1 text-left font-mono text-[11px] text-faint transition-colors duration-150 hover:text-mute"
                        style={{ paddingLeft: 12 + ((g.label ? 1 : 0) + 1) * 16 }}
                      >
                        {staleOpen.has(e.repo.dir)
                          ? "hide stale worktrees"
                          : `show ${e.staleWorktrees.length} stale worktree${e.staleWorktrees.length === 1 ? "" : "s"}`}
                      </button>
                    )}
                    {staleOpen.has(e.repo.dir) &&
                      e.staleWorktrees.map((w) => (
                        <div key={w.dir} className="opacity-55">
                          <RepoRow repo={w} indent={(g.label ? 1 : 0) + 1} isWorktree />
                        </div>
                      ))}
                  </div>
                ))}
              </div>
            ))}
          </div>
          {inactiveCount > 0 && (
            <button
              type="button"
              onClick={() => setShowInactive((v) => !v)}
              className="block w-full border-t border-edge-soft px-3 py-2 text-left font-mono text-[11.5px] text-faint transition-colors duration-150 hover:bg-raise/40 hover:text-mute"
            >
              {showInactive
                ? "hide inactive projects"
                : `show ${inactiveCount} inactive project${inactiveCount === 1 ? "" : "s"}`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function RepoRow({
  repo: r,
  indent,
  isWorktree,
}: {
  repo: RepoInfo;
  indent: number;
  isWorktree?: boolean;
}) {
  // A worktree's dir name repeats its branch — the branch IS its identity,
  // so worktree rows lead with it and the branch column keeps only "→ base".
  const checkout = r.branch ?? `detached @ ${r.head}`;
  return (
    <Link
      href={api.href("/review", { dir: r.dir, base: r.defaultBase ?? "main" })}
      title={r.dir}
      className={cx(GRID, "px-3 py-2 transition-colors duration-150 hover:bg-raise/60")}
    >
      <span
        className="flex min-w-0 items-center gap-2"
        style={{ paddingLeft: indent * 16 }}
      >
        {isWorktree && (
          <span aria-hidden className="shrink-0 font-mono text-[11px] leading-none text-faint">
            └
          </span>
        )}
        <span
          title={r.dirty ? "uncommitted changes" : "clean"}
          className={cx(
            "size-1.5 shrink-0 rounded-full",
            r.dirty ? "bg-accent" : "bg-edge",
          )}
        />
        <span className="truncate text-[13px] font-medium text-fg">
          {isWorktree ? checkout : basename(r.dir)}
        </span>
        {isWorktree && (
          <span className="shrink-0 rounded-sm bg-raise px-1 py-px font-mono text-[10.5px] text-faint">
            worktree
          </span>
        )}
      </span>
      <span className="truncate font-mono text-[11.5px] text-mute">
        {!isWorktree && checkout}
        {r.defaultBase && <span className="text-faint">{isWorktree ? "→ " : " → "}{r.defaultBase}</span>}
        {(r.behindBase ?? 0) > 0 && (
          <span
            title={`${r.behindBase} commit${r.behindBase === 1 ? "" : "s"} behind ${r.defaultBase} — needs rebase or merge`}
            className="ml-1.5 rounded-sm bg-del-soft px-1 py-px text-[10.5px] font-medium text-del"
          >
            ↓{r.behindBase}
          </span>
        )}
        {(r.aheadBase ?? 0) > 0 && (
          <span
            title={`${r.aheadBase} commit${r.aheadBase === 1 ? "" : "s"} ahead of ${r.defaultBase}`}
            className="ml-1.5 text-[10.5px] text-faint"
          >
            ↑{r.aheadBase}
          </span>
        )}
      </span>
      <span className="text-right font-mono text-[11px] tabular-nums text-mute">
        {r.changedFiles != null
          ? `${r.changedFiles} file${r.changedFiles === 1 ? "" : "s"}`
          : "—"}
      </span>
      <span className="text-right">
        {r.openComments > 0 ? (
          <span className="rounded-sm bg-accent-soft px-1.5 py-0.5 font-mono text-[11px] font-medium text-accent">
            {r.openComments} open
          </span>
        ) : (
          <span className="font-mono text-[11px] text-faint">—</span>
        )}
      </span>
      <span className="text-right text-[11px] text-faint">{relativeTime(r.lastActivity)}</span>
    </Link>
  );
}
