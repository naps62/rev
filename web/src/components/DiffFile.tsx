import { useQuery } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import type {
  Comment,
  CommentAnchor,
  DiffHunk,
  DiffLine,
  EntityChange,
  FileSummary,
} from "#shared/types";
import { TUNING } from "#shared/tuning";
import * as api from "../api";
import { highlightLines, type TokenLine } from "../highlight";
import { intralineSpans, type Span } from "../intraline";
import type { FileClass } from "../semantic/classify.ts";
import { CHANGE_GLYPH, entityLabel } from "../semantic/entities.ts";
import { importFolds, langOf, testFolds, type FoldRun } from "../semantic/fold.ts";
import { loadFoldState, saveFoldState } from "../semantic/foldStore.ts";
import {
  buildSegments,
  innermostAt,
  seenRuns,
  type Segment,
} from "../semantic/segments.ts";
import { isSymbol, tokenAt } from "../semantic/symbols.ts";
import { cx, lineKey, type Thread } from "../util";
import { AuthorChip, CommentThread, threadShell } from "./CommentThread";
import { Checkbox } from "./Checkbox";
import { Composer } from "./Composer";

// "M" stays neutral so amber only ever means attention (stale, open, current).
const STATUS_GLYPH: Record<FileSummary["status"], { glyph: string; cls: string; label: string }> = {
  modified: { glyph: "M", cls: "text-mute", label: "modified" },
  added: { glyph: "A", cls: "text-add", label: "added" },
  deleted: { glyph: "D", cls: "text-del", label: "deleted" },
  renamed: { glyph: "R", cls: "text-agent", label: "renamed" },
  untracked: { glyph: "U", cls: "text-add", label: "untracked" },
};

export type DiffMode = "unified" | "split";

interface DiffFileProps {
  dir: string;
  /** Base ref of the review; threads from other bases get a label. */
  currentBase: string;
  file: FileSummary;
  mode: DiffMode;
  /** All threads anchored to this file; placed on lines once hunks load. */
  threads: Thread[];
  isCurrent: boolean;
  /** Semantic view on: enables import/test-body folding (unified only). */
  semantic?: boolean;
  /** Entity-level changes from sem (semantic view); absent → no strip. */
  entities?: EntityChange[];
  /** Click on an entity in the strip — scroll its first line into view. */
  onJumpToEntity?: (e: EntityChange) => void;
  /** This file's class in semantic view; "tests" switches to body folding. */
  fileClass?: FileClass;
  /** Start collapsed regardless of size/seen (semantic "generated" class). */
  defaultCollapsed?: boolean;
  /** Section-level collapse/expand-all: acts once per seq bump. */
  collapseCmd?: { seq: number; expand: boolean };
  /** Mouse moved over this file — claim focus (rail + yellow indicator). */
  onHover?: () => void;
  onToggleSeen: (file: FileSummary, seen: boolean) => void;
  /** Mark/unmark sub-file segments (s/S over a line, click on a seen strip). */
  onToggleSegments?: (
    file: FileSummary,
    segments: Array<{ hash: string; addDelLines: number }>,
    seen: boolean,
  ) => void;
  /** Click on an identifier — open/retarget the symbol panel. */
  onSymbolClick?: (symbol: string) => void;
  /** Hover over an identifier; only fired while the panel is open. */
  onSymbolHover?: (symbol: string) => void;
  /** Symbol panel is open: enables hover retargeting. */
  symbolActive?: boolean;
  onCreateComment: (anchor: CommentAnchor, body: string) => void;
  onReply: (root: Comment, body: string) => void;
  onResolve: (root: Comment, resolved: boolean) => void;
  sectionRef: (el: HTMLElement | null) => void;
  /** Registers hunk-header rows and fold strips for n/p navigation. */
  hunkRef?: (hunkId: number | string, el: HTMLTableRowElement | null) => void;
}

export function DiffFile({
  dir,
  currentBase,
  file,
  mode,
  threads,
  isCurrent,
  semantic,
  entities,
  onJumpToEntity,
  fileClass,
  defaultCollapsed,
  collapseCmd,
  onHover,
  onToggleSeen,
  onToggleSegments,
  onSymbolClick,
  onSymbolHover,
  symbolActive,
  onCreateComment,
  onReply,
  onResolve,
  sectionRef,
  hunkRef,
}: DiffFileProps) {
  const changed = file.additions + file.deletions;
  const [flash, setFlash] = useState(false);
  const [editing, setEditing] = useState(false);
  const [composerAt, setComposerAt] = useState<{ key: string; anchor: CommentAnchor } | null>(null);
  const prevStale = useRef(file.stale);

  useEffect(() => {
    if (file.stale && !prevStale.current) {
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 1700);
      prevStale.current = file.stale;
      return () => clearTimeout(t);
    }
    prevStale.current = file.stale;
  }, [file.stale]);

  // Collapsed IS seen (one state, from main) — but the semantic view needs
  // to open/close files without touching seen: section collapse-all,
  // generated-class default-collapsed. `peek` overrides the derived state;
  // null follows it. Any seen change clears the override.
  const [peek, setPeek] = useState<boolean | null>(null);
  const lastCmdSeq = useRef(collapseCmd?.seq ?? 0);
  useEffect(() => {
    if (!collapseCmd || collapseCmd.seq === lastCmdSeq.current) return;
    lastCmdSeq.current = collapseCmd.seq;
    setPeek(collapseCmd.expand);
  }, [collapseCmd]);
  const prevSeen = useRef(file.seen);
  useEffect(() => {
    if (file.seen !== prevSeen.current) {
      prevSeen.current = file.seen;
      setPeek(null);
    }
  }, [file.seen]);

  const status = STATUS_GLYPH[file.status];
  // Summary alone tells whether there is anything to show: binary and
  // mode-only changes have no lines; oversized untracked files report 0.
  const canExpand = !file.binary && changed > 0;
  const canEdit = !file.binary && file.status !== "deleted";
  // Collapsed IS seen — one state. Stale re-opens the file until re-marked.
  // peek (semantic view) overrides both; defaultCollapsed only the default.
  const expanded =
    canExpand && (peek ?? ((!file.seen && !defaultCollapsed) || file.stale));
  // Whether anything renders below the header (diff table or quick-edit).
  const open = editing || expanded;

  // A stale file is "needs review", so a click re-marks it seen rather than
  // unmarking it.
  const toggleSeen = () => onToggleSeen(file, !file.seen || file.stale);
  /**
   * Header/chevron click. Seen-collapsed and unseen-expanded keep main's
   * toggle-seen behavior; peek-collapsed (section collapse-all, generated
   * default) opens without unmarking, and peek-opened seen files close
   * without marking anything.
   */
  const toggleOpen = () => {
    if (!expanded && !file.seen && !file.stale) {
      setPeek(true);
      return;
    }
    if (expanded && file.seen && !file.stale) {
      setPeek(null);
      return;
    }
    setPeek(null);
    toggleSeen();
  };

  // Body stays mounted while the close animation slides it shut (250ms
  // transition in .file-body), then unmounts to free the rows.
  const [lingering, setLingering] = useState(false);
  const everOpened = useRef(open);
  useEffect(() => {
    if (open) {
      everOpened.current = true;
      setLingering(false);
      return;
    }
    if (!everOpened.current) return;
    setLingering(true);
    const t = setTimeout(() => setLingering(false), 300);
    return () => clearTimeout(t);
  }, [open]);
  const showBody = open || lingering;

  // Stale files default to the interdiff: only what changed since the user
  // last marked the file seen. "full" switches back to the whole diff.
  const [view, setView] = useState<"delta" | "full">("delta");
  useEffect(() => {
    if (file.stale) setView("delta");
  }, [file.stale]);

  // Hunks stream in per file: fetched only once expanded AND near the
  // viewport, so opening a huge review costs nothing up front.
  const ownRef = useRef<HTMLElement | null>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (near || !open) return;
    const el = ownRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => entries.some((e) => e.isIntersecting) && setNear(true),
      { rootMargin: `${TUNING.HUNK_PREFETCH_MARGIN_PX}px 0px` },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [near, open]);

  const wantDelta = file.stale && view === "delta" && expanded && near && !editing;
  const interQ = useQuery({
    queryKey: ["interdiff", dir, currentBase, file.path, file.contentHash],
    queryFn: () => api.getInterdiff(dir, currentBase, file.path),
    enabled: wantDelta,
    staleTime: Infinity,
    // 404 = no snapshot (pre-feature seen rows): fall back to the full diff
    retry: (count, err) => (err as api.ApiError).status !== 404 && count < 2,
  });
  const noSnapshot = interQ.isError && (interQ.error as api.ApiError).status === 404;
  const deltaActive = wantDelta && !noSnapshot;

  const hunksQ = useQuery({
    queryKey: ["diff-file", dir, currentBase, file.path, file.contentHash],
    queryFn: () => api.getFileDiff(dir, currentBase, file.path, file.oldPath),
    enabled: canExpand && expanded && near && !deltaActive,
    staleTime: Infinity,
  });
  const activeFile = deltaActive ? interQ.data?.file : hunksQ.data?.file;
  const activeError = deltaActive
    ? interQ.isError
      ? (interQ.error as Error)
      : null
    : hunksQ.isError
      ? (hunksQ.error as Error)
      : null;
  const activeRetry = deltaActive ? interQ.refetch : hunksQ.refetch;
  const hunks = useMemo(() => activeFile?.hunks ?? [], [activeFile]);

  const flat = useMemo(() => hunks.flatMap((h) => h.lines), [hunks]);
  const spans = useMemo(() => intralineSpans(hunks), [hunks]);

  // Semantic folding: import runs everywhere, whole bodies in test files.
  // Manually expanded strips and the show-bodies toggle persist per file,
  // pinned to contentHash — a content change invalidates the hunk-relative
  // fold keys, so the state resets with it.
  const persistedFolds = useMemo(
    () => loadFoldState(dir, file.path, file.contentHash),
    [dir, file.path, file.contentHash],
  );
  const [expandedFolds, setExpandedFolds] = useState<Set<string>>(
    () => new Set(persistedFolds?.folds ?? []),
  );
  const [showBodies, setShowBodies] = useState(persistedFolds?.showBodies ?? false);
  useEffect(() => {
    setExpandedFolds(new Set(persistedFolds?.folds ?? []));
    setShowBodies(persistedFolds?.showBodies ?? false);
  }, [persistedFolds]);
  useEffect(() => {
    saveFoldState(dir, file.path, file.contentHash, {
      folds: [...expandedFolds],
      showBodies,
    });
  }, [dir, file.path, file.contentHash, expandedFolds, showBodies]);
  // Fold whose gutter rail is under the pointer; its rows get a wash.
  const [hotFold, setHotFold] = useState<string | null>(null);
  const toggleFold = useCallback((key: string) => {
    setHotFold(null);
    setExpandedFolds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const foldBodies = semantic && fileClass === "tests" && !showBodies;
  // Import and test-body folds share hunk offsets; the prefix keeps a key
  // expanded in one mode from leaking into the other.
  const foldKey = (hi: number, run: FoldRun) =>
    `${foldBodies ? "t" : "i"}:${hi}:${run.start}`;
  const foldsByHunk = useMemo(() => {
    const lang = langOf(file.path);
    if (!semantic || !lang) return null;
    const m = new Map<number, FoldRun[]>();
    hunks.forEach((h, hi) => {
      const runs = foldBodies ? testFolds(h.lines, lang) : importFolds(h.lines, lang);
      if (runs.length > 0) m.set(hi, runs);
    });
    return m.size > 0 ? m : null;
  }, [semantic, file.path, hunks, foldBodies]);

  // Sub-file seen segments: detected client-side per hunk, keyed by content
  // hash (segments.ts). Unified full-diff only — delta hunks are different
  // rows, so their hashes would never match.
  const segActive = mode === "unified" && !deltaActive && !file.binary;
  const segsByHunk = useMemo(() => {
    if (!segActive || onToggleSegments === undefined) return null;
    const lang = langOf(file.path);
    const m = new Map<number, Segment[]>();
    hunks.forEach((h, hi) => {
      const segs = buildSegments(h.lines, lang);
      if (segs.length > 0) m.set(hi, segs);
    });
    return m.size > 0 ? m : null;
  }, [segActive, onToggleSegments, file.path, hunks]);
  const seenSegs = useMemo(
    () => new Set(hunksQ.data?.seenSegments ?? []),
    [hunksQ.data],
  );
  const seenRunsByHunk = useMemo(() => {
    if (!segsByHunk) return null;
    const m = new Map<number, Segment[]>();
    for (const [hi, segs] of segsByHunk) {
      const runs = seenRuns(segs, (h) => seenSegs.has(h));
      if (runs.length > 0) m.set(hi, runs);
    }
    return m.size > 0 ? m : null;
  }, [segsByHunk, seenSegs]);

  // s/S act on the row under the pointer: the section's mousemove keeps the
  // last position, elementFromPoint resolves it back to a data-hi/data-li row.
  const mousePos = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!segsByHunk || !onToggleSegments) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "s" && e.key !== "S") return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || t?.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const pos = mousePos.current;
      if (!pos) return;
      const el = document.elementFromPoint(pos.x, pos.y);
      if (!el || !ownRef.current?.contains(el)) return;
      const row = (el as HTMLElement).closest<HTMLElement>("[data-hi]");
      if (!row?.dataset.hi) return;
      const segs = segsByHunk.get(Number(row.dataset.hi));
      if (!segs) return;
      // nearest unseen ancestor starting at idx (marking a seen one is a no-op)
      const unseenFrom = (idx: number | null): number | null => {
        let i = idx;
        while (i != null && seenSegs.has(segs[i]!.hash)) i = segs[i]!.parent;
        return i;
      };
      let target: Segment | null = null;
      let mark = true;
      if (row.dataset.stripStart !== undefined) {
        const g = segs.find((s) => s.start === Number(row.dataset.stripStart));
        if (!g) return;
        if (e.key === "s") {
          target = g; // toggle the strip off
          mark = false;
        } else {
          const p = unseenFrom(g.parent);
          target = p != null ? segs[p]! : null; // widen past the strip
        }
      } else if (row.dataset.li !== undefined) {
        const i0 = innermostAt(segs, Number(row.dataset.li));
        if (i0 == null) return;
        const i = unseenFrom(i0);
        if (i == null) {
          // every enclosing segment already seen (widget-suppressed strip):
          // toggle the innermost back off
          target = segs[i0]!;
          mark = false;
        } else if (e.key === "s") {
          target = segs[i]!;
        } else {
          const p = unseenFrom(segs[i]!.parent);
          target = p != null ? segs[p]! : null;
        }
      }
      if (!target) return;
      e.preventDefault();
      onToggleSegments(
        file,
        [{ hash: target.hash, addDelLines: target.adds + target.dels }],
        mark,
      );
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [segsByHunk, seenSegs, file, onToggleSegments]);

  // Symbol panel wiring: resolve the identifier under the pointer and filter
  // through the language's stopwords before bubbling up.
  const symbolHandlers = useMemo<SymbolHandlers | undefined>(() => {
    if (!semantic || !onSymbolClick) return undefined;
    const lang = langOf(file.path);
    const extract = (e: MouseEvent<HTMLElement>, text: string) => {
      const t = tokenFromPoint(e, text);
      return t != null && isSymbol(t, lang) ? t : null;
    };
    return {
      click: (e, text) => {
        const t = extract(e, text);
        if (t) onSymbolClick(t);
      },
      hover: (e, text) => {
        if (!symbolActive || !onSymbolHover) return;
        const t = extract(e, text);
        if (t) onSymbolHover(t);
      },
    };
  }, [semantic, onSymbolClick, onSymbolHover, symbolActive, file.path]);
  const [tokens, setTokens] = useState<TokenLine[] | null>(null);
  // Tokens align to `flat` by index — drop them the moment the diff changes,
  // but NOT on collapse, so colors survive the close animation.
  useEffect(() => setTokens(null), [flat]);
  useEffect(() => {
    if (!expanded || file.binary || flat.length === 0) return;
    let live = true;
    highlightLines(file.path, file.contentHash, flat.map((l) => l.text)).then(
      (t) => live && setTokens(t),
    );
    return () => {
      live = false;
    };
  }, [expanded, file.binary, file.path, file.contentHash, flat]);

  // Place threads on their lines (server-re-anchored resolvedLine first,
  // original anchor as fallback); the rest are detached. Placement needs
  // hunks — until they load, nothing is declared detached.
  const { threadsByLine, detached } = useMemo(() => {
    const byLine = new Map<string, Thread[]>();
    const rest: Thread[] = [];
    if (threads.length === 0 || activeFile == null) return { threadsByLine: byLine, detached: rest };
    const lines = new Set<string>();
    for (const h of hunks) {
      for (const l of h.lines) {
        if (l.oldLine != null) lines.add(lineKey("old", l.oldLine));
        if (l.newLine != null) lines.add(lineKey("new", l.newLine));
      }
    }
    for (const t of threads) {
      const a = t.root.anchor!;
      const rl = t.root.resolvedLine;
      const candidates =
        a.side === "new" && typeof rl === "number" && rl !== a.line
          ? [lineKey("new", rl), lineKey(a.side, a.line)]
          : [lineKey(a.side, a.line)];
      const k = candidates.find((c) => lines.has(c));
      if (k != null) byLine.set(k, [...(byLine.get(k) ?? []), t]);
      else rest.push(t);
    }
    return { threadsByLine: byLine, detached: rest };
  }, [threads, hunks, activeFile]);

  const unresolved = useMemo(
    () => threads.filter((t) => t.root.resolvedAt == null).length,
    [threads],
  );

  const collapsedNote = file.binary
    ? "binary"
    : file.status === "deleted"
      ? `deleted · ${file.deletions} lines`
      : file.seen
        ? "seen"
        : "collapsed";

  const toggleComposer = (side: "old" | "new", line: DiffLine, hunk: DiffHunk) => {
    const num = (side === "old" ? line.oldLine : line.newLine) ?? 0;
    const key = lineKey(side, num);
    setComposerAt((cur) =>
      cur?.key === key
        ? null
        : {
            key,
            anchor: {
              file: file.path,
              side,
              line: num,
              snippet: line.text.trim(),
              context: anchorContext(hunk, line, side),
            },
          },
    );
  };

  const composerNode = (key: string) =>
    composerAt?.key === key ? (
      <div className={threadShell}>
        <div className="flex items-baseline gap-2 border-b border-edge-soft bg-panel px-3 py-1">
          <AuthorChip author="user" />
          <span className="min-w-0 truncate font-mono text-[11px] text-faint">
            {file.path}:{composerAt.anchor.line}
          </span>
        </div>
        <Composer
          placeholder="Write a comment…"
          autoFocus
          onSubmit={(body) => {
            onCreateComment(composerAt.anchor, body);
            setComposerAt(null);
          }}
          onCancel={() => setComposerAt(null)}
        />
      </div>
    ) : null;

  const threadNodes = (key: string | null): ReactNode[] =>
    key == null
      ? []
      : (threadsByLine.get(key) ?? []).map((thread) => (
          <CommentThread
            key={thread.root.id}
            thread={thread}
            baseLabel={thread.root.base !== currentBase ? thread.root.base : undefined}
            onReply={(body) => onReply(thread.root, body)}
            onResolve={(resolved) => onResolve(thread.root, resolved)}
          />
        ));

  // Rows are built imperatively so comment threads and the composer can be
  // spliced in directly under their anchored line (in the right pane when split).
  const split = mode === "split";
  const rows: ReactNode[] = [];
  if ((expanded || lingering) && !editing) {
    let flatIdx = 0;
    hunks.forEach((hunk, hi) => {
      rows.push(
        split ? (
          <tr key={`h${hi}`} ref={(el) => hunkRef?.(hi, el)}>
            <td colSpan={4} className="bg-raise/50 py-1 pl-7 font-mono text-[11px] text-faint">
              @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
              {hunk.header ? <span className="text-mute"> {hunk.header}</span> : null}
            </td>
          </tr>
        ) : (
          <tr key={`h${hi}`} ref={(el) => hunkRef?.(hi, el)}>
            <td colSpan={2} className="select-none border-r border-edge-soft bg-raise/50" />
            <td className="bg-raise/50 py-1 pl-7 font-mono text-[11px] text-faint">
              @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
              {hunk.header ? <span className="text-mute"> {hunk.header}</span> : null}
            </td>
          </tr>
        ),
      );

      // A fold with a thread or open composer inside must stay visible —
      // a hidden comment is worse than a visible import block.
      const hasWidget = (run: { start: number; end: number }) => {
        for (let j = run.start; j < run.end; j++) {
          const l = hunk.lines[j]!;
          const keys = [
            l.oldLine != null ? lineKey("old", l.oldLine) : null,
            l.newLine != null ? lineKey("new", l.newLine) : null,
          ];
          for (const k of keys) {
            if (k != null && (threadsByLine.has(k) || composerAt?.key === k)) return true;
          }
        }
        return false;
      };
      // Seen-segment strips win over folds: drop fold runs they intersect.
      const sruns = (seenRunsByHunk?.get(hi) ?? []).filter((g) => !hasWidget(g));
      const runs = (foldsByHunk?.get(hi) ?? []).filter(
        (r) => !sruns.some((g) => r.start < g.end && g.start < r.end),
      );
      // hasWidget scans the run's lines; runAt is now called per line, so
      // cache the verdict per run.
      const widgetCache = new Map<FoldRun, boolean>();
      const runHasWidget = (r: FoldRun) => {
        let v = widgetCache.get(r);
        if (v === undefined) {
          v = hasWidget(r);
          widgetCache.set(r, v);
        }
        return v;
      };
      const runAt = (li: number) => {
        const r = runs.find((x) => li >= x.start && li < x.end);
        return r && !runHasWidget(r) ? r : null;
      };
      const railProps = (run: FoldRun, fk: string, first: boolean): FoldRail => ({
        hot: hotFold === fk,
        first,
        label: `Fold ${run.end - run.start} ${run.label}`,
        onToggle: () => toggleFold(fk),
        onHover: (h) => setHotFold((cur) => (h ? fk : cur === fk ? null : cur)),
      });

      if (split) {
        type Slot = { line: DiffLine; idx: number; li: number };
        const pairs: Array<{ l: Slot | null; r: Slot | null }> = [];
        let dels: Slot[] = [];
        let adds: Slot[] = [];
        const flush = () => {
          const n = Math.max(dels.length, adds.length);
          for (let i = 0; i < n; i++) pairs.push({ l: dels[i] ?? null, r: adds[i] ?? null });
          dels = [];
          adds = [];
        };
        hunk.lines.forEach((line, li) => {
          const idx = flatIdx++;
          if (line.kind === "del") dels.push({ line, idx, li });
          else if (line.kind === "add") adds.push({ line, idx, li });
          else {
            flush();
            pairs.push({ l: { line, idx, li }, r: { line, idx, li } });
          }
        });
        flush();

        // A pair folds only when every populated slot sits in the same run;
        // consecutive such pairs collapse into one strip.
        const pairRun = (p: { l: Slot | null; r: Slot | null }): FoldRun | null => {
          const slots = [p.l, p.r].filter(Boolean) as Slot[];
          if (slots.length === 0) return null;
          const rs = slots.map((s) => runAt(s.li));
          const r = rs[0];
          return r != null && rs.every((x) => x === r) ? r : null;
        };

        // Expanded runs render as real rows with a gutter rail; the first
        // pair of each run carries the accessible rail control.
        const railed = new Set<FoldRun>();
        for (let pi = 0; pi < pairs.length; pi++) {
          const p = pairs[pi]!;
          const run = pairRun(p);
          let fold: FoldRail | undefined;
          if (run) {
            const fk = foldKey(hi, run);
            if (!expandedFolds.has(fk)) {
              rows.push(
                <FoldStrip
                  key={`f${hi}.${run.start}.${pi}`}
                  run={run}
                  split
                  stripRef={
                    run.start > 0 ? (el) => hunkRef?.(`${hi}.${run.start}`, el) : undefined
                  }
                  onExpand={() => toggleFold(fk)}
                />,
              );
              while (pi + 1 < pairs.length && pairRun(pairs[pi + 1]!) === run) pi++;
              continue;
            }
            fold = railProps(run, fk, !railed.has(run));
            railed.add(run);
          }
          rows.push(
            <SplitRow
              key={`s${hi}.${pi}`}
              left={p.l}
              right={p.r}
              tokens={tokens}
              spans={spans}
              fold={fold}
              onCommentLeft={p.l ? () => toggleComposer("old", p.l!.line, hunk) : undefined}
              onCommentRight={p.r ? () => toggleComposer("new", p.r!.line, hunk) : undefined}
              onSym={symbolHandlers}
            />,
          );
          const leftKey = p.l?.line.oldLine != null ? lineKey("old", p.l.line.oldLine) : null;
          const rightKey = p.r?.line.newLine != null ? lineKey("new", p.r.line.newLine) : null;
          const leftNodes = [
            ...threadNodes(leftKey),
            leftKey != null ? composerNode(leftKey) : null,
          ].filter(Boolean);
          const rightNodes = [
            ...threadNodes(rightKey),
            rightKey != null ? composerNode(rightKey) : null,
          ].filter(Boolean);
          if (leftNodes.length > 0 || rightNodes.length > 0) {
            rows.push(
              <tr key={`x${hi}.${pi}`}>
                <td colSpan={2} className="border-r border-edge-soft p-0 align-top">
                  {leftNodes}
                </td>
                <td colSpan={2} className="p-0 align-top">
                  {rightNodes}
                </td>
              </tr>,
            );
          }
        }
      } else {
        for (let li = 0; li < hunk.lines.length; li++) {
          const sg = sruns.find((g) => g.start === li);
          if (sg) {
            rows.push(
              <SeenStrip
                key={`sg${hi}.${sg.start}`}
                seg={sg}
                hi={hi}
                onUnsee={() =>
                  onToggleSegments?.(
                    file,
                    [{ hash: sg.hash, addDelLines: sg.adds + sg.dels }],
                    false,
                  )
                }
              />,
            );
            flatIdx += sg.end - sg.start;
            li = sg.end - 1;
            continue;
          }
          const run = runs.find((r) => r.start === li);
          if (run && !runHasWidget(run) && !expandedFolds.has(foldKey(hi, run))) {
            const fk = foldKey(hi, run);
            rows.push(
              <FoldStrip
                key={`f${hi}.${run.start}`}
                run={run}
                // Strips right under the @@ header would double n/p stops.
                stripRef={
                  run.start > 0 ? (el) => hunkRef?.(`${hi}.${run.start}`, el) : undefined
                }
                onExpand={() => toggleFold(fk)}
              />,
            );
            flatIdx += run.end - run.start;
            li = run.end - 1;
            continue;
          }
          // Expanded runs render their real lines with a fold rail in the
          // gutter instead of a strip row, so the diff reads uninterrupted.
          const openRun = runAt(li);
          const fold =
            openRun && expandedFolds.has(foldKey(hi, openRun))
              ? railProps(openRun, foldKey(hi, openRun), li === openRun.start)
              : undefined;
          const line = hunk.lines[li]!;
          const idx = flatIdx++;
          const side: "old" | "new" = line.kind === "del" ? "old" : "new";
          const num = (side === "old" ? line.oldLine : line.newLine) ?? 0;
          const key = lineKey(side, num);
          rows.push(
            <LineRow
              key={`l${hi}.${li}`}
              line={line}
              hi={hi}
              li={li}
              tokens={tokens?.[idx] ?? null}
              span={spans.get(idx)}
              fold={fold}
              onComment={() => toggleComposer(side, line, hunk)}
              onSym={symbolHandlers}
            />,
          );
          const keys =
            line.kind === "context" && line.oldLine != null
              ? [key, lineKey("old", line.oldLine)]
              : [key];
          const extras = [
            ...keys.flatMap((k) => threadNodes(k)),
            composerNode(key),
          ].filter(Boolean);
          if (extras.length > 0) {
            rows.push(
              <tr key={`x${hi}.${li}`}>
                <td colSpan={3} className="p-0">
                  {extras}
                </td>
              </tr>,
            );
          }
        }
      }
    });
  }

  return (
    <section
      ref={(el) => {
        ownRef.current = el;
        sectionRef(el);
      }}
      data-path={file.path}
      onMouseMove={(e) => {
        mousePos.current = { x: e.clientX, y: e.clientY };
        onHover?.();
      }}
      className={cx(
        // No overflow-hidden here: it would turn the section into the sticky
        // header's scrollport and pin it 48px into the card.
        "rounded-md border bg-panel",
        isCurrent ? "border-accent/50" : "border-edge",
        flash && "stale-flash",
      )}
    >
      <header
        onClick={() => !editing && toggleOpen()}
        className={cx(
          "sticky top-12 z-10 flex min-w-0 items-center gap-2.5 rounded-t-[5px] bg-raise px-2 py-1.5",
          showBody ? "border-b border-edge-soft" : "rounded-b-[5px]",
          !editing && "cursor-pointer",
        )}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (!editing) toggleOpen();
          }}
          disabled={!canExpand}
          aria-expanded={canExpand ? expanded : undefined}
          aria-label={expanded ? "Mark seen and collapse" : "Mark unseen and expand"}
          className="grid size-5 shrink-0 place-items-center rounded-sm text-mute transition-colors duration-150 hover:bg-panel hover:text-fg disabled:cursor-default disabled:text-faint"
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden
            className={cx("transition-transform duration-150", expanded && "rotate-90")}
          >
            <path d="M5.5 3 11 8l-5.5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <span
          title={status.label}
          className={cx("w-3 shrink-0 text-center font-mono text-[12px] font-bold", status.cls)}
        >
          {status.glyph}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg">
          {file.oldPath && (
            <>
              <span className="text-faint">{file.oldPath}</span>
              <span className="text-faint"> → </span>
            </>
          )}
          {file.path}
        </span>
        {!open && (
          <span className="shrink-0 font-mono text-[11px] text-faint">{collapsedNote}</span>
        )}
        {!file.binary && (
          <span className="shrink-0 font-mono text-[11.5px] tabular-nums">
            <span className="text-add">+{file.additions}</span>{" "}
            <span className="text-del">−{file.deletions}</span>
          </span>
        )}
        {file.stale && (
          <span className="shrink-0 rounded-sm border border-accent/40 bg-accent-soft px-1.5 py-px text-[11px] font-medium text-accent">
            changed since seen
          </span>
        )}
        {unresolved > 0 && (
          <span className="shrink-0 rounded-sm bg-panel px-1.5 py-px font-mono text-[11px] text-accent">
            {unresolved} open
          </span>
        )}
        <div className="flex shrink-0 items-center gap-2.5">
          {semantic && fileClass === "tests" && open && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setShowBodies((b) => !b);
              }}
              title={showBodies ? "Fold test bodies back to names" : "Show full test bodies"}
              className="rounded-sm px-1.5 py-0.5 font-mono text-[11px] text-mute transition-colors duration-150 hover:bg-panel hover:text-fg"
            >
              {showBodies ? "hide bodies" : "show bodies"}
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setEditing(true);
              }}
              className="rounded-sm px-1.5 py-0.5 text-[12px] text-mute transition-colors duration-150 hover:bg-panel hover:text-fg"
            >
              edit
            </button>
          )}
          <label
            onClick={(e) => e.stopPropagation()}
            className="flex cursor-pointer items-center gap-1.5 text-[12px] text-mute transition-colors duration-150 hover:text-fg"
          >
            <Checkbox
              checked={file.seen}
              onChange={(checked) => onToggleSeen(file, checked)}
            />
            seen
          </label>
        </div>
      </header>

      <div className="file-body" data-open={open || undefined}>
      <div className="min-h-0 overflow-hidden rounded-b-[5px]">
      {showBody && !editing && semantic && entities != null && entities.length > 0 && (
        <EntityStrip entities={entities} onJump={onJumpToEntity} />
      )}
      {showBody && !editing && file.stale && interQ.data != null && (
        <div className="flex items-baseline gap-2 border-b border-edge-soft bg-accent-soft/60 px-3 py-1 font-mono text-[11px] text-mute">
          {deltaActive ? (
            <>
              <span>
                changes since last seen{" "}
                <span className="text-add">+{interQ.data.file.additions}</span>{" "}
                <span className="text-del">−{interQ.data.file.deletions}</span>
              </span>
              <button
                type="button"
                onClick={() => setView("full")}
                className="ml-auto text-accent hover:underline"
              >
                full diff
              </button>
            </>
          ) : (
            <>
              <span>full diff</span>
              <button
                type="button"
                onClick={() => setView("delta")}
                className="ml-auto text-accent hover:underline"
              >
                changes since last seen
              </button>
            </>
          )}
        </div>
      )}
      {editing ? (
        <QuickEditPanel dir={dir} path={file.path} onClose={() => setEditing(false)} />
      ) : !showBody ? null : activeFile == null ? (
        activeError && !noSnapshot ? (
          <div className="flex items-center gap-3 px-4 py-3">
            <p className="font-mono text-[12px] text-del">{activeError.message}</p>
            <button
              type="button"
              onClick={() => activeRetry()}
              className="text-[12px] text-mute hover:text-fg"
            >
              Retry
            </button>
            {deltaActive && (
              <button
                type="button"
                onClick={() => setView("full")}
                className="text-[12px] text-mute hover:text-fg"
              >
                Show full diff
              </button>
            )}
          </div>
        ) : (
          <HunkSkeleton changed={changed} />
        )
      ) : deltaActive && hunks.length === 0 ? (
        <p className="px-3 py-2 font-mono text-[12px] text-faint">
          no changes since you last reviewed this file
        </p>
      ) : (
        <table className={cx("w-full border-collapse", split && "table-fixed")}>
          {split ? (
            <colgroup>
              <col className="w-11" />
              <col />
              <col className="w-11" />
              <col />
            </colgroup>
          ) : (
            <colgroup>
              <col className="w-11" />
              <col className="w-11" />
              <col />
            </colgroup>
          )}
          <tbody>{rows}</tbody>
        </table>
      )}

      {(expanded || lingering) && !editing && activeFile != null && detached.length > 0 && (
        <div className="border-t border-edge-soft">
          <p className="px-3 pt-2 text-[11px] text-faint">
            Couldn't re-anchor — the commented lines no longer exist:
          </p>
          {detached.map((thread) => (
            <CommentThread
              key={thread.root.id}
              thread={thread}
              baseLabel={thread.root.base !== currentBase ? thread.root.base : undefined}
              anchorNote={
                thread.root.anchor
                  ? `${thread.root.anchor.side}:${thread.root.anchor.line}  ${thread.root.anchor.snippet}`
                  : undefined
              }
              onReply={(body) => onReply(thread.root, body)}
              onResolve={(resolved) => onResolve(thread.root, resolved)}
            />
          ))}
        </div>
      )}
      </div>
      </div>
    </section>
  );
}

const ENTITY_STRIP_CAP = 12;

const ENTITY_CLS: Record<EntityChange["change"], string> = {
  added: "text-add",
  modified: "text-mute",
  deleted: "text-del",
  renamed: "text-agent",
  moved: "text-agent",
  reordered: "text-agent",
};

/** What changed at entity level ("~ authenticate · + gamma"), from sem. */
function EntityStrip({
  entities,
  onJump,
}: {
  entities: EntityChange[];
  onJump?: (e: EntityChange) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? entities : entities.slice(0, ENTITY_STRIP_CAP);
  return (
    <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 border-b border-edge-soft bg-raise/30 px-3 py-1 font-mono text-[11px]">
      {shown.map((e, i) => (
        <button
          key={`${e.entityType}:${e.name}:${i}`}
          type="button"
          onClick={() => onJump?.(e)}
          title={`${e.entityType} ${e.change}${e.startLine != null ? ` · line ${e.startLine}` : ""}`}
          className="group max-w-72 truncate text-mute transition-colors duration-150 hover:text-fg"
        >
          <span className={ENTITY_CLS[e.change]}>{CHANGE_GLYPH[e.change]}</span>{" "}
          <span className="group-hover:underline">{entityLabel(e)}</span>
        </button>
      ))}
      {!showAll && entities.length > ENTITY_STRIP_CAP && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="text-faint hover:text-mute"
        >
          +{entities.length - ENTITY_STRIP_CAP} more
        </button>
      )}
    </div>
  );
}

/** Collapsed run of folded lines; click restores the real rows. */
function FoldStrip({
  run,
  split,
  stripRef,
  onExpand,
}: {
  run: FoldRun;
  split?: boolean;
  stripRef?: (el: HTMLTableRowElement | null) => void;
  onExpand: () => void;
}) {
  return (
    <tr ref={stripRef}>
      {!split && (
        <td colSpan={2} className="select-none border-r border-edge-soft bg-raise/30" />
      )}
      <td colSpan={split ? 4 : 1} className="p-0">
        <button
          type="button"
          onClick={onExpand}
          aria-expanded={false}
          title="Expand folded lines"
          className="flex w-full items-center gap-1.5 py-1 pl-7 pr-4 text-left font-mono text-[11px] text-faint transition-colors duration-150 hover:bg-raise/40 hover:text-mute"
        >
          <svg width="9" height="9" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path
              d="M3 5.5 8 11l5-5.5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {run.end - run.start} {run.label}
          <span className="text-add">+{run.adds}</span>
          <span className="text-del">−{run.dels}</span>
        </button>
      </td>
    </tr>
  );
}

/** Wiring for the gutter rail marking one line of an expanded fold run. */
interface FoldRail {
  /** The run's rail is under the pointer; every row of the run gets a wash. */
  hot: boolean;
  /** Only the run's first row carries the accessible, tabbable control. */
  first: boolean;
  label: string;
  onToggle: () => void;
  onHover: (hovering: boolean) => void;
}

/**
 * One segment of the rail: a slim bar filling the row's gutter edge. Segments
 * on adjacent rows join into a continuous rail spanning the expanded run.
 */
function FoldRailSeg({ fold }: { fold: FoldRail }) {
  return (
    <button
      type="button"
      onClick={fold.onToggle}
      onMouseEnter={() => fold.onHover(true)}
      onMouseLeave={() => fold.onHover(false)}
      title={fold.label}
      aria-label={fold.first ? fold.label : undefined}
      aria-expanded={fold.first ? true : undefined}
      aria-hidden={fold.first ? undefined : true}
      tabIndex={fold.first ? 0 : -1}
      className="absolute inset-y-0 left-0 w-[7px]"
    >
      <span
        aria-hidden
        className={cx(
          "absolute inset-y-0 left-0 w-[3px] transition-colors duration-150",
          fold.hot ? "bg-mute" : "bg-mute/40",
        )}
      />
    </button>
  );
}

/**
 * Collapsed seen segment (unified mode only). Click — or s while hovering —
 * unmarks and restores the rows; S widens to the parent segment.
 */
function SeenStrip({
  seg,
  hi,
  onUnsee,
}: {
  seg: Segment;
  hi: number;
  onUnsee: () => void;
}) {
  return (
    <tr data-hi={hi} data-strip-start={seg.start}>
      <td colSpan={2} className="select-none border-r border-edge-soft bg-raise/30" />
      <td className="p-0">
        <button
          type="button"
          onClick={onUnsee}
          title="Mark unseen and expand"
          className="flex w-full items-center gap-1.5 py-1 pl-7 pr-4 text-left font-mono text-[11px] text-faint transition-colors duration-150 hover:bg-raise/40 hover:text-mute"
        >
          <svg width="9" height="9" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path
              d="m2.5 8.5 4 4 7-8"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {seg.end - seg.start} lines seen
          <span className="text-add">+{seg.adds}</span>
          <span className="text-del">−{seg.dels}</span>
        </button>
      </td>
    </tr>
  );
}

/**
 * Diff-line-shaped placeholder shown while a file's hunks load. Row count
 * approximates the incoming diff so the page doesn't jump when it lands.
 */
function HunkSkeleton({ changed }: { changed: number }) {
  const rows = Math.max(3, Math.min(changed + 2, 24));
  return (
    <div aria-hidden className="animate-pulse py-1">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-2 py-[5px]">
          <div className="h-2.5 w-16 shrink-0 rounded-sm bg-raise" />
          <div
            className="h-2.5 rounded-sm bg-raise"
            style={{ width: `${22 + ((i * 37) % 58)}%` }}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * Up to 3 trimmed neighbor lines each way, taken from the diff's view of the
 * anchored side within the same hunk — gives the server's re-anchoring
 * something to disambiguate with.
 */
function anchorContext(
  hunk: DiffHunk,
  line: DiffLine,
  side: "old" | "new",
): { before: string[]; after: string[] } {
  const visible = hunk.lines.filter((l) =>
    side === "new" ? l.kind !== "del" : l.kind !== "add",
  );
  const i = visible.indexOf(line);
  if (i < 0) return { before: [], after: [] };
  return {
    before: visible.slice(Math.max(0, i - 3), i).map((l) => l.text.trim()),
    after: visible.slice(i + 1, i + 4).map((l) => l.text.trim()),
  };
}

/** Line content with the intra-line changed span tinted, tokens preserved. */
function renderContent(
  line: DiffLine,
  tokens: TokenLine | null,
  span: Span | undefined,
): ReactNode {
  if (!span || span.end <= span.start) {
    return tokens
      ? tokens.map((t, i) => (
          <span key={i} style={t.color ? { color: t.color } : undefined}>
            {t.content}
          </span>
        ))
      : line.text || " ";
  }
  const hiCls = cx("rounded-[2px]", line.kind === "add" ? "bg-add-hi" : "bg-del-hi");
  if (!tokens) {
    return (
      <>
        {line.text.slice(0, span.start)}
        <span className={hiCls}>{line.text.slice(span.start, span.end)}</span>
        {line.text.slice(span.end)}
      </>
    );
  }
  const parts: ReactNode[] = [];
  let pos = 0;
  tokens.forEach((t, ti) => {
    const s = pos;
    const e = pos + t.content.length;
    pos = e;
    const cuts: Array<[number, number, boolean]> = [
      [s, Math.min(e, span.start), false],
      [Math.max(s, span.start), Math.min(e, span.end), true],
      [Math.max(s, span.end), e, false],
    ];
    for (const [cs, ce, hi] of cuts) {
      if (ce <= cs) continue;
      parts.push(
        <span
          key={`${ti}.${cs}`}
          style={t.color ? { color: t.color } : undefined}
          className={hi ? hiCls : undefined}
        >
          {t.content.slice(cs - s, ce - s)}
        </span>,
      );
    }
  });
  return parts;
}

/** Pointer → symbol handlers, built once per file by DiffFile. */
interface SymbolHandlers {
  click: (e: MouseEvent<HTMLElement>, text: string) => void;
  hover: (e: MouseEvent<HTMLElement>, text: string) => void;
}

/** `data-lk` value: every line key this row answers to (`old:N new:M`). */
function lkAttr(line: DiffLine): string | undefined {
  const keys = [
    line.oldLine != null ? `old:${line.oldLine}` : null,
    line.newLine != null ? `new:${line.newLine}` : null,
  ].filter(Boolean);
  return keys.length > 0 ? keys.join(" ") : undefined;
}

function LineRow({
  line,
  hi,
  li,
  tokens,
  span,
  fold,
  onComment,
  onSym,
}: {
  line: DiffLine;
  /** Hunk/line indices for segment targeting (s/S keys); unified mode only. */
  hi?: number;
  li?: number;
  tokens: TokenLine | null;
  span: Span | undefined;
  fold?: FoldRail;
  onComment: () => void;
  onSym?: SymbolHandlers;
}) {
  return (
    <tr
      data-lk={lkAttr(line)}
      data-hi={hi}
      data-li={li}
      className={cx(
        "group",
        line.kind === "add" && "bg-add-soft",
        line.kind === "del" && "bg-del-soft",
        fold?.hot && "fold-hot",
      )}
    >
      <td className="relative select-none border-r border-edge-soft px-1.5 text-right align-top font-mono text-[11px] leading-[1.7] text-faint tabular-nums">
        {fold && <FoldRailSeg fold={fold} />}
        {line.oldLine ?? ""}
      </td>
      <td className="select-none border-r border-edge-soft px-1.5 text-right align-top font-mono text-[11px] leading-[1.7] text-faint tabular-nums">
        {line.newLine ?? ""}
      </td>
      <td
        data-code
        data-side={line.kind === "del" ? "old" : "new"}
        onClick={onSym ? (e) => onSym.click(e, line.text) : undefined}
        onMouseMove={onSym ? (e) => onSym.hover(e, line.text) : undefined}
        className="relative whitespace-pre-wrap break-all py-0 pl-5 pr-4 align-top font-mono text-[12.5px] leading-[1.7] text-fg"
      >
        <button
          type="button"
          onClick={onComment}
          title="Comment on this line"
          aria-label="Comment on this line"
          className="absolute left-0.5 top-[3px] grid size-4 place-items-center rounded-sm bg-accent font-sans text-[13px] font-bold leading-none text-bg opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
        >
          +
        </button>
        {renderContent(line, tokens, span)}
      </td>
    </tr>
  );
}

function SplitRow({
  left,
  right,
  tokens,
  spans,
  fold,
  onCommentLeft,
  onCommentRight,
  onSym,
}: {
  left: { line: DiffLine; idx: number } | null;
  right: { line: DiffLine; idx: number } | null;
  tokens: TokenLine[] | null;
  spans: Map<number, Span>;
  fold?: FoldRail;
  onCommentLeft?: () => void;
  onCommentRight?: () => void;
  onSym?: SymbolHandlers;
}) {
  const lk =
    [
      left?.line.oldLine != null ? `old:${left.line.oldLine}` : null,
      right?.line.newLine != null ? `new:${right.line.newLine}` : null,
    ]
      .filter(Boolean)
      .join(" ") || undefined;
  return (
    <tr data-lk={lk} className={cx(fold?.hot && "fold-hot")}>
      <td className="relative select-none border-r border-edge-soft px-1.5 text-right align-top font-mono text-[11px] leading-[1.7] text-faint tabular-nums">
        {fold && <FoldRailSeg fold={fold} />}
        {left?.line.oldLine ?? ""}
      </td>
      <SplitCell slot={left} isLeft tokens={tokens} spans={spans} onComment={onCommentLeft} onSym={onSym} />
      <td className="select-none border-r border-edge-soft px-1.5 text-right align-top font-mono text-[11px] leading-[1.7] text-faint tabular-nums">
        {right?.line.newLine ?? ""}
      </td>
      <SplitCell slot={right} isLeft={false} tokens={tokens} spans={spans} onComment={onCommentRight} onSym={onSym} />
    </tr>
  );
}

function SplitCell({
  slot,
  isLeft,
  tokens,
  spans,
  onComment,
  onSym,
}: {
  slot: { line: DiffLine; idx: number } | null;
  isLeft: boolean;
  tokens: TokenLine[] | null;
  spans: Map<number, Span>;
  onComment?: () => void;
  onSym?: SymbolHandlers;
}) {
  if (!slot) {
    // Padding cell keeping the panes aligned when one side has no counterpart.
    return <td className={cx("bg-raise/30", isLeft && "border-r border-edge-soft")} />;
  }
  const { line, idx } = slot;
  const toks = tokens?.[idx] ?? null;
  return (
    <td
      data-code
      data-side={isLeft ? "old" : "new"}
      onClick={onSym ? (e) => onSym.click(e, line.text) : undefined}
      onMouseMove={onSym ? (e) => onSym.hover(e, line.text) : undefined}
      className={cx(
        "group/cell relative whitespace-pre-wrap break-all py-0 pl-5 pr-3 align-top font-mono text-[12.5px] leading-[1.7] text-fg",
        line.kind === "add" && "bg-add-soft",
        line.kind === "del" && "bg-del-soft",
        isLeft && "border-r border-edge-soft",
      )}
    >
      {onComment && (
        <button
          type="button"
          onClick={onComment}
          title="Comment on this line"
          aria-label="Comment on this line"
          className="absolute left-0.5 top-[3px] grid size-4 place-items-center rounded-sm bg-accent font-sans text-[13px] font-bold leading-none text-bg opacity-0 focus-visible:opacity-100 group-hover/cell:opacity-100"
        >
          +
        </button>
      )}
      {renderContent(line, toks, spans.get(idx))}
    </td>
  );
}

/**
 * Identifier under the pointer, resolved through the browser caret APIs.
 * Offset accumulation skips the absolute-positioned overlays inside the cell
 * (comment button, +/− marker) so it lines up with the DiffLine text.
 */
function tokenFromPoint(e: MouseEvent<HTMLElement>, lineText: string): string | null {
  interface CaretPos {
    offsetNode: Node;
    offset: number;
  }
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => CaretPos | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  let node: Node | null = null;
  let offset = 0;
  if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(e.clientX, e.clientY);
    if (p) {
      node = p.offsetNode;
      offset = p.offset;
    }
  } else if (doc.caretRangeFromPoint) {
    const r = doc.caretRangeFromPoint(e.clientX, e.clientY);
    if (r) {
      node = r.startContainer;
      offset = r.startOffset;
    }
  }
  if (node == null || node.nodeType !== Node.TEXT_NODE) return null;
  const cell = e.currentTarget;
  if (!cell.contains(node)) return null;
  let acc = 0;
  let found = false;
  const walk = (n: Node): boolean => {
    if (n === node) {
      acc += offset;
      found = true;
      return true;
    }
    if (n.nodeType === Node.TEXT_NODE) {
      acc += n.textContent?.length ?? 0;
      return false;
    }
    if (n.nodeType === Node.ELEMENT_NODE) {
      const el = n as HTMLElement;
      if (el.tagName === "BUTTON" || el.hasAttribute("aria-hidden")) return false;
      for (const c of Array.from(n.childNodes)) if (walk(c)) return true;
    }
    return false;
  };
  walk(cell);
  if (!found) return null;
  return tokenAt(lineText, acc);
}

type EditState =
  | { phase: "loading" }
  | { phase: "load-error"; message: string }
  | {
      phase: "ready";
      baseHash: string;
      text: string;
      dirty: boolean;
      saving: boolean;
      conflict: boolean;
      error: string | null;
    };

function QuickEditPanel({
  dir,
  path,
  onClose,
}: {
  dir: string;
  path: string;
  onClose: () => void;
}) {
  const [state, setState] = useState<EditState>({ phase: "loading" });

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    try {
      const res = await api.getFile(dir, path);
      setState({
        phase: "ready",
        baseHash: res.contentHash,
        text: res.content,
        dirty: false,
        saving: false,
        conflict: false,
        error: null,
      });
    } catch (e) {
      setState({ phase: "load-error", message: (e as Error).message });
    }
  }, [dir, path]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    if (state.phase !== "ready" || state.saving) return;
    setState({ ...state, saving: true, error: null });
    try {
      const res = await api.putFile({ dir, path, content: state.text, baseHash: state.baseHash });
      setState({
        phase: "ready",
        baseHash: res.contentHash,
        text: res.content,
        dirty: false,
        saving: false,
        conflict: false,
        error: null,
      });
      onClose();
    } catch (e) {
      const status = (e as api.ApiError).status;
      setState({
        ...state,
        saving: false,
        conflict: status === 409,
        error: status === 409 ? null : (e as Error).message,
      });
    }
  };

  if (state.phase === "loading") {
    return <p className="px-4 py-3 font-mono text-[12px] text-faint">loading {path}…</p>;
  }
  if (state.phase === "load-error") {
    return (
      <div className="flex items-center gap-3 px-4 py-3">
        <p className="font-mono text-[12px] text-del">{state.message}</p>
        <button type="button" onClick={load} className="text-[12px] text-mute hover:text-fg">
          Retry
        </button>
        <button type="button" onClick={onClose} className="text-[12px] text-mute hover:text-fg">
          Close
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {state.conflict && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-accent/40 bg-accent-soft px-3 py-2">
          <p className="text-[12.5px] font-medium text-accent">
            File changed underneath you — saving would clobber the newer version.
          </p>
          <button
            type="button"
            onClick={load}
            className="rounded-sm border border-accent/50 px-2 py-0.5 text-[12px] text-accent transition-colors duration-150 hover:bg-accent hover:text-bg"
          >
            Reload file (discards these edits)
          </button>
          <button
            type="button"
            onClick={() => setState({ ...state, conflict: false })}
            className="text-[12px] text-mute hover:text-fg"
          >
            Dismiss
          </button>
        </div>
      )}
      {state.error && (
        <p className="border-b border-del/40 bg-del-soft px-3 py-2 text-[12.5px] text-del">
          {state.error}
        </p>
      )}
      <textarea
        value={state.text}
        spellCheck={false}
        onChange={(e) => setState({ ...state, text: e.target.value, dirty: true })}
        onKeyDown={(e) => {
          if (e.key === "Tab") {
            e.preventDefault();
            const el = e.currentTarget;
            el.setRangeText("  ", el.selectionStart, el.selectionEnd, "end");
            setState({ ...state, text: el.value, dirty: true });
          }
          e.stopPropagation();
        }}
        className="min-h-72 w-full resize-y bg-bg px-3 py-2.5 font-mono text-[12.5px] leading-[1.6] text-fg focus:outline-none"
      />
      <div className="flex items-center gap-2 border-t border-edge-soft px-3 py-2">
        <button
          type="button"
          onClick={save}
          disabled={!state.dirty || state.saving}
          className="rounded-sm bg-accent px-3 py-1 text-[12px] font-medium text-bg transition-colors duration-150 hover:bg-accent/85 disabled:cursor-default disabled:bg-raise disabled:text-faint"
        >
          {state.saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-sm px-2 py-1 text-[12px] text-mute transition-colors duration-150 hover:text-fg"
        >
          {state.dirty ? "Discard & close" : "Close"}
        </button>
        <span className="ml-auto font-mono text-[11px] text-faint">
          {path} · working tree
        </span>
      </div>
    </div>
  );
}
