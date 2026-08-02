import { useEffect, useState } from "react";
import type { Comment } from "@shared/types";
import { Markdown } from "../markdown";
import { cx, relativeTime, type Thread } from "../util";
import { Composer } from "./Composer";

function AuthorChip({ author }: { author: Comment["author"] }) {
  const user = author === "user";
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 text-[12px] font-medium",
        user ? "text-accent" : "text-agent",
      )}
    >
      <span
        aria-hidden
        className={cx(
          "inline-block size-[7px]",
          user ? "rounded-[1px] bg-accent" : "rounded-full bg-agent",
        )}
      />
      {user ? "you" : "agent"}
    </span>
  );
}

function CommentBody({ comment, baseLabel }: { comment: Comment; baseLabel?: string }) {
  return (
    <div className="px-3 py-2">
      <div className="flex items-baseline gap-2">
        <AuthorChip author={comment.author} />
        <span className="text-[11px] text-faint">
          {relativeTime(comment.createdAt)}
        </span>
        {baseLabel && (
          <span
            title={`written against base ${baseLabel}`}
            className="rounded-sm border border-edge px-1 font-mono text-[10.5px] leading-4 text-faint"
          >
            base {baseLabel}
          </span>
        )}
      </div>
      <div className="mt-1 whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-fg">
        <Markdown text={comment.body} />
      </div>
    </div>
  );
}

interface CommentThreadProps {
  thread: Thread;
  /** Shown for threads whose anchor no longer matches a diff line. */
  anchorNote?: string;
  /** Set when the thread was written against a different base than the review. */
  baseLabel?: string;
  onReply: (body: string) => void;
  onResolve: (resolved: boolean) => void;
  busy?: boolean;
}

export function CommentThread({
  thread,
  anchorNote,
  baseLabel,
  onReply,
  onResolve,
  busy,
}: CommentThreadProps) {
  const { root, replies } = thread;
  const resolved = root.resolvedAt != null;
  const [expanded, setExpanded] = useState(!resolved);
  const [replying, setReplying] = useState(false);

  // Resolving (optimistically or from another client) collapses right away;
  // unresolving re-expands.
  useEffect(() => setExpanded(!resolved), [resolved]);

  // Containment that separates conversation from diff: inset panel, left
  // accent in the thread author's color (amber = user, blue = agent).
  const shell = cx(
    "mx-3 my-2 overflow-hidden rounded-md border border-edge border-l-2 bg-bg font-sans",
    root.author === "user" ? "border-l-accent/70" : "border-l-agent/70",
  );

  if (resolved && !expanded) {
    return (
      <div className={shell}>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-mute transition-colors duration-150 hover:text-fg"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path
              d="M3 8.5 6.5 12 13 4.5"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>resolved</span>
          <span className="min-w-0 flex-1 truncate">{root.body}</span>
          <span className="shrink-0 text-faint">
            {replies.length > 0 && `${replies.length} repl${replies.length === 1 ? "y" : "ies"} · `}
            expand
          </span>
        </button>
      </div>
    );
  }

  return (
    <div className={shell}>
      {anchorNote && (
        <div className="border-b border-edge-soft px-3 py-1.5 font-mono text-[11px] text-faint">
          {anchorNote}
        </div>
      )}
      <div className="divide-y divide-edge-soft">
        <CommentBody comment={root} baseLabel={baseLabel} />
        {replies.map((r) => (
          <div key={r.id} className="pl-4">
            <CommentBody comment={r} />
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3 border-t border-edge-soft px-3 py-1.5">
        {!replying && (
          <button
            type="button"
            onClick={() => setReplying(true)}
            className="text-[12px] text-mute transition-colors duration-150 hover:text-fg"
          >
            Reply
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => onResolve(!resolved)}
          className="text-[12px] text-mute transition-colors duration-150 hover:text-fg disabled:text-faint"
        >
          {resolved ? "Unresolve" : "Resolve"}
        </button>
        {resolved && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="ml-auto text-[12px] text-faint transition-colors duration-150 hover:text-mute"
          >
            Collapse
          </button>
        )}
      </div>
      {replying && (
        <div className="border-t border-edge-soft">
          <Composer
            placeholder="Reply…"
            submitLabel="Reply"
            autoFocus
            busy={busy}
            onSubmit={(body) => {
              onReply(body);
              setReplying(false);
            }}
            onCancel={() => setReplying(false)}
          />
        </div>
      )}
    </div>
  );
}
