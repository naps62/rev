import { useState } from "react";
import type { EntityChange } from "#shared/types";
import {
  CHANGE_CLS,
  CHANGE_GLYPH,
  CHANGE_LABEL,
  entityLabel,
} from "../semantic/entities.ts";
import { BUCKET_LABEL, type RollupGroup } from "../semantic/rollup.ts";
import { cx } from "../util";

interface RollupPanelProps {
  groups: RollupGroup[];
  /** Jump to one entity's first line in the diff. */
  onJump: (path: string, entity: EntityChange) => void;
}

const groupKey = (g: RollupGroup) => `${g.bucket}:${g.change}`;

/**
 * The triage entry point: every entity change in the diff, grouped by
 * (bucket × change kind); expanding a group lists its entities per file.
 */
export function RollupPanel({ groups, onJump }: RollupPanelProps) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  if (groups.length === 0) return null;

  return (
    <section className="rounded-md border border-edge bg-panel max-sm:rounded-none max-sm:border-x-0">
      <div className="flex flex-col">
        {groups.map((g) => {
          const key = groupKey(g);
          const open = openKey === key;
          return (
            <div key={key} className="border-b border-edge-soft last:border-b-0">
              <button
                type="button"
                onClick={() => setOpenKey(open ? null : key)}
                aria-expanded={open}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[12px] text-fg hover:bg-raise/40"
              >
                <svg
                  width="9"
                  height="9"
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden
                  className={cx("shrink-0 transition-transform duration-150", open && "rotate-90")}
                >
                  <path
                    d="M5.5 3 11 8l-5.5 5"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className={cx("w-3 text-center font-bold", CHANGE_CLS[g.change])}>
                  {CHANGE_GLYPH[g.change]}
                </span>
                <span>
                  {g.items.length} {CHANGE_LABEL[g.change]} {BUCKET_LABEL[g.bucket]}
                </span>
              </button>
              {open && <GroupByFile group={g} onJump={onJump} />}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function GroupByFile({ group, onJump }: { group: RollupGroup; onJump: RollupPanelProps["onJump"] }) {
  const byPath = new Map<string, EntityChange[]>();
  for (const it of group.items) {
    let list = byPath.get(it.path);
    if (!list) byPath.set(it.path, (list = []));
    list.push(it.entity);
  }
  return (
    <div className="flex flex-col pb-1.5">
      {[...byPath.entries()].map(([path, entities]) => (
        <div key={path}>
          <p className="truncate px-3 py-0.5 pl-7 font-mono text-[11px] text-faint" title={path}>
            {path}
            <span className="ml-1.5 tabular-nums">{entities.length}</span>
          </p>
          <div className="flex flex-wrap gap-x-2.5 gap-y-0.5 px-3 pl-10">
            {entities.map((e, i) => (
              <button
                key={`${e.entityType}:${e.name}:${i}`}
                type="button"
                onClick={() => onJump(path, e)}
                title={`${e.entityType} ${e.change}${e.startLine != null ? ` · line ${e.startLine}` : ""}`}
                className="max-w-72 truncate font-mono text-[11.5px] text-mute hover:text-fg hover:underline"
              >
                {entityLabel(e)}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
