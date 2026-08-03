import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import type {
  Comment,
  CommentAnchor,
  CommentListResponse,
  CommentPatchRequest,
  DiffSummaryResponse,
  EntityChange,
  FileDiffResponse,
  FileSummary,
} from "#shared/types";
import * as api from "../api";
import { AppHeader, HEADER_PX } from "../components/AppHeader";
import { CommentThread } from "../components/CommentThread";
import { Composer } from "../components/Composer";
import { DiffFile, type DiffMode } from "../components/DiffFile";
import { FileNav } from "../components/FileNav";
import { HelpOverlay } from "../components/HelpOverlay";
import { FeatureMenu } from "../components/FeatureMenu";
import { LayoutToggle } from "../components/LayoutToggle";
import { LiveDot } from "../components/LiveDot";
import { ReviewProgress } from "../components/ReviewProgress";
import { Checkbox } from "../components/Checkbox";
import { EntityPanel } from "../components/EntityPanel";
import { RollupPanel } from "../components/RollupPanel";
import { SymbolPanel } from "../components/SymbolPanel";
import {
  buildClassSections,
  CLASS_LABEL,
  classifyFile,
  type ClassSection,
  type FileClass,
} from "../semantic/classify.ts";
import { entityAnchor } from "../semantic/entities.ts";
import { buildRollup } from "../semantic/rollup.ts";
import { findOccurrences, type Occurrence } from "../semantic/symbols.ts";
import { attachCrosshair } from "../crosshair";
import { type FeatureFlags, loadFeatures, saveFeatures } from "../features";
import { buildFileTree, flattenTree } from "../tree";
import { basename, buildThreads, cx, shortSha, type Thread } from "../util";
import { useRevSocket } from "../ws";

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

  // Summary first (no hunks — near-instant even on huge diffs); each DiffFile
  // streams its own hunks in as it approaches the viewport.
  const diffQ = useQuery({
    queryKey: ["diff-summary", dir, base],
    queryFn: () => api.getDiffSummary(dir, base),
    enabled: !!dir && !!base,
  });
  // No base filter: threads from earlier reviews against other bases stay
  // visible (tagged with their base) instead of vanishing on a base switch.
  const commentsQ = useQuery({
    queryKey: ["comments", dir],
    queryFn: () => api.getComments(dir),
    enabled: !!dir,
  });
  // Base candidates for the header picker; refs move rarely, cache generously.
  const refsQ = useQuery({
    queryKey: ["refs", dir],
    queryFn: () => api.getRefs(dir),
    enabled: !!dir,
    staleTime: 5 * 60_000,
  });

  const wsStatus = useRevSocket(dir || undefined, (msg) => {
    if (msg.type === "diff-invalidated" && msg.dir === dir) {
      qc.invalidateQueries({ queryKey: ["diff-summary", dir] });
      qc.invalidateQueries({ queryKey: ["semantic", dir] });
      if (msg.paths.length > 0) {
        for (const p of msg.paths) qc.invalidateQueries({ queryKey: ["diff-file", dir, base, p] });
      } else {
        qc.invalidateQueries({ queryKey: ["diff-file", dir] });
      }
    } else if (msg.type === "comments-changed" && msg.dir === dir) {
      qc.invalidateQueries({ queryKey: ["comments", dir] });
    }
  });

  const seenMut = useMutation({
    mutationFn: api.putSeen,
    onMutate: (req) => {
      qc.setQueryData<DiffSummaryResponse>(["diff-summary", dir, base], (old) =>
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
    onError: () => qc.invalidateQueries({ queryKey: ["diff-summary", dir, base] }),
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["diff-summary", dir] });
      qc.invalidateQueries({ queryKey: ["diff-file", dir] });
    },
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => fetchMut.reset(), [dir, base]);

  const toggleSeen = (file: FileSummary, seen: boolean) =>
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
  const [features, setFeaturesState] = useState<FeatureFlags>(() => loadFeatures(params));
  const setFeatures = (
    f: FeatureFlags | ((prev: FeatureFlags) => FeatureFlags),
  ) => {
    setFeaturesState((prev) => {
      const next = typeof f === "function" ? f(prev) : f;
      saveFeatures(next);
      return next;
    });
  };

  // Entity-level diff from the optional sem CLI; available:false (binary
  // missing, parse failure) simply leaves the heuristics in charge.
  const semQ = useQuery({
    queryKey: ["semantic", dir, base],
    queryFn: () => api.getSemanticDiff(dir, base),
    enabled: !!dir && !!base && features.entities,
  });
  const entitiesByPath = useMemo(() => {
    const m = new Map<string, EntityChange[]>();
    if (features.entities && semQ.data?.available) {
      for (const f of semQ.data.files) m.set(f.path, f.entities);
    }
    return m;
  }, [features.entities, semQ.data]);

  // Tree (visual) order drives everything: the rail, the diff pane, scroll-spy
  // and j/k all agree on it. With grouping on the order is class sections
  // first, tree order within each.
  const sections = useMemo(
    () => (features.grouping ? buildClassSections(diffQ.data?.files ?? []) : null),
    [features.grouping, diffQ.data],
  );
  const tree = useMemo(
    () => (sections ? [] : buildFileTree(diffQ.data?.files ?? [])),
    [sections, diffQ.data],
  );
  const files = useMemo(
    () => (sections ? sections.flatMap((s) => s.files) : flattenTree(tree)),
    [sections, tree],
  );

  // Collapse/expand-all per class section; seq bump = one action broadcast to
  // that section's DiffFiles. fileCmds targets a single file (symbol jumps).
  const cmdSeq = useRef(0);
  const [sectionCmds, setSectionCmds] = useState<
    Partial<Record<FileClass, { seq: number; expand: boolean }>>
  >({});
  const commandSection = (cls: FileClass, expand: boolean) => {
    cmdSeq.current += 1;
    setSectionCmds((prev) => ({ ...prev, [cls]: { seq: cmdSeq.current, expand } }));
  };
  const [fileCmds, setFileCmds] = useState<
    Record<string, { seq: number; expand: boolean }>
  >({});
  const commandFile = (path: string, expand: boolean) => {
    cmdSeq.current += 1;
    setFileCmds((prev) => ({ ...prev, [path]: { seq: cmdSeq.current, expand } }));
  };

  // Symbol panel: click opens/retargets, Esc closes. Occurrence search runs
  // over whatever per-file hunks are already in the query cache — coverage
  // grows as files stream in.
  const [symbol, setSymbol] = useState<string | null>(null);
  useEffect(() => {
    if (!features.symbols) setSymbol(null);
  }, [features.symbols]);

  // Re-run the occurrence search when new file hunks land in the cache.
  const [cacheTick, setCacheTick] = useState(0);
  useEffect(() => {
    if (symbol == null) return;
    return qc.getQueryCache().subscribe((ev) => {
      if ((ev.query.queryKey as unknown[])[0] === "diff-file") {
        setCacheTick((t) => t + 1);
      }
    });
  }, [qc, symbol]);

  const symbolData = useMemo(() => {
    if (symbol == null) return null;
    const entries = qc.getQueriesData<FileDiffResponse>({
      queryKey: ["diff-file", dir, base],
    });
    // Several cache entries can exist per path (older contentHashes); keep
    // the freshest.
    const byPath = new Map<string, FileDiffResponse>();
    for (const [, data] of entries) {
      if (!data) continue;
      const cur = byPath.get(data.file.path);
      if (!cur || data.computedAt > cur.computedAt) byPath.set(data.file.path, data);
    }
    const loaded = files
      .filter((f) => byPath.has(f.path))
      .map((f) => ({ path: f.path, hunks: byPath.get(f.path)!.file.hunks }));
    const occurrences = findOccurrences(symbol, loaded);
    const notLoaded = files.filter(
      (f) => !byPath.has(f.path) && !f.binary && f.additions + f.deletions > 0,
    ).length;
    return {
      occurrences,
      notLoaded,
      files: new Set(occurrences.map((o) => o.path)),
    };
    // cacheTick invalidates on new hunks landing; qc itself is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, files, dir, base, cacheTick]);

  const loadAllHunks = () => {
    for (const f of files) {
      if (f.binary || f.additions + f.deletions === 0) continue;
      qc.prefetchQuery({
        queryKey: ["diff-file", dir, base, f.path, f.contentHash],
        queryFn: () => api.getFileDiff(dir, base, f.path, f.oldPath),
        staleTime: Infinity,
      });
    }
  };

  // Route threads by file: to their file's DiffFile (which places them on
  // lines once its hunks load), or to the review-level panel (unanchored, or
  // file absent from this diff).
  const { threadsByFile, reviewLevel, unresolvedByFile } = useMemo(() => {
    const threads = buildThreads(commentsQ.data?.comments ?? []);
    const inDiff = new Set(files.map((f) => f.path));
    const threadsByFile = new Map<string, Thread[]>();
    const reviewLevel: Thread[] = [];
    const unresolvedByFile = new Map<string, number>();
    for (const t of threads) {
      const a = t.root.anchor;
      if (!a || !inDiff.has(a.file)) {
        reviewLevel.push(t);
        continue;
      }
      threadsByFile.set(a.file, [...(threadsByFile.get(a.file) ?? []), t]);
      if (t.root.resolvedAt == null) {
        unresolvedByFile.set(a.file, (unresolvedByFile.get(a.file) ?? 0) + 1);
      }
    }
    return { threadsByFile, reviewLevel, unresolvedByFile };
  }, [commentsQ.data, files]);

  // Current-file tracking (scroll spy + j/k target).
  const sectionEls = useRef(new Map<string, HTMLElement>());
  // Rendered hunk-header rows, for n/p navigation. Collapsed files render no
  // rows, so their hunks are naturally skipped.
  const hunkEls = useRef(new Map<string, HTMLElement>());
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const currentRef = useRef<string | null>(null);
  currentRef.current = currentPath;

  // Animated jump state: scroll-spy pauses while gliding so the rail doesn't
  // flick through every file passed on the way.
  const animRef = useRef<number | null>(null);
  const glidingRef = useRef(false);
  const jumpToRef = useRef<(path: string) => void>(() => {});
  const cancelGlide = () => {
    if (animRef.current != null) cancelAnimationFrame(animRef.current);
    animRef.current = null;
    glidingRef.current = false;
  };

  useEffect(() => {
    if (files.length === 0) return;
    const onScroll = () => {
      if (glidingRef.current) return;
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
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelGlide();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diffQ.data]);

  const targetTop = (el: HTMLElement) => {
    const top = el.getBoundingClientRect().top + window.scrollY - HEADER_PX - 8;
    const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    return Math.min(Math.max(top, 0), max);
  };

  /**
   * Fast glide instead of a teleport. Exponential approach re-measures the
   * element every frame, so files lazy-loading above (and shifting layout)
   * can't make it land short; wheel/touch input hands control back.
   */
  const jumpTo = (path: string) => {
    const el = sectionEls.current.get(path);
    if (!el) return;
    setCurrentPath(path);
    cancelGlide();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      window.scrollTo({ top: targetTop(el) });
      return;
    }
    glidingRef.current = true;
    window.addEventListener("wheel", cancelGlide, { once: true, passive: true });
    window.addEventListener("touchstart", cancelGlide, { once: true, passive: true });
    const TAU_MS = 55; // settles in ~4·TAU regardless of frame rate
    let last = performance.now();
    const step = (now: number) => {
      if (!glidingRef.current) return;
      const goal = targetTop(el);
      const delta = goal - window.scrollY;
      if (Math.abs(delta) < 1) {
        window.scrollTo({ top: goal });
        cancelGlide();
        return;
      }
      const k = 1 - Math.exp(-(now - last) / TAU_MS);
      last = now;
      window.scrollTo({ top: window.scrollY + delta * k });
      animRef.current = requestAnimationFrame(step);
    };
    animRef.current = requestAnimationFrame(step);
  };
  jumpToRef.current = jumpTo;

  /**
   * Jump to a specific occurrence row. The row may not exist yet (file
   * collapsed or hunks still streaming): expand it, glide toward the file,
   * and poll for the row for a few seconds before settling for the file top.
   */
  const jumpToOccurrence = (o: Occurrence) => {
    commandFile(o.path, true);
    jumpTo(o.path);
    const sel = `[data-path="${CSS.escape(o.path)}"] tr[data-lk~="${o.side}:${o.line}"]`;
    const t0 = performance.now();
    const attempt = () => {
      const el = document.querySelector<HTMLElement>(sel);
      if (el) {
        cancelGlide();
        window.scrollTo({
          top: el.getBoundingClientRect().top + window.scrollY - HEADER_PX - 80,
        });
        el.classList.remove("hunk-flash");
        void el.offsetWidth;
        el.classList.add("hunk-flash");
        setTimeout(() => el.classList.remove("hunk-flash"), 1300);
        setCurrentPath(o.path);
        return;
      }
      if (performance.now() - t0 < 3000) requestAnimationFrame(attempt);
    };
    requestAnimationFrame(attempt);
  };

  const jumpToEntityIn = (path: string, e: EntityChange) => {
    const a = entityAnchor(e);
    if (a) jumpToOccurrence({ path, side: a.side, line: a.line, kind: "context", text: "" });
  };

  const rollup = useMemo(
    () => (features.entities && semQ.data?.available ? buildRollup(semQ.data.files) : null),
    [features.entities, semQ.data],
  );

  // Hovering a diff claims focus; ignored mid-glide so a rail click isn't
  // hijacked by files sliding under the stationary-ish cursor.
  const hoverFocus = (path: string) => {
    if (glidingRef.current) return;
    setCurrentPath(path);
  };

  // Pointer crosshair over the diff tables (x toggles, persisted).
  const mainRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = mainRef.current;
    if (!features.crosshair || !el) return;
    return attachCrosshair(el);
  }, [features.crosshair, diffQ.data]);

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
      } else if (e.key === "J" || e.key === "K") {
        if (fs.length === 0) return;
        e.preventDefault();
        // -1 (no current file) behaves like being on the first file
        const idx = Math.max(0, fs.findIndex((f) => f.path === currentRef.current));
        const wants = (f: (typeof fs)[number]) => !f.seen || f.stale;
        const order: typeof fs = [];
        if (e.key === "J") {
          for (let i = 1; i <= fs.length; i++) order.push(fs[(idx + i + fs.length) % fs.length]!);
        } else {
          for (let i = 1; i <= fs.length; i++) order.push(fs[(idx - i + 2 * fs.length) % fs.length]!);
        }
        const next = order.find(wants);
        if (next) jumpToRef.current(next.path);
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
      } else if (e.key === "v" || e.key === "." || e.key === "s") {
        const f = fs.find((x) => x.path === currentRef.current);
        if (f) {
          seenMut.mutate({
            dir,
            base,
            path: f.path,
            contentHash: f.contentHash,
            // stale = needs review again, so the toggle re-marks it seen
            seen: !f.seen || f.stale,
          });
        }
      } else if (e.key === "x") {
        setFeatures((p) => ({ ...p, crosshair: !p.crosshair }));
      } else if (e.key === "?") {
        setHelp((h) => !h);
      } else if (e.key === "Escape") {
        setHelp(false);
        setSymbol(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir, base]);

  const [baseInput, setBaseInput] = useState(base);
  useEffect(() => setBaseInput(base), [base]);

  return (
    <div className="min-h-screen">
      <AppHeader>
        <span className="text-faint max-sm:hidden">/</span>
        <span
          className="max-w-56 shrink-0 truncate text-[13px] font-medium text-fg max-sm:max-w-24"
          title={dir}
        >
          {diffQ.data
            ? diffQ.data.branch ?? `detached @ ${shortSha(diffQ.data.head)}`
            : dir
              ? basename(dir)
              : "review"}
        </span>
        <span className="text-faint max-sm:hidden">→</span>
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
            list="base-refs"
            className="w-24 rounded-sm border border-edge bg-bg px-1.5 py-0.5 font-mono text-[12px] text-fg focus:border-accent/60 focus:outline-none max-sm:w-16"
          />
          <datalist id="base-refs">
            {(refsQ.data?.refs ?? []).map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
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
        {files.length > 0 && (
          <ReviewProgress files={files} currentPath={currentPath} onJump={jumpTo} />
        )}
        <div className="ml-auto flex items-center gap-3 self-stretch">
          <FeatureMenu features={features} onChange={setFeatures} />
          <LayoutToggle mode={mode} onChange={setMode} />
          <LiveDot status={wsStatus} />
          <button
            type="button"
            onClick={() => setHelp(true)}
            aria-label="Keyboard shortcuts"
            className="grid size-7 place-items-center rounded-sm font-mono text-[13px] text-mute transition-colors duration-150 hover:bg-raise hover:text-fg"
          >
            ?
          </button>
        </div>
      </AppHeader>

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
        <div className="w-full py-2">
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
        <div className="flex w-full items-start gap-2 py-2">
          <aside
            className="sticky hidden w-72 shrink-0 overflow-y-auto rounded-md border border-edge bg-panel md:block"
            style={{ top: HEADER_PX + 8, maxHeight: `calc(100vh - ${HEADER_PX + 16}px)` }}
          >
            <FileNav
              tree={tree}
              sections={sections}
              symbolFiles={symbolData?.files}
              unresolvedByFile={unresolvedByFile}
              currentPath={currentPath}
              onSelect={jumpTo}
              onToggleSeen={toggleSeen}
            />
          </aside>

          <main ref={mainRef} className="relative flex min-w-0 flex-1 flex-col gap-3">
            {rollup && <RollupPanel groups={rollup} onJump={jumpToEntityIn} />}
            {(sections ?? [null]).map((s) => (
              <Fragment key={s?.cls ?? "all"}>
                {s && (
                  <ClassSectionHeader
                    section={s}
                    onCollapseAll={(expand) => commandSection(s.cls, expand)}
                    onToggleSeenAll={(seen) => {
                      for (const f of s.files) toggleSeen(f, seen);
                    }}
                  />
                )}
                {(s?.files ?? files).map((f) => {
                  const cls = features.classDefaults
                    ? s?.cls ?? classifyFile(f.path)
                    : undefined;
                  return (
              <DiffFile
                key={f.path}
                dir={dir}
                currentBase={base}
                file={f}
                mode={mode}
                threads={threadsByFile.get(f.path) ?? []}
                isCurrent={currentPath === f.path}
                foldImports={features.importFolds}
                fileClass={cls}
                defaultCollapsed={cls === "generated"}
                collapseCmd={(() => {
                  const a = fileCmds[f.path];
                  const b = s ? sectionCmds[s.cls] : undefined;
                  return a && b ? (a.seq > b.seq ? a : b) : a ?? b;
                })()}
                onSymbolClick={features.symbols ? setSymbol : undefined}
                onHover={() => hoverFocus(f.path)}
                onToggleSeen={toggleSeen}
                onCreateComment={(anchor, body) => createComment(anchor, body)}
                onReply={reply}
                onResolve={resolve}
                sectionRef={(el) => {
                  if (el) sectionEls.current.set(f.path, el);
                  else sectionEls.current.delete(f.path);
                }}
                hunkRef={(hi, el) => {
                  const k = `${f.path} ${hi}`;
                  if (el) hunkEls.current.set(k, el);
                  else hunkEls.current.delete(k);
                }}
              />
                  );
                })}
              </Fragment>
            ))}

            <section className="rounded-md border border-edge bg-panel max-sm:rounded-none max-sm:border-x-0">
              <h2 className="border-b border-edge-soft px-3 py-2 text-[12px] font-semibold uppercase tracking-wide text-mute">
                Review notes
              </h2>
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
              j/k files · J/K unseen · n/p hunks · . seen · s block seen · x crosshair · ? shortcuts
            </p>
          </main>

          {(() => {
            const currentEntities =
              currentPath != null ? entitiesByPath.get(currentPath) : undefined;
            const panel =
              symbol != null && symbolData ? (
                <SymbolPanel
                  symbol={symbol}
                  occurrences={symbolData.occurrences}
                  fileOrder={files.map((f) => f.path)}
                  currentPath={currentPath}
                  notLoaded={symbolData.notLoaded}
                  onLoadAll={loadAllHunks}
                  onJump={jumpToOccurrence}
                  onClose={() => setSymbol(null)}
                />
              ) : rollup && currentPath ? (
                <EntityPanel
                  path={currentPath}
                  entities={currentEntities ?? []}
                  onJump={jumpToEntityIn}
                />
              ) : null;
            return (
              panel && (
                <aside
                  className="sticky hidden w-72 shrink-0 flex-col overflow-hidden rounded-md border border-edge bg-panel lg:flex"
                  style={{
                    top: HEADER_PX + 8,
                    maxHeight: `calc(100vh - ${HEADER_PX + 16}px)`,
                  }}
                >
                  {panel}
                </aside>
              )
            );
          })()}
        </div>
      )}

      {help && <HelpOverlay onClose={() => setHelp(false)} />}
    </div>
  );
}

function ClassSectionHeader({
  section,
  onCollapseAll,
  onToggleSeenAll,
}: {
  section: ClassSection;
  onCollapseAll: (expand: boolean) => void;
  onToggleSeenAll: (seen: boolean) => void;
}) {
  const { cls, files } = section;
  const totals = files.reduce(
    (acc, f) => ({ add: acc.add + f.additions, del: acc.del + f.deletions }),
    { add: 0, del: 0 },
  );
  const allSeen = files.length > 0 && files.every((f) => f.seen);
  const someSeen = files.some((f) => f.seen);
  return (
    <div className="mt-2 flex items-center gap-2.5 px-1 first:mt-0 max-sm:px-2">
      <Checkbox
        checked={allSeen}
        indeterminate={someSeen && !allSeen}
        title={allSeen ? "Mark section unseen" : "Mark section seen"}
        onChange={onToggleSeenAll}
      />
      <h2 className="text-[12px] font-semibold uppercase tracking-wide text-mute">
        {CLASS_LABEL[cls]}
      </h2>
      <span className="font-mono text-[11.5px] tabular-nums text-faint">
        {files.length} file{files.length === 1 ? "" : "s"}{" "}
        <span className="text-add">+{totals.add}</span>{" "}
        <span className="text-del">−{totals.del}</span>
      </span>
      <div className="ml-auto flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => onCollapseAll(false)}
          className="rounded-sm px-1.5 py-0.5 font-mono text-[11px] text-faint transition-colors duration-150 hover:bg-raise hover:text-fg"
        >
          collapse all
        </button>
        <button
          type="button"
          onClick={() => onCollapseAll(true)}
          className="rounded-sm px-1.5 py-0.5 font-mono text-[11px] text-faint transition-colors duration-150 hover:bg-raise hover:text-fg"
        >
          expand all
        </button>
      </div>
    </div>
  );
}

function CenterPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto mt-24 w-full max-w-md rounded-md border border-edge bg-panel px-6 py-6 text-center max-sm:mx-4 max-sm:w-auto">
      {children}
    </div>
  );
}
