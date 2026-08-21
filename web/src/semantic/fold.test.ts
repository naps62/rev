import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DiffLine } from "#shared/types";
import { importFolds, langOf, testFolds } from "./fold.ts";

const ctx = (text: string): DiffLine => ({
  kind: "context",
  oldLine: 1,
  newLine: 1,
  text,
});
const add = (text: string): DiffLine => ({ kind: "add", newLine: 1, text });
const del = (text: string): DiffLine => ({ kind: "del", oldLine: 1, text });

describe("langOf", () => {
  it("maps extensions", () => {
    assert.equal(langOf("a/b.tsx"), "ts");
    assert.equal(langOf("src/lib.rs"), "rust");
    assert.equal(langOf("c/V.sol"), "solidity");
    assert.equal(langOf("x/y.py"), "python");
    assert.equal(langOf("a.go"), null);
  });
});

describe("importFolds", () => {
  it("folds a ts import block, leaving code alone", () => {
    const lines = [
      add(`import { a } from "./a";`),
      add(`import type { B } from "./b";`),
      del(`import { c } from "./c";`),
      ctx(""),
      ctx("export function main() {"),
      add("  return 1;"),
      ctx("}"),
    ];
    const runs = importFolds(lines, "ts");
    assert.equal(runs.length, 1);
    assert.deepEqual(
      {
        start: runs[0]!.start,
        end: runs[0]!.end,
        adds: runs[0]!.adds,
        dels: runs[0]!.dels,
      },
      { start: 0, end: 3, adds: 2, dels: 1 },
    );
  });

  it("carries multiline imports via bracket depth", () => {
    const lines = [
      add("import {"),
      add("  first,"),
      add("  second,"),
      add(`} from "./mod";`),
      ctx("const x = 1;"),
    ];
    const runs = importFolds(lines, "ts");
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.end, 4);
  });

  it("folds 2 import lines but never a single one", () => {
    const two = [
      add(`import { a } from "./a";`),
      add(`import { b } from "./b";`),
      ctx("code"),
    ];
    assert.equal(importFolds(two, "ts").length, 1);
    const one = [add(`import { a } from "./a";`), ctx("code")];
    assert.equal(importFolds(one, "ts").length, 0);
  });

  it("glues interior comment lines into an import run", () => {
    const lines = [
      add(`import { a } from "./a";`),
      add("// internal"),
      add(`import { b } from "./b";`),
      ctx("// this trailing comment stays visible"),
      ctx("const x = 1;"),
    ];
    const runs = importFolds(lines, "ts");
    assert.equal(runs.length, 1);
    assert.deepEqual([runs[0]!.start, runs[0]!.end], [0, 3]);
  });

  it("glues blank lines inside a run but trims trailing ones", () => {
    const lines = [
      add("use std::fs;"),
      add(""),
      add("use std::io;"),
      add("pub use crate::x;"),
      add(""),
      ctx("fn main() {}"),
    ];
    const runs = importFolds(lines, "rust");
    assert.equal(runs.length, 1);
    assert.deepEqual([runs[0]!.start, runs[0]!.end], [0, 4]);
  });

  it("folds a hunk opening mid-multiline-import (continuation head)", () => {
    const lines = [
      ctx("  useMemo,"),
      ctx("  useRef,"),
      add("  type MouseEvent,"),
      ctx(`} from "react";`),
      ctx(`import { cx } from "../util";`),
      ctx("const x = 1;"),
    ];
    const runs = importFolds(lines, "ts");
    assert.equal(runs.length, 1);
    assert.deepEqual([runs[0]!.start, runs[0]!.end], [0, 5]);
  });

  it("does not misread a plain object literal head as a continuation", () => {
    const lines = [
      ctx("  color: red,"),
      add("  size: 12,"),
      ctx("};"),
      ctx("const y = 2;"),
    ];
    assert.equal(importFolds(lines, "ts").length, 0);
  });

  it("handles solidity pragma + imports and python parens", () => {
    const sol = [
      add("// SPDX-License-Identifier: MIT"),
      add("pragma solidity ^0.8.20;"),
      add(`import {Vault} from "./Vault.sol";`),
    ];
    assert.equal(importFolds(sol, "solidity").length, 1);
    const py = [
      add("from typing import ("),
      add("    Any,"),
      add(")"),
      add("import os"),
      ctx("x = 1"),
    ];
    const runs = importFolds(py, "python");
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.end, 4);
  });
});

describe("testFolds", () => {
  it("keeps describe/it headers and comments, folds bodies", () => {
    const lines = [
      ctx(`describe("thing", () => {`),
      ctx(`  it("does x", () => {`),
      add("    const v = setup();"),
      add("    v.run();"),
      add("    expect(v.done).toBe(true);"),
      ctx("  });"),
      ctx("  // edge case follows"),
      ctx(`  it("does y", () => {`),
      add("    expect(y()).toBe(2);"),
      ctx("  });"),
      ctx("});"),
    ];
    // Bodies fold including their closing brackets: [2,6) is the first `it`
    // body + its `});`, [8,11) the second body + both closers.
    const runs = testFolds(lines, "ts");
    assert.equal(runs.length, 2);
    assert.deepEqual([runs[0]!.start, runs[0]!.end], [2, 6]);
    assert.equal(runs[0]!.adds, 3);
    assert.deepEqual([runs[1]!.start, runs[1]!.end], [8, 11]);
  });

  it("keeps rust test attributes and fn headers visible", () => {
    const lines = [
      ctx("#[test]"),
      ctx("fn parses_empty() {"),
      add('    let out = parse("");'),
      add("    assert!(out.is_empty());"),
      add("    assert_eq!(out.len(), 0);"),
      ctx("}"),
    ];
    const runs = testFolds(lines, "rust");
    assert.equal(runs.length, 1);
    assert.deepEqual([runs[0]!.start, runs[0]!.end], [2, 6]);
  });

  it("keeps python defs and decorators", () => {
    const lines = [
      ctx("@pytest.fixture"),
      ctx("def client():"),
      add("    yield make_client()"),
      ctx("def test_login(client):"),
      add("    r = client.post('/login')"),
      add("    assert r.status == 200"),
      add("    assert r.token"),
    ];
    const runs = testFolds(lines, "python");
    assert.equal(runs.length, 1);
    assert.deepEqual([runs[0]!.start, runs[0]!.end], [4, 7]);
  });
});
