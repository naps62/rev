/**
 * Per-user review feature flags. The five VIEW_FEATURES are the unbundled
 * pieces of the old classic/semantic toggle: all off = classic, all on =
 * semantic. Crosshair rides along so every toggle lives in one place, but
 * is not part of the presets (it defaulted to on in classic too).
 */

export interface FeatureFlags {
  /** Rail + diff pane grouped by file class instead of the directory tree. */
  grouping: boolean;
  /** Generated files start collapsed; test bodies fold to their names. */
  classDefaults: boolean;
  /** Collapse import blocks. */
  importFolds: boolean;
  /** Clickable identifiers + occurrence panel. */
  symbols: boolean;
  /** Entity-level change strip from the optional sem CLI. */
  entities: boolean;
  /** Pointer line/column highlight over diff tables. */
  crosshair: boolean;
}

export const VIEW_FEATURES = [
  "grouping",
  "classDefaults",
  "importFolds",
  "symbols",
  "entities",
] as const;

export const FEATURE_DEFAULTS: FeatureFlags = {
  grouping: false,
  classDefaults: false,
  importFolds: false,
  symbols: false,
  entities: false,
  crosshair: true,
};

const KEY = "rev.features";
const LEGACY_VIEW_KEY = "rev.viewMode";
const LEGACY_XHAIR_KEY = "rev.crosshair";

export function loadFeatures(params: URLSearchParams): FeatureFlags {
  let f = { ...FEATURE_DEFAULTS };
  const raw = localStorage.getItem(KEY);
  if (raw != null) {
    try {
      f = { ...f, ...(JSON.parse(raw) as Partial<FeatureFlags>) };
    } catch {
      // corrupted store — fall back to defaults
    }
  } else {
    // One-time migration from the pre-flag keys.
    if (localStorage.getItem(LEGACY_VIEW_KEY) === "semantic") {
      for (const k of VIEW_FEATURES) f[k] = true;
    }
    f.crosshair = localStorage.getItem(LEGACY_XHAIR_KEY) !== "off";
  }
  // ?view=semantic|classic still forces the presets (shareable URLs).
  const v = params.get("view");
  if (v === "semantic" || v === "classic") {
    for (const k of VIEW_FEATURES) f[k] = v === "semantic";
  }
  return f;
}

export function saveFeatures(f: FeatureFlags) {
  localStorage.setItem(KEY, JSON.stringify(f));
}
