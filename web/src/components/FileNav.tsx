import { useEffect, useState } from "react";
import type { FileSummary } from "#shared/types";
import { CLASS_LABEL, type ClassSection, type FileClass } from "../semantic/classify.ts";
import type { DirNode, TreeNode } from "../tree";
import { flattenTree } from "../tree";
import { cx } from "../util";
import { Checkbox } from "./Checkbox";
import { DiffStat } from "./DiffStat";

const GLYPH: Record<FileSummary["status"], { g: string; cls: string }> = {
  modified: { g: "M", cls: "text-mute" },
  added: { g: "A", cls: "text-add" },
  deleted: { g: "D", cls: "text-del" },
  renamed: { g: "R", cls: "text-agent" },
  untracked: { g: "U", cls: "text-add" },
};

interface FileNavProps {
  tree: TreeNode[];
  /** Semantic view: class sections replace the top-level tree. */
  sections?: ClassSection[] | null;
  /** Files containing the active symbol — get a marker dot. */
  symbolFiles?: Set<string>;
  unresolvedByFile: Map<string, number>;
  currentPath: string | null;
  onSelect: (path: string) => void;
  onToggleSeen: (file: FileSummary, seen: boolean) => void;
}

/**
 * Collapse keys. A directory shows up once per class section in the semantic
 * view, so the key carries the section: "\0<cls>/<path>" there, bare "<path>"
 * in the flat tree. A bare "\0<cls>" is the section header itself.
 */
const sectionPrefix = (cls: FileClass) => `\0${cls}/`;

/** Section + directory a collapse key refers to; `dir` is null for headers. */
function parseKey(key: string): { cls: FileClass | null; dir: string | null } {
  if (!key.startsWith("\0")) return { cls: null, dir: key };
  const slash = key.indexOf("/");
  if (slash === -1) return { cls: key.slice(1) as FileClass, dir: null };
  return { cls: key.slice(1, slash) as FileClass, dir: key.slice(slash + 1) };
}

export function FileNav({
  tree,
  sections,
  symbolFiles,
  unresolvedByFile,
  currentPath,
  onSelect,
  onToggleSeen,
}: FileNavProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Landing on a file (scroll, j/k, mobile select) expands the dirs hiding it —
  // only in the section that actually holds it.
  useEffect(() => {
    if (!currentPath) return;
    const cls = sections?.find((s) => s.files.some((f) => f.path === currentPath))?.cls ?? null;
    setCollapsed((prev) => {
      const next = [...prev].filter((key) => {
        const k = parseKey(key);
        if (k.dir === null) return true;
        if (k.cls !== cls) return true;
        return !currentPath.startsWith(`${k.dir}/`);
      });
      return next.length === prev.size ? prev : new Set(next);
    });
  }, [currentPath, sections]);

  const toggleDir = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const level = (nodes: TreeNode[], keyPrefix = "") => (
    <TreeLevel
      nodes={nodes}
      depth={0}
      keyPrefix={keyPrefix}
      collapsed={collapsed}
      toggleDir={toggleDir}
      unresolvedByFile={unresolvedByFile}
      symbolFiles={symbolFiles}
      currentPath={currentPath}
      onSelect={onSelect}
      onToggleSeen={onToggleSeen}
    />
  );

  return (
    <nav aria-label="Changed files" className="flex flex-col py-1">
      {sections
        ? sections.map((s) => {
            // "\0"-prefixed key can't collide with a real directory path.
            const key = `\0${s.cls}`;
            const isCollapsed = collapsed.has(key);
            const allSeen = s.files.length > 0 && s.files.every((f) => f.seen);
            const someSeen = s.files.some((f) => f.seen);
            const open = s.files.reduce(
              (n, f) => n + (unresolvedByFile.get(f.path) ?? 0),
              0,
            );
            return (
              <div key={s.cls}>
                <div
                  onClick={() => toggleDir(key)}
                  className="group flex w-full cursor-pointer items-center gap-1.5 py-1 pl-2 pr-2 hover:bg-raise/50"
                >
                  <Checkbox
                    checked={allSeen}
                    indeterminate={someSeen && !allSeen}
                    title={allSeen ? "Mark section unseen" : "Mark section seen"}
                    onChange={(checked) => {
                      for (const f of s.files) onToggleSeen(f, checked);
                    }}
                  />
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
                  <span
                    className={cx(
                      "min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide text-mute",
                      allSeen && "opacity-60",
                    )}
                  >
                    {CLASS_LABEL[s.cls]}
                  </span>
                  {open > 0 && (
                    <span className="shrink-0 rounded-sm bg-accent-soft px-1 font-mono text-[10.5px] leading-4 text-accent">
                      {open}
                    </span>
                  )}
                  <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-faint">
                    {s.files.length}
                  </span>
                </div>
                {!isCollapsed && level(s.tree, sectionPrefix(s.cls))}
              </div>
            );
          })
        : level(tree)}
    </nav>
  );
}

interface LevelProps {
  nodes: TreeNode[];
  depth: number;
  /** Namespaces collapse keys per class section; "" in the flat tree. */
  keyPrefix: string;
  collapsed: Set<string>;
  toggleDir: (path: string) => void;
  unresolvedByFile: Map<string, number>;
  symbolFiles?: Set<string>;
  currentPath: string | null;
  onSelect: (path: string) => void;
  onToggleSeen: (file: FileSummary, seen: boolean) => void;
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
  const { depth, keyPrefix, collapsed, toggleDir, unresolvedByFile, onToggleSeen } = level;
  const key = keyPrefix + node.path;
  const isCollapsed = collapsed.has(key);
  const files = flattenTree(node.children);
  const open = files.reduce((n, f) => n + (unresolvedByFile.get(f.path) ?? 0), 0);
  const stale = files.some((f) => f.stale);
  const allSeen = files.length > 0 && files.every((f) => f.seen);
  const someSeen = files.some((f) => f.seen);
  return (
    <>
      <div
        onClick={() => toggleDir(key)}
        title={node.path}
        className="group flex w-full cursor-pointer items-center gap-1.5 border-l border-transparent py-1 pr-2 hover:bg-raise/50"
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        <Checkbox
          checked={allSeen}
          indeterminate={someSeen && !allSeen}
          title={allSeen ? "Mark directory unseen" : "Mark directory seen"}
          onChange={(checked) => {
            for (const f of files) onToggleSeen(f, checked);
          }}
        />
        <button
          type="button"
          aria-expanded={!isCollapsed}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
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
          <span
            className={cx(
              "min-w-0 flex-1 truncate font-mono text-[11.5px] text-mute",
              allSeen && "opacity-60",
            )}
          >
            {node.label}
            <span className="text-faint">/</span>
          </span>
        </button>
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
      </div>
      {!isCollapsed && <TreeLevel {...level} nodes={node.children} depth={depth + 1} />}
    </>
  );
}

function FileRow(props: LevelProps & { file: FileSummary }) {
  const { file: f, depth, unresolvedByFile, symbolFiles, currentPath, onSelect, onToggleSeen } =
    props;
  const name = f.path.slice(f.path.lastIndexOf("/") + 1);
  const open = unresolvedByFile.get(f.path) ?? 0;
  const current = currentPath === f.path;
  const hasSymbol = symbolFiles?.has(f.path) ?? false;
  return (
    // The whole row navigates (cursor + onClick); the inner button carries
    // keyboard focus, and the checkbox stops propagation so seen-toggling
    // doesn't also jump.
    <div
      onClick={() => onSelect(f.path)}
      className={cx(
        "group flex cursor-pointer items-center gap-2 border-l py-1 pr-2",
        current ? "border-accent bg-raise" : "border-transparent hover:bg-raise/50",
      )}
      style={{ paddingLeft: 8 + depth * 14 }}
    >
      <Checkbox
        checked={f.seen}
        title={f.seen ? "Mark unseen" : "Mark seen"}
        onChange={(checked) => onToggleSeen(f, checked)}
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
        title={f.path}
        className="min-w-0 flex-1 truncate text-left font-mono text-[11.5px]"
      >
        <span className={cx(f.seen && !f.stale ? "text-mute" : "text-fg")}>{name}</span>
      </button>
      {hasSymbol && (
        <span
          title="contains the active symbol"
          className="size-1.5 shrink-0 rounded-full bg-agent"
        />
      )}
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
        f.additions + f.deletions > 0 && (
          <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-faint">
            <DiffStat add={f.additions} del={f.deletions} dim />
          </span>
        )
      )}
    </div>
  );
}
