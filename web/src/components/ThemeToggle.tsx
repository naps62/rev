import { setThemePref, useThemePref, type ThemePref } from "../theme";
import { PopupToggle, type ToggleOption } from "./PopupToggle";

function ThemeGlyph({ pref }: { pref: ThemePref }) {
  if (pref === "light")
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
        <circle cx="8" cy="8" r="3" stroke="currentColor" />
        <path
          d="M8 1.25v1.75M8 13v1.75M1.25 8H3M13 8h1.75M3.2 3.2l1.25 1.25M11.55 11.55l1.25 1.25M12.8 3.2l-1.25 1.25M4.45 11.55L3.2 12.8"
          stroke="currentColor"
          strokeLinecap="round"
        />
      </svg>
    );
  if (pref === "dark")
    return (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
        <path
          d="M13.2 9.7A5.7 5.7 0 1 1 6.3 2.8a4.6 4.6 0 0 0 6.9 6.9Z"
          stroke="currentColor"
          strokeLinejoin="round"
        />
      </svg>
    );
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" />
      <path d="M8 2.5a5.5 5.5 0 0 1 0 11Z" fill="currentColor" />
    </svg>
  );
}

/* Literal colors: each row previews its own theme, so the art must not
   follow the active token values. */
function Mini({ bg, edge, bar, add, del }: Record<string, string>) {
  return (
    <>
      <rect x="0.5" y="0.5" width="43" height="29" rx="2.5" fill={bg} stroke={edge} />
      <rect x="5" y="5" width="16" height="2.5" rx="1.25" fill={bar} />
      <rect x="3" y="11" width="38" height="4.5" rx="1" fill={add} />
      <rect x="3" y="17.5" width="38" height="4.5" rx="1" fill={del} />
      <rect x="5" y="25" width="22" height="2" rx="1" fill={bar} />
    </>
  );
}

function ThemeArt({ pref }: { pref: ThemePref }) {
  const light = {
    bg: "#f4f5f7",
    edge: "#d8dce2",
    bar: "#a9b1bc",
    add: "#e2efe6",
    del: "#f3e4e1",
  };
  const dark = {
    bg: "#0e1115",
    edge: "#252c36",
    bar: "#414c59",
    add: "#1c2b21",
    del: "#2b1d1a",
  };
  return (
    <svg
      width="44"
      height="30"
      viewBox="0 0 44 30"
      fill="none"
      aria-hidden
      className="shrink-0"
    >
      {pref === "auto" ? (
        <>
          <clipPath id="theme-art-left">
            <rect x="0" y="0" width="22" height="30" />
          </clipPath>
          <clipPath id="theme-art-right">
            <rect x="22" y="0" width="22" height="30" />
          </clipPath>
          <g clipPath="url(#theme-art-left)">
            <Mini {...light} />
          </g>
          <g clipPath="url(#theme-art-right)">
            <Mini {...dark} />
          </g>
          <path d="M22 1v28" stroke="#8d97a5" strokeDasharray="2 2" />
        </>
      ) : (
        <Mini {...(pref === "light" ? light : dark)} />
      )}
    </svg>
  );
}

const OPTIONS: readonly ToggleOption<ThemePref>[] = [
  {
    value: "dark",
    blurb: "Graphite. The native look.",
    glyph: <ThemeGlyph pref="dark" />,
    art: <ThemeArt pref="dark" />,
  },
  {
    value: "light",
    blurb: "Ink on paper; diff tints re-inked for daylight.",
    glyph: <ThemeGlyph pref="light" />,
    art: <ThemeArt pref="light" />,
  },
  {
    value: "auto",
    blurb: "Follows the OS scheme, live.",
    glyph: <ThemeGlyph pref="auto" />,
    art: <ThemeArt pref="auto" />,
  },
];

export function ThemeToggle() {
  const pref = useThemePref();
  return (
    <PopupToggle
      name="Theme"
      options={OPTIONS}
      value={pref}
      onChange={setThemePref}
    />
  );
}
