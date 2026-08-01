import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import * as api from "../api";
import { LiveDot } from "../components/LiveDot";
import { cx, relativeTime } from "../util";
import { useRevSocket } from "../ws";

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

  const repos = [...(reposQ.data ?? [])].sort((a, b) => {
    if (a.openComments !== b.openComments) return b.openComments - a.openComments;
    return (b.lastActivity ?? 0) - (a.lastActivity ?? 0);
  });

  return (
    <div className="mx-auto w-full max-w-3xl px-4">
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

      {reposQ.data && repos.length === 0 && (
        <div className="rounded-md border border-edge bg-panel px-4 py-8 text-center">
          <p className="text-[13px] text-mute">No git repos discovered under the configured roots.</p>
          <p className="mt-1 text-[12px] text-faint">
            Set REV_ROOTS on the server, then rescan.
          </p>
        </div>
      )}

      {repos.length > 0 && (
        <ul className="divide-y divide-edge-soft overflow-hidden rounded-md border border-edge bg-panel">
          {repos.map((r) => (
            <li key={r.dir}>
              <Link
                href={api.href("/review", { dir: r.dir, base: r.defaultBase ?? "main" })}
                title={r.dir}
                className="flex items-center gap-3 px-3 py-2.5 transition-colors duration-150 hover:bg-raise/60"
              >
                <span
                  title={r.dirty ? "uncommitted changes" : "clean"}
                  className={cx(
                    "size-1.5 shrink-0 rounded-full",
                    r.dirty ? "bg-accent" : "bg-edge",
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-fg">
                    {r.name}
                    {r.isWorktree && (
                      <span className="ml-2 rounded-sm bg-raise px-1 py-px font-mono text-[10.5px] font-normal text-faint">
                        worktree
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate font-mono text-[11.5px] text-mute">
                    {r.branch ?? `detached @ ${r.head}`}
                    {r.defaultBase && <span className="text-faint"> → {r.defaultBase}</span>}
                  </span>
                </span>
                {r.openComments > 0 && (
                  <span className="shrink-0 rounded-sm bg-accent-soft px-1.5 py-0.5 font-mono text-[11px] font-medium text-accent">
                    {r.openComments} open
                  </span>
                )}
                <span className="w-16 shrink-0 text-right font-mono text-[11px] tabular-nums text-mute">
                  {r.changedFiles != null
                    ? `${r.changedFiles} file${r.changedFiles === 1 ? "" : "s"}`
                    : "—"}
                </span>
                <span className="w-16 shrink-0 text-right text-[11px] text-faint">
                  {relativeTime(r.lastActivity)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
