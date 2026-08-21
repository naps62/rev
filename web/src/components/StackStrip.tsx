import { Fragment } from "react";
import type { StackResponse } from "#shared/types";
import * as api from "../api";
import { cx } from "../util";

/**
 * Branch-stack strip shown when the reviewed branch sits on other local
 * branches. Reads bottom-up (base on the left, HEAD on the right). Clicking
 * a branch re-bases THIS review at it — the cumulative diff of everything
 * above it; clicking the stack base shows the full stack. Segments checked
 * out elsewhere link to their own review (against their parent) for the
 * isolated per-segment diff.
 */
export function StackStrip({
  stack,
  currentBase,
  onBase,
}: {
  stack: StackResponse;
  currentBase: string;
  onBase: (ref: string) => void;
}) {
  const bottomUp = [...stack.segments].reverse();
  const head = stack.segments[0];
  const chip = (active: boolean) =>
    cx(
      "rounded-sm border px-1.5 py-px font-mono text-[11px] transition-colors duration-150",
      active
        ? "border-accent/50 bg-accent-soft text-accent"
        : "border-edge text-mute hover:border-accent/40 hover:text-fg",
    );
  return (
    <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto rounded-md border border-edge bg-panel px-3 py-1.5 max-sm:rounded-none max-sm:border-x-0">
      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-mute">
        stack
      </span>
      <button
        type="button"
        onClick={() => onBase(stack.base)}
        title={`Diff the whole stack against ${stack.base}`}
        className={cx("shrink-0", chip(currentBase === stack.base))}
      >
        {stack.base}
      </button>
      {bottomUp.map((s) => (
        <Fragment key={s.branch}>
          <span aria-hidden className="shrink-0 text-faint">
            ‹
          </span>
          <span className="flex shrink-0 items-center gap-1">
            {s === head ? (
              <span
                title={`${s.commits} commit${s.commits === 1 ? "" : "s"} — this review's branch`}
                className="rounded-sm border border-edge-soft bg-raise px-1.5 py-px font-mono text-[11px] text-fg"
              >
                {s.branch}
                <span className="ml-1 text-faint">●</span>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onBase(s.branch)}
                title={`Re-base this review at ${s.branch}: everything stacked above it`}
                className={chip(currentBase === s.branch)}
              >
                {s.branch}
              </button>
            )}
            <span className="font-mono text-[10.5px] tabular-nums text-faint">
              {s.commits}
            </span>
            {s.checkoutDir !== null && s.checkoutDir !== stack.dir && (
              <a
                href={api.href("/review", {
                  dir: s.checkoutDir,
                  base: s.parent,
                })}
                title={`Open ${s.branch}'s own review vs ${s.parent} (its checkout)`}
                className="text-[11px] text-faint hover:text-accent"
              >
                ↗
              </a>
            )}
          </span>
        </Fragment>
      ))}
    </div>
  );
}
