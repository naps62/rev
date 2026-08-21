/**
 * Directory tree for the review file rail. Single-child directory chains are
 * collapsed into one node ("web/src/components"), GitHub-style. `flattenTree`
 * yields files in visual (tree) order — the diff pane, scroll-spy and j/k all
 * follow that order so the rail and the page never disagree.
 */

import type { FileSummary } from "#shared/types";

export interface DirNode {
  type: "dir";
  /** Display label, possibly a collapsed chain like "web/src/components". */
  label: string;
  /** Full repo-relative path of the (deepest) directory, no trailing slash. */
  path: string;
  children: TreeNode[];
}

interface FileNode {
  type: "file";
  file: FileSummary;
}

export type TreeNode = DirNode | FileNode;

interface RawDir {
  dirs: Map<string, RawDir>;
  files: FileSummary[];
}

export function buildFileTree(files: FileSummary[]): TreeNode[] {
  const root: RawDir = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.dirs.get(part);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        node.dirs.set(part, next);
      }
      node = next;
    }
    node.files.push(f);
  }

  const toNodes = (raw: RawDir, prefix: string): TreeNode[] => {
    const dirNodes: DirNode[] = [...raw.dirs.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, sub]) => {
        let label = name;
        let path = prefix ? `${prefix}/${name}` : name;
        let cur = sub;
        while (cur.files.length === 0 && cur.dirs.size === 1) {
          const [childName, child] = [...cur.dirs.entries()][0]!;
          label = `${label}/${childName}`;
          path = `${path}/${childName}`;
          cur = child;
        }
        return { type: "dir", label, path, children: toNodes(cur, path) };
      });
    const fileNodes: FileNode[] = [...raw.files]
      .sort((a, b) => fileName(a).localeCompare(fileName(b)))
      .map((file) => ({ type: "file", file }));
    return [...dirNodes, ...fileNodes];
  };
  return toNodes(root, "");
}

function fileName(f: FileSummary): string {
  return f.path.slice(f.path.lastIndexOf("/") + 1);
}

/** Files in tree (visual) order. */
export function flattenTree(nodes: TreeNode[]): FileSummary[] {
  const out: FileSummary[] = [];
  const walk = (ns: TreeNode[]) => {
    for (const n of ns) {
      if (n.type === "dir") walk(n.children);
      else out.push(n.file);
    }
  };
  walk(nodes);
  return out;
}
