import { useEffect, useMemo, useRef, useState } from "react";
import type { FileSummary } from "#shared/types";
import { DiffStat } from "./DiffStat";

/** Above this many files per-file segments get too thin to read or click. */
const SEGMENT_LIMIT = 48;

/**
 * Header centerpiece: per-file review progress. One segment per file, width
 * scaled by change volume, filled as files are marked seen. Stale files show
 * amber (seen at an older content hash — they need another look, so they
 * don't count as done). Click a segment to glide to that file. Everything
 * flips green with a check when the last file is done.
 */
export function ReviewProgress({
  files,
  currentPath,
  onJump,
}: {
  files: FileSummary[];
  currentPath: string | null;
  onJump: (path: string) => void;
}) {
  const totals = useMemo(
    () =>
      files.reduce(
        (acc, f) => ({
          add: acc.add + f.additions,
          del: acc.del + f.deletions,
        }),
        { add: 0, del: 0 },
      ),
    [files],
  );
  const done = files.filter((f) => f.seen && !f.stale).length;
  const stale = files.filter((f) => f.stale).length;
  const complete = files.length > 0 && done === files.length;
  const pct = files.length === 0 ? 0 : Math.round((done / files.length) * 100);

  // Green pulse only on the transition into complete, never on initial mount
  // of an already-finished review.
  const wasComplete = useRef(complete);
  const [pulse, setPulse] = useState(false);
  useEffect(() => {
    const was = wasComplete.current;
    wasComplete.current = complete;
    if (complete && !was) {
      setPulse(true);
      const t = setTimeout(() => setPulse(false), 900);
      return () => clearTimeout(t);
    }
  }, [complete]);

  // sqrt dampens huge files so a lockfile doesn't dwarf everything else.
  const weight = (f: FileSummary) =>
    Math.max(1, Math.sqrt(f.additions + f.deletions));
  const doneWeight = files.reduce(
    (acc, f) => acc + (f.seen && !f.stale ? weight(f) : 0),
    0,
  );
  const totalWeight = files.reduce((acc, f) => acc + weight(f), 0);

  const segFill = (f: FileSummary) =>
    f.stale
      ? "bg-accent/40 hover:bg-accent/70"
      : f.seen
        ? complete
          ? "bg-add hover:brightness-110"
          : "bg-accent hover:brightness-110"
        : "bg-edge hover:bg-mute/50";

  const segTitle = (f: FileSummary) =>
    `${f.path} · +${f.additions} −${f.deletions}${
      f.stale ? " · stale — changed since marked seen" : f.seen ? " · seen" : ""
    }`;

  return (
    <div className="flex min-w-0 shrink items-center justify-center gap-2.5">
      <span
        className={`flex shrink-0 items-center gap-1 whitespace-nowrap font-mono text-[11.5px] tabular-nums transition-colors duration-300 ${
          complete ? "text-add" : "text-mute"
        }`}
        title={
          complete
            ? `all ${files.length} files reviewed`
            : `${done} of ${files.length} files reviewed · ${pct}%`
        }
      >
        {complete && (
          <svg
            viewBox="0 0 12 12"
            className="size-3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M2 6.5 4.8 9.2 10 3" />
          </svg>
        )}
        {done}/{files.length} seen
      </span>

      {files.length <= SEGMENT_LIMIT ? (
        <div
          className={`hidden h-[11px] w-96 min-w-0 shrink items-center gap-px md:flex ${
            pulse ? "progress-pulse" : ""
          }`}
        >
          {files.map((f) => (
            <button
              key={f.path}
              type="button"
              onClick={() => onJump(f.path)}
              title={segTitle(f)}
              aria-label={segTitle(f)}
              aria-current={f.path === currentPath ? "true" : undefined}
              style={{ flexGrow: weight(f) }}
              className={`min-w-[3px] basis-0 rounded-[1px] transition-[height,background-color,filter] duration-200 ${
                f.path === currentPath ? "h-[11px]" : "h-[7px]"
              } ${segFill(f)}`}
            />
          ))}
        </div>
      ) : (
        <div
          className={`hidden h-[7px] w-96 min-w-0 shrink overflow-hidden rounded-sm bg-edge md:block ${
            pulse ? "progress-pulse" : ""
          }`}
          title={`${done} of ${files.length} files reviewed · ${pct}%`}
        >
          <div
            className={`h-full rounded-sm transition-[width,background-color] duration-300 ${
              complete ? "bg-add" : "bg-accent"
            }`}
            style={{ width: `${(doneWeight / totalWeight) * 100}%` }}
          />
        </div>
      )}

      {stale > 0 && (
        <span
          className="shrink-0 whitespace-nowrap font-mono text-[11.5px] tabular-nums text-accent max-sm:hidden"
          title="files that changed since being marked seen"
        >
          {stale} stale
        </span>
      )}

      {totals.add + totals.del > 0 && (
        <span className="shrink-0 whitespace-nowrap font-mono text-[11.5px] tabular-nums max-sm:hidden">
          <DiffStat add={totals.add} del={totals.del} />
        </span>
      )}
    </div>
  );
}
