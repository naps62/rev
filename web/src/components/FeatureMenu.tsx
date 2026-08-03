import { type FeatureFlags, VIEW_FEATURES } from "../features";
import { Checkbox } from "./Checkbox";
import { cx } from "../util";

const ROWS: { key: keyof FeatureFlags; label: string; blurb: string }[] = [
  {
    key: "grouping",
    label: "group by kind",
    blurb: "Order the rail and diff by file class: code, tests, tooling, docs, generated.",
  },
  {
    key: "classDefaults",
    label: "class defaults",
    blurb: "Generated files start collapsed; test bodies fold to their names.",
  },
  {
    key: "importFolds",
    label: "fold imports",
    blurb: "Collapse import blocks at the top of each file.",
  },
  {
    key: "symbols",
    label: "symbol panel",
    blurb: "Click an identifier to list its occurrences across the diff.",
  },
  {
    key: "entities",
    label: "entity outline",
    blurb: "Per-file strip of changed functions and classes (needs the sem CLI).",
  },
  {
    key: "crosshair",
    label: "crosshair",
    blurb: "Pointer line and column highlight over the diff (x key).",
  },
];

function MenuGlyph({ semantic }: { semantic: boolean }) {
  return semantic ? (
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
  ) : (
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
  );
}

/**
 * Review-feature menu: the icon reflects how much of the old semantic view
 * is on, clicking it jumps between the classic (all off) and semantic (all
 * on) presets, and the hover popup toggles each feature individually.
 */
export function FeatureMenu({
  features,
  onChange,
}: {
  features: FeatureFlags;
  onChange: (f: FeatureFlags) => void;
}) {
  const onCount = VIEW_FEATURES.filter((k) => features[k]).length;
  const allOn = onCount === VIEW_FEATURES.length;
  const setPreset = () => {
    const next = { ...features };
    for (const k of VIEW_FEATURES) next[k] = !allOn;
    onChange(next);
  };
  const toggle = (key: keyof FeatureFlags) =>
    onChange({ ...features, [key]: !features[key] });
  return (
    <div className="group relative hidden self-stretch sm:flex">
      <button
        type="button"
        onClick={setPreset}
        aria-label={`Review features: ${onCount} of ${VIEW_FEATURES.length} on — click to turn all ${allOn ? "off" : "on"}`}
        className="peer flex items-center gap-1.5 px-3 text-mute transition-colors duration-150 hover:bg-raise/60 hover:text-fg"
      >
        <MenuGlyph semantic={onCount > 0} />
        <span
          className={cx(
            "font-mono text-[11px]",
            onCount > 0 && "text-accent",
          )}
        >
          {onCount}/{VIEW_FEATURES.length}
        </span>
      </button>
      <div
        role="menu"
        aria-label="Review features"
        className="invisible absolute right-0 top-full z-40 w-80 translate-y-1 rounded-b-sm border border-edge bg-panel opacity-0 shadow-lg transition-all duration-100 peer-focus-visible:visible peer-focus-visible:translate-y-0 peer-focus-visible:opacity-100 group-hover:visible group-hover:translate-y-0 group-hover:opacity-100"
      >
        {ROWS.map((r) => (
          <button
            key={r.key}
            type="button"
            role="menuitemcheckbox"
            aria-checked={features[r.key]}
            onClick={() => toggle(r.key)}
            className="flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors duration-150 hover:bg-raise/60"
          >
            <Checkbox
              checked={features[r.key]}
              onChange={() => toggle(r.key)}
              className="mt-px shrink-0"
            />
            <span className="min-w-0">
              <span
                className={cx(
                  "font-mono text-[12px]",
                  features[r.key] ? "text-accent" : "text-fg",
                )}
              >
                {r.label}
              </span>
              <span className="block text-[11px] leading-snug text-mute">
                {r.blurb}
              </span>
            </span>
          </button>
        ))}
        <div className="flex items-center justify-between border-t border-edge-soft px-3 py-1.5 font-mono text-[10.5px] text-faint">
          <span>all off = classic · all on = semantic</span>
          <button
            type="button"
            onClick={setPreset}
            className="text-mute transition-colors duration-150 hover:text-accent"
          >
            {allOn ? "classic" : "semantic"}
          </button>
        </div>
      </div>
    </div>
  );
}
