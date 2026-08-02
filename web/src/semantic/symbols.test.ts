import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DiffHunk } from "#shared/types";
import { findOccurrences, isSymbol, tokenAt } from "./symbols.ts";

describe("tokenAt", () => {
  const text = "const fooBar = useThing(fooBar, 42);";
  it("expands to the full identifier around the offset", () => {
    assert.equal(tokenAt(text, 8), "fooBar");
    assert.equal(tokenAt(text, 6), "fooBar");
    assert.equal(tokenAt(text, 15), "useThing");
  });
  it("falls back to the char before a boundary and rejects non-words", () => {
    assert.equal(tokenAt(text, 12), "fooBar"); // just past the identifier
    assert.equal(tokenAt("a + b", 2), null);
  });
});

describe("isSymbol", () => {
  it("rejects short, numeric and keyword tokens", () => {
    assert.equal(isSymbol("x", null), false);
    assert.equal(isSymbol("42", null), false);
    assert.equal(isSymbol("return", null), false);
    assert.equal(isSymbol("Vec", "rust"), false);
    assert.equal(isSymbol("mapping", "solidity"), false);
  });
  it("accepts real identifiers", () => {
    assert.equal(isSymbol("computeDiff", "ts"), true);
    assert.equal(isSymbol("merge_base", "rust"), true);
  });
});

const hunk = (lines: DiffHunk["lines"]): DiffHunk => ({
  oldStart: 1,
  oldLines: lines.length,
  newStart: 1,
  newLines: lines.length,
  header: "",
  lines,
});

describe("findOccurrences", () => {
  it("matches word boundaries only, on all line kinds and sides", () => {
    const files = [
      {
        path: "a.ts",
        hunks: [
          hunk([
            { kind: "add" as const, newLine: 1, text: "function compute() {}" },
            { kind: "del" as const, oldLine: 1, text: "const x = compute();" },
            { kind: "context" as const, oldLine: 2, newLine: 2, text: "computeAll();" },
          ]),
        ],
      },
      {
        path: "b.ts",
        hunks: [hunk([{ kind: "context" as const, oldLine: 5, newLine: 5, text: "recompute(compute)" }])],
      },
    ];
    const occ = findOccurrences("compute", files);
    assert.deepEqual(
      occ.map((o) => [o.path, o.side, o.line, o.kind]),
      [
        ["a.ts", "new", 1, "add"],
        ["a.ts", "old", 1, "del"],
        ["b.ts", "new", 5, "context"],
      ],
    );
  });

  it("escapes regex metacharacters in symbols", () => {
    const files = [
      { path: "a.ts", hunks: [hunk([{ kind: "add" as const, newLine: 1, text: "use $state here" }])] },
    ];
    assert.equal(findOccurrences("$state", files).length, 1);
  });
});
