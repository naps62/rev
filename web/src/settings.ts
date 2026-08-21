/**
 * Server-stored UI settings (features, diff layout, theme), shared by every
 * browser using this rev instance. Fetched once before first render
 * (main.tsx awaits initSettings), so reads are synchronous from the
 * in-memory snapshot; writes patch the snapshot and fire-and-forget a PUT.
 * First run migrates the old localStorage prefs onto the server.
 */

import type { UiSettings } from "#shared/types";
import * as api from "./api";

let ui: UiSettings = {};

export function uiSettings(): UiSettings {
  return ui;
}

export function patchUiSettings(patch: Partial<UiSettings>): void {
  ui = { ...ui, ...patch };
  void api.putSettings(ui).catch(() => {
    // save failed (server down): the change still applies until reload
  });
}

// rev.theme stays: it doubles as the pre-paint cache read by index.html.
const LEGACY_KEYS = [
  "rev.features",
  "rev.diffMode",
  "rev.viewMode",
  "rev.crosshair",
];

function legacySettings(): UiSettings {
  const out: UiSettings = {};
  const rawFeatures = localStorage.getItem("rev.features");
  if (rawFeatures != null) {
    try {
      out.features = JSON.parse(rawFeatures) as Record<string, boolean>;
    } catch {
      // corrupted store — nothing to migrate
    }
  } else if (localStorage.getItem("rev.viewMode") === "semantic") {
    out.features = {
      grouping: true,
      classDefaults: true,
      importFolds: true,
      symbols: true,
      entities: true,
    };
  }
  const mode = localStorage.getItem("rev.diffMode");
  if (mode === "unified" || mode === "split" || mode === "mixed")
    out.diffMode = mode;
  const theme = localStorage.getItem("rev.theme");
  if (theme === "light" || theme === "dark") out.theme = theme;
  return out;
}

export async function initSettings(): Promise<void> {
  try {
    ui = await api.getSettings();
  } catch {
    ui = legacySettings(); // server unreachable — best effort, migrate later
    return;
  }
  if (!ui.features && !ui.diffMode && !ui.theme) {
    const legacy = legacySettings();
    if (Object.keys(legacy).length > 0) {
      ui = legacy;
      void api.putSettings(ui).catch(() => {});
    }
  }
  for (const k of LEGACY_KEYS) localStorage.removeItem(k);
}
