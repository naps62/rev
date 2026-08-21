import { useQuery } from "@tanstack/react-query";
import {
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { TUNING } from "#shared/tuning";
import type {
  Comment,
  CommentAnchor,
  DiffHunk,
  DiffLine,
  FileSummary,
} from "#shared/types";
import * as api from "../api";
import type { DiffMode } from "../features";
import { highlightLines, type TokenLine } from "../highlight";
import { intralineSpans, type Span } from "../intraline";
import type { FileClass } from "../semantic/classify.ts";
import {
  type FoldRun,
  importFolds,
  langOf,
  testFolds,
} from "../semantic/fold.ts";
import { loadFoldState, saveFoldState } from "../semantic/foldStore.ts";
import { isSymbol, tokenAt } from "../semantic/symbols.ts";
import { useScheme } from "../theme";
import { cx, lineKey, type Thread } from "../util";
import { Checkbox } from "./Checkbox";
import { AuthorChip, CommentThread, threadShell } from "./CommentThread";
import { Composer } from "./Composer";
import { DiffStat } from "./DiffStat";
import { ImageDiff } from "./ImageDiff";
import { Reveal } from "./Reveal";

export type { DiffMode };

// "M" stays neutral so amber only ever means attention (stale, open, current).
const STATUS_GLYPH: Record<
  FileSummary["status"],
  { glyph: string; cls: string; label: string }
> = {
  modified: { glyph: "M", cls: "text-mute", label: "modified" },
  added: { glyph: "A", cls: "text-add", label: "added" },
  deleted: { glyph: "D", cls: "text-del", label: "deleted" },
  renamed: { glyph: "R", cls: "text-agent", label: "renamed" },
  untracked: { glyph: "U", cls: "text-add", label: "untracked" },
};

interface DiffFileProps {
  dir: string;
  /** Base ref of the review; threads from other bases get a label. */
  currentBase: string;
  /** Resolved merge-base SHA used for the old side of image comparisons. */
  mergeBase: string;
  file: FileSummary;
  mode: DiffMode;
  /** All threads anchored to this file; placed on lines once hunks load. */
  threads: Thread[];
  isCurrent: boolean;
  /** Fold import blocks (unified only). */
  foldImports?: boolean;
  /** This file's class; "tests" switches to body folding. */
  fileClass?: FileClass;
  /** Start collapsed regardless of size/seen (the "generated" class). */
  defaultCollapsed?: boolean;
  /** Section-level collapse/expand-all: acts once per seq bump. */
  collapseCmd?: { seq: number; expand: boolean };
  /**
   * Keyboard toggle routed to this file, acting once per seq bump.
   * "file" = open/close the body (same as a header click); "folds" = expand
   * every fold strip, or fold them all back when nothing is folded.
   */
  keyCmd?: { seq: number; kind: "file" | "folds" };
  /** Mouse moved over this file — claim focus (rail + yellow indicator). */
  onHover?: () => void;
  onToggleSeen: (file: FileSummary, seen: boolean) => void;
  /** Click on an identifier — open/retarget the symbol panel. */
  onSymbolClick?: (symbol: string) => void;
  /** May return a promise (GitHub destination): the composer stays open until it settles. */
  onCreateComment: (
    anchor: CommentAnchor,
    body: string,
  ) => undefined | Promise<unknown>;
  onReply: (root: Comment, body: string) => undefined | Promise<unknown>;
  onResolve: (root: Comment, resolved: boolean) => void;
  /** Composer destination toggle (rendered only when both are set — a PR exists). */
  commentDest?: "local" | "github";
  onCommentDest?: (d: "local" | "github") => void;
  sectionRef: (el: HTMLElement | null) => void;
  /** Registers hunk-header rows and fold strips for n/p navigation. */
  hunkRef?: (hunkId: number | string, el: HTMLTableRowElement | null) => void;
}

export function DiffFile({
  dir,
  currentBase,
  mergeBase,
  file,
  mode,
  threads,
  isCurrent,
  foldImports,
  fileClass,
  defaultCollapsed,
  collapseCmd,
  keyCmd,
  onHover,
  onToggleSeen,
  onSymbolClick,
  onCreateComment,
  onReply,
  onResolve,
  commentDest,
  onCommentDest,
  sectionRef,
  hunkRef,
}: DiffFileProps) {
  const changed = file.additions + file.deletions;
  const [flash, setFlash] = useState(false);
  const [editing, setEditing] = useState(false);
  const [composerAt, setComposerAt] = useState<{
    key: string;
    anchor: CommentAnchor;
  } | null>(null);
  // True while the composer slides shut; it unmounts when Reveal exits.
  const [composerClosing, setComposerClosing] = useState(false);
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
  const image = isPreviewableImage(file.path);
  // Images have no line stats, but still expand into a visual comparison.
  const canExpand = image || (!file.binary && changed > 0);
  const canEdit = !image && !file.binary && file.status !== "deleted";
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

  const hunksQ = useQuery({
    queryKey: ["diff-file", dir, currentBase, file.path, file.contentHash],
    queryFn: () => api.getFileDiff(dir, currentBase, file.path, file.oldPath),
    enabled: !image && canExpand && expanded && near,
    staleTime: Infinity,
  });
  const activeFile = hunksQ.data?.file;
  const activeError = hunksQ.isError ? (hunksQ.error as Error) : null;
  const activeRetry = hunksQ.refetch;
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
  const [showBodies, setShowBodies] = useState(
    persistedFolds?.showBodies ?? false,
  );
  const [collapsedHunks, setCollapsedHunks] = useState<Set<number>>(
    () => new Set(persistedFolds?.hunks ?? []),
  );
  useEffect(() => {
    setExpandedFolds(new Set(persistedFolds?.folds ?? []));
    setShowBodies(persistedFolds?.showBodies ?? false);
    setCollapsedHunks(new Set(persistedFolds?.hunks ?? []));
  }, [persistedFolds]);
  useEffect(() => {
    saveFoldState(dir, file.path, file.contentHash, {
      folds: [...expandedFolds],
      showBodies,
      hunks: [...collapsedHunks],
    });
  }, [
    dir,
    file.path,
    file.contentHash,
    expandedFolds,
    showBodies,
    collapsedHunks,
  ]);
  const toggleHunk = useCallback((hi: number) => {
    setCollapsedHunks((prev) => {
      const next = new Set(prev);
      if (next.has(hi)) next.delete(hi);
      else next.add(hi);
      return next;
    });
  }, []);
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
  const foldBodies = fileClass === "tests" && !showBodies;
  // Import and test-body folds share hunk offsets; the prefix keeps a key
  // expanded in one mode from leaking into the other.
  const foldKey = (hi: number, run: FoldRun, bodies = foldBodies) =>
    `${bodies ? "t" : "i"}:${hi}:${run.start}`;
  const foldsByHunk = useMemo(() => {
    const lang = langOf(file.path);
    if (!lang || (!foldBodies && !foldImports)) return null;
    const m = new Map<number, FoldRun[]>();
    hunks.forEach((h, hi) => {
      const runs = foldBodies
        ? testFolds(h.lines, lang)
        : importFolds(h.lines, lang);
      if (runs.length > 0) m.set(hi, runs);
    });
    return m.size > 0 ? m : null;
  }, [foldImports, file.path, hunks, foldBodies]);

  // e/E from the review keymap, one action per seq bump.
  const lastKeySeq = useRef(keyCmd?.seq ?? 0);
  useEffect(() => {
    if (!keyCmd || keyCmd.seq === lastKeySeq.current) return;
    lastKeySeq.current = keyCmd.seq;
    if (keyCmd.kind === "file") {
      if (canExpand && !editing) toggleOpen();
      return;
    }
    // folds: a collapsed file first opens (without touching seen), so E is
    // always "show me more" until everything is visible, then folds it back.
    if (!expanded) {
      if (canExpand) setPeek(true);
      return;
    }
    const collapsed =
      collapsedHunks.size > 0 ||
      (fileClass === "tests" && !showBodies) ||
      [...(foldsByHunk ?? new Map<number, FoldRun[]>())].some(([hi, runs]) =>
        runs.some((r) => !expandedFolds.has(foldKey(hi, r))),
      );
    if (collapsed) {
      // End state "everything visible": hunks open, bodies shown AND import
      // folds open. Import keys are computed directly — after setShowBodies
      // flips the mode, foldsByHunk will re-derive with the i: prefix.
      const lang = langOf(file.path);
      const keys: string[] = [];
      if (lang && foldImports) {
        hunks.forEach((h, hi) => {
          for (const r of importFolds(h.lines, lang))
            keys.push(foldKey(hi, r, false));
        });
      }
      setExpandedFolds(new Set(keys));
      setCollapsedHunks(new Set());
      if (fileClass === "tests") setShowBodies(true);
    } else {
      setExpandedFolds(new Set());
      if (fileClass === "tests") setShowBodies(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyCmd]);

  // Symbol panel wiring: resolve the identifier under the pointer and filter
  // through the language's stopwords before bubbling up.
  const symbolHandlers = useMemo<SymbolHandlers | undefined>(() => {
    if (!onSymbolClick) return undefined;
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
    };
  }, [onSymbolClick, file.path]);
  const scheme = useScheme();
  const [tokens, setTokens] = useState<TokenLine[] | null>(null);
  // Tokens align to `flat` by index — drop them the moment the diff changes,
  // but NOT on collapse, so colors survive the close animation.
  useEffect(() => setTokens(null), [flat]);
  useEffect(() => {
    if (!expanded || file.binary || flat.length === 0) return;
    let live = true;
    highlightLines(
      file.path,
      file.contentHash,
      flat.map((l) => l.text),
      scheme,
    ).then((t) => live && setTokens(t));
    return () => {
      live = false;
    };
  }, [expanded, file.binary, file.path, file.contentHash, flat, scheme]);

  // Place threads on their lines (server-re-anchored resolvedLine first,
  // original anchor as fallback); the rest are detached. Placement needs
  // hunks — until they load, nothing is declared detached.
  const { threadsByLine, detached } = useMemo(() => {
    const byLine = new Map<string, Thread[]>();
    const rest: Thread[] = [];
    if (threads.length === 0 || activeFile == null)
      return { threadsByLine: byLine, detached: rest };
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

  const collapsedNote = image
    ? "image"
    : file.binary
      ? "binary"
      : file.status === "deleted"
        ? `deleted · ${file.deletions} lines`
        : file.seen
          ? "seen"
          : "collapsed";

  const closeComposer = () => setComposerClosing(true);

  const toggleComposer = (
    side: "old" | "new",
    line: DiffLine,
    hunk: DiffHunk,
  ) => {
    const num = (side === "old" ? line.oldLine : line.newLine) ?? 0;
    const key = lineKey(side, num);
    if (composerAt?.key === key) {
      // Already closing (the click's own mousedown blur-dismissed the empty
      // composer): swallow the toggle so it doesn't reopen.
      if (!composerClosing) closeComposer();
      return;
    }
    setComposerClosing(false);
    setComposerAt({
      key,
      anchor: {
        file: file.path,
        side,
        line: num,
        snippet: line.text.trim(),
        context: anchorContext(hunk, line, side),
      },
    });
  };

  const composerNode = (key: string) =>
    composerAt?.key === key ? (
      <Reveal
        open={!composerClosing}
        onExited={() => {
          setComposerAt(null);
          setComposerClosing(false);
        }}
      >
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
            destination={commentDest}
            onDestination={onCommentDest}
            onSubmit={(body) => {
              const r = onCreateComment(composerAt.anchor, body);
              if (r instanceof Promise)
                return r.then(() => setComposerAt(null));
              setComposerAt(null);
            }}
            onCancel={closeComposer}
          />
        </div>
      </Reveal>
    ) : null;

  const threadNodes = (key: string | null): ReactNode[] =>
    key == null
      ? []
      : (threadsByLine.get(key) ?? []).map((thread) => (
          <CommentThread
            key={thread.root.id}
            thread={thread}
            baseLabel={
              thread.root.base !== currentBase ? thread.root.base : undefined
            }
            onReply={(body) => onReply(thread.root, body)}
            onResolve={(resolved) => onResolve(thread.root, resolved)}
          />
        ));

  // Rows are built imperatively so comment threads and the composer can be
  // spliced in directly under their anchored line (in the right pane when split).
  // "mixed" is split, except one-sided files (only adds or only dels, context
  // aside — new, deleted, or append/remove-only) drop to unified — split
  // wastes half the width.
  const changedLines = hunks.flatMap((h) => h.lines.filter((l) => l.kind !== "context"));
  const oneSided =
    changedLines.length > 0 &&
    (changedLines.every((l) => l.kind === "add") || changedLines.every((l) => l.kind === "del"));
  const split = mode === "split" || (mode === "mixed" && !oneSided);
  const rows: ReactNode[] = [];
  if ((expanded || lingering) && !editing) {
    let flatIdx = 0;
    hunks.forEach((hunk, hi) => {
      const hunkCollapsed = collapsedHunks.has(hi);
      // A collapsed hunk hides its threads; the count keeps them findable.
      const hiddenThreads = hunkCollapsed
        ? hunk.lines.reduce(
            (n, l) =>
              n +
              (l.oldLine != null
                ? (threadsByLine.get(lineKey("old", l.oldLine))?.length ?? 0)
                : 0) +
              (l.newLine != null
                ? (threadsByLine.get(lineKey("new", l.newLine))?.length ?? 0)
                : 0),
            0,
          )
        : 0;
      rows.push(
        <HunkHeader
          key={`h${hi}`}
          hunk={hunk}
          split={split}
          collapsed={hunkCollapsed}
          threads={hiddenThreads}
          rowRef={(el) => hunkRef?.(hi, el)}
          onToggle={() => toggleHunk(hi)}
        />,
      );
      if (hunkCollapsed) {
        // Tokens and intraline spans index into `flat`; keep them aligned.
        flatIdx += hunk.lines.length;
        return;
      }

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
            if (k != null && (threadsByLine.has(k) || composerAt?.key === k))
              return true;
          }
        }
        return false;
      };
      const runs = foldsByHunk?.get(hi) ?? [];
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
      const railProps = (
        run: FoldRun,
        fk: string,
        first: boolean,
      ): FoldRail => ({
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
          for (let i = 0; i < n; i++)
            pairs.push({ l: dels[i] ?? null, r: adds[i] ?? null });
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
        const pairRun = (p: {
          l: Slot | null;
          r: Slot | null;
        }): FoldRun | null => {
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
                    run.start > 0
                      ? (el) => hunkRef?.(`${hi}.${run.start}`, el)
                      : undefined
                  }
                  onExpand={() => toggleFold(fk)}
                />,
              );
              while (pi + 1 < pairs.length && pairRun(pairs[pi + 1]!) === run)
                pi++;
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
              onCommentLeft={
                p.l ? () => toggleComposer("old", p.l!.line, hunk) : undefined
              }
              onCommentRight={
                p.r ? () => toggleComposer("new", p.r!.line, hunk) : undefined
              }
              onSym={symbolHandlers}
            />,
          );
          const leftKey =
            p.l?.line.oldLine != null ? lineKey("old", p.l.line.oldLine) : null;
          const rightKey =
            p.r?.line.newLine != null ? lineKey("new", p.r.line.newLine) : null;
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
                <td
                  colSpan={2}
                  className="border-r border-edge-soft p-0 align-top"
                >
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
          const run = runs.find((r) => r.start === li);
          if (
            run &&
            !runHasWidget(run) &&
            !expandedFolds.has(foldKey(hi, run))
          ) {
            const fk = foldKey(hi, run);
            rows.push(
              <FoldStrip
                key={`f${hi}.${run.start}`}
                run={run}
                // Strips right under the @@ header would double n/p stops.
                stripRef={
                  run.start > 0
                    ? (el) => hunkRef?.(`${hi}.${run.start}`, el)
                    : undefined
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
      onMouseMove={() => onHover?.()}
      className={cx(
        // No overflow-hidden here: it would turn the section into the sticky
        // header's scrollport and pin it 48px into the card.
        "rounded-md border bg-panel max-sm:rounded-none max-sm:border-x-0",
        isCurrent ? "border-accent/50" : "border-edge",
        flash && "stale-flash",
      )}
    >
      <div className="pointer-events-none relative z-10 h-0" aria-hidden>
        <div className="absolute inset-x-[-1px] bottom-0 h-3 bg-bg" />
      </div>
      <header
        onClick={() => !editing && toggleOpen()}
        className={cx(
          "sticky top-12 z-10 flex min-w-0 items-center gap-2.5 rounded-t-[5px] bg-raise px-2 py-1.5 max-sm:rounded-none",
          showBody
            ? "border-b border-edge-soft"
            : "rounded-b-[5px] max-sm:rounded-none",
          !editing && "cursor-pointer",
        )}
      >
        <button
          type="button"
          data-hint
          onClick={(e) => {
            e.stopPropagation();
            if (!editing) toggleOpen();
          }}
          disabled={!canExpand}
          aria-expanded={canExpand ? expanded : undefined}
          aria-label={
            expanded ? "Mark seen and collapse" : "Mark unseen and expand"
          }
          className="grid size-5 shrink-0 place-items-center rounded-sm text-mute transition-colors duration-150 hover:bg-panel hover:text-fg disabled:cursor-default disabled:text-faint"
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden
            className={cx(
              "transition-transform duration-150",
              expanded && "rotate-90",
            )}
          >
            <path
              d="M5.5 3 11 8l-5.5 5"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <span
          title={status.label}
          className={cx(
            "w-3 shrink-0 text-center font-mono text-[12px] font-bold",
            status.cls,
          )}
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
          <span className="shrink-0 font-mono text-[11px] text-faint">
            {collapsedNote}
          </span>
        )}
        {!file.binary && file.additions + file.deletions > 0 && (
          <span className="shrink-0 font-mono text-[11.5px] tabular-nums">
            <DiffStat add={file.additions} del={file.deletions} />
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
          {fileClass === "tests" && open && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setShowBodies((b) => !b);
              }}
              title={
                showBodies
                  ? "Fold test bodies back to names"
                  : "Show full test bodies"
              }
              data-hint
              className="rounded-sm px-1.5 py-0.5 font-mono text-[11px] text-mute transition-colors duration-150 hover:bg-panel hover:text-fg"
            >
              {showBodies ? "hide bodies" : "show bodies"}
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              data-hint
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
            data-hint
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
        <div className="min-h-0 overflow-hidden rounded-b-[5px] max-sm:rounded-none">
          {editing ? (
            <QuickEditPanel
              dir={dir}
              path={file.path}
              onClose={() => setEditing(false)}
            />
          ) : showBody && image ? (
            <ImageDiff
              status={file.status}
              oldSrc={
                file.status === "added" || file.status === "untracked"
                  ? undefined
                  : api.rawFileUrl(
                      dir,
                      file.oldPath ?? file.path,
                      mergeBase,
                      mergeBase,
                    )
              }
              newSrc={
                file.status === "deleted"
                  ? undefined
                  : api.rawFileUrl(dir, file.path, undefined, file.contentHash)
              }
            />
          ) : !showBody ? null : activeFile == null ? (
            activeError ? (
              <div className="flex items-center gap-3 px-4 py-3">
                <p className="font-mono text-[12px] text-del">
                  {activeError.message}
                </p>
                <button
                  type="button"
                  onClick={() => activeRetry()}
                  className="text-[12px] text-mute hover:text-fg"
                >
                  Retry
                </button>
              </div>
            ) : (
              <HunkSkeleton changed={changed} />
            )
          ) : (
            <table
              className={cx("w-full border-collapse", split && "table-fixed")}
            >
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

          {(expanded || lingering) &&
            !editing &&
            activeFile != null &&
            detached.length > 0 && (
              <div className="border-t border-edge-soft">
                <p className="px-3 pt-2 text-[11px] text-faint">
                  Couldn't re-anchor — the commented lines no longer exist:
                </p>
                {detached.map((thread) => (
                  <CommentThread
                    key={thread.root.id}
                    thread={thread}
                    baseLabel={
                      thread.root.base !== currentBase
                        ? thread.root.base
                        : undefined
                    }
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

const IMAGE_EXTENSIONS = /\.(?:apng|avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i;

function isPreviewableImage(path: string): boolean {
  return IMAGE_EXTENSIONS.test(path);
}

/** Clickable @@ row: collapses/expands its hunk (also the z key's target). */
function HunkHeader({
  hunk,
  split,
  collapsed,
  threads,
  rowRef,
  onToggle,
}: {
  hunk: DiffHunk;
  split: boolean;
  collapsed: boolean;
  /** Threads hidden inside the collapsed hunk (0 when expanded). */
  threads: number;
  rowRef: (el: HTMLTableRowElement | null) => void;
  onToggle: () => void;
}) {
  let adds = 0;
  let dels = 0;
  for (const l of hunk.lines) {
    if (l.kind === "add") adds++;
    else if (l.kind === "del") dels++;
  }
  return (
    <tr ref={rowRef} data-hunk-header>
      {!split && (
        <td
          colSpan={2}
          className="select-none border-r border-edge-soft bg-raise/50"
        />
      )}
      <td colSpan={split ? 4 : 1} className="bg-raise/50 p-0">
        <button
          type="button"
          data-hint
          onClick={onToggle}
          aria-expanded={!collapsed}
          title={collapsed ? "Expand hunk (z)" : "Collapse hunk (z)"}
          className="flex w-full items-center gap-1.5 py-1 pl-2 pr-4 text-left font-mono text-[11px] text-faint transition-colors duration-150 hover:bg-raise/40 hover:text-mute max-sm:pl-1"
        >
          <svg
            width="9"
            height="9"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden
            className={cx(
              "shrink-0 transition-transform duration-150",
              !collapsed && "rotate-90",
            )}
          >
            <path
              d="M5.5 3 11 8l-5.5 5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="min-w-0 truncate">
            @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines}{" "}
            @@
            {hunk.header ? (
              <span className="text-mute"> {hunk.header}</span>
            ) : null}
          </span>
          {collapsed && (
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              <span className="text-add">+{adds}</span>
              <span className="text-del">−{dels}</span>
              {threads > 0 && (
                <span className="text-accent">
                  {threads} comment{threads === 1 ? "" : "s"}
                </span>
              )}
            </span>
          )}
        </button>
      </td>
    </tr>
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
        <td
          colSpan={2}
          className="select-none border-r border-edge-soft bg-raise/30"
        />
      )}
      <td colSpan={split ? 4 : 1} className="p-0">
        <button
          type="button"
          data-hint
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
  const hiCls = cx(
    "rounded-[2px]",
    line.kind === "add" ? "bg-add-hi" : "bg-del-hi",
  );
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
  tokens,
  span,
  fold,
  onComment,
  onSym,
}: {
  line: DiffLine;
  tokens: TokenLine | null;
  span: Span | undefined;
  fold?: FoldRail;
  onComment: () => void;
  onSym?: SymbolHandlers;
}) {
  return (
    <tr
      data-lk={lkAttr(line)}
      className={cx(
        "group",
        line.kind === "add" && "bg-add-soft",
        line.kind === "del" && "bg-del-soft",
        fold?.hot && "fold-hot",
      )}
    >
      <td className="relative select-none border-r border-edge-soft px-1.5 text-right align-top font-mono text-[11px] leading-[1.7] text-faint tabular-nums max-sm:px-1">
        {fold && <FoldRailSeg fold={fold} />}
        {line.oldLine ?? ""}
      </td>
      <td className="select-none border-r border-edge-soft px-1.5 text-right align-top font-mono text-[11px] leading-[1.7] text-faint tabular-nums max-sm:px-1">
        {line.newLine ?? ""}
      </td>
      <td
        data-code
        data-side={line.kind === "del" ? "old" : "new"}
        onClick={onSym ? (e) => onSym.click(e, line.text) : undefined}
        className="relative whitespace-pre-wrap break-all py-0 pl-5 pr-4 align-top font-mono text-[12.5px] leading-[1.7] text-fg max-sm:pl-2 max-sm:pr-2"
      >
        <button
          type="button"
          data-comment-btn
          onClick={onComment}
          title="Comment on this line (c)"
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
      <td className="relative select-none border-r border-edge-soft px-1.5 text-right align-top font-mono text-[11px] leading-[1.7] text-faint tabular-nums max-sm:px-1">
        {fold && <FoldRailSeg fold={fold} />}
        {left?.line.oldLine ?? ""}
      </td>
      <SplitCell
        slot={left}
        isLeft
        tokens={tokens}
        spans={spans}
        onComment={onCommentLeft}
        onSym={onSym}
      />
      <td className="select-none border-r border-edge-soft px-1.5 text-right align-top font-mono text-[11px] leading-[1.7] text-faint tabular-nums max-sm:px-1">
        {right?.line.newLine ?? ""}
      </td>
      <SplitCell
        slot={right}
        isLeft={false}
        tokens={tokens}
        spans={spans}
        onComment={onCommentRight}
        onSym={onSym}
      />
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
    return (
      <td
        className={cx("bg-raise/30", isLeft && "border-r border-edge-soft")}
      />
    );
  }
  const { line, idx } = slot;
  const toks = tokens?.[idx] ?? null;
  return (
    <td
      data-code
      data-side={isLeft ? "old" : "new"}
      onClick={onSym ? (e) => onSym.click(e, line.text) : undefined}
      className={cx(
        "group/cell relative whitespace-pre-wrap break-all py-0 pl-5 pr-3 align-top font-mono text-[12.5px] leading-[1.7] text-fg max-sm:pl-2 max-sm:pr-1",
        line.kind === "add" && "bg-add-soft",
        line.kind === "del" && "bg-del-soft",
        isLeft && "border-r border-edge-soft",
      )}
    >
      {onComment && (
        <button
          type="button"
          data-comment-btn
          onClick={onComment}
          title="Comment on this line (c)"
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
function tokenFromPoint(
  e: MouseEvent<HTMLElement>,
  lineText: string,
): string | null {
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
      if (el.tagName === "BUTTON" || el.hasAttribute("aria-hidden"))
        return false;
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
      const res = await api.putFile({
        dir,
        path,
        content: state.text,
        baseHash: state.baseHash,
      });
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
    return (
      <p className="px-4 py-3 font-mono text-[12px] text-faint">
        loading {path}…
      </p>
    );
  }
  if (state.phase === "load-error") {
    return (
      <div className="flex items-center gap-3 px-4 py-3">
        <p className="font-mono text-[12px] text-del">{state.message}</p>
        <button
          type="button"
          onClick={load}
          className="text-[12px] text-mute hover:text-fg"
        >
          Retry
        </button>
        <button
          type="button"
          onClick={onClose}
          className="text-[12px] text-mute hover:text-fg"
        >
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
            File changed underneath you — saving would clobber the newer
            version.
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
        onChange={(e) =>
          setState({ ...state, text: e.target.value, dirty: true })
        }
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
