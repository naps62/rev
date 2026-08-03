import { useEffect, useState } from "react";
import type { Comment } from "#shared/types";
import { Markdown } from "../markdown";
import { cx, relativeTime, type Thread } from "../util";
import { Composer } from "./Composer";
import { Reveal } from "./Reveal";

export function AuthorChip({ author }: { author: Comment["author"] }) {
  const user = author === "user";
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-fg">
      <span
        aria-hidden
        className={cx(
          "inline-block size-[7px]",
          user
            ? "rounded-[1px] bg-accent"
            : author === "reviewer"
              ? "rounded-full bg-reviewer"
              : "rounded-full bg-agent",
        )}
      />
      {user ? "you" : author}
    </span>
  );
}

/** Contained conversation well: darker than the diff surface, bordered all
 * around. Comment headers and the action row sit on the panel surface so the
 * thread reads as a ledger of turns, not a stack of cards. */
export const threadShell =
  "mx-3 my-2 overflow-hidden rounded-md border border-edge bg-bg font-sans";

function CommentBlock({ comment, baseLabel }: { comment: Comment; baseLabel?: string }) {
  return (
    <div>
      <div className="flex items-baseline gap-2 bg-panel px-3 py-1">
        <AuthorChip author={comment.author} />
        <span className="text-[11px] text-faint">
          {relativeTime(comment.createdAt)}
        </span>
        {baseLabel && (
          <span
            title={`written against base ${baseLabel}`}
            className="ml-auto rounded-sm border border-edge px-1 font-mono text-[10.5px] leading-4 text-faint"
          >
            base {baseLabel}
          </span>
        )}
      </div>
      <div className="whitespace-pre-wrap px-3 pb-1.5 pt-1 font-sans text-[13px] leading-relaxed text-fg">
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
  // Expansion derives from resolved state so an (optimistic) resolve collapses
  // in the same render as the click; the override only carries a manual
  // expand/collapse and resets whenever resolved flips.
  const [override, setOverride] = useState<boolean | null>(null);
  const expanded = override ?? !resolved;
  useEffect(() => setOverride(null), [resolved]);
  const [replying, setReplying] = useState(false);
  // True while the reply composer slides shut; it unmounts when Reveal exits.
  const [replyClosing, setReplyClosing] = useState(false);

  if (resolved && !expanded) {
    return (
      <div className={threadShell}>
        <button
          type="button"
          onClick={() => setOverride(true)}
          className="flex w-full items-center gap-2 bg-panel px-3 py-1.5 text-left text-[12px] text-mute transition-colors duration-150 hover:text-fg"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden
            className="shrink-0 text-add"
          >
            <path
              d="M3 8.5 6.5 12 13 4.5"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="font-medium">Resolved</span>
          <span className="min-w-0 flex-1 truncate text-faint">{root.body}</span>
          <span className="shrink-0 text-faint">
            {replies.length > 0 && `${replies.length} repl${replies.length === 1 ? "y" : "ies"} · `}
            expand
          </span>
        </button>
      </div>
    );
  }

  return (
    <div className={threadShell}>
      {anchorNote && (
        <div className="border-b border-edge-soft px-3 py-1.5 font-mono text-[11px] text-faint">
          {anchorNote}
        </div>
      )}
      <div className="divide-y divide-edge-soft">
        <CommentBlock comment={root} baseLabel={baseLabel} />
        {replies.map((r) => (
          <CommentBlock key={r.id} comment={r} />
        ))}
      </div>
      <div className="flex items-center gap-3 border-t border-edge-soft bg-panel px-3 py-1.5">
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
            onClick={() => setOverride(null)}
            className="ml-auto text-[12px] text-faint transition-colors duration-150 hover:text-mute"
          >
            Collapse
          </button>
        )}
      </div>
      {replying && (
        <Reveal
          open={!replyClosing}
          onExited={() => {
            setReplying(false);
            setReplyClosing(false);
          }}
        >
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
              onCancel={() => setReplyClosing(true)}
            />
          </div>
        </Reveal>
      )}
    </div>
  );
}
