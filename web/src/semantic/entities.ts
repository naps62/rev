/** Presentation helpers for sem entity changes (strip under file headers). */

import type { EntityChange } from "#shared/types";

export const CHANGE_GLYPH: Record<EntityChange["change"], string> = {
  added: "+",
  modified: "~",
  deleted: "−",
  renamed: "→",
  moved: "↷",
  reordered: "↕",
};

export const CHANGE_CLS: Record<EntityChange["change"], string> = {
  added: "text-add",
  modified: "text-mute",
  deleted: "text-del",
  renamed: "text-agent",
  moved: "text-agent",
  reordered: "text-agent",
};

/** Where a strip click should land: the new side while the entity exists. */
export function entityAnchor(
  e: EntityChange,
): { side: "old" | "new"; line: number } | null {
  if (e.startLine != null) return { side: "new", line: e.startLine };
  if (e.oldStartLine != null) return { side: "old", line: e.oldStartLine };
  return null;
}

/** Display label; renames read "before → after". */
export function entityLabel(e: EntityChange): string {
  return e.change === "renamed" && e.oldName
    ? `${e.oldName} → ${e.name}`
    : e.name;
}
