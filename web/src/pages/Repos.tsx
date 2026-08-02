import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import type { RepoInfo } from "#shared/types";
import { TUNING } from "#shared/tuning";
import * as api from "../api";
import { AppHeader } from "../components/AppHeader";
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

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

interface Term {
  kind: "text" | "is" | "has";
  value: string;
}

function parseQuery(q: string): Term[] {
  return q
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => {
      if (t.startsWith("is:")) return { kind: "is" as const, value: t.slice(3) };
      if (t.startsWith("has:")) return { kind: "has" as const, value: t.slice(4) };
      return { kind: "text" as const, value: t };
    });
}

function matchRepo(r: RepoInfo, terms: Term[], now: number): boolean {
  return terms.every((t) => {
    switch (t.kind) {
      case "is":
        switch (t.value) {
          case "dirty": return r.dirty;
          case "clean": return !r.dirty;
          case "behind": return (r.behindBase ?? 0) > 0;
          case "ahead": return (r.aheadBase ?? 0) > 0;
          case "active": return isActive(r, now);
          case "stale": return !isActive(r, now);
          case "worktree": return r.isWorktree;
          default: return false;
        }
      case "has":
        return t.value === "comments" && r.openComments > 0;
      case "text": {
        const hay = `${r.name} ${r.branch ?? ""} ${r.dir} ${r.scope}`.toLowerCase();
        return hay.includes(t.value);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// View model: what each card actually renders, in default and filtered modes
// ---------------------------------------------------------------------------

interface CardRow {
  repo: RepoInfo;
  dim: boolean;
}

interface Card {
  entry: RepoEntry;
  dim: boolean;
  rows: CardRow[];
  /** Stale worktrees behind the per-card toggle; 0 while filtering. */
  staleCount: number;
  /** Where Enter on the filter input should land for the first card. */
  primary: RepoInfo;
}

function buildCards(
  groups: Group[],
  terms: Term[],
  now: number,
  showInactive: boolean,
  staleOpen: Set<string>,
): { label: string; cards: Card[] }[] {
  return groups
    .map((g) => ({
      label: g.label,
      cards: g.entries
        .map((e): Card | null => {
          if (terms.length === 0) {
            if (!e.active && !showInactive) return null;
            const open = staleOpen.has(e.repo.dir);
            return {
              entry: e,
              dim: !e.active,
              rows: [
                ...e.activeWorktrees.map((repo) => ({ repo, dim: false })),
                ...(open ? e.staleWorktrees.map((repo) => ({ repo, dim: true })) : []),
              ],
              staleCount: e.staleWorktrees.length,
              primary: e.repo,
            };
          }
          const repoMatch = matchRepo(e.repo, terms, now);
          const all = [...e.activeWorktrees, ...e.staleWorktrees].sort(
            (a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0),
          );
          const matched = all.filter((w) => matchRepo(w, terms, now));
          if (!repoMatch && matched.length === 0) return null;
          const shown = repoMatch ? all : matched;
          const staleSet = new Set(e.staleWorktrees.map((w) => w.dir));
          return {
            entry: e,
            dim: !e.active,
            rows: shown.map((repo) => ({ repo, dim: staleSet.has(repo.dir) })),
            staleCount: 0,
            primary: repoMatch ? e.repo : matched[0]!,
          };
        })
        .filter((c): c is Card => c !== null),
    }))
    .filter((g) => g.cards.length > 0);
}

const SCOPE_KEY = "rev.scope";

export function Repos() {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
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
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const terms = useMemo(() => parseQuery(query), [query]);

  // Fall back to the busiest scope when nothing (or a vanished scope) is saved.
  const currentScope =
    scope != null && scopes.includes(scope) ? scope : scopes[0] ?? null;

  const selectScope = (s: string) => {
    setScope(s);
    localStorage.setItem(SCOPE_KEY, s);
    setShowInactive(false);
    setStaleOpen(new Set());
  };

  // "/" pulls focus back to the filter from anywhere on the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const matchCounts = useMemo(() => {
    if (terms.length === 0) return null;
    const counts = new Map<string, number>();
    for (const s of scopes) {
      counts.set(s, repos.filter((r) => r.scope === s && matchRepo(r, terms, now)).length);
    }
    return counts;
  }, [repos, scopes, terms, now]);

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

  const visibleGroups = useMemo(
    () => buildCards(groups, terms, now, showInactive, staleOpen),
    [groups, terms, now, showInactive, staleOpen],
  );

  const firstTarget = visibleGroups[0]?.cards[0]?.primary ?? null;

  const toggleStale = (dir: string) =>
    setStaleOpen((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });

  const otherScopeMatches =
    matchCounts == null
      ? []
      : scopes.filter((s) => s !== currentScope && (matchCounts.get(s) ?? 0) > 0);

  return (
    <div className="min-h-screen">
      <h1 className="sr-only">rev — always-on review</h1>
      <AppHeader>
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
      </AppHeader>

      <div className="w-full px-4 pb-8 pt-4">
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
                    (matchCounts != null
                      ? (matchCounts.get(s) ?? 0) > 0
                      : s === currentScope)
                      ? "text-accent"
                      : "text-faint",
                  )}
                >
                  {matchCounts != null ? matchCounts.get(s) ?? 0 : activeCounts.get(s) ?? 0}
                </span>
              </button>
            ))}
          </nav>
        )}

        <input
          ref={searchRef}
          // biome-ignore lint/a11y/noAutofocus: the filter is this page's primary control
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              if (query) setQuery("");
              else e.currentTarget.blur();
            }
            if (e.key === "Enter" && firstTarget) {
              navigate(
                api.href("/review", {
                  dir: firstTarget.dir,
                  base: firstTarget.defaultBase ?? "main",
                }),
              );
            }
          }}
          placeholder="filter — name, branch, is:dirty, is:behind, has:comments"
          aria-label="Filter projects"
          className="mb-3 w-full rounded-md border border-edge bg-panel px-3 py-1.5 font-mono text-[12px] text-fg transition-colors duration-150 placeholder:text-faint focus:border-accent/50"
        />

        {reposQ.isPending && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(23rem,100%),1fr))] items-start gap-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="animate-pulse rounded-md border border-edge bg-panel px-3 py-3">
                <div className="h-3.5 w-40 rounded-sm bg-raise" />
                <div className="mt-2 h-2.5 w-56 rounded-sm bg-raise/70" />
                <div className="mt-3 h-2.5 w-48 rounded-sm bg-raise/50" />
              </div>
            ))}
          </div>
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

        {groups.length > 0 && visibleGroups.length === 0 && (
          <div className="rounded-md border border-edge bg-panel px-4 py-8 text-center">
            {terms.length > 0 ? (
              <>
                <p className="text-[13px] text-mute">
                  No matches for <span className="font-mono text-fg">{query.trim()}</span>
                  {currentScope && <> in <span className="font-mono">{currentScope}</span></>}.
                </p>
                {otherScopeMatches.length > 0 && (
                  <p className="mt-2 flex items-center justify-center gap-2 text-[12px] text-faint">
                    {otherScopeMatches.map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => selectScope(s)}
                        className="rounded-sm border border-edge px-2 py-0.5 font-mono text-[11.5px] text-mute transition-colors duration-150 hover:border-accent/50 hover:text-fg"
                      >
                        {matchCounts?.get(s)} in {s}
                      </button>
                    ))}
                  </p>
                )}
              </>
            ) : (
              <p className="text-[12.5px] text-mute">Nothing in active development here right now.</p>
            )}
          </div>
        )}

        {visibleGroups.map((g) => (
          <section key={g.label || "(root)"} className="mb-4">
            {g.label && (
              <p className="mb-1.5 font-mono text-[11px] text-faint">{g.label}/</p>
            )}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(23rem,100%),1fr))] items-start gap-3">
              {g.cards.map((c) => (
                <ProjectCard
                  key={c.entry.repo.dir}
                  card={c}
                  staleOpen={staleOpen.has(c.entry.repo.dir)}
                  onToggleStale={() => toggleStale(c.entry.repo.dir)}
                />
              ))}
            </div>
          </section>
        ))}

        {terms.length === 0 && inactiveCount > 0 && (
          <button
            type="button"
            onClick={() => setShowInactive((v) => !v)}
            className="block w-full rounded-md border border-edge px-3 py-2 text-left font-mono text-[11.5px] text-faint transition-colors duration-150 hover:bg-raise/40 hover:text-mute"
          >
            {showInactive
              ? "hide inactive projects"
              : `show ${inactiveCount} inactive project${inactiveCount === 1 ? "" : "s"}`}
          </button>
        )}
      </div>
    </div>
  );
}

function DirtyDot({ dirty }: { dirty: boolean }) {
  return (
    <span
      title={dirty ? "uncommitted changes" : "clean"}
      className={cx("size-1.5 shrink-0 rounded-full", dirty ? "bg-accent" : "bg-edge")}
    />
  );
}

function Drift({ repo: r }: { repo: RepoInfo }) {
  return (
    <>
      {(r.behindBase ?? 0) > 0 && (
        <span
          title={`${r.behindBase} commit${r.behindBase === 1 ? "" : "s"} behind ${r.defaultBase} — needs rebase or merge`}
          className="shrink-0 rounded-sm bg-del-soft px-1 py-px font-mono text-[10.5px] font-medium text-del"
        >
          ↓{r.behindBase}
        </span>
      )}
      {(r.aheadBase ?? 0) > 0 && (
        <span
          title={`${r.aheadBase} commit${r.aheadBase === 1 ? "" : "s"} ahead of ${r.defaultBase}`}
          className="shrink-0 font-mono text-[10.5px] text-faint"
        >
          ↑{r.aheadBase}
        </span>
      )}
    </>
  );
}

function Meta({ repo: r }: { repo: RepoInfo }) {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-2">
      {r.openComments > 0 && (
        <span className="rounded-sm bg-accent-soft px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-accent">
          {r.openComments} open
        </span>
      )}
      {r.changedFiles != null && r.changedFiles > 0 && (
        <span className="font-mono text-[11px] tabular-nums text-mute">
          {r.changedFiles} file{r.changedFiles === 1 ? "" : "s"}
        </span>
      )}
      <span className="w-14 text-right text-[11px] text-faint">
        {relativeTime(r.lastActivity)}
      </span>
    </span>
  );
}

function ProjectCard({
  card: c,
  staleOpen,
  onToggleStale,
}: {
  card: Card;
  staleOpen: boolean;
  onToggleStale: () => void;
}) {
  const r = c.entry.repo;
  const checkout = r.branch ?? `detached @ ${r.head}`;
  return (
    <section
      className={cx(
        "overflow-hidden rounded-md border border-edge bg-panel",
        c.dim && "opacity-55",
      )}
    >
      <Link
        href={api.href("/review", { dir: r.dir, base: r.defaultBase ?? "main" })}
        title={r.dir}
        className="block px-3 pb-2 pt-2.5 transition-colors duration-150 hover:bg-raise/60"
      >
        <span className="flex items-center gap-2">
          <DirtyDot dirty={r.dirty} />
          <span className="min-w-0 truncate text-[13px] font-semibold text-fg">
            {basename(r.dir)}
          </span>
          <Meta repo={r} />
        </span>
        <span className="mt-1 flex min-w-0 items-center gap-1.5 pl-3.5">
          <span className="truncate font-mono text-[11.5px] text-mute">
            {checkout}
            {r.defaultBase && r.branch !== r.defaultBase && (
              <span className="text-faint"> → {r.defaultBase}</span>
            )}
          </span>
          <Drift repo={r} />
        </span>
      </Link>

      {c.rows.length > 0 && (
        <div className="divide-y divide-edge-soft border-t border-edge-soft">
          {c.rows.map((row) => (
            <WorktreeRow key={row.repo.dir} repo={row.repo} dim={row.dim} />
          ))}
        </div>
      )}

      {c.staleCount > 0 && (
        <button
          type="button"
          onClick={onToggleStale}
          className="block w-full border-t border-edge-soft px-3 py-1.5 text-left font-mono text-[11px] text-faint transition-colors duration-150 hover:text-mute"
        >
          {staleOpen
            ? "hide stale worktrees"
            : `show ${c.staleCount} stale worktree${c.staleCount === 1 ? "" : "s"}`}
        </button>
      )}
    </section>
  );
}

function WorktreeRow({ repo: r, dim }: { repo: RepoInfo; dim: boolean }) {
  // A worktree's dir name repeats its branch — the branch IS its identity.
  const checkout = r.branch ?? `detached @ ${r.head}`;
  return (
    <Link
      href={api.href("/review", { dir: r.dir, base: r.defaultBase ?? "main" })}
      title={r.dir}
      className={cx(
        "flex items-center gap-2 px-3 py-1.5 transition-colors duration-150 hover:bg-raise/60",
        dim && "opacity-55",
      )}
    >
      <DirtyDot dirty={r.dirty} />
      <span className="min-w-0 truncate font-mono text-[12px] text-fg">{checkout}</span>
      <Drift repo={r} />
      <Meta repo={r} />
    </Link>
  );
}
