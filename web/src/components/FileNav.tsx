import type { FileDiff } from "@shared/types";
import { cx } from "../util";

const GLYPH: Record<FileDiff["status"], { g: string; cls: string }> = {
  modified: { g: "M", cls: "text-accent" },
  added: { g: "A", cls: "text-add" },
  deleted: { g: "D", cls: "text-del" },
  renamed: { g: "R", cls: "text-agent" },
  untracked: { g: "U", cls: "text-add" },
};

interface FileNavProps {
  files: FileDiff[];
  unresolvedByFile: Map<string, number>;
  currentPath: string | null;
  onSelect: (path: string) => void;
  onToggleSeen: (file: FileDiff, seen: boolean) => void;
}

export function FileNav({
  files,
  unresolvedByFile,
  currentPath,
  onSelect,
  onToggleSeen,
}: FileNavProps) {
  return (
    <nav aria-label="Changed files" className="flex flex-col py-1">
      {files.map((f) => {
        const slash = f.path.lastIndexOf("/");
        const dirPart = slash >= 0 ? f.path.slice(0, slash + 1) : "";
        const namePart = slash >= 0 ? f.path.slice(slash + 1) : f.path;
        const open = unresolvedByFile.get(f.path) ?? 0;
        const current = currentPath === f.path;
        return (
          <div
            key={f.path}
            className={cx(
              "group flex items-center gap-2 border-l-2 py-1 pl-2 pr-2",
              current
                ? "border-accent bg-raise"
                : "border-transparent hover:bg-raise/50",
            )}
          >
            <input
              type="checkbox"
              checked={f.seen}
              title={f.seen ? "Mark unseen" : "Mark seen"}
              onChange={(e) => onToggleSeen(f, e.target.checked)}
              className="size-3 shrink-0 accent-accent"
            />
            <span className={cx("w-2.5 shrink-0 text-center font-mono text-[11px] font-bold", GLYPH[f.status].cls)}>
              {GLYPH[f.status].g}
            </span>
            <button
              type="button"
              onClick={() => onSelect(f.path)}
              title={f.path}
              className="flex min-w-0 flex-1 items-baseline text-left font-mono text-[11.5px]"
            >
              <span className="truncate">
                <span className="text-faint">{dirPart}</span>
                <span className={cx(f.seen && !f.stale ? "text-mute" : "text-fg")}>{namePart}</span>
              </span>
            </button>
            {f.stale && (
              <span title="changed since seen" className="size-1.5 shrink-0 rounded-full bg-accent" />
            )}
            {open > 0 && (
              <span className="shrink-0 rounded-sm bg-accent-soft px-1 font-mono text-[10.5px] leading-4 text-accent">
                {open}
              </span>
            )}
            {f.binary ? (
              <span className="shrink-0 font-mono text-[10.5px] text-faint">bin</span>
            ) : (
              <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-faint">
                <span className="text-add/80">+{f.additions}</span>
                <span className="text-del/80"> −{f.deletions}</span>
              </span>
            )}
          </div>
        );
      })}
    </nav>
  );
}
