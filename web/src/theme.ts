/**
 * Theme preference (light/dark/auto) persisted in localStorage; the resolved
 * scheme lands as `data-theme` on <html>, which the CSS token overrides key
 * off. An inline script in index.html applies the initial attribute before
 * first paint; this module owns it from then on.
 */

import { useSyncExternalStore } from "react";

export type ThemePref = "light" | "dark" | "auto";
export type Scheme = "light" | "dark";

const KEY = "rev.theme";
const META_COLOR: Record<Scheme, string> = { dark: "#0e1115", light: "#f4f5f7" };

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
  listeners.forEach((l) => l());
}

media.addEventListener("change", () => {
  if (pref === "auto") notify();
});

export function setThemePref(p: ThemePref) {
  pref = p;
  try {
    localStorage.setItem(KEY, p);
  } catch {
    // Losing persistence just means next load falls back to auto.
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
