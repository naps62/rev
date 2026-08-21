import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Markdown } from "../markdown";
import { cx } from "../util";

const MOD_KEY =
  typeof navigator !== "undefined" && /Mac|iP/.test(navigator.platform)
    ? "⌘"
    : "Ctrl+";

type Format = "bold" | "italic" | "code" | "codeblock" | "link";

const SHORTCUT_FORMAT: Record<string, Format> = {
  b: "bold",
  i: "italic",
  e: "code",
  k: "link",
};

interface FormatResult {
  next: string;
  start: number;
  end: number;
}

/** Pure text transform: wrap the [start,end) selection of `value` in `fmt`
 * markdown, or insert empty syntax at the caret with the caret placed inside. */
export function applyFormat(
  fmt: Format,
  value: string,
  start: number,
  end: number,
): FormatResult {
  const sel = value.slice(start, end);
  const before = value.slice(0, start);
  const after = value.slice(end);

  if (fmt === "link") {
    if (sel) {
      // [sel](url) with "url" selected so typing replaces it.
      const urlStart = start + sel.length + 3;
      return {
        next: `${before}[${sel}](url)${after}`,
        start: urlStart,
        end: urlStart + 3,
      };
    }
    return { next: `${before}[](url)${after}`, start: start + 1, end: start + 1 };
  }

  if (fmt === "codeblock") {
    // Fences need their own lines; only add newlines the text doesn't have.
    const open = before === "" || before.endsWith("\n") ? "```\n" : "\n```\n";
    const close = "\n```" + (after === "" || after.startsWith("\n") ? "" : "\n");
    if (sel) {
      const s = start + open.length;
      return { next: before + open + sel + close + after, start: s, end: s + sel.length };
    }
    // open + close renders "```\n\n```"; caret lands on the empty middle line.
    const s = start + open.length;
    return { next: before + open + close + after, start: s, end: s };
  }

  const m = fmt === "bold" ? "**" : fmt === "italic" ? "*" : "`";
  if (sel) {
    return {
      next: before + m + sel + m + after,
      start: start + m.length,
      end: end + m.length,
    };
  }
  const caret = start + m.length;
  return { next: before + m + m + after, start: caret, end: caret };
}

function ToolButton({
  label,
  onApply,
  children,
}: {
  label: string;
  onApply: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      // Keep focus (and the selection) in the textarea.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onApply}
      className="flex size-6 items-center justify-center rounded-sm text-faint transition-colors duration-150 hover:bg-raise hover:text-fg"
    >
      {children}
    </button>
  );
}

interface ComposerProps {
  placeholder: string;
  submitLabel?: string;
  autoFocus?: boolean;
  busy?: boolean;
  compact?: boolean;
  /**
   * A returned promise makes the submit transactional: the draft is kept and
   * an error shown on rejection (GitHub posts can fail), cleared on success.
   * A void return clears immediately (local comments are fire-and-forget).
   */
  onSubmit: (body: string) => void | Promise<unknown>;
  onCancel?: () => void;
  /** When set (with onDestination), a local/GitHub destination toggle renders. */
  destination?: "local" | "github";
  onDestination?: (d: "local" | "github") => void;
}

export function Composer({
  placeholder,
  submitLabel = "Comment",
  autoFocus,
  busy,
  compact,
  onSubmit,
  onCancel,
  destination,
  onDestination,
}: ComposerProps) {
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [tab, setTab] = useState<"write" | "preview">("write");
  const taRef = useRef<HTMLTextAreaElement>(null);
  // Preview keeps the editor's height so tab toggling doesn't shift layout.
  const [previewMinH, setPreviewMinH] = useState<number>();
  const selRef = useRef<[number, number]>([0, 0]);
  const pointerIn = useRef(false);
  const canSubmit = body.trim().length > 0 && !busy && !sending;

  const minH = compact ? "min-h-[50px]" : "min-h-[68px]";

  // Manual focus: native autofocus scrolls the still-collapsed Reveal
  // wrapper into view mid-slide.
  useEffect(() => {
    if (autoFocus) taRef.current?.focus({ preventScroll: true });
  }, []);

  // Grow with content (the textarea is hidden — scrollHeight 0 — in preview).
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta || tab !== "write") return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight + 2}px`; // +2: top/bottom border
  }, [body, tab]);

  const submit = () => {
    if (!canSubmit) return;
    const done = () => {
      setBody("");
      setTab("write");
    };
    const r = onSubmit(body.trim());
    if (r instanceof Promise) {
      setError(null);
      setSending(true);
      r.then(done, (e: unknown) => setError((e as Error)?.message ?? "failed to post")).finally(
        () => setSending(false),
      );
    } else {
      done();
    }
  };

  const runFormat = (fmt: Format) => {
    const ta = taRef.current;
    if (!ta) return;
    const r = applyFormat(fmt, body, ta.selectionStart, ta.selectionEnd);
    flushSync(() => setBody(r.next));
    ta.focus();
    ta.setSelectionRange(r.start, r.end);
  };

  const showPreview = () => {
    const ta = taRef.current;
    if (ta) {
      setPreviewMinH(ta.offsetHeight);
      selRef.current = [ta.selectionStart, ta.selectionEnd];
    }
    setTab("preview");
  };

  const showWrite = () => {
    if (tab === "write") return;
    flushSync(() => setTab("write"));
    const ta = taRef.current;
    if (ta) {
      ta.focus();
      ta.setSelectionRange(...selRef.current);
    }
  };

  const tabCls = (active: boolean) =>
    cx(
      "rounded-sm px-2 py-0.5 text-[12px] transition-colors duration-150",
      active ? "bg-raise text-fg" : "text-mute hover:text-fg",
    );

  return (
    <div
      className={cx("flex flex-col gap-1.5", compact ? "" : "p-2")}
      onKeyDown={(e) => {
        // Fallback for focus outside the textarea (tabs, preview). The
        // textarea's own handler stops propagation before reaching here.
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          submit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          (e.target as HTMLElement).blur?.();
        }
        e.stopPropagation();
      }}
      onMouseDownCapture={() => {
        // Clicking a non-focusable spot inside blurs with relatedTarget
        // null; this flag distinguishes that from focus truly leaving.
        pointerIn.current = true;
        setTimeout(() => {
          pointerIn.current = false;
        });
      }}
      onBlur={(e) => {
        if (!onCancel || busy || body.trim() || pointerIn.current) return;
        if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget)) return;
        onCancel();
      }}
    >
      <div className="flex h-6 items-center gap-1">
        <div className="flex items-center gap-0.5">
          <button type="button" onClick={showWrite} className={tabCls(tab === "write")}>
            Write
          </button>
          <button
            type="button"
            onClick={showPreview}
            className={tabCls(tab === "preview")}
          >
            Preview
          </button>
        </div>
        {tab === "write" && (
          <div className="ml-auto flex items-center gap-0.5">
            <ToolButton label={`Bold (${MOD_KEY}B)`} onApply={() => runFormat("bold")}>
              <span className="text-[12px] font-bold">B</span>
            </ToolButton>
            <ToolButton
              label={`Italic (${MOD_KEY}I)`}
              onApply={() => runFormat("italic")}
            >
              <span className="font-serif text-[13px] italic">I</span>
            </ToolButton>
            <ToolButton
              label={`Inline code (${MOD_KEY}E)`}
              onApply={() => runFormat("code")}
            >
              <span className="font-mono text-[11px]">{"<>"}</span>
            </ToolButton>
            <ToolButton label="Code block" onApply={() => runFormat("codeblock")}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                <rect
                  x="1.5"
                  y="2.5"
                  width="13"
                  height="11"
                  rx="1.5"
                  stroke="currentColor"
                  strokeWidth="1.3"
                />
                <path
                  d="M6.8 6 4.8 8l2 2M9.2 6l2 2-2 2"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </ToolButton>
            <ToolButton label={`Link (${MOD_KEY}K)`} onApply={() => runFormat("link")}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                <path
                  d="M6.75 9.25l2.5-2.5M7.5 4.75 8.75 3.5a2.475 2.475 0 0 1 3.5 3.5L11 8.25M8.75 11.25 7.5 12.5a2.475 2.475 0 0 1-3.5-3.5l1.25-1.25"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </ToolButton>
          </div>
        )}
      </div>
      <textarea
        ref={taRef}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          const mod = e.metaKey || e.ctrlKey;
          if (mod && e.key === "Enter") {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (mod && !e.altKey && !e.shiftKey) {
            const fmt = SHORTCUT_FORMAT[e.key.toLowerCase()];
            if (fmt) {
              e.preventDefault();
              runFormat(fmt);
            }
          }
          e.stopPropagation();
        }}
        placeholder={placeholder}
        rows={compact ? 2 : 3}
        className={cx(
          "w-full resize-none overflow-hidden rounded-sm border border-edge bg-bg px-2.5 py-1.5 font-mono text-[12px] leading-normal text-fg placeholder:font-sans placeholder:text-[13px] placeholder:text-faint focus:border-accent/60 focus:outline-none",
          minH,
          tab === "preview" && "hidden",
        )}
      />
      {tab === "preview" && (
        <div
          style={previewMinH ? { minHeight: previewMinH } : undefined}
          className={cx(
            "w-full rounded-sm border border-edge bg-bg px-2.5 py-1.5",
            minH,
          )}
        >
          {body.trim() ? (
            <div className="whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-fg">
              <Markdown text={body} />
            </div>
          ) : (
            <span className="font-sans text-[13px] text-faint">
              Nothing to preview
            </span>
          )}
        </div>
      )}
      {error != null && (
        <p className="text-[11.5px] text-del" title={error}>
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          className="rounded-sm bg-accent px-2.5 py-1 text-[12px] font-medium text-bg transition-colors duration-150 hover:bg-accent/85 disabled:cursor-default disabled:bg-raise disabled:text-faint"
        >
          {busy || sending ? "Saving…" : destination === "github" ? `${submitLabel} on GitHub` : submitLabel}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-sm px-2 py-1 text-[12px] text-mute transition-colors duration-150 hover:text-fg"
          >
            Cancel
          </button>
        )}
        {destination !== undefined && onDestination !== undefined && (
          <button
            type="button"
            onClick={() => onDestination(destination === "local" ? "github" : "local")}
            title={
              destination === "local"
                ? "Posting locally (to the agent) — click to post to the GitHub PR instead"
                : "Posting to the GitHub PR — click to post locally (to the agent) instead"
            }
            className={cx(
              "rounded-sm border px-1.5 py-0.5 font-mono text-[11px] transition-colors duration-150",
              destination === "github"
                ? "border-reviewer/50 text-reviewer"
                : "border-edge text-faint hover:text-mute",
            )}
          >
            → {destination === "github" ? "GitHub PR" : "local"}
          </button>
        )}
        <span className="ml-auto text-[11px] text-faint">{MOD_KEY}↵ to send</span>
      </div>
    </div>
  );
}
