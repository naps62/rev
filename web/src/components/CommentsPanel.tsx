import { useMemo, useState } from "react";
import type { Comment } from "#shared/types";
import { basename, cx, type Thread } from "../util";
import { CommentThread } from "./CommentThread";

type Filter = "all" | "open" | "resolved";

interface CommentsPanelProps {
  /** Every thread of the review (anchored and review-level). */
  threads: Thread[];
  currentBase: string;
  /** Paths in pane order — anchored threads sort by this, then line. */
  fileOrder: string[];
  onJump: (t: Thread) => void;
  onReply: (root: Comment, body: string) => void;
  onResolve: (root: Comment, resolved: boolean) => void;
  onClose: () => void;
}

const isOpen = (t: Thread) => t.root.resolvedAt == null;

export function CommentsPanel({
  threads,
  currentBase,
  fileOrder,
  onJump,
  onReply,
  onResolve,
  onClose,
}: CommentsPanelProps) {
  const openCount = threads.filter(isOpen).length;
  const [filter, setFilter] = useState<Filter>(openCount > 0 ? "open" : "all");

  // Anchored threads in diff order; anchors to files absent from the diff
  // render (and jump) as review notes, matching the diff pane's routing.
  const { anchored, notes } = useMemo(() => {
    const order = new Map(fileOrder.map((p, i) => [p, i]));
    const anchored: Thread[] = [];
    const notes: Thread[] = [];
    for (const t of threads) {
      const a = t.root.anchor;
      if (a && order.has(a.file)) anchored.push(t);
      else notes.push(t);
    }
    anchored.sort((x, y) => {
      const ax = x.root.anchor!;
      const ay = y.root.anchor!;
      return (order.get(ax.file)! - order.get(ay.file)!) || ax.line - ay.line;
    });
    return { anchored, notes };
  }, [threads, fileOrder]);

  const matches = (t: Thread) =>
    filter === "all" || (filter === "open") === isOpen(t);
  const shownAnchored = anchored.filter(matches);
  const shownNotes = notes.filter(matches);
  const counts: Record<Filter, number> = {
    all: threads.length,
    open: openCount,
    resolved: threads.length - openCount,
  };

  const row = (t: Thread) => (
    <ThreadRow
      key={t.root.id}
      thread={t}
      currentBase={currentBase}
      onJump={onJump}
      onReply={onReply}
      onResolve={onResolve}
    />
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-edge-soft px-3 py-2">
        <span className="text-[12.5px] font-medium text-fg">Comments</span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-faint">
          {threads.length} thread{threads.length === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close comments panel"
          title="Close (Esc)"
          className="ml-auto grid size-5 shrink-0 place-items-center rounded-sm text-faint transition-colors duration-150 hover:bg-raise hover:text-fg"
        >
          ×
        </button>
      </div>

      <div className="flex items-center gap-1 border-b border-edge-soft px-2 py-1.5">
        {(["all", "open", "resolved"] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            aria-pressed={filter === f}
            className={cx(
              "rounded-sm px-1.5 py-0.5 font-mono text-[11px] tabular-nums transition-colors duration-150",
              filter === f ? "bg-raise text-fg" : "text-faint hover:text-fg",
            )}
          >
            {f} {counts[f]}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1.5">
        {shownAnchored.length === 0 && shownNotes.length === 0 && (
          <p className="px-3 py-2 text-[12px] text-faint">
            No {filter === "all" ? "" : `${filter} `}comments.
          </p>
        )}
        {shownAnchored.map(row)}
        {shownNotes.length > 0 && (
          <>
            <p
              className={cx(
                "px-3 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint",
                shownAnchored.length > 0 && "mt-1.5 border-t border-edge-soft",
              )}
            >
              Review notes
            </p>
            {shownNotes.map(row)}
          </>
        )}
      </div>

      <p className="border-t border-edge-soft px-3 py-1.5 text-[11px] text-faint">
        header jumps to the thread · reply/resolve inline
      </p>
    </div>
  );
}

/** Jump header + the full interactive thread (reply composer, resolve). */
function ThreadRow({
  thread,
  currentBase,
  onJump,
  onReply,
  onResolve,
}: {
  thread: Thread;
  currentBase: string;
  onJump: (t: Thread) => void;
  onReply: (root: Comment, body: string) => void;
  onResolve: (root: Comment, resolved: boolean) => void;
}) {
  const { root } = thread;
  const a = root.anchor;
  return (
    <div className="px-2 pb-2">
      <button
        type="button"
        onClick={() => onJump(thread)}
        title="Jump to this thread in the diff"
        className="flex w-full items-center gap-2 rounded-t-sm px-1 py-1 text-left hover:bg-raise/50"
      >
        <span
          className="min-w-0 truncate font-mono text-[11px] text-faint"
          title={a ? `${a.file}:${a.line}` : undefined}
        >
          {a ? `${basename(a.file)}:${a.line}` : "review note"}
        </span>
        {root.resolvedAt != null && (
          <svg
            width="11"
            height="11"
            viewBox="0 0 16 16"
            fill="none"
            aria-label="resolved"
            className="ml-auto shrink-0 text-add"
          >
            <path
              d="M3 8.5 6.5 12 13 4.5"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </button>
      <CommentThread
        thread={thread}
        baseLabel={root.base !== currentBase ? root.base : undefined}
        onReply={(body) => onReply(root, body)}
        onResolve={(resolved) => onResolve(root, resolved)}
      />
    </div>
  );
}
