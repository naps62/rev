/**
 * Line-folding heuristics for the semantic view: import runs everywhere,
 * whole bodies in test files. Regex + bracket-depth tracking, no parsing —
 * a wrong fold costs one click to expand.
 */

import type { DiffLine } from "#shared/types";

export type Lang = "ts" | "rust" | "solidity" | "python";

const EXT_LANG: Array<[RegExp, Lang]> = [
  [/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/, "ts"],
  [/\.rs$/, "rust"],
  [/\.sol$/, "solidity"],
  [/\.pyi?$/, "python"],
];

export function langOf(path: string): Lang | null {
  for (const [re, lang] of EXT_LANG) if (re.test(path)) return lang;
  return null;
}

/** A foldable run of lines: [start, end) indices into the hunk's lines. */
export interface FoldRun {
  start: number;
  end: number;
  adds: number;
  dels: number;
  label: string;
}

interface ImportSyntax {
  start: RegExp[];
  /** Bracket pair whose depth carries a statement across lines. */
  open: string;
  close: string;
}

const IMPORTS: Record<Lang, ImportSyntax> = {
  ts: {
    start: [/^\s*import\b/, /^\s*export\s+.*\bfrom\s+["']/],
    open: "{",
    close: "}",
  },
  rust: {
    start: [
      /^\s*(pub(\([^)]*\))?\s+)?use\b/,
      /^\s*extern\s+crate\b/,
      /^\s*mod\s+[\w:]+\s*;/,
    ],
    open: "{",
    close: "}",
  },
  solidity: {
    start: [/^\s*import\b/, /^\s*pragma\b/, /^\s*\/\/\s*SPDX/],
    open: "{",
    close: "}",
  },
  python: {
    start: [/^\s*import\s+[\w.]/, /^\s*from\s+\S+\s+import\b/],
    open: "(",
    close: ")",
  },
};

const count = (s: string, ch: string) => s.split(ch).length - 1;

/**
 * A hunk can open mid-statement inside a multiline import (`  useMemo,` …
 * `} from "react";`) with the `import {` opener outside the hunk. Detect
 * that head: bare specifier lines leading to a `} from "…"` closer.
 */
function continuationHead(texts: string[], lang: Lang): number {
  if (lang === "python") {
    for (let i = 0; i < Math.min(texts.length, 12); i++) {
      const t = texts[i]!;
      if (/^\s*\)\s*$/.test(t)) return i + 1;
      if (!/^\s*[\w.]+\s*,?\s*$/.test(t)) return 0;
    }
    return 0;
  }
  const closer =
    lang === "rust" ? /^\s*\};\s*$/ : /^\s*\}\s*from\s+["'][^"']+["'];?\s*$/;
  const specifier =
    lang === "rust" ? /^\s*[\w:{}*]+\s*,?\s*$/ : /^\s*(type\s+)?[\w$]+(\s+as\s+[\w$]+)?\s*,?\s*$/;
  for (let i = 0; i < Math.min(texts.length, 12); i++) {
    const t = texts[i]!;
    if (closer.test(t)) return i + 1;
    if (!specifier.test(t) && t.trim() !== "") return 0;
  }
  return 0;
}

/** Marks each line as import-statement text (multiline statements included). */
function importMask(texts: string[], lang: Lang): boolean[] {
  const syn = IMPORTS[lang];
  const mask: boolean[] = [];
  let depth = 0;
  const head = continuationHead(texts, lang);
  for (const [i, text] of texts.entries()) {
    if (i < head) {
      mask.push(true);
      continue;
    }
    if (depth > 0) {
      mask.push(true);
      depth += count(text, syn.open) - count(text, syn.close);
      if (depth < 0) depth = 0;
      continue;
    }
    if (syn.start.some((re) => re.test(text))) {
      mask.push(true);
      depth = count(text, syn.open) - count(text, syn.close);
      if (depth < 0) depth = 0;
    } else {
      mask.push(false);
    }
  }
  return mask;
}

/** A 1-line fold saves nothing; 2 import lines still collapse for uniformity. */
const MIN_IMPORT_LINES = 2;
const MIN_FOLD_LINES = 3;

/** Maximal runs of foldable lines (glue lines joined in, trimmed at the edges). */
function runsFromMask(
  lines: DiffLine[],
  foldable: boolean[],
  minCount: number,
  label: string,
  glue?: (text: string) => boolean,
): FoldRun[] {
  const glues = (i: number) => {
    const text = lines[i]!.text;
    return text.trim() === "" || (glue?.(text) ?? false);
  };
  const runs: FoldRun[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!foldable[i]) {
      i++;
      continue;
    }
    let end = i;
    let matched = 0;
    for (let j = i; j < lines.length; j++) {
      if (foldable[j]) {
        matched++;
        end = j + 1;
      } else if (glues(j)) {
        continue; // glue lines join runs; trailing ones fall outside [i, end)
      } else {
        break;
      }
    }
    if (matched >= minCount) {
      let adds = 0;
      let dels = 0;
      for (let j = i; j < end; j++) {
        if (lines[j]!.kind === "add") adds++;
        else if (lines[j]!.kind === "del") dels++;
      }
      runs.push({ start: i, end, adds, dels, label });
    }
    i = end;
  }
  return runs;
}

/**
 * Import runs in a hunk, ready to collapse into a strip. Interior comment
 * lines (`// external` group headers) glue like blanks do.
 */
export function importFolds(lines: DiffLine[], lang: Lang): FoldRun[] {
  const mask = importMask(lines.map((l) => l.text), lang);
  const comment = COMMENT[lang];
  return runsFromMask(lines, mask, MIN_IMPORT_LINES, "import lines", (t) =>
    comment.test(t),
  );
}

// ---------------------------------------------------------------------------
// Test-file folding: structure and comments stay, bodies fold.
// ---------------------------------------------------------------------------

const STRUCTURE: Record<Lang, RegExp[]> = {
  ts: [
    /^\s*(describe|it|test|suite)[.(]/,
    /^\s*(export\s+)?(default\s+)?(async\s+)?function\b/,
    /^\s*(export\s+)?(abstract\s+)?class\b/,
  ],
  rust: [
    /^\s*#\[/,
    /^\s*(pub(\([^)]*\))?\s+)?(async\s+)?(unsafe\s+)?fn\s+/,
    /^\s*(pub(\([^)]*\))?\s+)?mod\s+/,
    /^\s*impl\b/,
    /^\s*(pub(\([^)]*\))?\s+)?(struct|enum|trait)\b/,
  ],
  solidity: [
    /^\s*function\s+/,
    /^\s*(abstract\s+)?contract\b/,
    /^\s*(constructor|modifier|receive|fallback)\b/,
  ],
  python: [/^\s*(async\s+)?def\s+/, /^\s*class\s+/, /^\s*@\w/],
};

export const COMMENT: Record<Lang, RegExp> = {
  ts: /^\s*(\/\/|\/\*|\*)/,
  rust: /^\s*(\/\/|\/\*|\*)/,
  solidity: /^\s*(\/\/|\/\*|\*)/,
  python: /^\s*#/,
};

/**
 * Everything that isn't a structure line (test/function/class header), a
 * comment, or an import folds. Bodies collapse to their +/− counts so a test
 * file reads as its list of names.
 */
export function testFolds(lines: DiffLine[], lang: Lang): FoldRun[] {
  const structure = STRUCTURE[lang];
  const comment = COMMENT[lang];
  const foldable = lines.map(
    (l) =>
      l.text.trim() !== "" &&
      !structure.some((re) => re.test(l.text)) &&
      !comment.test(l.text),
  );
  return runsFromMask(lines, foldable, MIN_FOLD_LINES, "lines");
}
