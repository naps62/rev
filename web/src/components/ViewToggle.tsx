import type { ViewMode } from "../pages/Review";
import { PopupToggle, type ToggleOption } from "./PopupToggle";

function ViewGlyph({ view }: { view: ViewMode }) {
  return view === "classic" ? (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M3 3h10" stroke="currentColor" strokeLinecap="round" />
      <path d="M4.5 5.5V12.5" stroke="currentColor" strokeLinecap="round" />
      <path
        d="M4.5 8h2.5M4.5 12.5h2.5"
        stroke="currentColor"
        strokeLinecap="round"
      />
      <path
        d="M9.5 8H13M9.5 12.5H13"
        stroke="currentColor"
        strokeLinecap="round"
      />
    </svg>
  ) : (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3 3h10"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path d="M5 6.25h8" stroke="currentColor" strokeLinecap="round" />
      <path
        d="M3 9.75h10"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path d="M5 13h8" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}

function ViewArt({ view }: { view: ViewMode }) {
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
      {view === "classic" ? (
        <>
          <rect x="5" y="5" width="14" height="2.5" rx="1.25" className="fill-mute/50" />
          <path d="M7 9.5v12" className="stroke-edge" />
          <rect x="10" y="10" width="22" height="2.5" rx="1.25" className="fill-mute/50" />
          <rect x="10" y="15" width="18" height="2.5" rx="1.25" className="fill-mute/50" />
          <rect x="10" y="20" width="24" height="2.5" rx="1.25" className="fill-mute/50" />
        </>
      ) : (
        <>
          <rect x="5" y="4.5" width="16" height="3" rx="1.5" className="fill-accent" />
          <rect x="8" y="10" width="24" height="2.5" rx="1.25" className="fill-mute/50" />
          <rect x="8" y="15" width="20" height="2.5" rx="1.25" className="fill-mute/50" />
          <rect x="5" y="20" width="11" height="3" rx="1.5" className="fill-accent" />
          <rect x="8" y="25.5" width="18" height="2" rx="1" className="fill-mute/50" />
        </>
      )}
    </svg>
  );
}

const OPTIONS: readonly [ToggleOption<ViewMode>, ToggleOption<ViewMode>] = [
  {
    value: "classic",
    blurb: "Files in directory order; every diff shown as-is.",
    glyph: <ViewGlyph view="classic" />,
    art: <ViewArt view="classic" />,
  },
  {
    value: "semantic",
    blurb:
      "Files grouped by kind (code, tests, docs…); imports and test bodies folded; symbol and entity navigation.",
    glyph: <ViewGlyph view="semantic" />,
    art: <ViewArt view="semantic" />,
  },
];

export function ViewToggle({
  view,
  onChange,
}: {
  view: ViewMode;
  onChange: (v: ViewMode) => void;
}) {
  return (
    <PopupToggle
      name="Review view"
      options={OPTIONS}
      value={view}
      onChange={onChange}
    />
  );
}
