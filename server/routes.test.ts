import { before as beforeAll, describe, test } from "node:test";
import { expect } from "expect";
import { symlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Comment,
  CommentListResponse,
  DiffResponse,
  DiffSummaryResponse,
  FileDiffResponse,
  ServerMessage,
} from "#shared/types";
import { config } from "./config.ts";
import { closeDb, openDb } from "./db.ts";
import { hashContent } from "./git.ts";
import { buildApi, resolveInRepo } from "./routes.ts";
import { git, makeRepo, SCRATCH, tmpdir, write } from "./testutil.ts";

// Fixture repos live in the scratchpad (outside $HOME); make it the only root
// so rescans never touch the user's real repos.
config.roots.length = 0;
config.roots.push(SCRATCH);

const sent: ServerMessage[] = [];
const app = buildApi((msg) => sent.push(msg));

const json = (method: string, path: string, body: unknown) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeAll(() => {
  closeDb();
  openDb(join(tmpdir("routes-db"), "rev.db"));
});

describe("resolveInRepo", () => {
  test("rejects traversal, absolute paths, symlink escapes", () => {
    const dir = makeRepo("safe");
    expect(resolveInRepo(dir, "a.txt")).toBe(join(dir, "a.txt"));
    expect(resolveInRepo(dir, "sub/new-file.txt")).toBe(join(dir, "sub/new-file.txt"));
    expect(resolveInRepo(dir, "../outside.txt")).toBeNull();
    expect(resolveInRepo(dir, "sub/../../outside.txt")).toBeNull();
    expect(resolveInRepo(dir, "/etc/passwd")).toBeNull();
    expect(resolveInRepo(dir, "")).toBeNull();
    symlinkSync("/etc", join(dir, "esc"));
    expect(resolveInRepo(dir, "esc/passwd")).toBeNull();
  });
});

describe("routes", () => {
  test("GET /health", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: "spike" });
  });

  test("unknown dir is rejected everywhere", async () => {
    const res = await app.request(`/diff?dir=${encodeURIComponent("/etc")}&base=main`);
    expect(res.status).toBe(400);
    const res2 = await app.request(`/diff?dir=${encodeURIComponent(tmpdir("notrepo"))}&base=main`);
    expect(res2.status).toBe(400);
  });

  test("GET /diff: bad base → 400, good base → files with seen/stale join", async () => {
    const dir = makeRepo("routes-diff");
    git(dir, "checkout", "-b", "f");
    write(dir, "a.txt", "edited\n");
    const q = `dir=${encodeURIComponent(dir)}&base=main`;

    const bad = await app.request(`/diff?dir=${encodeURIComponent(dir)}&base=nope`);
    expect(bad.status).toBe(400);
    expect(typeof ((await bad.json()) as { error: string }).error).toBe("string");

    const res = await app.request(`/diff?${q}`);
    expect(res.status).toBe(200);
    const diff = (await res.json()) as DiffResponse;
    const file = diff.files.find((f) => f.path === "a.txt")!;
    expect(file.seen).toBe(false);
    expect(file.stale).toBe(false);

    // mark seen at current hash → seen: true
    const seenRes = await json("PUT", "/seen", {
      dir,
      base: "main",
      path: "a.txt",
      contentHash: file.contentHash,
      seen: true,
    });
    expect(await seenRes.json()).toEqual({ ok: true });
    const diff2 = (await (await app.request(`/diff?${q}`)).json()) as DiffResponse;
    expect(diff2.files.find((f) => f.path === "a.txt")!.seen).toBe(true);

    // file changes → stale: true
    write(dir, "a.txt", "edited more\n");
    const diff3 = (await (await app.request(`/diff?${q}`)).json()) as DiffResponse;
    const f3 = diff3.files.find((f) => f.path === "a.txt")!;
    expect(f3.seen).toBe(false);
    expect(f3.stale).toBe(true);
  });

  test("GET/PUT /file: roundtrip, 409 on hash mismatch, traversal 400", async () => {
    const dir = makeRepo("routes-file", { "a.txt": "v1\n" });
    const q = `dir=${encodeURIComponent(dir)}&path=a.txt`;
    const got = await app.request(`/file?${q}`);
    expect(got.status).toBe(200);
    const body = (await got.json()) as { content: string; contentHash: string };
    expect(body.content).toBe("v1\n");

    const conflict = await json("PUT", "/file", { dir, path: "a.txt", content: "v2\n", baseHash: "wrong" });
    expect(conflict.status).toBe(409);

    const ok = await json("PUT", "/file", { dir, path: "a.txt", content: "v2\n", baseHash: body.contentHash });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { contentHash: string }).contentHash).toBe(hashContent("v2\n"));
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("v2\n");

    const esc = await json("PUT", "/file", { dir, path: "../esc.txt", content: "x", baseHash: "" });
    expect(esc.status).toBe(400);
    const escRead = await app.request(`/file?dir=${encodeURIComponent(dir)}&path=..%2Fesc.txt`);
    expect(escRead.status).toBe(400);
  });

  test("comments: create, reply, patch, list, broadcast", async () => {
    const dir = makeRepo("routes-comments");
    sent.length = 0;

    const created = await json("POST", "/comments", {
      dir,
      base: "main",
      author: "user",
      body: "please rename this",
      anchor: { file: "a.txt", side: "new", line: 1, snippet: "one" },
    });
    expect(created.status).toBe(201);
    const root = (await created.json()) as Comment;
    expect(sent).toContainEqual({ type: "comments-changed", dir, seq: root.seq });

    const badAuthor = await json("POST", "/comments", { dir, base: "main", author: "bot", body: "x" });
    expect(badAuthor.status).toBe(400);
    const badParent = await json("POST", "/comments", { dir, base: "main", author: "user", body: "x", parentId: "nope" });
    expect(badParent.status).toBe(400);

    const replied = await json("POST", "/comments", { dir, base: "main", author: "agent", body: "done", parentId: root.id });
    const reply = (await replied.json()) as Comment;
    expect(reply.parentId).toBe(root.id);
    expect(reply.anchor).toBeNull();

    const patched = await json("PATCH", `/comments/${root.id}`, { resolved: true });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as Comment).resolvedAt).toBeGreaterThan(0);
    const missing = await json("PATCH", "/comments/does-not-exist", { resolved: true });
    expect(missing.status).toBe(404);

    const list = await app.request(`/comments?dir=${encodeURIComponent(dir)}`);
    const { comments, cursor } = (await list.json()) as CommentListResponse;
    expect(comments.map((c) => c.id)).toEqual([root.id, reply.id]);
    expect(cursor).toBe(reply.seq);

    const since = await app.request(`/comments?dir=${encodeURIComponent(dir)}&since=${root.seq}`);
    expect(((await since.json()) as CommentListResponse).comments.map((c) => c.id)).toEqual([reply.id]);
  });

  test("long-poll resolves early when a comment lands", async () => {
    const dir = makeRepo("routes-poll");
    const t0 = Date.now();
    const pending = app.request(`/comments?dir=${encodeURIComponent(dir)}&since=0&wait=1`);
    await new Promise((r) => setTimeout(r, 50));
    await json("POST", "/comments", { dir, base: "main", author: "user", body: "wake up" });
    const res = (await (await pending).json()) as CommentListResponse;
    expect(res.comments.map((c) => c.body)).toEqual(["wake up"]);
    expect(Date.now() - t0).toBeLessThan(5_000); // resolved by notify, not the 25s cap
  });

  // Cold-scans every fixture repo accumulated in the scratchpad, so it needs
  // far more than the 5s default under a loaded machine.
  test(
    "rescan broadcasts repos-changed",
    async () => {
      sent.length = 0;
      const res = await app.request("/repos/rescan", { method: "POST" });
      expect(res.status).toBe(200);
      expect(Array.isArray(await res.json())).toBe(true);
      expect(sent).toContainEqual({ type: "repos-changed" });
    },
    30_000,
  );
});

describe("GET /diff/summary and /diff/file", () => {
  test("summary joins seen/stale; per-file serves hunks with seen join", async () => {
    const dir = makeRepo("routes-summary");
    git(dir, "checkout", "-b", "f");
    write(dir, "a.txt", "edited\n");
    write(dir, "new.txt", "n1\n");
    const q = `dir=${encodeURIComponent(dir)}&base=main`;

    const bad = await app.request(`/diff/summary?dir=${encodeURIComponent(dir)}&base=nope`);
    expect(bad.status).toBe(400);

    const res = await app.request(`/diff/summary?${q}`);
    expect(res.status).toBe(200);
    const summary = (await res.json()) as DiffSummaryResponse;
    const a = summary.files.find((f) => f.path === "a.txt")!;
    expect(a.status).toBe("modified");
    expect(a.contentHash).toBe(hashContent("edited\n"));
    expect("hunks" in a).toBe(false);
    expect(summary.files.find((f) => f.path === "new.txt")!.status).toBe("untracked");

    await json("PUT", "/seen", {
      dir,
      base: "main",
      path: "a.txt",
      contentHash: a.contentHash,
      seen: true,
    });
    const summary2 = (await (
      await app.request(`/diff/summary?${q}`)
    ).json()) as DiffSummaryResponse;
    expect(summary2.files.find((f) => f.path === "a.txt")!.seen).toBe(true);

    const fileRes = await app.request(`/diff/file?${q}&path=a.txt`);
    expect(fileRes.status).toBe(200);
    const fd = (await fileRes.json()) as FileDiffResponse;
    expect(fd.file.path).toBe("a.txt");
    expect(fd.file.hunks).toHaveLength(1);
    expect(fd.file.seen).toBe(true);

    const untrackedRes = await app.request(`/diff/file?${q}&path=new.txt`);
    const ufd = (await untrackedRes.json()) as FileDiffResponse;
    expect(ufd.file.status).toBe("untracked");
    expect(ufd.file.hunks[0]!.lines).toEqual([{ kind: "add", newLine: 1, text: "n1" }]);

    const missing = await app.request(`/diff/file?${q}&path=unchanged.txt`);
    expect(missing.status).toBe(404);

    const escape = await app.request(`/diff/file?${q}&path=${encodeURIComponent("../x")}`);
    expect(escape.status).toBe(400);
  });
});

describe("GET /refs", () => {
  test("lists local + remote refs, defaultBase first, excludes origin/HEAD", async () => {
    const dir = makeRepo("routes-refs");
    git(dir, "branch", "feat-x");
    const head = git(dir, "rev-parse", "HEAD").trim();
    git(dir, "update-ref", "refs/remotes/origin/main", head);
    git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");

    const res = await app.request(`/refs?dir=${encodeURIComponent(dir)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dir: string; refs: string[] };
    expect(body.refs[0]).toBe("main"); // defaultBase leads
    expect(body.refs).toContain("feat-x");
    expect(body.refs).toContain("origin/main");
    expect(body.refs).not.toContain("origin/HEAD");
    expect(body.refs).not.toContain("origin");

    const bad = await app.request("/refs?dir=/etc");
    expect(bad.status).toBe(400);
  });
});
