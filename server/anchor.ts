/**
 * Re-anchoring: comments store where a line WAS; the working tree moves under
 * them. At read time we locate the anchored line in the current file content
 * so threads follow the code instead of orphaning on every edit above them.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Comment, CommentAnchor } from "#shared/types";

/**
 * Find the 1-based line of `anchor` in `lines` (trimmed comparison).
 * Preference order: exact line still matches → candidate with the best
 * context score → candidate nearest the original line. Null when the snippet
 * no longer exists anywhere (orphaned).
 */
export function resolveAnchor(lines: string[], anchor: CommentAnchor): number | null {
  const target = anchor.snippet.trim();
  const at = (i: number) => lines[i]?.trim();
  if (at(anchor.line - 1) === target) return anchor.line;

  const candidates: number[] = [];
  for (let i = 0; i < lines.length; i++) if (at(i) === target) candidates.push(i);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]! + 1;

  const ctx = anchor.context;
  if (ctx && (ctx.before.length > 0 || ctx.after.length > 0)) {
    let best = -1;
    let bestScore = -1;
    for (const i of candidates) {
      let score = 0;
      for (let k = 0; k < ctx.before.length; k++) {
        if (at(i - 1 - k) === ctx.before[ctx.before.length - 1 - k]?.trim()) score++;
      }
      for (let k = 0; k < ctx.after.length; k++) {
        if (at(i + 1 + k) === ctx.after[k]?.trim()) score++;
      }
      const better =
        score > bestScore ||
        (score === bestScore && Math.abs(i + 1 - anchor.line) < Math.abs(best + 1 - anchor.line));
      if (better) {
        best = i;
        bestScore = score;
      }
    }
    return best + 1;
  }

  let nearest = candidates[0]!;
  for (const i of candidates) {
    if (Math.abs(i + 1 - anchor.line) < Math.abs(nearest + 1 - anchor.line)) nearest = i;
  }
  return nearest + 1;
}

/**
 * Fill `resolvedLine` on thread roots with "new"-side anchors by reading each
 * commented file from `dir`'s working tree once. "old"-side anchors echo
 * their stored line (the old side only moves when the merge-base does);
 * unreadable/deleted files orphan their anchors (null).
 */
export async function resolveComments(dir: string, comments: Comment[]): Promise<void> {
  const byFile = new Map<string, Comment[]>();
  for (const c of comments) {
    if (c.parentId !== null || c.anchor === null) continue;
    if (c.anchor.side === "old") {
      c.resolvedLine = c.anchor.line;
      continue;
    }
    const list = byFile.get(c.anchor.file) ?? [];
    list.push(c);
    byFile.set(c.anchor.file, list);
  }
  for (const [file, list] of byFile) {
    let lines: string[] | null = null;
    try {
      lines = (await readFile(join(dir, file), "utf8")).split("\n");
    } catch {
      // deleted or binary: orphan below
    }
    for (const c of list) {
      c.resolvedLine = lines === null ? null : resolveAnchor(lines, c.anchor!);
    }
  }
}
