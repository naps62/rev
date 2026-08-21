/**
 * Vimium-style link hints, scoped to review actions: press f and every
 * visible contextual control — seen checkboxes, file collapse chevrons,
 * section expand/collapse buttons, hunk headers, fold strips, per-line
 * comment buttons —
 * grows a label; typing the label clicks it. Pure DOM, same pattern as
 * crosshair.ts: nothing re-renders in React.
 *
 * Targets are discovered at activation time: anything carrying [data-hint]
 * plus the per-line [data-comment-btn] buttons, filtered to the viewport.
 * Components opt controls in by adding the attribute; this module never
 * hardcodes their DOM shape.
 */

import { HEADER_PX } from "./components/AppHeader";

// Home-row-ish and unambiguous; every hint uses 1 char, or all use 2, so a
// prefix can never also be a full label.
const ALPHABET = "asdfjklewcmpghur";

function labelsFor(n: number): string[] {
  const A = ALPHABET;
  if (n <= A.length) return [...A].slice(0, n);
  const out: string[] = [];
  for (let i = 0; out.length < n && i < A.length; i++) {
    for (let j = 0; out.length < n && j < A.length; j++)
      out.push(A[i]! + A[j]!);
  }
  return out;
}

function collectTargets(): HTMLElement[] {
  const els = [
    ...document.querySelectorAll<HTMLElement>("[data-hint]"),
    ...document.querySelectorAll<HTMLElement>("button[data-comment-btn]"),
  ];
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  return els.filter((el) => {
    const r = el.getBoundingClientRect();
    // Below the sticky header, inside the viewport, and actually laid out
    // (hidden-until-hover comment buttons keep their box, display:none loses it).
    return (
      r.width > 0 &&
      r.height > 0 &&
      r.bottom > HEADER_PX + 2 &&
      r.top < vh &&
      r.right > 0 &&
      r.left < vw
    );
  });
}

interface Hint {
  el: HTMLElement;
  label: string;
  badge: HTMLElement;
}

/**
 * Enter hint mode. Returns a cancel function; `onExit` fires exactly once on
 * any exit path (match, Escape, scroll, cancel()).
 */
export function startHints(onExit: () => void): () => void {
  const targets = collectTargets();
  if (targets.length === 0) {
    onExit();
    return () => {};
  }

  const root = document.createElement("div");
  root.className = "hints-root";
  root.setAttribute("aria-hidden", "true");

  const labels = labelsFor(targets.length);
  const hints: Hint[] = targets.map((el, i) => {
    const label = labels[i] ?? "";
    const badge = document.createElement("div");
    badge.className = "hint-badge";
    const r = el.getBoundingClientRect();
    badge.style.left = `${Math.min(Math.max(r.left, 2), window.innerWidth - 30)}px`;
    badge.style.top = `${Math.max(r.top + r.height / 2, HEADER_PX + 10)}px`;
    root.appendChild(badge);
    return { el, label, badge };
  });
  // Overflowed the 2-char label space: unlabeled targets get no hint.
  const live = hints.filter((h) => h.label !== "");
  document.body.appendChild(root);

  let typed = "";
  let done = false;

  const render = () => {
    for (const h of live) {
      if (!h.label.startsWith(typed)) {
        h.badge.style.display = "none";
        continue;
      }
      h.badge.style.display = "block";
      h.badge.replaceChildren();
      const hit = document.createElement("span");
      hit.className = "hint-typed";
      hit.textContent = typed;
      h.badge.append(hit, h.label.slice(typed.length));
    }
  };
  render();

  const exit = () => {
    if (done) return;
    done = true;
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("scroll", exit, true);
    window.removeEventListener("resize", exit);
    window.removeEventListener("mousedown", exit, true);
    root.remove();
    onExit();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return; // browser chords pass through
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape" || e.key === "f") return exit();
    if (e.key === "Backspace") {
      typed = typed.slice(0, -1);
      render();
      return;
    }
    const ch = e.key.toLowerCase();
    if (ch.length !== 1 || !ALPHABET.includes(ch)) return;
    const next = typed + ch;
    const matches = live.filter((h) => h.label.startsWith(next));
    if (matches.length === 0) return; // stray key — keep the current filter
    typed = next;
    const exact = matches.find((h) => h.label === typed);
    if (exact) {
      exit();
      exact.el.click(); // <label> targets forward the click to their control
      return;
    }
    render();
  };

  window.addEventListener("keydown", onKey, true);
  // Any scroll or pointer interaction invalidates the measured positions.
  window.addEventListener("scroll", exit, { capture: true, passive: true });
  window.addEventListener("resize", exit);
  window.addEventListener("mousedown", exit, true);

  return exit;
}
