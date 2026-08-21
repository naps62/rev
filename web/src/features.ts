/**
 * Review feature flags, backed by the server-stored UI settings (see
 * settings.ts) so every browser shares one configuration. The five
 * VIEW_FEATURES are the unbundled pieces of the old classic/semantic
 * toggle: all off = classic, all on = semantic. Crosshair rides along so
 * every toggle lives in one place, but is not part of the presets (it
 * defaulted to on in classic too).
 */

import { patchUiSettings, uiSettings } from "./settings";

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

export function loadFeatures(params: URLSearchParams): FeatureFlags {
  const f: FeatureFlags = { ...FEATURE_DEFAULTS, ...uiSettings().features };
  // ?view=semantic|classic still forces the presets (shareable URLs).
  const v = params.get("view");
  if (v === "semantic" || v === "classic") {
    for (const k of VIEW_FEATURES) f[k] = v === "semantic";
  }
  return f;
}

export function saveFeatures(f: FeatureFlags) {
  patchUiSettings({ features: { ...f } });
}

export type DiffMode = "unified" | "split" | "mixed";

export function loadDiffMode(): DiffMode {
  return uiSettings().diffMode ?? "unified";
}

export function saveDiffMode(m: DiffMode) {
  patchUiSettings({ diffMode: m });
}
