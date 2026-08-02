/**
 * File classification for the semantic review view. Pure path heuristics —
 * cheap, language-blind, wrong in ways that cost one click (a misfiled file
 * is still reviewable). Precedence: tests → generated → docs → config → code;
 * display order is CLASS_ORDER.
 */

import type { FileSummary } from "#shared/types";
import { buildFileTree, flattenTree, type TreeNode } from "../tree.ts";

export type FileClass = "code" | "tests" | "config" | "docs" | "generated";

export const CLASS_ORDER: FileClass[] = ["code", "tests", "config", "docs", "generated"];

export const CLASS_LABEL: Record<FileClass, string> = {
  code: "Code",
  tests: "Tests",
  config: "Tooling & CI",
  docs: "Docs",
  generated: "Generated & lockfiles",
};

const TESTS = [
  /(^|\/)(tests?|__tests__|spec)\//,
  /\.(test|spec)\.[^/]+$/,
  /_test\.[^/]+$/,
  /(^|\/)test_[^/]*\.py$/,
  /\.t\.sol$/,
  /\.stories\.[^/]+$/,
];

const GENERATED = [
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|flake\.lock|go\.sum)$/,
  /(^|\/)(dist|out|coverage|__snapshots__|node_modules|vendor)\//,
  /\.(snap|min\.js|min\.css|map)$/,
  /\.(gen|generated)\.[^/]+$/,
  /(^|\/)generated\//,
];

const DOCS = [
  /\.(md|mdx|rst|txt|adoc)$/i,
  /(^|\/)docs?\//,
  /(^|\/)(LICENSE|CHANGELOG|README|NOTICE|AUTHORS|CONTRIBUTING|CODEOWNERS)[^/]*$/,
];

const CONFIG = [
  /(^|\/)\.(github|gitea|gitlab|circleci|vscode|claude)\//,
  /(^|\/)(Dockerfile[^/]*|docker-compose[^/]*|Makefile|justfile|Justfile)$/,
  /(^|\/)\.[^/]+$/, // dotfiles: .gitignore, .env.example, .eslintrc, …
  /\.(json|jsonc|toml|yaml|yml|ini|cfg|conf|properties)$/,
  /\.config\.[^/]+$/,
  /(^|\/)systemd\//,
];

const MATCHERS: Array<[FileClass, RegExp[]]> = [
  ["tests", TESTS],
  ["generated", GENERATED],
  ["docs", DOCS],
  ["config", CONFIG],
];

export function classifyFile(path: string): FileClass {
  for (const [cls, patterns] of MATCHERS) {
    if (patterns.some((p) => p.test(path))) return cls;
  }
  return "code";
}

export interface ClassSection {
  cls: FileClass;
  tree: TreeNode[];
  /** Files in tree (visual) order within the section. */
  files: FileSummary[];
}

/** Groups files into non-empty class sections, ordered by CLASS_ORDER. */
export function buildClassSections(files: FileSummary[]): ClassSection[] {
  const byClass = new Map<FileClass, FileSummary[]>();
  for (const f of files) {
    const cls = classifyFile(f.path);
    byClass.set(cls, [...(byClass.get(cls) ?? []), f]);
  }
  return CLASS_ORDER.filter((cls) => byClass.has(cls)).map((cls) => {
    const tree = buildFileTree(byClass.get(cls)!);
    return { cls, tree, files: flattenTree(tree) };
  });
}
