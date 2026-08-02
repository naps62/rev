import { describe, test } from "node:test";
import { expect } from "expect";
import type { DiffLine, LineKind } from "#shared/types";
import { buildSegments, innermostAt, seenRuns, segmentHash } from "./segments.ts";

const line = (text: string, kind: LineKind = "context"): DiffLine => ({ kind, text });
const lines = (...texts: string[]): DiffLine[] => texts.map((t) => line(t));

describe("buildSegments — brace languages", () => {
  test("nested blocks with parent links, hunk root on top", () => {
    const ls = lines(
      "function f() {", // 0
      "  if (x) {", // 1
      "    a();", // 2
      "    b();", // 3
      "  }", // 4
      "}", // 5
    );
    const segs = buildSegments(ls, "ts");
    // the whole-hunk block deduplicates into the hunk root (same rows, same hash)
    expect(segs.map((s) => [s.kind, s.start, s.end])).toEqual([
      ["hunk", 0, 6],
      ["block", 1, 5],
    ]);
    expect(segs[1]!.parent).toBe(0);
  });

  test("block still open at hunk end clamps to it", () => {
    const segs = buildSegments(
      lines("use x;", "impl Foo {", "  fn a() {}", "  fn b() {}"),
      "rust",
    );
    expect(segs.map((s) => [s.kind, s.start, s.end])).toEqual([
      ["hunk", 0, 4],
      ["block", 1, 4],
    ]);
  });

  test("same-line braces and tiny blocks are not segments", () => {
    const segs = buildSegments(lines("const x = { a: 1 };", "y();", "z();"), "ts");
    expect(segs.map((s) => s.kind)).toEqual(["hunk"]);
  });

  test("brace blocks work without a known language", () => {
    const segs = buildSegments(
      lines("package main", "func main() {", "\ta()", "\tb()", "}"),
      null,
    );
    expect(segs.map((s) => [s.kind, s.start, s.end])).toEqual([
      ["hunk", 0, 5],
      ["block", 1, 5],
    ]);
  });
});

describe("buildSegments — comments", () => {
  test("comment runs of 2+ lines are segments nested in their block", () => {
    const ls = lines(
      "import x;", // 0
      "function f() {", // 1
      "  // does the thing", // 2
      "  // carefully", // 3
      "  go();", // 4
      "  stop();", // 5
      "}", // 6
    );
    const segs = buildSegments(ls, "ts");
    const comment = segs.find((s) => s.kind === "comment")!;
    expect([comment.start, comment.end]).toEqual([2, 4]);
    expect(segs[comment.parent!]!.kind).toBe("block");
  });

  test("single comment line is not a segment", () => {
    const segs = buildSegments(lines("// lone", "a();", "b();"), "ts");
    expect(segs.map((s) => s.kind)).toEqual(["hunk"]);
  });
});

describe("buildSegments — python", () => {
  test("indent blocks from ':' headers, blanks glue", () => {
    const ls = lines(
      "def f():", // 0
      "    if x:", // 1
      "        a()", // 2
      "", // 3
      "        b()", // 4
      "    c()", // 5
    );
    const segs = buildSegments(ls, "python");
    expect(segs.map((s) => [s.kind, s.start, s.end])).toEqual([
      ["hunk", 0, 6],
      ["block", 1, 5],
    ]);
  });
});

describe("segment identity", () => {
  test("hash covers kind and text — any edit changes it", () => {
    const a = lines("if (x) {", "  a();", "}");
    expect(segmentHash(a, 0, 3)).toBe(segmentHash(a, 0, 3));
    const edited = lines("if (x) {", "  a2();", "}");
    expect(segmentHash(edited, 0, 3)).not.toBe(segmentHash(a, 0, 3));
    const kindFlip = [line("if (x) {"), line("  a();", "add"), line("}")];
    expect(segmentHash(kindFlip, 0, 3)).not.toBe(segmentHash(a, 0, 3));
  });

  test("adds/dels counted per segment", () => {
    const ls = [
      line("start();"),
      line("if (x) {"),
      line("  a();", "add"),
      line("  b();", "del"),
      line("}"),
    ];
    const block = buildSegments(ls, "ts").find((s) => s.kind === "block")!;
    expect(block.adds).toBe(1);
    expect(block.dels).toBe(1);
  });
});

describe("innermostAt / seenRuns", () => {
  const ls = lines(
    "import x;", // 0
    "function f() {", // 1
    "  if (y) {", // 2
    "    a();", // 3
    "  }", // 4
    "  b();", // 5
    "}", // 6
  );
  const segs = buildSegments(ls, "ts");

  test("innermostAt picks the deepest containing segment", () => {
    expect(segs[innermostAt(segs, 3)!]!.start).toBe(2);
    expect(segs[innermostAt(segs, 5)!]!.start).toBe(1);
    expect(segs[innermostAt(segs, 5)!]!.kind).toBe("block");
    expect(segs[innermostAt(segs, 0)!]!.kind).toBe("hunk");
  });

  test("seenRuns keeps only outermost seen segments", () => {
    const inner = segs.find((s) => s.start === 2)!;
    const outer = segs.find((s) => s.kind === "block" && s.start === 1)!;
    const seen = new Set([inner.hash, outer.hash]);
    const runs = seenRuns(segs, (h) => seen.has(h));
    expect(runs).toEqual([outer]);
    expect(seenRuns(segs, (h) => h === inner.hash)).toEqual([inner]);
  });
});
