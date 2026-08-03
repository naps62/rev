import type { DiffMode } from "./DiffFile";
import { cx } from "../util";

const BLURB: Record<DiffMode, string> = {
  unified: "One column — removed and added lines interleaved in order.",
  split: "Two columns — old version on the left, new on the right.",
};

function ModeGlyph({ mode }: { mode: DiffMode }) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect
        x="1.5"
        y="2.5"
        width="13"
        height="11"
        rx="1.5"
        stroke="currentColor"
      />
      {mode === "unified" ? (
        <path
          d="M4.5 5.75h7M4.5 8h7M4.5 10.25h7"
          stroke="currentColor"
          strokeLinecap="round"
        />
      ) : (
        <>
          <path d="M8 2.5v11" stroke="currentColor" />
          <path
            d="M3.75 5.75h2M3.75 8h2M3.75 10.25h2M10.25 5.75h2M10.25 8h2M10.25 10.25h2"
            stroke="currentColor"
            strokeLinecap="round"
          />
        </>
      )}
    </svg>
  );
}

function ModeArt({ mode }: { mode: DiffMode }) {
  return (
    <svg
      width="44"
      height="30"
      viewBox="0 0 44 30"
      fill="none"
      aria-hidden
      className="shrink-0"
    >
      <rect x="0.5" y="0.5" width="43" height="29" rx="2.5" className="stroke-edge" />
      {mode === "unified" ? (
        <>
          <rect x="5" y="5" width="24" height="2.5" rx="1.25" className="fill-mute/50" />
          <rect x="5" y="10" width="31" height="2.5" rx="1.25" className="fill-del" />
          <rect x="5" y="15" width="31" height="2.5" rx="1.25" className="fill-add" />
          <rect x="5" y="20" width="19" height="2.5" rx="1.25" className="fill-mute/50" />
        </>
      ) : (
        <>
          <path d="M22 .5v29" className="stroke-edge" />
          <rect x="4.5" y="5" width="12" height="2.5" rx="1.25" className="fill-mute/50" />
          <rect x="4.5" y="10" width="14" height="2.5" rx="1.25" className="fill-del" />
          <rect x="4.5" y="15" width="10" height="2.5" rx="1.25" className="fill-mute/50" />
          <rect x="26" y="5" width="12" height="2.5" rx="1.25" className="fill-mute/50" />
          <rect x="26" y="10" width="14" height="2.5" rx="1.25" className="fill-add" />
          <rect x="26" y="15" width="10" height="2.5" rx="1.25" className="fill-mute/50" />
        </>
      )}
    </svg>
  );
}

export function LayoutToggle({
  mode,
  onChange,
}: {
  mode: DiffMode;
  onChange: (m: DiffMode) => void;
}) {
  const other: DiffMode = mode === "unified" ? "split" : "unified";
  return (
    <div className="group relative hidden self-stretch sm:flex">
      <button
        type="button"
        onClick={() => onChange(other)}
        aria-label={`Diff layout: ${mode} — click to switch to ${other}`}
        className="peer flex items-center border-x border-edge px-3 text-mute transition-colors duration-150 hover:bg-raise/60 hover:text-fg"
      >
        <ModeGlyph mode={mode} />
      </button>
      <div
        role="menu"
        aria-label="Diff layout options"
        className="invisible absolute right-0 top-full z-40 w-72 translate-y-1 rounded-b-sm border border-edge bg-panel opacity-0 shadow-lg transition-all duration-100 peer-focus-visible:visible peer-focus-visible:translate-y-0 peer-focus-visible:opacity-100 group-hover:visible group-hover:translate-y-0 group-hover:opacity-100"
      >
        {(["unified", "split"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="menuitemradio"
            aria-checked={mode === m}
            onClick={() => onChange(m)}
            className={cx(
              "flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors duration-150",
              mode === m ? "bg-accent-soft" : "hover:bg-raise/60",
            )}
          >
            <ModeArt mode={m} />
            <span className="min-w-0">
              <span
                className={cx(
                  "font-mono text-[12px]",
                  mode === m ? "text-accent" : "text-fg",
                )}
              >
                {m}
              </span>
              <span className="block text-[11px] leading-snug text-mute">
                {BLURB[m]}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
