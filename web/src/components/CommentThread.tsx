import { useEffect, useState } from "react";
import type { Comment } from "#shared/types";
import { Markdown } from "../markdown";
import { cx, relativeTime, type Thread } from "../util";
import { Composer } from "./Composer";

export function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export function AuthorChip({ author, ghLogin }: { author: Comment["author"]; ghLogin?: string }) {
  if (ghLogin != null) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-fg">
        <GithubMark className="size-[11px] shrink-0 text-reviewer" />
        {ghLogin}
      </span>
    );
  }
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

/**
 * Delivery state toward the agent, on user comments only. Steady state
 * (picked_up) is unlabeled; agent/reviewer comments have no delivery story.
 */
function StatusChip({ comment }: { comment: Comment }) {
  if (comment.author !== "user" || comment.status === "picked_up") return null;
  return comment.status === "pending" ? (
    <span
      title="Not yet sent to the agent — sends on idle, on leaving the page, or via Send now"
      className="rounded-sm border border-accent/40 px-1 text-[10.5px] leading-4 text-accent"
    >
      pending
    </span>
  ) : (
    <span title="Sent — waiting for the agent to pick it up" className="text-[10.5px] text-faint">
      sent
    </span>
  );
}

function CommentBlock({ comment, baseLabel }: { comment: Comment; baseLabel?: string }) {
  const gh = comment.source === "github";
  return (
    <div>
      <div className="flex items-baseline gap-2 bg-panel px-3 py-1">
        <AuthorChip author={comment.author} ghLogin={gh ? comment.ghLogin ?? "github" : undefined} />
        {gh && comment.ghUrl ? (
          <a
            href={comment.ghUrl}
            target="_blank"
            rel="noreferrer"
            title="Open on GitHub"
            className="text-[11px] text-faint hover:text-reviewer hover:underline"
          >
            {relativeTime(comment.createdAt)}
          </a>
        ) : (
          <span className="text-[11px] text-faint">
            {relativeTime(comment.createdAt)}
          </span>
        )}
        <StatusChip comment={comment} />
        {baseLabel && (
          <span
            title={`written against base ${baseLabel}`}
            className="ml-auto rounded-sm border border-edge px-1 font-mono text-[10.5px] leading-4 text-faint"
          >
            base {baseLabel}
          </span>
        )}
      </div>
      <div className="whitespace-pre-wrap px-3 pb-1.5 pt-1 font-sans text-[14px] leading-relaxed text-fg">
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
  /** A returned promise keeps the reply composer open (and its draft) until it settles. */
  onReply: (body: string) => void | Promise<unknown>;
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
  const gh = root.source === "github";
  // GitHub conversation comments (no review thread behind them) can't resolve.
  const canResolve = !gh || root.ghThreadId != null;
  const shell = cx(threadShell, gh && "border-reviewer/30");
  // Expansion derives from resolved state so an (optimistic) resolve collapses
  // in the same render as the click; the override only carries a manual
  // expand/collapse and resets whenever resolved flips.
  const [override, setOverride] = useState<boolean | null>(null);
  const expanded = override ?? !resolved;
  useEffect(() => setOverride(null), [resolved]);

  if (resolved && !expanded) {
    return (
      <div className={shell} data-thread-id={root.id}>
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
          {gh && <GithubMark className="size-[11px] shrink-0 text-reviewer" />}
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
    <div className={shell} data-thread-id={root.id}>
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
        {canResolve && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onResolve(!resolved)}
            className="text-[12px] text-mute transition-colors duration-150 hover:text-fg disabled:text-faint"
          >
            {resolved ? "Unresolve" : "Resolve"}
          </button>
        )}
        {gh && (
          <span className="ml-auto inline-flex items-center gap-1 text-[10.5px] text-faint" title="Synced from the GitHub PR — replies post to GitHub">
            <GithubMark className="size-[10px] shrink-0" />
            GitHub
          </span>
        )}
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
      <div className="border-t border-edge-soft p-2">
        <Composer
          placeholder="Reply…"
          submitLabel="Reply"
          compact
          busy={busy}
          onSubmit={onReply}
        />
      </div>
    </div>
  );
}
