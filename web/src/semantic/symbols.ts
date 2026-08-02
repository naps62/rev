/**
 * Symbol occurrence search for the semantic view sidebar. Text-level only:
 * word-boundary, case-sensitive matching over loaded hunks — no definition/
 * reference distinction, no cross-case linking (see issue #28 for the real
 * thing).
 */

import type { DiffHunk, LineKind } from "#shared/types";
import type { Lang } from "./fold.ts";

const WORD = /[A-Za-z0-9_$]/;

const GLOBAL_STOP = new Set(
  (
    "true false null undefined new return if else for while do break continue " +
    "in of is not and or as from import export default const let var function " +
    "class interface type enum void any unknown never string number boolean " +
    "object async await try catch finally throw switch case public private " +
    "protected static readonly extends implements typeof instanceof keyof " +
    "delete yield this self super"
  ).split(" "),
);

const LANG_STOP: Record<Lang, Set<string>> = {
  ts: new Set("describe it test expect require module exports".split(" ")),
  rust: new Set(
    (
      "fn pub use mod impl struct trait where match loop mut ref crate dyn " +
      "Some None Ok Err Box Vec String str u8 u16 u32 u64 u128 i8 i16 i32 " +
      "i64 i128 f32 f64 usize isize bool unsafe move assert_eq assert_ne assert"
    ).split(" "),
  ),
  solidity: new Set(
    (
      "pragma solidity contract mapping address uint uint256 int256 bytes " +
      "bytes32 memory storage calldata require revert emit event modifier " +
      "payable view pure external internal override virtual returns constructor"
    ).split(" "),
  ),
  python: new Set(
    (
      "def elif lambda pass raise with global nonlocal assert except print " +
      "True False None len dict list str int float set tuple range isinstance"
    ).split(" "),
  ),
};

/** Whether a token is worth treating as a symbol (letters, not a keyword). */
export function isSymbol(token: string, lang: Lang | null): boolean {
  if (token.length < 2) return false;
  if (!/[A-Za-z]/.test(token)) return false;
  if (GLOBAL_STOP.has(token)) return false;
  if (lang && LANG_STOP[lang].has(token)) return false;
  return true;
}

/** The identifier-shaped token at (or just before) a character offset. */
export function tokenAt(text: string, offset: number): string | null {
  let i = offset;
  if (i >= text.length || !WORD.test(text[i]!)) i = offset - 1;
  if (i < 0 || i >= text.length || !WORD.test(text[i]!)) return null;
  let start = i;
  while (start > 0 && WORD.test(text[start - 1]!)) start--;
  let end = i + 1;
  while (end < text.length && WORD.test(text[end]!)) end++;
  return text.slice(start, end);
}

export interface Occurrence {
  path: string;
  side: "old" | "new";
  line: number;
  kind: LineKind;
  text: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * All word-boundary matches of `symbol` across the given files' hunks —
 * adds, dels and context alike (context is where "where is it used?" often
 * answers itself).
 */
export function findOccurrences(
  symbol: string,
  files: Array<{ path: string; hunks: DiffHunk[] }>,
): Occurrence[] {
  const re = new RegExp(
    `(?:^|[^A-Za-z0-9_$])${escapeRe(symbol)}(?:$|[^A-Za-z0-9_$])`,
  );
  const out: Occurrence[] = [];
  for (const f of files) {
    for (const h of f.hunks) {
      for (const l of h.lines) {
        if (!re.test(l.text)) continue;
        const side: "old" | "new" = l.newLine != null ? "new" : "old";
        out.push({
          path: f.path,
          side,
          line: (side === "new" ? l.newLine : l.oldLine)!,
          kind: l.kind,
          text: l.text,
        });
      }
    }
  }
  return out;
}
