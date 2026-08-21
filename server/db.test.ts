import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, test } from "node:test";
import { expect } from "expect";
import type { CommentAnchor } from "#shared/types";
import {
  ackPickedUp,
  closeDb,
  createComment,
  DbError,
  listComments,
  openCommentCounts,
  openDb,
  patchComment,
  seenHashes,
  setSeen,
  submitPending,
} from "./db.ts";
import { tmpdir } from "./testutil.ts";

const anchor: CommentAnchor = {
  file: "src/a.ts",
  side: "new",
  line: 12,
  snippet: "const x = 1;",
};

beforeEach(() => {
  closeDb();
  openDb(join(tmpdir("db"), "rev.db"));
});

describe("comments", () => {
  test("create assigns id, monotonic seq, createdAt", () => {
    const c1 = createComment({
      dir: "/r/a",
      base: "main",
      author: "user",
      body: "first",
      anchor,
    });
    const c2 = createComment({
      dir: "/r/a",
      base: "main",
      author: "agent",
      body: "second",
    });
    expect(c1.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(c2.seq).toBe(c1.seq + 1);
    expect(c1.createdAt).toBeGreaterThan(0);
    expect(c1.anchor).toEqual(anchor);
    expect(c2.anchor).toBeNull();
    expect(c1.parentId).toBeNull();
    expect(c1.resolvedAt).toBeNull();
  });

  test("reply references root, drops anchor; reply-to-reply flattens to root", () => {
    const root = createComment({
      dir: "/r/a",
      base: "main",
      author: "user",
      body: "root",
      anchor,
    });
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
    const nested = createComment({
      dir: "/r/a",
      base: "main",
      author: "user",
      body: "re-re",
      parentId: reply.id,
    });
    expect(nested.parentId).toBe(root.id);
  });

  test("reply to unknown parent throws DbError", () => {
    expect(() =>
      createComment({
        dir: "/r/a",
        base: "main",
        author: "user",
        body: "x",
        parentId: "nope",
      }),
    ).toThrow(DbError);
  });

  test("list filters by dir, base, since; cursor is dir-wide max", () => {
    const a1 = createComment({
      dir: "/r/a",
      base: "main",
      author: "user",
      body: "a1",
    });
    createComment({ dir: "/r/b", base: "main", author: "user", body: "b1" });
    const a2 = createComment({
      dir: "/r/a",
      base: "dev",
      author: "user",
      body: "a2",
    });
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
    const root = createComment({
      dir: "/r/a",
      base: "main",
      author: "user",
      body: "root",
    });
    const reply = createComment({
      dir: "/r/a",
      base: "main",
      author: "agent",
      body: "re",
      parentId: root.id,
    });
    const edited = patchComment(root.id, { body: "edited" });
    expect(edited.body).toBe("edited");
    patchComment(reply.id, { resolved: true });
    expect(
      listComments("/r/a").comments.find((c) => c.id === root.id)!.resolvedAt,
    ).toBeGreaterThan(0);
    patchComment(root.id, { resolved: false });
    expect(
      listComments("/r/a").comments.find((c) => c.id === root.id)!.resolvedAt,
    ).toBeNull();
    expect(() => patchComment("missing", { resolved: true })).toThrow(DbError);
  });

  test("openCommentCounts counts unresolved roots only", () => {
    const r1 = createComment({
      dir: "/r/a",
      base: "main",
      author: "user",
      body: "1",
    });
    createComment({
      dir: "/r/a",
      base: "main",
      author: "agent",
      body: "re",
      parentId: r1.id,
    });
    createComment({ dir: "/r/a", base: "dev", author: "user", body: "2" });
    const resolved = createComment({
      dir: "/r/b",
      base: "main",
      author: "user",
      body: "3",
    });
    patchComment(resolved.id, { resolved: true });
    const counts = openCommentCounts();
    expect(counts.get("/r/a")).toBe(2);
    expect(counts.get("/r/b")).toBeUndefined();
  });
});

describe("pending / submit / ack", () => {
  test("non-pending create is submitted immediately; pending has no submittedSeq", () => {
    const now = createComment({
      dir: "/r/a",
      base: "main",
      author: "agent",
      body: "now",
    });
    expect(now.status).toBe("submitted");
    expect(now.submittedSeq).not.toBeNull();
    const later = createComment({
      dir: "/r/a",
      base: "main",
      author: "user",
      body: "later",
      pending: true,
    });
    expect(later.status).toBe("pending");
    expect(later.submittedSeq).toBeNull();
  });

  test("submission order can differ from creation order; submitted axis stays monotonic", () => {
    // A created first but pending; B created after, submitted at once. A
    // must land AFTER B on the submitted axis or a watcher past B's cursor
    // would never see it.
    const a = createComment({
      dir: "/r/a",
      base: "main",
      author: "user",
      body: "A",
      pending: true,
    });
    const b = createComment({
      dir: "/r/a",
      base: "main",
      author: "agent",
      body: "B",
    });
    const res = submitPending("/r/a");
    expect(res.submitted).toBe(1);
    const list = listComments("/r/a", undefined, undefined, true);
    expect(list.comments.map((c) => c.body)).toEqual(["B", "A"]);
    const submittedA = list.comments.find((c) => c.id === a.id)!;
    expect(submittedA.status).toBe("submitted");
    expect(submittedA.submittedSeq!).toBeGreaterThan(b.submittedSeq!);
    expect(res.cursor).toBe(submittedA.submittedSeq);
    // a watcher parked at B's cursor picks up A
    const sinceB = listComments("/r/a", undefined, b.submittedSeq!, true);
    expect(sinceB.comments.map((c) => c.id)).toEqual([a.id]);
  });

  test("multiple pending submit in creation order", () => {
    createComment({
      dir: "/r/a",
      base: "main",
      author: "user",
      body: "1",
      pending: true,
    });
    createComment({
      dir: "/r/a",
      base: "main",
      author: "user",
      body: "2",
      pending: true,
    });
    createComment({
      dir: "/r/b",
      base: "main",
      author: "user",
      body: "other-dir",
      pending: true,
    });
    expect(submitPending("/r/a").submitted).toBe(2);
    expect(
      listComments("/r/a", undefined, undefined, true).comments.map(
        (c) => c.body,
      ),
    ).toEqual(["1", "2"]);
    // other dir untouched
    expect(listComments("/r/b").comments[0]!.status).toBe("pending");
    expect(submitPending("/r/a").submitted).toBe(0); // idempotent when nothing pending
  });

  test("submittedOnly list excludes pending; cursor is submitted axis", () => {
    const s = createComment({
      dir: "/r/a",
      base: "main",
      author: "user",
      body: "sent",
    });
    createComment({
      dir: "/r/a",
      base: "main",
      author: "user",
      body: "draft",
      pending: true,
    });
    const res = listComments("/r/a", undefined, undefined, true);
    expect(res.comments.map((c) => c.body)).toEqual(["sent"]);
    expect(res.cursor).toBe(s.submittedSeq);
    // default (UI) list still shows everything on the seq axis
    expect(listComments("/r/a").comments.map((c) => c.body)).toEqual([
      "sent",
      "draft",
    ]);
  });

  test("ackPickedUp marks only submitted ≤ upTo, once", () => {
    const first = createComment({
      dir: "/r/a",
      base: "main",
      author: "user",
      body: "first",
    });
    const second = createComment({
      dir: "/r/a",
      base: "main",
      author: "user",
      body: "second",
    });
    expect(ackPickedUp("/r/a", first.submittedSeq!)).toBe(1);
    const byBody = (body: string) =>
      listComments("/r/a").comments.find((c) => c.body === body)!;
    expect(byBody("first").status).toBe("picked_up");
    expect(byBody("second").status).toBe("submitted");
    expect(ackPickedUp("/r/a", second.submittedSeq!)).toBe(1); // first already acked
    expect(byBody("second").status).toBe("picked_up");
    expect(ackPickedUp("/r/a", second.submittedSeq!)).toBe(0);
  });

  test("pre-pending-schema DB migrates: columns added, submitted_seq backfilled = seq", () => {
    const path = join(tmpdir("db-migrate"), "rev.db");
    closeDb();
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TABLE comments (
        id          TEXT PRIMARY KEY,
        dir         TEXT NOT NULL,
        base        TEXT NOT NULL,
        anchor      TEXT,
        parent_id   TEXT REFERENCES comments(id),
        author      TEXT NOT NULL,
        body        TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        resolved_at INTEGER,
        seq         INTEGER NOT NULL UNIQUE
      );
    `);
    raw
      .prepare(
        "INSERT INTO comments (id, dir, base, anchor, parent_id, author, body, created_at, resolved_at, seq) VALUES ('old', '/r/m', 'main', NULL, NULL, 'user', 'legacy', 1, NULL, 7)",
      )
      .run();
    raw.close();
    openDb(path);
    const { comments, cursor } = listComments(
      "/r/m",
      undefined,
      undefined,
      true,
    );
    expect(comments.map((c) => c.id)).toEqual(["old"]);
    expect(comments[0]!.status).toBe("submitted");
    expect(comments[0]!.submittedSeq).toBe(7); // old watcher cursors (seq values) stay valid
    expect(cursor).toBe(7);
    // new submissions continue past the backfilled axis
    const next = createComment({
      dir: "/r/m",
      base: "main",
      author: "user",
      body: "new",
    });
    expect(next.submittedSeq).toBe(8);
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

describe("persistence", () => {
  test("data survives reopen at the same path", () => {
    const path = join(tmpdir("db-persist"), "rev.db");
    closeDb();
    openDb(path);
    const c = createComment({
      dir: "/r/p",
      base: "main",
      author: "user",
      body: "kept",
    });
    closeDb();
    openDb(path);
    const { comments, cursor } = listComments("/r/p");
    expect(comments.map((x) => x.id)).toEqual([c.id]);
    expect(cursor).toBe(c.seq);
  });
});
