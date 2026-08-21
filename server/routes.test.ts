import { before as beforeAll, describe, test } from "node:test";
import { expect } from "expect";
import { existsSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Comment,
  CommentListResponse,
  DiffResponse,
  DiffSummaryResponse,
  FileDiffResponse,
  InterdiffResponse,
  PresenceResponse,
  ServerMessage,
} from "#shared/types";
import { DEFAULT_WORKTREE_CMD, DEFAULT_WORKTREE_REMOVE_CMD } from "#shared/commands";
import { config } from "./config.ts";
import { closeDb, openDb } from "./db.ts";
import { hashContent } from "./git.ts";
import { enter as presenceEnter, leave as presenceLeave } from "./presence.ts";
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

describe("github routes", () => {
  test("GET /github validates dir and soft-fails on non-github repos", async () => {
    expect((await app.request("/github")).status).toBe(400);
    expect((await app.request(`/github?dir=${encodeURIComponent("/etc")}`)).status).toBe(400);
    const dir = makeRepo("gh-route");
    const res = await app.request(`/github?dir=${encodeURIComponent(dir)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean; reason?: string };
    expect(body.available).toBe(false);
    expect(["not-github", "gh-missing"]).toContain(body.reason);
  });

  test("POST /github/reply|comment|resolve validate their bodies", async () => {
    expect((await json("POST", "/github/reply", { dir: "x" })).status).toBe(400);
    expect((await json("POST", "/github/reply", { dir: "x", body: "hi", rootId: "nope" })).status).toBe(400);
    expect((await json("POST", "/github/comment", { dir: "x", body: " " })).status).toBe(400);
    expect((await json("POST", "/github/resolve", { dir: "x", threadId: "t" })).status).toBe(400);
    // known repo without a PR: upstream failure surfaces as 502, not a crash
    const dir = makeRepo("gh-route-mut");
    expect((await json("POST", "/github/reply", { dir, body: "hi" })).status).toBe(502);
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

  test("GET /file/raw preserves image bytes from revisions and working tree", async () => {
    const dir = makeRepo("routes-raw");
    const oldImage = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    const newImage = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]);
    writeFileSync(join(dir, "image.png"), oldImage);
    git(dir, "add", "image.png");
    git(dir, "commit", "-m", "add image");
    writeFileSync(join(dir, "image.png"), newImage);
    const q = `dir=${encodeURIComponent(dir)}&path=image.png`;

    const oldRes = await app.request(`/file/raw?${q}&rev=HEAD`);
    expect(oldRes.status).toBe(200);
    expect(oldRes.headers.get("content-type")).toBe("image/png");
    expect(oldRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await oldRes.arrayBuffer())).toEqual(oldImage);

    const newRes = await app.request(`/file/raw?${q}`);
    expect(new Uint8Array(await newRes.arrayBuffer())).toEqual(newImage);

    const escaped = await app.request(`/file/raw?dir=${encodeURIComponent(dir)}&path=..%2Fimage.png`);
    expect(escaped.status).toBe(400);
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

  test("pending: hidden from submitted channel until submit; ack flips picked_up", async () => {
    const dir = makeRepo("routes-pending");
    sent.length = 0;

    const immediate = (await (
      await json("POST", "/comments", { dir, base: "main", author: "user", body: "now" })
    ).json()) as Comment;
    expect(immediate.status).toBe("submitted");
    const draft = (await (
      await json("POST", "/comments", { dir, base: "main", author: "user", body: "later", pending: true })
    ).json()) as Comment;
    expect(draft.status).toBe("pending");
    expect(draft.submittedSeq).toBeNull();

    const chan = `/comments?dir=${encodeURIComponent(dir)}&submitted=1`;
    let res = (await (await app.request(chan)).json()) as CommentListResponse;
    expect(res.comments.map((c) => c.body)).toEqual(["now"]);
    expect(res.cursor).toBe(immediate.submittedSeq);

    sent.length = 0;
    const submit = await json("POST", "/comments/submit", { dir });
    expect(submit.status).toBe(200);
    const { submitted, cursor } = (await submit.json()) as { submitted: number; cursor: number };
    expect(submitted).toBe(1);
    expect(sent.some((m) => m.type === "comments-changed" && m.dir === dir)).toBe(true);

    res = (await (await app.request(chan)).json()) as CommentListResponse;
    expect(res.comments.map((c) => c.body)).toEqual(["now", "later"]);
    expect(res.cursor).toBe(cursor);

    const ack = await json("POST", "/comments/ack", { dir, upTo: cursor });
    expect((await ack.json()) as { acked: number }).toEqual({ acked: 2 });
    res = (await (await app.request(chan)).json()) as CommentListResponse;
    expect(res.comments.map((c) => c.status)).toEqual(["picked_up", "picked_up"]);

    const badPending = await json("POST", "/comments", { dir, base: "main", author: "user", body: "x", pending: "yes" });
    expect(badPending.status).toBe(400);
    const badAck = await json("POST", "/comments/ack", { dir, upTo: "nope" });
    expect(badAck.status).toBe(400);
  });

  test("submitted-channel long-poll resolves on submit, not on pending create", async () => {
    const dir = makeRepo("routes-poll-submitted");
    await json("POST", "/comments", { dir, base: "main", author: "user", body: "draft", pending: true });
    const t0 = Date.now();
    const waiting = app.request(
      `/comments?dir=${encodeURIComponent(dir)}&since=0&wait=1&submitted=1`,
    );
    await new Promise((r) => setTimeout(r, 50));
    await json("POST", "/comments/submit", { dir });
    const res = (await (await waiting).json()) as CommentListResponse;
    expect(res.comments.map((c) => c.body)).toEqual(["draft"]);
    expect(Date.now() - t0).toBeLessThan(5_000);
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
  test("comments: reviewer author accepted", async () => {
    const dir = makeRepo("routes-reviewer");
    const res = await json("POST", "/comments", { dir, base: "main", author: "reviewer", body: "nit" });
    expect(res.status).toBe(201);
  });

  test("rescan broadcasts repos-changed", { timeout: 30_000 }, async () => {
    sent.length = 0;
    const res = await app.request("/repos/rescan", { method: "POST" });
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
    expect(sent).toContainEqual({ type: "repos-changed" });
  });
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

describe("GET /presence", () => {
  test("counts live viewers, keeps a last-seen stamp after they leave", async () => {
    const dir = makeRepo("routes-presence");
    const get = async () => {
      const res = await app.request(`/presence?dir=${encodeURIComponent(dir)}`);
      expect(res.status).toBe(200);
      return (await res.json()) as PresenceResponse;
    };

    expect(await get()).toEqual({ dir, viewers: 0, lastSeen: 0 });

    presenceEnter(dir);
    presenceEnter(dir);
    expect((await get()).viewers).toBe(2);

    presenceLeave(dir);
    expect((await get()).viewers).toBe(1);
    presenceLeave(dir);
    const gone = await get();
    expect(gone.viewers).toBe(0);
    expect(gone.lastSeen).toBeGreaterThan(0); // still "recently reviewed"

    presenceLeave(dir); // extra unwatch must not drive the count negative
    expect((await get()).viewers).toBe(0);

    const bad = await app.request("/presence?dir=/etc");
    expect(bad.status).toBe(400);
  });
});

describe("interdiff", () => {
  test("seen snapshots the file; interdiff returns only the delta since", async () => {
    const dir = makeRepo("routes-interdiff", { "a.txt": "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n" });
    git(dir, "checkout", "-b", "f");
    // first round of changes, reviewed and marked seen
    write(dir, "a.txt", "l1\nCHANGED\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n");
    const q = `dir=${encodeURIComponent(dir)}&base=main`;
    const hash1 = hashContent("l1\nCHANGED\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n");
    await json("PUT", "/seen", { dir, base: "main", path: "a.txt", contentHash: hash1, seen: true });

    // nothing changed since → interdiff exists, zero hunks
    const clean = (await (await app.request(`/diff/interdiff?${q}&path=a.txt`)).json()) as InterdiffResponse;
    expect(clean.sinceHash).toBe(hash1);
    expect(clean.file.hunks).toEqual([]);

    // second round of changes at the END of the file
    write(dir, "a.txt", "l1\nCHANGED\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nAFTER\n");
    const inter = (await (await app.request(`/diff/interdiff?${q}&path=a.txt`)).json()) as InterdiffResponse;
    // the delta shows ONLY round two: one hunk touching AFTER, not CHANGED
    expect(inter.file.hunks).toHaveLength(1);
    const text = inter.file.hunks[0]!.lines.map((l) => `${l.kind}:${l.text}`).join("|");
    expect(text).toContain("add:AFTER");
    expect(text).toContain("del:l10");
    expect(text).not.toContain("add:CHANGED");
    // while the full per-file diff still shows both rounds
    const full = (await (await app.request(`/diff/file?${q}&path=a.txt`)).json()) as FileDiffResponse;
    const fullText = full.file.hunks.flatMap((h) => h.lines).map((l) => `${l.kind}:${l.text}`).join("|");
    expect(fullText).toContain("add:CHANGED");
    expect(fullText).toContain("add:AFTER");

    // un-marking seen drops the snapshot
    await json("PUT", "/seen", { dir, base: "main", path: "a.txt", contentHash: hash1, seen: false });
    const gone = await app.request(`/diff/interdiff?${q}&path=a.txt`);
    expect(gone.status).toBe(404);
  });

  test("hash-mismatched seen stores no snapshot; deleted file diffs to all-del", async () => {
    const dir = makeRepo("routes-interdiff2", { "b.txt": "x1\nx2\n" });
    git(dir, "checkout", "-b", "f");
    write(dir, "b.txt", "x1\nx2\nx3\n");
    const q = `dir=${encodeURIComponent(dir)}&base=main`;

    // stale contentHash (file moved on) → seen recorded but no snapshot
    await json("PUT", "/seen", { dir, base: "main", path: "b.txt", contentHash: "0123456789abcdef", seen: true });
    expect((await app.request(`/diff/interdiff?${q}&path=b.txt`)).status).toBe(404);

    // proper snapshot, then delete the file → interdiff is all deletions
    const h = hashContent("x1\nx2\nx3\n");
    await json("PUT", "/seen", { dir, base: "main", path: "b.txt", contentHash: h, seen: true });
    rmSync(join(dir, "b.txt"));
    const inter = (await (await app.request(`/diff/interdiff?${q}&path=b.txt`)).json()) as InterdiffResponse;
    expect(inter.file.hunks[0]!.lines.every((l) => l.kind === "del")).toBe(true);
    expect(inter.file.contentHash).toBe("");
  });
});

describe("PRs and worktree creation", () => {
  test("GET /prs returns prs:null for a repo with no remote", async () => {
    const dir = makeRepo("prs-noremote");
    const res = await app.request(`/prs?dir=${encodeURIComponent(dir)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dir, prs: null });
  });

  test("GET /prs rejects unknown dirs", async () => {
    const res = await app.request("/prs?dir=/nope");
    expect(res.status).toBe(400);
  });

  test("POST /worktrees validates body and branch name", async () => {
    const dir = makeRepo("wt-validate");
    expect((await json("POST", "/worktrees", { dir })).status).toBe(400);
    expect((await json("POST", "/worktrees", { dir: "/nope", branch: "x" })).status).toBe(400);
    expect((await json("POST", "/worktrees", { dir, branch: "--delete" })).status).toBe(400);
    expect((await json("POST", "/worktrees", { dir, branch: "a..b" })).status).toBe(400);
  });
});

describe("commands", () => {
  test("GET returns the defaults, PUT validates and persists per field", async () => {
    const before = (await (await app.request("/commands")).json()) as {
      worktreeCreate: string;
      worktreeRemove: string;
    };
    expect(typeof before.worktreeCreate).toBe("string");
    expect(typeof before.worktreeRemove).toBe("string");
    expect((await json("PUT", "/commands", { worktreeCreate: "echo no-branch" })).status).toBe(400);
    expect((await json("PUT", "/commands", { worktreeRemove: "echo no-placeholder" })).status).toBe(400);
    expect((await json("PUT", "/commands", {})).status).toBe(400);
    const res = await json("PUT", "/commands", { worktreeCreate: "aoe add {dir} --worktree {branch}" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      worktreeCreate: "aoe add {dir} --worktree {branch}",
      worktreeRemove: before.worktreeRemove,
    });
    const res2 = await json("PUT", "/commands", { worktreeRemove: "aoe remove {branch} --delete-worktree" });
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({
      worktreeCreate: "aoe add {dir} --worktree {branch}",
      worktreeRemove: "aoe remove {branch} --delete-worktree",
    });
  });
});

describe("settings", () => {
  test("GET starts empty, PUT sanitizes and persists", async () => {
    expect(await (await app.request("/settings")).json()).toEqual({});
    expect((await json("PUT", "/settings", null)).status).toBe(400);
    expect((await json("PUT", "/settings", [1])).status).toBe(400);
    const res = await json("PUT", "/settings", {
      features: { grouping: true, symbols: false, junk: "yes" },
      diffMode: "split",
      theme: "sepia",
      extra: 1,
    });
    expect(res.status).toBe(200);
    const clean = { features: { grouping: true, symbols: false }, diffMode: "split" };
    expect(await res.json()).toEqual(clean);
    expect(await (await app.request("/settings")).json()).toEqual(clean);
  });
});

describe("POST /worktrees end-to-end (default command)", () => {
  test("creates a worktree for a branch that only exists on origin", async () => {
    await json("PUT", "/commands", { worktreeCreate: DEFAULT_WORKTREE_CMD });
    const origin = makeRepo("wt-origin");
    git(origin, "checkout", "-b", "feat-x");
    write(origin, "f.txt", "x\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-m", "feat");
    git(origin, "checkout", "main");
    const clone = tmpdir("wt-clone");
    git(SCRATCH, "clone", origin, clone);
    git(clone, "branch", "-r"); // sanity: origin/feat-x exists remotely only

    const res = await json("POST", "/worktrees", { dir: clone, branch: "feat-x" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { dir: string | null; branch: string };
    expect(body.branch).toBe("feat-x");
    expect(body.dir).toBe(join(clone, "worktrees", "feat-x"));
    expect(git(body.dir!, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("feat-x");
    expect(sent.some((m) => m.type === "repos-changed")).toBe(true);
  });
});

describe("DELETE /worktrees", () => {
  const setup = async (name: string) => {
    await json("PUT", "/commands", { worktreeCreate: DEFAULT_WORKTREE_CMD });
    const main = makeRepo(name);
    git(main, "branch", "feat-y");
    const res = await json("POST", "/worktrees", { dir: main, branch: "feat-y" });
    expect(res.status).toBe(201);
    const { dir } = (await res.json()) as { dir: string };
    return { main, dir };
  };

  test("validates dir: missing, unknown, and main checkouts are rejected", async () => {
    const main = makeRepo("wtrm-validate");
    expect((await app.request("/worktrees", { method: "DELETE" })).status).toBe(400);
    expect((await app.request("/worktrees?dir=/nope", { method: "DELETE" })).status).toBe(400);
    const res = await app.request(`/worktrees?dir=${encodeURIComponent(main)}`, { method: "DELETE" });
    expect(res.status).toBe(400);
  });

  test("removes a worktree with the default command", async () => {
    const { dir } = await setup("wtrm-default");
    await json("PUT", "/commands", { worktreeRemove: DEFAULT_WORKTREE_REMOVE_CMD });
    const res = await app.request(`/worktrees?dir=${encodeURIComponent(dir)}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dir });
    expect(existsSync(dir)).toBe(false);
    expect(sent.some((m) => m.type === "repos-changed")).toBe(true);
  });

  test("falls back to git worktree remove when the command leaves the worktree", async () => {
    const { dir } = await setup("wtrm-fallback");
    // A session-closing command that never touches the worktree itself.
    await json("PUT", "/commands", { worktreeRemove: "echo closed {dir}" });
    const res = await app.request(`/worktrees?dir=${encodeURIComponent(dir)}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(existsSync(dir)).toBe(false);
  });

  test("surfaces the command's error when the worktree survives both attempts", async () => {
    const { dir } = await setup("wtrm-dirty");
    writeFileSync(join(dir, "dirty.txt"), "x\n"); // untracked file: git refuses to remove
    await json("PUT", "/commands", { worktreeRemove: "false {dir}" });
    const res = await app.request(`/worktrees?dir=${encodeURIComponent(dir)}`, { method: "DELETE" });
    expect(res.status).toBe(400);
    expect(existsSync(dir)).toBe(true);
  });
});
