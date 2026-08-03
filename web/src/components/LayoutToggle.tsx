import type { DiffMode } from "./DiffFile";
import { PopupToggle, type ToggleOption } from "./PopupToggle";

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
      ) : mode === "split" ? (
        <>
          <path d="M8 2.5v11" stroke="currentColor" />
          <path
            d="M3.75 5.75h2M3.75 8h2M3.75 10.25h2M10.25 5.75h2M10.25 8h2M10.25 10.25h2"
            stroke="currentColor"
            strokeLinecap="round"
          />
        </>
      ) : (
        <>
          <path d="M8 2.5v4.5" stroke="currentColor" />
          <path
            d="M3.75 5.25h2M10.25 5.25h2M4.5 8.5h7M4.5 10.75h7"
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
      ) : mode === "split" ? (
        <>
          <path d="M22 .5v29" className="stroke-edge" />
          <rect x="4.5" y="5" width="12" height="2.5" rx="1.25" className="fill-mute/50" />
          <rect x="4.5" y="10" width="14" height="2.5" rx="1.25" className="fill-del" />
          <rect x="4.5" y="15" width="10" height="2.5" rx="1.25" className="fill-mute/50" />
          <rect x="26" y="5" width="12" height="2.5" rx="1.25" className="fill-mute/50" />
          <rect x="26" y="10" width="14" height="2.5" rx="1.25" className="fill-add" />
          <rect x="26" y="15" width="10" height="2.5" rx="1.25" className="fill-mute/50" />
        </>
      ) : (
        <>
          <path d="M.5 15.5h43M22 .5v15" className="stroke-edge" />
          <rect x="4.5" y="4.5" width="12" height="2.5" rx="1.25" className="fill-del" />
          <rect x="26" y="4.5" width="14" height="2.5" rx="1.25" className="fill-add" />
          <rect x="4.5" y="9.5" width="9" height="2.5" rx="1.25" className="fill-mute/50" />
          <rect x="26" y="9.5" width="9" height="2.5" rx="1.25" className="fill-mute/50" />
          <rect x="5" y="19.5" width="31" height="2.5" rx="1.25" className="fill-add" />
          <rect x="5" y="24" width="24" height="2.5" rx="1.25" className="fill-add" />
        </>
      )}
    </svg>
  );
}

const OPTIONS: readonly ToggleOption<DiffMode>[] = [
  {
    value: "unified",
    blurb: "One column — removed and added lines interleaved in order.",
    glyph: <ModeGlyph mode="unified" />,
    art: <ModeArt mode="unified" />,
  },
  {
    value: "split",
    blurb: "Two columns — old version on the left, new on the right.",
    glyph: <ModeGlyph mode="split" />,
    art: <ModeArt mode="split" />,
  },
  {
    value: "mixed",
    blurb: "Split, but fully added or deleted files render as one column.",
    glyph: <ModeGlyph mode="mixed" />,
    art: <ModeArt mode="mixed" />,
  },
];

export function LayoutToggle({
  mode,
  onChange,
}: {
  mode: DiffMode;
  onChange: (m: DiffMode) => void;
}) {
  return (
    <PopupToggle
      name="Diff layout"
      options={OPTIONS}
      value={mode}
      onChange={onChange}
    />
  );
}
