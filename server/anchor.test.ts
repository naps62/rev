import { describe, expect, test } from "bun:test";
import type { Comment, CommentAnchor } from "@shared/types";
import { resolveAnchor, resolveComments } from "./anchor";
import { makeRepo, write } from "./testutil";

function anchor(line: number, snippet: string, context?: CommentAnchor["context"]): CommentAnchor {
  return { file: "a.txt", side: "new", line, snippet, context };
}

describe("resolveAnchor", () => {
  const lines = ["const a = 1;", "return x;", "// end", "return x;", "done()"];

  test("exact line still matches", () => {
    expect(resolveAnchor(lines, anchor(2, "return x;"))).toBe(2);
  });

  test("line moved: unique snippet found elsewhere", () => {
    expect(resolveAnchor(lines, anchor(4, "const a = 1;"))).toBe(1);
  });

  test("orphaned when snippet is gone", () => {
    expect(resolveAnchor(lines, anchor(2, "deleted line"))).toBeNull();
  });

  test("ambiguous without context: nearest to original line wins", () => {
    expect(resolveAnchor(lines, anchor(5, "return x;"))).toBe(4);
    expect(resolveAnchor(lines, anchor(1, "return x;"))).toBe(2);
  });

  test("ambiguous with context: neighbors disambiguate over distance", () => {
    // original line 1 is nearest to candidate 2, but context points at candidate 4
    const a = anchor(1, "return x;", { before: ["// end"], after: ["done()"] });
    expect(resolveAnchor(lines, a)).toBe(4);
  });

  test("trimmed comparison survives re-indentation", () => {
    expect(resolveAnchor(["  return x;"], anchor(1, "return x;"))).toBe(1);
  });
});

describe("resolveComments", () => {
  function comment(over: Partial<Comment>): Comment {
    return {
      id: crypto.randomUUID(),
      dir: "",
      base: "main",
      anchor: null,
      parentId: null,
      author: "user",
      body: "b",
      createdAt: 0,
      resolvedAt: null,
      seq: 1,
      ...over,
    };
  }

  test("new-side follows edits, old-side echoes, missing file orphans, replies untouched", async () => {
    const dir = makeRepo("anchor", { "a.txt": "one\ntwo\nthree\n" });
    write(dir, "a.txt", "zero\none\ntwo\nthree\n"); // shift everything down one

    const moved = comment({ anchor: { file: "a.txt", side: "new", line: 2, snippet: "two" } });
    const oldSide = comment({ anchor: { file: "a.txt", side: "old", line: 2, snippet: "two" } });
    const gone = comment({ anchor: { file: "missing.txt", side: "new", line: 1, snippet: "x" } });
    const reply = comment({ parentId: "root-id" });

    await resolveComments(dir, [moved, oldSide, gone, reply]);

    expect(moved.resolvedLine).toBe(3);
    expect(oldSide.resolvedLine).toBe(2);
    expect(gone.resolvedLine).toBeNull();
    expect(reply.resolvedLine).toBeUndefined();
  });
});
