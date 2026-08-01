import { useState } from "react";
import { cx } from "../util";

interface ComposerProps {
  placeholder: string;
  submitLabel?: string;
  autoFocus?: boolean;
  busy?: boolean;
  compact?: boolean;
  onSubmit: (body: string) => void;
  onCancel?: () => void;
}

export function Composer({
  placeholder,
  submitLabel = "Comment",
  autoFocus,
  busy,
  compact,
  onSubmit,
  onCancel,
}: ComposerProps) {
  const [body, setBody] = useState("");
  const canSubmit = body.trim().length > 0 && !busy;

  const submit = () => {
    if (!canSubmit) return;
    onSubmit(body.trim());
    setBody("");
  };

  return (
    <div className={cx("flex flex-col gap-1.5", compact ? "" : "p-2")}>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape" && onCancel) {
            e.preventDefault();
            onCancel();
          }
          e.stopPropagation();
        }}
        placeholder={placeholder}
        autoFocus={autoFocus}
        rows={compact ? 2 : 3}
        className="w-full resize-y rounded-sm border border-edge bg-bg px-2.5 py-1.5 font-sans text-[13px] leading-snug text-fg placeholder:text-faint focus:border-accent/60 focus:outline-none"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          className="rounded-sm bg-accent px-2.5 py-1 text-[12px] font-medium text-bg transition-colors duration-150 hover:bg-accent/85 disabled:cursor-default disabled:bg-raise disabled:text-faint"
        >
          {busy ? "Saving…" : submitLabel}
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
        <span className="ml-auto text-[11px] text-faint">⌘↵ to send</span>
      </div>
    </div>
  );
}
