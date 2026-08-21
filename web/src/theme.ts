/**
 * Theme preference (light/dark/auto) stored in the server-side UI settings;
 * localStorage keeps a copy only so the inline script in index.html can
 * apply the attribute before first paint. The resolved scheme lands as
 * `data-theme` on <html>, which the CSS token overrides key off.
 */

import { useSyncExternalStore } from "react";
import { patchUiSettings, uiSettings } from "./settings";

export type ThemePref = "light" | "dark" | "auto";
export type Scheme = "light" | "dark";

const KEY = "rev.theme";
const META_COLOR: Record<Scheme, string> = {
  dark: "#0e1115",
  light: "#f4f5f7",
};

const media = window.matchMedia("(prefers-color-scheme: light)");

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "auto";
  } catch {
    return "auto";
  }
}

let pref: ThemePref = readPref();
const listeners = new Set<() => void>();

const resolve = (p: ThemePref): Scheme =>
  p === "auto" ? (media.matches ? "light" : "dark") : p;

function apply() {
  const scheme = resolve(pref);
  document.documentElement.dataset.theme = scheme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", META_COLOR[scheme]);
}

function notify() {
  apply();
  for (const l of listeners) l();
}

media.addEventListener("change", () => {
  if (pref === "auto") notify();
});

export function setThemePref(p: ThemePref) {
  applyPref(p);
  patchUiSettings({ theme: p });
}

/** Adopt the server-stored pref; called once after initSettings resolves. */
export function syncThemeFromSettings() {
  const p = uiSettings().theme;
  if (p) applyPref(p);
}

function applyPref(p: ThemePref) {
  pref = p;
  try {
    localStorage.setItem(KEY, p); // pre-paint cache for index.html
  } catch {
    // Losing the cache just means a flash of the wrong theme on load.
  }
  notify();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export const useThemePref = (): ThemePref =>
  useSyncExternalStore(subscribe, () => pref);

export const useScheme = (): Scheme =>
  useSyncExternalStore(subscribe, () => resolve(pref));

apply();
