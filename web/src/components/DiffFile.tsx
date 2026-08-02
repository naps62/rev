import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  Comment,
  CommentAnchor,
  DiffHunk,
  DiffLine,
  FileDiff,
} from "@shared/types";
import { TUNING } from "@shared/tuning";
import * as api from "../api";
import { highlightLines, type TokenLine } from "../highlight";
import { intralineSpans, type Span } from "../intraline";
import { cx, lineKey, type Thread } from "../util";
import { AuthorChip, CommentThread, threadShell } from "./CommentThread";
import { Composer } from "./Composer";

// "M" stays neutral so amber only ever means attention (stale, open, current).
const STATUS_GLYPH: Record<FileDiff["status"], { glyph: string; cls: string; label: string }> = {
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
  file: FileDiff;
  mode: DiffMode;
  /** lineKey("side:line") → threads anchored there. */
  threadsByLine: Map<string, Thread[]>;
  /** Threads anchored to this file whose line no longer exists in the diff. */
  detached: Thread[];
  isCurrent: boolean;
  onToggleSeen: (file: FileDiff, seen: boolean) => void;
  onCreateComment: (anchor: CommentAnchor, body: string) => void;
  onReply: (root: Comment, body: string) => void;
  onResolve: (root: Comment, resolved: boolean) => void;
  sectionRef: (el: HTMLElement | null) => void;
  /** Registers rendered hunk-header rows for n/p navigation. */
  hunkRef?: (hunkIdx: number, el: HTMLTableRowElement | null) => void;
}

export function DiffFile({
  dir,
  currentBase,
  file,
  mode,
  threadsByLine,
  detached,
  isCurrent,
  onToggleSeen,
  onCreateComment,
  onReply,
  onResolve,
  sectionRef,
  hunkRef,
}: DiffFileProps) {
  const changed = file.additions + file.deletions;
  const tooBig = changed > TUNING.COLLAPSE_THRESHOLD_LINES;
  const [expanded, setExpanded] = useState(
    () => file.stale || !(file.seen || file.binary || file.status === "deleted" || tooBig),
  );
  const [flash, setFlash] = useState(false);
  const [editing, setEditing] = useState(false);
  const [composerAt, setComposerAt] = useState<{ key: string; anchor: CommentAnchor } | null>(null);
  const prevStale = useRef(file.stale);

  useEffect(() => {
    if (file.stale && !prevStale.current) {
      setExpanded(true);
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 1700);
      prevStale.current = file.stale;
      return () => clearTimeout(t);
    }
    prevStale.current = file.stale;
  }, [file.stale]);

  const flat = useMemo(() => file.hunks.flatMap((h) => h.lines), [file.hunks]);
  const spans = useMemo(() => intralineSpans(file.hunks), [file.hunks]);
  const [tokens, setTokens] = useState<TokenLine[] | null>(null);
  useEffect(() => {
    setTokens(null);
    if (!expanded || file.binary || flat.length === 0) return;
    let live = true;
    highlightLines(file.path, file.contentHash, flat.map((l) => l.text)).then(
      (t) => live && setTokens(t),
    );
    return () => {
      live = false;
    };
  }, [expanded, file.binary, file.path, file.contentHash, flat]);

  const unresolved = useMemo(() => {
    let n = 0;
    for (const list of threadsByLine.values())
      for (const t of list) if (t.root.resolvedAt == null) n++;
    for (const t of detached) if (t.root.resolvedAt == null) n++;
    return n;
  }, [threadsByLine, detached]);

  const status = STATUS_GLYPH[file.status];
  const canExpand = !file.binary && file.hunks.length > 0;
  const canEdit = !file.binary && file.status !== "deleted";
  // Whether anything renders below the header (diff table or quick-edit).
  const open = editing || (expanded && canExpand);

  // Collapse on mark-seen, expand on unmark — regardless of which control
  // (header checkbox, file nav, `v` key) flipped it.
  const prevSeen = useRef(file.seen);
  useEffect(() => {
    if (file.seen !== prevSeen.current) {
      prevSeen.current = file.seen;
      setExpanded(file.seen ? false : !tooBig);
    }
  }, [file.seen, tooBig]);

  const collapsedNote = file.binary
    ? "binary"
    : file.status === "deleted"
      ? `deleted · ${file.deletions} lines`
      : file.seen
        ? "seen"
        : tooBig
          ? `large diff · ${changed.toLocaleString()} lines`
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
  if (expanded && !editing) {
    let flatIdx = 0;
    file.hunks.forEach((hunk, hi) => {
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

      if (split) {
        type Slot = { line: DiffLine; idx: number };
        const pairs: Array<{ l: Slot | null; r: Slot | null }> = [];
        let dels: Slot[] = [];
        let adds: Slot[] = [];
        const flush = () => {
          const n = Math.max(dels.length, adds.length);
          for (let i = 0; i < n; i++) pairs.push({ l: dels[i] ?? null, r: adds[i] ?? null });
          dels = [];
          adds = [];
        };
        for (const line of hunk.lines) {
          const idx = flatIdx++;
          if (line.kind === "del") dels.push({ line, idx });
          else if (line.kind === "add") adds.push({ line, idx });
          else {
            flush();
            pairs.push({ l: { line, idx }, r: { line, idx } });
          }
        }
        flush();

        pairs.forEach((p, pi) => {
          rows.push(
            <SplitRow
              key={`s${hi}.${pi}`}
              left={p.l}
              right={p.r}
              tokens={tokens}
              spans={spans}
              onCommentLeft={p.l ? () => toggleComposer("old", p.l!.line, hunk) : undefined}
              onCommentRight={p.r ? () => toggleComposer("new", p.r!.line, hunk) : undefined}
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
        });
      } else {
        hunk.lines.forEach((line, li) => {
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
              onComment={() => toggleComposer(side, line, hunk)}
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
        });
      }
    });
  }

  return (
    <section
      ref={sectionRef}
      data-path={file.path}
      className={cx(
        // No overflow-hidden here: it would turn the section into the sticky
        // header's scrollport and pin it 48px into the card.
        "rounded-md border bg-panel",
        isCurrent ? "border-accent/50" : "border-edge",
        flash && "stale-flash",
      )}
    >
      <header
        onClick={() => canExpand && !editing && setExpanded((e) => !e)}
        className={cx(
          "sticky top-12 z-10 flex min-w-0 items-center gap-2.5 rounded-t-[5px] bg-raise px-2 py-1.5",
          open ? "border-b border-edge-soft" : "rounded-b-[5px]",
          canExpand && !editing && "cursor-pointer",
        )}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (canExpand && !editing) setExpanded((x) => !x);
          }}
          disabled={!canExpand}
          aria-expanded={canExpand ? expanded : undefined}
          aria-label={expanded ? "Collapse file" : "Expand file"}
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
          {canEdit && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setEditing(true);
                setExpanded(true);
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
            <input
              type="checkbox"
              checked={file.seen}
              onChange={(e) => onToggleSeen(file, e.target.checked)}
              className="size-3.5 accent-accent"
            />
            seen
          </label>
        </div>
      </header>

      <div className="overflow-hidden rounded-b-[5px]">
      {editing ? (
        <QuickEditPanel dir={dir} path={file.path} onClose={() => setEditing(false)} />
      ) : !open ? null : (
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

      {expanded && !editing && detached.length > 0 && (
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
    </section>
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

function LineRow({
  line,
  tokens,
  span,
  onComment,
}: {
  line: DiffLine;
  tokens: TokenLine | null;
  span: Span | undefined;
  onComment: () => void;
}) {
  const marker = line.kind === "add" ? "+" : line.kind === "del" ? "−" : "";
  return (
    <tr
      className={cx(
        "group",
        line.kind === "add" && "bg-add-soft",
        line.kind === "del" && "bg-del-soft",
      )}
    >
      <td className="select-none border-r border-edge-soft px-1.5 text-right align-top font-mono text-[11px] leading-[1.7] text-faint tabular-nums">
        {line.oldLine ?? ""}
      </td>
      <td className="select-none border-r border-edge-soft px-1.5 text-right align-top font-mono text-[11px] leading-[1.7] text-faint tabular-nums">
        {line.newLine ?? ""}
      </td>
      <td className="relative whitespace-pre-wrap break-all py-0 pl-7 pr-4 align-top font-mono text-[12.5px] leading-[1.7] text-fg">
        <button
          type="button"
          onClick={onComment}
          title="Comment on this line"
          aria-label="Comment on this line"
          className="absolute left-0.5 top-[3px] hidden size-4 place-items-center rounded-sm bg-accent font-sans text-[13px] font-bold leading-none text-bg group-hover:grid"
        >
          +
        </button>
        <span
          aria-hidden
          className={cx(
            "absolute left-[18px] select-none",
            line.kind === "add" ? "text-add" : line.kind === "del" ? "text-del" : "text-faint",
          )}
        >
          {marker}
        </span>
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
  onCommentLeft,
  onCommentRight,
}: {
  left: { line: DiffLine; idx: number } | null;
  right: { line: DiffLine; idx: number } | null;
  tokens: TokenLine[] | null;
  spans: Map<number, Span>;
  onCommentLeft?: () => void;
  onCommentRight?: () => void;
}) {
  return (
    <tr>
      <td className="select-none border-r border-edge-soft px-1.5 text-right align-top font-mono text-[11px] leading-[1.7] text-faint tabular-nums">
        {left?.line.oldLine ?? ""}
      </td>
      <SplitCell slot={left} isLeft tokens={tokens} spans={spans} onComment={onCommentLeft} />
      <td className="select-none border-r border-edge-soft px-1.5 text-right align-top font-mono text-[11px] leading-[1.7] text-faint tabular-nums">
        {right?.line.newLine ?? ""}
      </td>
      <SplitCell slot={right} isLeft={false} tokens={tokens} spans={spans} onComment={onCommentRight} />
    </tr>
  );
}

function SplitCell({
  slot,
  isLeft,
  tokens,
  spans,
  onComment,
}: {
  slot: { line: DiffLine; idx: number } | null;
  isLeft: boolean;
  tokens: TokenLine[] | null;
  spans: Map<number, Span>;
  onComment?: () => void;
}) {
  if (!slot) {
    // Padding cell keeping the panes aligned when one side has no counterpart.
    return <td className={cx("bg-raise/30", isLeft && "border-r border-edge-soft")} />;
  }
  const { line, idx } = slot;
  const marker = line.kind === "add" ? "+" : line.kind === "del" ? "−" : "";
  const toks = tokens?.[idx] ?? null;
  return (
    <td
      className={cx(
        "group/cell relative whitespace-pre-wrap break-all py-0 pl-7 pr-3 align-top font-mono text-[12.5px] leading-[1.7] text-fg",
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
          className="absolute left-0.5 top-[3px] hidden size-4 place-items-center rounded-sm bg-accent font-sans text-[13px] font-bold leading-none text-bg group-hover/cell:grid"
        >
          +
        </button>
      )}
      <span
        aria-hidden
        className={cx(
          "absolute left-[18px] select-none",
          line.kind === "add" ? "text-add" : line.kind === "del" ? "text-del" : "text-faint",
        )}
      >
        {marker}
      </span>
      {renderContent(line, toks, spans.get(idx))}
    </td>
  );
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
