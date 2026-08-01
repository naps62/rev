import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { Link } from "wouter";
import type { RepoInfo } from "@shared/types";
import * as api from "../api";
import { LiveDot } from "../components/LiveDot";
import { basename, cx, relativeTime } from "../util";
import { useRevSocket } from "../ws";

interface RepoEntry {
  repo: RepoInfo;
  worktrees: RepoInfo[];
}

interface Group {
  /** Path segments between the common root and the repo, "" for top-level. */
  label: string;
  entries: RepoEntry[];
}

const parentDir = (dir: string) =>
  dir.replace(/\/+$/, "").split("/").slice(0, -1).join("/");

/**
 * Groups repos by their parent path relative to the common root (e.g.
 * "yolo/", "bullish/") and nests worktrees under their main checkout via
 * RepoInfo.mainDir. Worktrees whose main repo wasn't discovered stay top-level.
 */
function groupRepos(repos: RepoInfo[]): Group[] {
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
    const entry: RepoEntry = {
      repo: r,
      worktrees: (worktreesByMain.get(r.dir) ?? []).sort((a, b) =>
        basename(a.dir).localeCompare(basename(b.dir)),
      ),
    };
    groups.set(rel, [...(groups.get(rel) ?? []), entry]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, entries]) => ({
      label,
      entries: entries.sort((a, b) =>
        basename(a.repo.dir).localeCompare(basename(b.repo.dir)),
      ),
    }));
}

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

  const groups = useMemo(() => groupRepos(reposQ.data ?? []), [reposQ.data]);

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
          <div className="divide-y divide-edge-soft">
            {groups.map((g) => (
              <div key={g.label || "(root)"}>
                {g.label && (
                  <p className="px-3 pb-0.5 pt-2 font-mono text-[11px] text-faint">
                    {g.label}/
                  </p>
                )}
                {g.entries.map((e) => (
                  <div key={e.repo.dir}>
                    <RepoRow repo={e.repo} indent={g.label ? 1 : 0} />
                    {e.worktrees.map((w) => (
                      <RepoRow key={w.dir} repo={w} indent={(g.label ? 1 : 0) + 1} isWorktree />
                    ))}
                  </div>
                ))}
              </div>
            ))}
          </div>
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
        <span className="truncate text-[13px] font-medium text-fg">{basename(r.dir)}</span>
        {isWorktree && (
          <span className="shrink-0 rounded-sm bg-raise px-1 py-px font-mono text-[10.5px] text-faint">
            worktree
          </span>
        )}
      </span>
      <span className="truncate font-mono text-[11.5px] text-mute">
        {r.branch ?? `detached @ ${r.head}`}
        {r.defaultBase && <span className="text-faint"> → {r.defaultBase}</span>}
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
