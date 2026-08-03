import type { ReactNode } from "react";
import { cx } from "../util";

export interface ToggleOption<T extends string> {
  value: T;
  blurb: string;
  glyph: ReactNode;
  art: ReactNode;
}

/**
 * Header icon button cycling between two options. Click toggles; hover or
 * keyboard focus opens a popup describing both options, each row clickable.
 */
export function PopupToggle<T extends string>({
  name,
  options,
  value,
  onChange,
}: {
  name: string;
  options: readonly [ToggleOption<T>, ToggleOption<T>];
  value: T;
  onChange: (v: T) => void;
}) {
  const current = options.find((o) => o.value === value) ?? options[0];
  const other = options.find((o) => o.value !== value) ?? options[1];
  return (
    <div className="group relative hidden self-stretch sm:flex">
      <button
        type="button"
        onClick={() => onChange(other.value)}
        aria-label={`${name}: ${value} — click to switch to ${other.value}`}
        className="peer flex items-center border-x border-edge px-3 text-mute transition-colors duration-150 hover:bg-raise/60 hover:text-fg"
      >
        {current.glyph}
      </button>
      <div
        role="menu"
        aria-label={`${name} options`}
        className="invisible absolute right-0 top-full z-40 w-72 translate-y-1 rounded-b-sm border border-edge bg-panel opacity-0 shadow-lg transition-all duration-100 peer-focus-visible:visible peer-focus-visible:translate-y-0 peer-focus-visible:opacity-100 group-hover:visible group-hover:translate-y-0 group-hover:opacity-100"
      >
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="menuitemradio"
            aria-checked={value === o.value}
            onClick={() => onChange(o.value)}
            className={cx(
              "flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors duration-150",
              value === o.value ? "bg-accent-soft" : "hover:bg-raise/60",
            )}
          >
            {o.art}
            <span className="min-w-0">
              <span
                className={cx(
                  "font-mono text-[12px]",
                  value === o.value ? "text-accent" : "text-fg",
                )}
              >
                {o.value}
              </span>
              <span className="block text-[11px] leading-snug text-mute">
                {o.blurb}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
