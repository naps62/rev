import { useEffect, useState } from "react";
import type { FileDiff } from "@shared/types";
import type { DirNode, TreeNode } from "../tree";
import { flattenTree } from "../tree";
import { cx } from "../util";

const GLYPH: Record<FileDiff["status"], { g: string; cls: string }> = {
  modified: { g: "M", cls: "text-mute" },
  added: { g: "A", cls: "text-add" },
  deleted: { g: "D", cls: "text-del" },
  renamed: { g: "R", cls: "text-agent" },
  untracked: { g: "U", cls: "text-add" },
};

interface FileNavProps {
  tree: TreeNode[];
  unresolvedByFile: Map<string, number>;
  currentPath: string | null;
  onSelect: (path: string) => void;
  onToggleSeen: (file: FileDiff, seen: boolean) => void;
}

export function FileNav({
  tree,
  unresolvedByFile,
  currentPath,
  onSelect,
  onToggleSeen,
}: FileNavProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Landing on a file (scroll, j/k, mobile select) expands the dirs hiding it.
  useEffect(() => {
    if (!currentPath) return;
    setCollapsed((prev) => {
      const next = [...prev].filter((d) => !currentPath.startsWith(`${d}/`));
      return next.length === prev.size ? prev : new Set(next);
    });
  }, [currentPath]);

  const toggleDir = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <nav aria-label="Changed files" className="flex flex-col py-1">
      <TreeLevel
        nodes={tree}
        depth={0}
        collapsed={collapsed}
        toggleDir={toggleDir}
        unresolvedByFile={unresolvedByFile}
        currentPath={currentPath}
        onSelect={onSelect}
        onToggleSeen={onToggleSeen}
      />
    </nav>
  );
}

interface LevelProps {
  nodes: TreeNode[];
  depth: number;
  collapsed: Set<string>;
  toggleDir: (path: string) => void;
  unresolvedByFile: Map<string, number>;
  currentPath: string | null;
  onSelect: (path: string) => void;
  onToggleSeen: (file: FileDiff, seen: boolean) => void;
}

function TreeLevel(props: LevelProps) {
  const { nodes, depth, collapsed, toggleDir } = props;
  return (
    <>
      {nodes.map((node) =>
        node.type === "dir" ? (
          <DirRow key={`d:${node.path}`} {...props} node={node} />
        ) : (
          <FileRow key={`f:${node.file.path}`} {...props} file={node.file} />
        ),
      )}
    </>
  );
}

function DirRow(props: LevelProps & { node: DirNode }) {
  // MUST NOT spread `props` (it carries `node`) into children — a later
  // node= would be overwritten back to this dir, recursing forever.
  const { node, ...level } = props;
  const { depth, collapsed, toggleDir, unresolvedByFile } = level;
  const isCollapsed = collapsed.has(node.path);
  const files = flattenTree(node.children);
  const open = files.reduce((n, f) => n + (unresolvedByFile.get(f.path) ?? 0), 0);
  const stale = files.some((f) => f.stale);
  return (
    <>
      <button
        type="button"
        onClick={() => toggleDir(node.path)}
        aria-expanded={!isCollapsed}
        title={node.path}
        className="group flex w-full items-center gap-1.5 border-l border-transparent py-1 pr-2 text-left hover:bg-raise/50"
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        <svg
          width="9"
          height="9"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden
          className={cx(
            "shrink-0 text-faint transition-transform duration-150",
            !isCollapsed && "rotate-90",
          )}
        >
          <path
            d="M5.5 3 11 8l-5.5 5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-mute">
          {node.label}
          <span className="text-faint">/</span>
        </span>
        {isCollapsed && (
          <>
            {stale && (
              <span title="changed since seen" className="size-1.5 shrink-0 rounded-full bg-accent" />
            )}
            {open > 0 && (
              <span className="shrink-0 rounded-sm bg-accent-soft px-1 font-mono text-[10.5px] leading-4 text-accent">
                {open}
              </span>
            )}
            <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-faint">
              {files.length}
            </span>
          </>
        )}
      </button>
      {!isCollapsed && <TreeLevel {...level} nodes={node.children} depth={depth + 1} />}
    </>
  );
}

function FileRow(props: LevelProps & { file: FileDiff }) {
  const { file: f, depth, unresolvedByFile, currentPath, onSelect, onToggleSeen } = props;
  const name = f.path.slice(f.path.lastIndexOf("/") + 1);
  const open = unresolvedByFile.get(f.path) ?? 0;
  const current = currentPath === f.path;
  return (
    <div
      className={cx(
        "group flex items-center gap-2 border-l py-1 pr-2",
        current ? "border-accent bg-raise" : "border-transparent hover:bg-raise/50",
      )}
      style={{ paddingLeft: 8 + depth * 14 }}
    >
      <input
        type="checkbox"
        checked={f.seen}
        title={f.seen ? "Mark unseen" : "Mark seen"}
        onChange={(e) => onToggleSeen(f, e.target.checked)}
        className="size-3 shrink-0 accent-accent"
      />
      <span
        className={cx(
          "w-2.5 shrink-0 text-center font-mono text-[11px] font-bold",
          GLYPH[f.status].cls,
        )}
      >
        {GLYPH[f.status].g}
      </span>
      <button
        type="button"
        onClick={() => onSelect(f.path)}
        title={f.path}
        className="min-w-0 flex-1 truncate text-left font-mono text-[11.5px]"
      >
        <span className={cx(f.seen && !f.stale ? "text-mute" : "text-fg")}>{name}</span>
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
}
