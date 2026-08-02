/**
 * Word-level intra-line diff. When a hunk has a del-run immediately followed
 * by an add-run of equal length, each del/add pair gets its changed span
 * computed via longest common prefix/suffix. Pairs whose changed middle
 * dominates the line (>70%) are skipped — highlighting most of the line is
 * noise, the whole-line tint already says "changed".
 */

import type { DiffHunk } from "@shared/types";

export interface Span {
  start: number;
  end: number;
}

/** Fraction of the line the changed middle may cover before we skip. */
const MAX_CHANGED_FRACTION = 0.7;

function pairSpans(a: string, b: string): { del: Span; add: Span } | null {
  if (a === b || a.length === 0 || b.length === 0) return null;
  const max = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < max && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  const del: Span = { start: prefix, end: a.length - suffix };
  const add: Span = { start: prefix, end: b.length - suffix };
  const frac = (s: Span, len: number) => (s.end - s.start) / len;
  if (
    Math.max(frac(del, a.length), frac(add, b.length)) > MAX_CHANGED_FRACTION
  ) {
    return null;
  }
  if (del.end <= del.start && add.end <= add.start) return null;
  return { del, add };
}

/**
 * Changed span per line, keyed by the line's flat index across all hunks
 * (the same index the highlighter tokens use). Lines without a span are
 * absent from the map.
 */
export function intralineSpans(hunks: DiffHunk[]): Map<number, Span> {
  const map = new Map<number, Span>();
  let flat = 0;
  for (const hunk of hunks) {
    const base = flat;
    flat += hunk.lines.length;
    const lines = hunk.lines;
    let i = 0;
    while (i < lines.length) {
      if (lines[i]!.kind !== "del") {
        i++;
        continue;
      }
      let j = i;
      while (j < lines.length && lines[j]!.kind === "del") j++;
      let k = j;
      while (k < lines.length && lines[k]!.kind === "add") k++;
      if (j - i === k - j) {
        for (let p = 0; p < j - i; p++) {
          const spans = pairSpans(lines[i + p]!.text, lines[j + p]!.text);
          if (spans) {
            if (spans.del.end > spans.del.start) map.set(base + i + p, spans.del);
            if (spans.add.end > spans.add.start) map.set(base + j + p, spans.add);
          }
        }
      }
      i = k;
    }
  }
  return map;
}
