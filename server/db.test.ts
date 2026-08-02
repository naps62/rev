import { beforeEach, describe, test } from "node:test";
import { expect } from "expect";
import { join } from "node:path";
import type { CommentAnchor } from "#shared/types";
import {
  closeDb,
  createComment,
  DbError,
  listComments,
  openCommentCounts,
  openDb,
  patchComment,
  seenHashes,
  seenSegmentHashes,
  seenSegmentLineTotals,
  setSeen,
  setSeenSegments,
} from "./db.ts";
import { tmpdir } from "./testutil.ts";

const anchor: CommentAnchor = { file: "src/a.ts", side: "new", line: 12, snippet: "const x = 1;" };

beforeEach(() => {
  closeDb();
  openDb(join(tmpdir("db"), "rev.db"));
});

describe("comments", () => {
  test("create assigns id, monotonic seq, createdAt", () => {
    const c1 = createComment({ dir: "/r/a", base: "main", author: "user", body: "first", anchor });
    const c2 = createComment({ dir: "/r/a", base: "main", author: "agent", body: "second" });
    expect(c1.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(c2.seq).toBe(c1.seq + 1);
    expect(c1.createdAt).toBeGreaterThan(0);
    expect(c1.anchor).toEqual(anchor);
    expect(c2.anchor).toBeNull();
    expect(c1.parentId).toBeNull();
    expect(c1.resolvedAt).toBeNull();
  });

  test("reply references root, drops anchor; reply-to-reply flattens to root", () => {
    const root = createComment({ dir: "/r/a", base: "main", author: "user", body: "root", anchor });
    const reply = createComment({
      dir: "/r/a",
      base: "main",
      author: "agent",
      body: "re",
      parentId: root.id,
      anchor, // must be ignored
    });
    expect(reply.parentId).toBe(root.id);
    expect(reply.anchor).toBeNull();
    const nested = createComment({ dir: "/r/a", base: "main", author: "user", body: "re-re", parentId: reply.id });
    expect(nested.parentId).toBe(root.id);
  });

  test("reply to unknown parent throws DbError", () => {
    expect(() =>
      createComment({ dir: "/r/a", base: "main", author: "user", body: "x", parentId: "nope" }),
    ).toThrow(DbError);
  });

  test("list filters by dir, base, since; cursor is dir-wide max", () => {
    const a1 = createComment({ dir: "/r/a", base: "main", author: "user", body: "a1" });
    createComment({ dir: "/r/b", base: "main", author: "user", body: "b1" });
    const a2 = createComment({ dir: "/r/a", base: "dev", author: "user", body: "a2" });
    const all = listComments("/r/a");
    expect(all.comments.map((c) => c.body)).toEqual(["a1", "a2"]);
    expect(all.cursor).toBe(a2.seq);
    const mainOnly = listComments("/r/a", "main");
    expect(mainOnly.comments.map((c) => c.body)).toEqual(["a1"]);
    expect(mainOnly.cursor).toBe(a2.seq); // cursor ignores the base filter
    const since = listComments("/r/a", undefined, a1.seq);
    expect(since.comments.map((c) => c.body)).toEqual(["a2"]);
    expect(listComments("/r/none").comments).toEqual([]);
    expect(listComments("/r/none").cursor).toBe(0);
  });

  test("patch body, resolve/unresolve; resolving a reply resolves the root", () => {
    const root = createComment({ dir: "/r/a", base: "main", author: "user", body: "root" });
    const reply = createComment({ dir: "/r/a", base: "main", author: "agent", body: "re", parentId: root.id });
    const edited = patchComment(root.id, { body: "edited" });
    expect(edited.body).toBe("edited");
    patchComment(reply.id, { resolved: true });
    expect(listComments("/r/a").comments.find((c) => c.id === root.id)!.resolvedAt).toBeGreaterThan(0);
    patchComment(root.id, { resolved: false });
    expect(listComments("/r/a").comments.find((c) => c.id === root.id)!.resolvedAt).toBeNull();
    expect(() => patchComment("missing", { resolved: true })).toThrow(DbError);
  });

  test("openCommentCounts counts unresolved roots only", () => {
    const r1 = createComment({ dir: "/r/a", base: "main", author: "user", body: "1" });
    createComment({ dir: "/r/a", base: "main", author: "agent", body: "re", parentId: r1.id });
    createComment({ dir: "/r/a", base: "dev", author: "user", body: "2" });
    const resolved = createComment({ dir: "/r/b", base: "main", author: "user", body: "3" });
    patchComment(resolved.id, { resolved: true });
    const counts = openCommentCounts();
    expect(counts.get("/r/a")).toBe(2);
    expect(counts.get("/r/b")).toBeUndefined();
  });
});

describe("seen state", () => {
  test("set, overwrite, clear per (dir, base, path)", () => {
    setSeen("/r/a", "main", "x.ts", "hash1", true);
    setSeen("/r/a", "main", "y.ts", "hash2", true);
    setSeen("/r/a", "dev", "x.ts", "hash3", true);
    expect(seenHashes("/r/a", "main")).toEqual(
      new Map([
        ["x.ts", "hash1"],
        ["y.ts", "hash2"],
      ]),
    );
    setSeen("/r/a", "main", "x.ts", "hash9", true); // re-mark at new hash
    expect(seenHashes("/r/a", "main").get("x.ts")).toBe("hash9");
    setSeen("/r/a", "main", "y.ts", "", false);
    expect(seenHashes("/r/a", "main").has("y.ts")).toBe(false);
    expect(seenHashes("/r/a", "dev")).toEqual(new Map([["x.ts", "hash3"]]));
  });
});

describe("seen segments", () => {
  test("mark, re-mark, unmark per (dir, base, path, hash)", () => {
    setSeenSegments("/r/a", "main", "x.ts", [{ hash: "h1", addDelLines: 4 }, { hash: "h2", addDelLines: 2 }], true);
    setSeenSegments("/r/a", "dev", "x.ts", [{ hash: "h3", addDelLines: 1 }], true);
    expect(seenSegmentHashes("/r/a", "main", "x.ts").sort()).toEqual(["h1", "h2"]);
    expect(seenSegmentHashes("/r/a", "dev", "x.ts")).toEqual(["h3"]);
    setSeenSegments("/r/a", "main", "x.ts", [{ hash: "h1", addDelLines: 6 }], true); // re-mark updates lines
    expect(seenSegmentLineTotals("/r/a", "main").get("x.ts")).toBe(8);
    setSeenSegments("/r/a", "main", "x.ts", [{ hash: "h2", addDelLines: 0 }], false);
    expect(seenSegmentHashes("/r/a", "main", "x.ts")).toEqual(["h1"]);
  });

  test("line totals group by path", () => {
    setSeenSegments("/r/b", "main", "x.ts", [{ hash: "a", addDelLines: 3 }], true);
    setSeenSegments("/r/b", "main", "y.ts", [{ hash: "b", addDelLines: 5 }, { hash: "c", addDelLines: 1 }], true);
    expect(seenSegmentLineTotals("/r/b", "main")).toEqual(
      new Map([
        ["x.ts", 3],
        ["y.ts", 6],
      ]),
    );
    expect(seenSegmentLineTotals("/r/none", "main").size).toBe(0);
  });
});

describe("persistence", () => {
  test("data survives reopen at the same path", () => {
    const path = join(tmpdir("db-persist"), "rev.db");
    closeDb();
    openDb(path);
    const c = createComment({ dir: "/r/p", base: "main", author: "user", body: "kept" });
    closeDb();
    openDb(path);
    const { comments, cursor } = listComments("/r/p");
    expect(comments.map((x) => x.id)).toEqual([c.id]);
    expect(cursor).toBe(c.seq);
  });
});
