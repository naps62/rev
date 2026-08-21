import { useMemo } from "react";
import type { Occurrence } from "../semantic/symbols.ts";
import { cx } from "../util";

const MAX_ROWS = 50;

interface SymbolPanelProps {
  symbol: string;
  occurrences: Occurrence[];
  /** Paths in pane (semantic) order — groups render in this order. */
  fileOrder: string[];
  currentPath: string | null;
  /** Diff files whose hunks aren't loaded yet, so matches there are unknown. */
  notLoaded: number;
  onLoadAll: () => void;
  onJump: (o: Occurrence) => void;
  onClose: () => void;
}

export function SymbolPanel({
  symbol,
  occurrences,
  fileOrder,
  currentPath,
  notLoaded,
  onLoadAll,
  onJump,
  onClose,
}: SymbolPanelProps) {
  const groups = useMemo(() => {
    const byPath = new Map<string, Occurrence[]>();
    for (const o of occurrences)
      byPath.set(o.path, [...(byPath.get(o.path) ?? []), o]);
    const order = new Map(fileOrder.map((p, i) => [p, i]));
    return [...byPath.entries()].sort(
      ([a], [b]) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity),
    );
  }, [occurrences, fileOrder]);

  let shown = 0;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-edge-soft px-3 py-2">
        <span className="min-w-0 truncate font-mono text-[12.5px] font-medium text-fg">
          {symbol}
        </span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-faint">
          {occurrences.length} match{occurrences.length === 1 ? "" : "es"}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close symbol panel"
          title="Close (Esc)"
          className="ml-auto grid size-5 shrink-0 place-items-center rounded-sm text-faint transition-colors duration-150 hover:bg-raise hover:text-fg"
        >
          ×
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {occurrences.length === 0 && (
          <p className="px-3 py-2 text-[12px] text-faint">
            No other occurrences in the loaded diff.
          </p>
        )}
        {groups.map(([path, occ]) => {
          if (shown >= MAX_ROWS) return null;
          const rows = occ.slice(0, MAX_ROWS - shown);
          shown += rows.length;
          return (
            <div key={path} className="mb-1.5">
              <p
                className={cx(
                  "truncate px-3 py-0.5 font-mono text-[11px]",
                  path === currentPath ? "text-mute" : "text-faint",
                )}
                title={path}
              >
                {path}
                <span className="ml-1.5 tabular-nums">{occ.length}</span>
              </p>
              {rows.map((o, i) => (
                <button
                  key={`${o.side}:${o.line}.${i}`}
                  type="button"
                  onClick={() => onJump(o)}
                  className={cx(
                    "flex w-full items-baseline gap-2 px-3 py-0.5 text-left hover:bg-raise/50",
                    path === currentPath && "opacity-70",
                  )}
                >
                  <span
                    className={cx(
                      "w-8 shrink-0 text-right font-mono text-[10.5px] tabular-nums",
                      o.kind === "add"
                        ? "text-add"
                        : o.kind === "del"
                          ? "text-del"
                          : "text-faint",
                    )}
                    title={
                      o.side === "old"
                        ? "old side (removed context)"
                        : undefined
                    }
                  >
                    {o.side === "old" ? `−${o.line}` : o.line}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-mute">
                    <HighlightedLine text={o.text} symbol={symbol} />
                  </span>
                </button>
              ))}
            </div>
          );
        })}
        {occurrences.length > MAX_ROWS && (
          <p className="px-3 py-1 font-mono text-[11px] text-faint">
            +{occurrences.length - MAX_ROWS} more not shown
          </p>
        )}
      </div>

      {notLoaded > 0 && (
        <div className="flex items-center gap-2 border-t border-edge-soft px-3 py-2">
          <span className="font-mono text-[11px] text-faint">
            {notLoaded} file{notLoaded === 1 ? "" : "s"} not searched yet
          </span>
          <button
            type="button"
            onClick={onLoadAll}
            className="ml-auto rounded-sm border border-accent/40 px-1.5 py-px font-mono text-[11px] text-accent transition-colors duration-150 hover:bg-accent hover:text-bg"
          >
            load all
          </button>
        </div>
      )}
    </div>
  );
}

/** The matched symbol tinted inside the occurrence line. */
function HighlightedLine({ text, symbol }: { text: string; symbol: string }) {
  const trimmed = text.trim();
  const idx = trimmed.indexOf(symbol);
  if (idx < 0) return <>{trimmed}</>;
  return (
    <>
      {trimmed.slice(0, idx)}
      <span className="rounded-[2px] bg-accent-soft text-accent">{symbol}</span>
      {trimmed.slice(idx + symbol.length)}
    </>
  );
}
