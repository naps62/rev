import { useEffect, useRef, useState } from "react";
import { cx } from "../util";

/**
 * Autocomplete picker for the review base ref. Type to filter the repo's
 * refs, arrow keys + Enter to pick, or submit free text (any revspec the
 * server accepts). Escape reverts to the current base.
 */
export function RefCombobox({
  value,
  refs,
  onPick,
}: {
  value: string;
  refs: string[];
  onPick: (ref: string) => void;
}) {
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => setText(value), [value]);

  // Untouched input (still showing the current base) lists everything;
  // once the user types, filter on the query.
  const q = text.trim().toLowerCase();
  const filtered =
    !q || text === value
      ? refs
      : refs.filter((r) => r.toLowerCase().includes(q));

  useEffect(() => {
    if (hi >= filtered.length) setHi(Math.max(0, filtered.length - 1));
  }, [filtered.length, hi]);

  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [hi, open]);

  const pick = (ref: string) => {
    setOpen(false);
    const v = ref.trim();
    if (v && v !== value) onPick(v);
    else setText(value);
  };

  return (
    <div
      ref={rootRef}
      className="relative shrink-0"
      onBlur={(e) => {
        if (!rootRef.current?.contains(e.relatedTarget as Node)) {
          setOpen(false);
          setText(value);
        }
      }}
    >
      <input
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setHi(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!open) setOpen(true);
            else if (filtered.length) {
              const d = e.key === "ArrowDown" ? 1 : -1;
              setHi((h) => (h + d + filtered.length) % filtered.length);
            }
          } else if (e.key === "Enter") {
            e.preventDefault();
            pick(open && filtered[hi] ? filtered[hi] : text);
          } else if (e.key === "Escape") {
            // Swallow it so the page-level Escape handler doesn't also fire.
            e.stopPropagation();
            setOpen(false);
            setText(value);
          }
        }}
        spellCheck={false}
        role="combobox"
        aria-expanded={open}
        aria-controls="base-ref-listbox"
        aria-label="Base ref"
        title="Base ref — pick from the list or press Enter to re-diff"
        className="w-24 rounded-sm border border-edge bg-bg px-1.5 py-0.5 font-mono text-[12px] text-fg focus:border-accent/60 focus:outline-none max-sm:w-16"
      />
      {open && filtered.length > 0 && (
        <div
          ref={listRef}
          id="base-ref-listbox"
          role="listbox"
          tabIndex={-1}
          className="absolute left-0 top-full z-40 mt-1 max-h-64 min-w-full max-w-72 overflow-y-auto overflow-x-hidden rounded-sm border border-edge bg-panel py-0.5 shadow-pop"
        >
          {filtered.map((r, i) => (
            <div
              key={r}
              role="option"
              tabIndex={-1}
              aria-selected={i === hi}
              onMouseEnter={() => setHi(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(r)}
              className={cx(
                "cursor-pointer truncate px-1.5 py-0.5 font-mono text-[12px]",
                i === hi ? "bg-accent/15 text-accent" : "text-fg",
                r === value && "font-medium",
              )}
            >
              {r}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
