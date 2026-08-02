import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import type {
  Comment,
  CommentAnchor,
  CommentListResponse,
  CommentPatchRequest,
  DiffResponse,
  FileDiff,
} from "@shared/types";
import * as api from "../api";
import { CommentThread } from "../components/CommentThread";
import { Composer } from "../components/Composer";
import { DiffFile, type DiffMode } from "../components/DiffFile";
import { FileNav } from "../components/FileNav";
import { HelpOverlay } from "../components/HelpOverlay";
import { LiveDot } from "../components/LiveDot";
import { buildFileTree, flattenTree } from "../tree";
import { basename, buildThreads, cx, lineKey, shortSha, type Thread } from "../util";
import { useRevSocket } from "../ws";

const HEADER_PX = 48;
const MODE_KEY = "rev.diffMode";

function initialMode(params: URLSearchParams): DiffMode {
  const p = params.get("mode");
  if (p === "split" || p === "unified") return p;
  return localStorage.getItem(MODE_KEY) === "split" ? "split" : "unified";
}

export function Review() {
  const search = useSearch();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const dir = params.get("dir") ?? "";
  const base = params.get("base") ?? "";
  const [, navigate] = useLocation();
  const qc = useQueryClient();

  const diffQ = useQuery({
    queryKey: ["diff", dir, base],
    queryFn: () => api.getDiff(dir, base),
    enabled: !!dir && !!base,
  });
  // No base filter: threads from earlier reviews against other bases stay
  // visible (tagged with their base) instead of vanishing on a base switch.
  const commentsQ = useQuery({
    queryKey: ["comments", dir],
    queryFn: () => api.getComments(dir),
    enabled: !!dir,
  });

  const wsStatus = useRevSocket(dir || undefined, (msg) => {
    if (msg.type === "diff-invalidated" && msg.dir === dir) {
      qc.invalidateQueries({ queryKey: ["diff", dir] });
    } else if (msg.type === "comments-changed" && msg.dir === dir) {
      qc.invalidateQueries({ queryKey: ["comments", dir] });
    }
  });

  const seenMut = useMutation({
    mutationFn: api.putSeen,
    onMutate: (req) => {
      qc.setQueryData<DiffResponse>(["diff", dir, base], (old) =>
        old
          ? {
              ...old,
              files: old.files.map((f) =>
                f.path === req.path ? { ...f, seen: req.seen, stale: false } : f,
              ),
            }
          : old,
      );
    },
    onError: () => qc.invalidateQueries({ queryKey: ["diff", dir, base] }),
  });
  const createMut = useMutation({
    mutationFn: api.postComment,
    onSettled: () => qc.invalidateQueries({ queryKey: ["comments", dir] }),
  });
  const patchMut = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: CommentPatchRequest }) =>
      api.patchComment(id, patch),
    // Resolve/unresolve applies to the cache immediately so the thread
    // collapses/expands without waiting on the server; rolled back on error.
    onMutate: async ({ id, patch }) => {
      if (patch.resolved === undefined) return;
      await qc.cancelQueries({ queryKey: ["comments", dir] });
      const prev = qc.getQueryData<CommentListResponse>(["comments", dir]);
      qc.setQueryData<CommentListResponse>(["comments", dir], (old) =>
        old
          ? {
              ...old,
              comments: old.comments.map((c) =>
                c.id === id
                  ? { ...c, resolvedAt: patch.resolved ? Date.now() : null }
                  : c,
              ),
            }
          : old,
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["comments", dir], ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["comments", dir] }),
  });
  const fetchMut = useMutation({
    mutationFn: () => api.postFetch({ dir, base }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["diff", dir] }),
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => fetchMut.reset(), [dir, base]);

  const toggleSeen = (file: FileDiff, seen: boolean) =>
    seenMut.mutate({ dir, base, path: file.path, contentHash: file.contentHash, seen });
  const createComment = (anchor: CommentAnchor | null, body: string) =>
    createMut.mutate({ dir, base, anchor: anchor ?? undefined, author: "user", body });
  const reply = (root: Comment, body: string) =>
    createMut.mutate({ dir, base, parentId: root.id, author: "user", body });
  const resolve = (root: Comment, resolved: boolean) =>
    patchMut.mutate({ id: root.id, patch: { resolved } });

  const [mode, setModeState] = useState<DiffMode>(() => initialMode(params));
  const setMode = (m: DiffMode) => {
    setModeState(m);
    localStorage.setItem(MODE_KEY, m);
  };

  // Tree (visual) order drives everything: the rail, the diff pane, scroll-spy
  // and j/k all agree on it.
  const tree = useMemo(() => buildFileTree(diffQ.data?.files ?? []), [diffQ.data]);
  const files = useMemo(() => flattenTree(tree), [tree]);

  // Route every thread: to its diff line, to its file's detached list, or to
  // the review-level panel (unanchored, or file absent from this diff).
  const { byFile, detachedByFile, reviewLevel, unresolvedByFile } = useMemo(() => {
    const threads = buildThreads(commentsQ.data?.comments ?? []);
    const lineSets = new Map<string, Set<string>>();
    for (const f of files) {
      const s = new Set<string>();
      for (const h of f.hunks) {
        for (const l of h.lines) {
          if (l.oldLine != null) s.add(lineKey("old", l.oldLine));
          if (l.newLine != null) s.add(lineKey("new", l.newLine));
        }
      }
      lineSets.set(f.path, s);
    }
    const byFile = new Map<string, Map<string, Thread[]>>();
    const detachedByFile = new Map<string, Thread[]>();
    const reviewLevel: Thread[] = [];
    const unresolvedByFile = new Map<string, number>();
    for (const t of threads) {
      const a = t.root.anchor;
      if (!a || !lineSets.has(a.file)) {
        reviewLevel.push(t);
        continue;
      }
      if (t.root.resolvedAt == null) {
        unresolvedByFile.set(a.file, (unresolvedByFile.get(a.file) ?? 0) + 1);
      }
      // Threads follow the code: the server re-anchors "new"-side comments
      // against the working tree (resolvedLine). Try that first, fall back to
      // the original anchor line; detach only when neither is in the diff.
      const rl = t.root.resolvedLine;
      const candidates =
        a.side === "new" && typeof rl === "number" && rl !== a.line
          ? [lineKey("new", rl), lineKey(a.side, a.line)]
          : [lineKey(a.side, a.line)];
      const k = candidates.find((c) => lineSets.get(a.file)!.has(c));
      if (k != null) {
        const m = byFile.get(a.file) ?? new Map<string, Thread[]>();
        m.set(k, [...(m.get(k) ?? []), t]);
        byFile.set(a.file, m);
      } else {
        detachedByFile.set(a.file, [...(detachedByFile.get(a.file) ?? []), t]);
      }
    }
    return { byFile, detachedByFile, reviewLevel, unresolvedByFile };
  }, [commentsQ.data, files]);

  // Current-file tracking (scroll spy + j/k target).
  const sectionEls = useRef(new Map<string, HTMLElement>());
  // Rendered hunk-header rows, for n/p navigation. Collapsed files render no
  // rows, so their hunks are naturally skipped.
  const hunkEls = useRef(new Map<string, HTMLElement>());
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const currentRef = useRef<string | null>(null);
  currentRef.current = currentPath;

  useEffect(() => {
    if (files.length === 0) return;
    const onScroll = () => {
      let current = files[0]?.path ?? null;
      for (const f of files) {
        const el = sectionEls.current.get(f.path);
        if (!el) continue;
        if (el.getBoundingClientRect().top <= HEADER_PX + 40) current = f.path;
        else break;
      }
      setCurrentPath(current);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diffQ.data]);

  const jumpTo = (path: string) => {
    const el = sectionEls.current.get(path);
    if (!el) return;
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - HEADER_PX - 8 });
    setCurrentPath(path);
  };

  const [help, setHelp] = useState(false);
  const filesRef = useRef(files);
  filesRef.current = files;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const fs = filesRef.current;
      if (e.key === "j" || e.key === "k") {
        if (fs.length === 0) return;
        e.preventDefault();
        const idx = fs.findIndex((f) => f.path === currentRef.current);
        const next =
          fs[e.key === "j" ? Math.min(idx + 1, fs.length - 1) : Math.max(idx - 1, 0)];
        const el = next && sectionEls.current.get(next.path);
        if (next && el) {
          window.scrollTo({
            top: el.getBoundingClientRect().top + window.scrollY - HEADER_PX - 8,
          });
          setCurrentPath(next.path);
        }
      } else if (e.key === "n" || e.key === "p") {
        // Anchor sits just below the sticky header + file header; a landed
        // hunk rests slightly above it so the next n moves on.
        const anchor = HEADER_PX + 44;
        const tops = [...hunkEls.current.values()]
          .filter((el) => el.isConnected)
          .map((el) => ({ el, top: el.getBoundingClientRect().top }))
          .sort((x, y) => x.top - y.top);
        const target =
          e.key === "n"
            ? tops.find((t) => t.top > anchor + 4)
            : [...tops].reverse().find((t) => t.top < anchor - 4);
        if (!target) return;
        e.preventDefault();
        window.scrollTo({ top: target.top + window.scrollY - HEADER_PX - 40 });
        const el = target.el;
        el.classList.remove("hunk-flash");
        void el.offsetWidth; // restart the animation when re-landing
        el.classList.add("hunk-flash");
        setTimeout(() => el.classList.remove("hunk-flash"), 1300);
      } else if (e.key === "v") {
        const f = fs.find((x) => x.path === currentRef.current);
        if (f) {
          seenMut.mutate({
            dir,
            base,
            path: f.path,
            contentHash: f.contentHash,
            seen: !f.seen,
          });
        }
      } else if (e.key === "?") {
        setHelp((h) => !h);
      } else if (e.key === "Escape") {
        setHelp(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir, base]);

  const [baseInput, setBaseInput] = useState(base);
  useEffect(() => setBaseInput(base), [base]);

  const totals = useMemo(
    () =>
      files.reduce(
        (acc, f) => ({ add: acc.add + f.additions, del: acc.del + f.deletions }),
        { add: 0, del: 0 },
      ),
    [files],
  );
  const seenCount = files.filter((f) => f.seen).length;

  return (
    <div className="min-h-screen">
      <header
        className="sticky top-0 z-20 flex items-center gap-3 border-b border-edge bg-panel px-3"
        style={{ height: HEADER_PX }}
      >
        <Link href={api.href("/")} className="font-mono text-[13px] font-bold text-fg hover:text-accent">
          rev<span className="text-accent">_</span>
        </Link>
        <span className="text-faint max-sm:hidden">/</span>
        <span
          className="max-w-48 shrink-0 truncate text-[13px] font-medium text-fg max-sm:max-w-20"
          title={dir}
        >
          {dir ? basename(dir) : "review"}
        </span>
        {diffQ.data && (
          <span className="hidden items-center gap-1.5 font-mono text-[12px] text-mute sm:flex">
            <span className="max-w-44 truncate" title={diffQ.data.branch ?? undefined}>
              {diffQ.data.branch ?? `detached @ ${shortSha(diffQ.data.head)}`}
            </span>
            <span className="text-faint">→</span>
          </span>
        )}
        <form
          className="shrink-0"
          onSubmit={(e) => {
            e.preventDefault();
            const v = baseInput.trim();
            if (v && v !== base) navigate(api.href("/review", { dir, base: v }));
          }}
        >
          <input
            value={baseInput}
            onChange={(e) => setBaseInput(e.target.value)}
            spellCheck={false}
            aria-label="Base ref"
            title="Base ref — press Enter to re-diff"
            className="w-24 rounded-sm border border-edge bg-bg px-1.5 py-0.5 font-mono text-[12px] text-fg focus:border-accent/60 focus:outline-none max-sm:w-16"
          />
        </form>
        {diffQ.data && (
          <span
            className="hidden text-[11px] text-faint md:inline"
            title={diffQ.data.mergeBase}
          >
            merge-base {shortSha(diffQ.data.mergeBase)}
          </span>
        )}
        {diffQ.data != null &&
          diffQ.data.baseBehind != null &&
          diffQ.data.baseBehind > 0 && (
            <span className="hidden shrink-0 items-center gap-1.5 sm:flex">
              <span className="font-mono text-[11px] text-accent">
                base {diffQ.data.baseBehind} behind origin
              </span>
              <button
                type="button"
                onClick={() => fetchMut.mutate()}
                disabled={fetchMut.isPending}
                title={`git fetch ${base}'s upstream, then re-diff`}
                className="rounded-sm border border-accent/40 px-1.5 py-px font-mono text-[11px] text-accent transition-colors duration-150 hover:bg-accent hover:text-bg disabled:cursor-default disabled:border-edge disabled:bg-transparent disabled:text-faint"
              >
                {fetchMut.isPending ? "fetching…" : "fetch"}
              </button>
              {fetchMut.error != null && (
                <span
                  className="max-w-44 truncate text-[11px] text-del"
                  title={(fetchMut.error as Error).message}
                >
                  {(fetchMut.error as Error).message}
                </span>
              )}
            </span>
          )}
        {files.length > 0 && (
          <select
            value={currentPath ?? ""}
            onChange={(e) => jumpTo(e.target.value)}
            aria-label="Jump to file"
            className="min-w-0 flex-1 rounded-sm border border-edge bg-bg px-1 py-0.5 font-mono text-[11px] text-fg md:hidden"
          >
            {files.map((f) => (
              <option key={f.path} value={f.path}>
                {f.path}
              </option>
            ))}
          </select>
        )}
        <div className="ml-auto flex items-center gap-3">
          <div
            role="radiogroup"
            aria-label="Diff layout"
            className="hidden overflow-hidden rounded-sm border border-edge sm:flex"
          >
            {(["unified", "split"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                aria-pressed={mode === m}
                className={cx(
                  "px-2 py-0.5 font-mono text-[11px] transition-colors duration-150",
                  mode === m ? "bg-raise text-fg" : "text-faint hover:bg-raise/40 hover:text-mute",
                )}
              >
                {m}
              </button>
            ))}
          </div>
          {files.length > 0 && (
            <>
              <span className="hidden font-mono text-[11.5px] tabular-nums text-mute sm:inline">
                {files.length} file{files.length === 1 ? "" : "s"}{" "}
                <span className="text-add">+{totals.add}</span>{" "}
                <span className="text-del">−{totals.del}</span>
              </span>
              <span
                className="whitespace-nowrap font-mono text-[11.5px] tabular-nums text-mute"
                title="files marked seen"
              >
                {seenCount}/{files.length} seen
              </span>
            </>
          )}
          <LiveDot status={wsStatus} />
          <button
            type="button"
            onClick={() => setHelp(true)}
            aria-label="Keyboard shortcuts"
            className="grid size-5 place-items-center rounded-sm font-mono text-[12px] text-faint transition-colors duration-150 hover:bg-raise hover:text-fg"
          >
            ?
          </button>
        </div>
      </header>

      {!dir || !base ? (
        <CenterPanel>
          <p className="text-[13px] text-del">
            Missing {!dir ? "dir" : "base"} parameter.
          </p>
          <p className="mt-1 text-[12px] text-mute">
            Expected /review?dir=&lt;abs path&gt;&amp;base=&lt;ref&gt;.{" "}
            <Link href={api.href("/")} className="text-accent hover:underline">
              Pick a repo
            </Link>
          </p>
        </CenterPanel>
      ) : diffQ.error ? (
        <CenterPanel>
          <p className="text-[13px] font-medium text-del">
            Couldn't compute diff
          </p>
          <p className="mt-1 font-mono text-[12.5px] text-fg">
            {(diffQ.error as Error).message}
          </p>
          <p className="mt-2 text-[12px] text-faint">
            Check that the directory exists and that{" "}
            <span className="font-mono text-mute">{base}</span> resolves to a ref in it.
          </p>
          <div className="mt-3 flex justify-center gap-3">
            <button
              type="button"
              onClick={() => diffQ.refetch()}
              className="rounded-sm border border-edge px-2.5 py-1 text-[12px] text-mute hover:border-accent/50 hover:text-fg"
            >
              Retry
            </button>
            <Link
              href={api.href("/")}
              className="rounded-sm px-2.5 py-1 text-[12px] text-mute hover:text-fg"
            >
              Repo list
            </Link>
          </div>
        </CenterPanel>
      ) : diffQ.isPending ? (
        <div className="w-full px-4 py-4">
          <div className="animate-pulse space-y-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="rounded-md border border-edge bg-panel">
                <div className="h-8 border-b border-edge-soft bg-raise" />
                <div className="h-28" />
              </div>
            ))}
          </div>
        </div>
      ) : files.length === 0 ? (
        <CenterPanel>
          <p className="font-mono text-[13px] text-add">working tree clean vs {base}</p>
          <p className="mt-1 text-[12px] text-faint">
            Nothing to review — commits and working tree match the merge-base.
          </p>
        </CenterPanel>
      ) : (
        <div className="flex w-full items-start gap-4 px-4 py-4">
          <aside
            className="sticky hidden w-72 shrink-0 overflow-y-auto rounded-md border border-edge bg-panel md:block"
            style={{ top: HEADER_PX + 12, maxHeight: `calc(100vh - ${HEADER_PX + 24}px)` }}
          >
            <FileNav
              tree={tree}
              unresolvedByFile={unresolvedByFile}
              currentPath={currentPath}
              onSelect={jumpTo}
              onToggleSeen={toggleSeen}
            />
          </aside>

          <main className="flex min-w-0 flex-1 flex-col gap-3">
            {files.map((f) => (
              <DiffFile
                key={f.path}
                dir={dir}
                currentBase={base}
                file={f}
                mode={mode}
                threadsByLine={byFile.get(f.path) ?? new Map()}
                detached={detachedByFile.get(f.path) ?? []}
                isCurrent={currentPath === f.path}
                onToggleSeen={toggleSeen}
                onCreateComment={(anchor, body) => createComment(anchor, body)}
                onReply={reply}
                onResolve={resolve}
                sectionRef={(el) => {
                  if (el) sectionEls.current.set(f.path, el);
                  else sectionEls.current.delete(f.path);
                }}
                hunkRef={(hi, el) => {
                  const k = `${f.path} ${hi}`;
                  if (el) hunkEls.current.set(k, el);
                  else hunkEls.current.delete(k);
                }}
              />
            ))}

            <section className="rounded-md border border-edge bg-panel">
              <h2 className="border-b border-edge-soft px-3 py-2 text-[12px] font-semibold uppercase tracking-wide text-mute">
                Review notes
              </h2>
              {reviewLevel.length === 0 && (
                <p className="px-3 pt-2 text-[12px] text-faint">
                  Notes that aren't tied to a line — scope, follow-ups, verdicts.
                </p>
              )}
              <div className="flex flex-col">
                {reviewLevel.map((t) => (
                  <CommentThread
                    key={t.root.id}
                    thread={t}
                    baseLabel={t.root.base !== base ? t.root.base : undefined}
                    anchorNote={
                      t.root.anchor
                        ? `${t.root.anchor.file}:${t.root.anchor.line} (not in this diff)`
                        : undefined
                    }
                    onReply={(body) => reply(t.root, body)}
                    onResolve={(resolved) => resolve(t.root, resolved)}
                  />
                ))}
              </div>
              <Composer
                placeholder="Add a review-level note…"
                submitLabel="Add note"
                onSubmit={(body) => createComment(null, body)}
              />
            </section>

            <p className="pb-4 text-center font-mono text-[11px] text-faint">
              j/k files · n/p hunks · v seen · ? shortcuts
            </p>
          </main>
        </div>
      )}

      {help && <HelpOverlay onClose={() => setHelp(false)} />}
    </div>
  );
}

function CenterPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto mt-24 w-full max-w-md rounded-md border border-edge bg-panel px-6 py-6 text-center">
      {children}
    </div>
  );
}
