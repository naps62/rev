import type { EntityChange } from "#shared/types";
import {
  CHANGE_CLS,
  CHANGE_GLYPH,
  entityAnchor,
  entityLabel,
} from "../semantic/entities.ts";
import { cx } from "../util";

const MAX_ROWS = 80;

interface EntityPanelProps {
  path: string;
  entities: EntityChange[];
  onJump: (path: string, entity: EntityChange) => void;
}

/**
 * Outline of the current file's semantic changes — answers "what changed
 * in the file I'm looking at". Follows scroll focus.
 */
export function EntityPanel({ path, entities, onJump }: EntityPanelProps) {
  const shown = entities.slice(0, MAX_ROWS);
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-edge-soft px-3 py-2">
        <span className="min-w-0 truncate font-mono text-[12.5px] font-medium text-fg" title={path}>
          {path.split("/").at(-1)}
        </span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-faint">
          {entities.length} change{entities.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {entities.length === 0 && (
          <p className="px-3 py-2 text-[12px] text-faint">
            No entity data for this file — sem skipped it (unsupported language or
            binary-looking content).
          </p>
        )}
        {shown.map((e, i) => {
          const a = entityAnchor(e);
          return (
            <button
              key={`${e.entityType}:${e.name}:${i}`}
              type="button"
              onClick={() => onJump(path, e)}
              title={`${e.entityType} ${e.change}`}
              className="flex w-full items-baseline gap-2 px-3 py-0.5 text-left hover:bg-raise/50"
            >
              <span className="w-8 shrink-0 text-right font-mono text-[10.5px] tabular-nums text-faint">
                {a == null ? "" : a.side === "old" ? `−${a.line}` : a.line}
              </span>
              <span className={cx("w-3 shrink-0 text-center font-mono text-[11px] font-bold", CHANGE_CLS[e.change])}>
                {CHANGE_GLYPH[e.change]}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-mute">
                {entityLabel(e)}
              </span>
            </button>
          );
        })}
        {entities.length > MAX_ROWS && (
          <p className="px-3 py-1 font-mono text-[11px] text-faint">
            +{entities.length - MAX_ROWS} more not shown
          </p>
        )}
      </div>
    </div>
  );
}
