import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { before as beforeAll, describe, test } from "node:test";
import { expect } from "expect";
import { config } from "./config.ts";
import { closeDb, createComment, listComments, openDb } from "./db.ts";
import { git, makeRepo, tmpdir, write } from "./testutil.ts";

// The gh binary is resolved at module load; point it at the stub before the
// module under test is evaluated (hence the dynamic import).
const STUB_DIR = tmpdir("gh-stub");
const STUB = join(STUB_DIR, "gh");
writeFileSync(
  STUB,
  `#!/usr/bin/env bash
d="$GH_STUB_DIR"
echo "$@" >> "$d/calls.log"
if [ -n "$GH_STUB_FAIL" ]; then echo "stub boom" >&2; exit 1; fi
case "$1" in
  --version) echo "gh version 2.0.0 (stub)";;
  pr) cat "$d/prlist.json";;
  api)
    if [ "$2" = "graphql" ]; then cat "$d/graphql.json"
    else cat "$d/mutation.json"
    fi;;
esac
`,
);
chmodSync(STUB, 0o755);
process.env.REV_GH_BIN = STUB;
process.env.GH_STUB_DIR = STUB_DIR;

const {
  anchorFromHunk,
  forwardAgentReply,
  githubConvos,
  githubReply,
  githubResolve,
  invalidateGithub,
} = await import("./github.ts");

const PR = {
  number: 7,
  title: "stub pr",
  url: "https://github.com/acme/widget/pull/7",
  isDraft: false,
  headRefOid: "abc123",
  baseRefName: "main",
};

function stubPr(pr: object[] = [PR]): void {
  writeFileSync(join(STUB_DIR, "prlist.json"), JSON.stringify(pr));
}

function stubGraphql(opts: { isResolved?: boolean } = {}): void {
  const gql = {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: "PRRT_1",
                isResolved: opts.isResolved ?? false,
                isOutdated: false,
                path: "src/app.ts",
                line: 2,
                originalLine: 2,
                diffSide: "RIGHT",
                comments: {
                  nodes: [
                    {
                      databaseId: 101,
                      author: { login: "octo" },
                      body: "root body",
                      createdAt: "2026-08-20T10:00:00Z",
                      url: "https://github.com/acme/widget/pull/7#discussion_r101",
                      diffHunk: "@@ -1,3 +1,3 @@\n line1\n-old2\n+line2",
                    },
                    {
                      databaseId: 102,
                      author: { login: "naps62" },
                      body: "reply body",
                      createdAt: "2026-08-20T11:00:00Z",
                      url: "https://github.com/acme/widget/pull/7#discussion_r102",
                      diffHunk: "",
                    },
                  ],
                },
              },
            ],
          },
          comments: {
            nodes: [
              {
                databaseId: 201,
                author: { login: "octo" },
                body: "conversation body",
                createdAt: "2026-08-20T12:00:00Z",
                url: "https://github.com/acme/widget/pull/7#issuecomment-201",
              },
            ],
          },
        },
      },
    },
  };
  writeFileSync(join(STUB_DIR, "graphql.json"), JSON.stringify(gql));
}

function makeGithubRepo(prefix: string): string {
  const dir = makeRepo(prefix, { "src/app.ts": "line1\nline2\nline3\n" });
  git(dir, "remote", "add", "origin", "git@github.com:acme/widget.git");
  git(dir, "checkout", "-b", "feat");
  return dir;
}

function calls(): string {
  try {
    return readFileSync(join(STUB_DIR, "calls.log"), "utf8");
  } catch {
    return "";
  }
}

beforeAll(() => {
  closeDb();
  openDb(":memory:");
  stubPr();
  stubGraphql();
  writeFileSync(join(STUB_DIR, "mutation.json"), JSON.stringify({ id: 555 }));
});

describe("anchorFromHunk", () => {
  test("new side: last +/context line is the snippet, prior ones the context", () => {
    const a = anchorFromHunk(
      "f.ts",
      "new",
      5,
      "@@ -1,4 +1,4 @@\n one\n-gone\n+two\n three\n+four",
    );
    expect(a.snippet).toBe("four");
    expect(a.context).toEqual({ before: ["one", "two", "three"], after: [] });
    expect(a.line).toBe(5);
  });

  test("old side keeps -/context lines only", () => {
    const a = anchorFromHunk(
      "f.ts",
      "old",
      2,
      "@@ -1,3 +1,2 @@\n one\n+added\n-gone",
    );
    expect(a.snippet).toBe("gone");
    expect(a.context).toEqual({ before: ["one"], after: [] });
  });

  test("empty hunk yields an empty snippet", () => {
    expect(anchorFromHunk("f.ts", "new", 3, "").snippet).toBe("");
  });
});

describe("githubConvos", () => {
  test("full sync: pr, anchored thread, discussion", async () => {
    const dir = makeGithubRepo("gh-full");
    const res = await githubConvos(dir);
    expect(res.available).toBe(true);
    expect(res.pr).toEqual(PR);
    expect(res.threads).toHaveLength(1);
    const t = res.threads[0]!;
    expect(t.id).toBe("PRRT_1");
    expect(t.anchor).toEqual({
      file: "src/app.ts",
      side: "new",
      line: 2,
      snippet: "line2",
      context: { before: ["line1"], after: [] },
    });
    expect(t.resolvedLine).toBe(2);
    expect(t.comments.map((c) => c.id)).toEqual([101, 102]);
    expect(t.comments[0]!.login).toBe("octo");
    expect(res.discussion).toEqual([
      {
        id: 201,
        login: "octo",
        body: "conversation body",
        createdAt: Date.parse("2026-08-20T12:00:00Z"),
        url: "https://github.com/acme/widget/pull/7#issuecomment-201",
      },
    ]);
    expect(res.truncated).toBe(false);
  });

  test("re-anchors against the local working tree", async () => {
    const dir = makeGithubRepo("gh-drift");
    write(dir, "src/app.ts", "inserted\nline1\nline2\nline3\n");
    const res = await githubConvos(dir, true);
    expect(res.threads[0]!.resolvedLine).toBe(3);
  });

  test("cache: served without a gh call until refreshed or invalidated", async () => {
    const dir = makeGithubRepo("gh-cache");
    await githubConvos(dir);
    const before = calls().length;
    await githubConvos(dir);
    expect(calls().length).toBe(before);
    invalidateGithub(dir);
    await githubConvos(dir);
    expect(calls().length).toBeGreaterThan(before);
  });

  test("no open PR → available:false, no-pr", async () => {
    stubPr([]);
    const dir = makeGithubRepo("gh-nopr");
    const res = await githubConvos(dir);
    expect(res).toMatchObject({
      available: false,
      reason: "no-pr",
      pr: null,
      threads: [],
    });
    stubPr();
  });

  test("non-github remote → not-github, and gh is never called", async () => {
    const dir = makeRepo("gh-gitea");
    git(dir, "remote", "add", "origin", "https://git.naps.pt/yolo/rev.git");
    const before = calls().length;
    const res = await githubConvos(dir);
    expect(res).toMatchObject({ available: false, reason: "not-github" });
    expect(calls().length).toBe(before);
  });

  test("gh failure → gh-failed", async () => {
    const dir = makeGithubRepo("gh-fail");
    process.env.GH_STUB_FAIL = "1";
    const res = await githubConvos(dir);
    delete process.env.GH_STUB_FAIL;
    expect(res).toMatchObject({ available: false, reason: "gh-failed" });
  });
});

describe("mutations", () => {
  test("reply targets the thread's replies endpoint and busts the cache", async () => {
    const dir = makeGithubRepo("gh-reply");
    await githubConvos(dir);
    const before = calls().length;
    await githubReply(dir, 101, "sounds right");
    expect(calls().slice(before)).toContain(
      "api repos/acme/widget/pulls/7/comments/101/replies -f body=sounds right",
    );
    // cache busted: the next read hits gh again
    const afterMutation = calls().length;
    await githubConvos(dir);
    expect(calls().length).toBeGreaterThan(afterMutation);
  });

  test("reply without rootId posts a conversation comment", async () => {
    const dir = makeGithubRepo("gh-reply-conv");
    await githubConvos(dir);
    const before = calls().length;
    await githubReply(dir, undefined, "top level");
    expect(calls().slice(before)).toContain(
      "api repos/acme/widget/issues/7/comments -f body=top level",
    );
  });

  test("resolve goes through graphql with the thread node id", async () => {
    const dir = makeGithubRepo("gh-resolve");
    await githubConvos(dir);
    const before = calls().length;
    await githubResolve(dir, "PRRT_1", true);
    const logged = calls().slice(before);
    expect(logged).toContain("resolveReviewThread");
    expect(logged).toContain("id=PRRT_1");
  });
});

describe("agent mirroring (REV_GITHUB_TO_AGENT)", () => {
  test("sync mirrors threads once, syncs resolution, forwards agent replies", async () => {
    config.githubToAgent = true;
    const dir = makeGithubRepo("gh-mirror");
    try {
      await githubConvos(dir, true);
      const delivered = listComments(dir, undefined, undefined, true);
      expect(delivered.comments).toHaveLength(3);
      const root = delivered.comments.find(
        (c) => c.parentId === null && c.anchor !== null,
      )!;
      expect(root.author).toBe("reviewer");
      expect(root.body).toBe("**@octo** (GitHub PR #7):\n\nroot body");
      expect(root.anchor!.snippet).toBe("line2");
      expect(root.status).toBe("submitted");
      const reply = delivered.comments.find((c) => c.parentId === root.id)!;
      expect(reply.body).toContain("reply body");
      // hidden from the UI axis — the review page renders them live from /api/github
      expect(listComments(dir).comments).toHaveLength(0);

      // second sync: dedup, nothing re-delivered
      await githubConvos(dir, true);
      expect(
        listComments(dir, undefined, undefined, true).comments,
      ).toHaveLength(3);

      // resolution flows into the mirrored root
      stubGraphql({ isResolved: true });
      await githubConvos(dir, true);
      const resolvedRoot = listComments(
        dir,
        undefined,
        undefined,
        true,
      ).comments.find((c) => c.id === root.id)!;
      expect(resolvedRoot.resolvedAt).not.toBeNull();
      stubGraphql();

      // agent reply on the mirrored thread forwards to GitHub and is stamped
      const agentReply = createComment({
        dir,
        base: "main",
        parentId: root.id,
        author: "agent",
        body: "fixed in abc",
      });
      const before = calls().length;
      await forwardAgentReply(dir, agentReply.id, "rc:101", agentReply.body);
      expect(calls().slice(before)).toContain(
        "api repos/acme/widget/pulls/7/comments/101/replies -f body=fixed in abc",
      );
      // stamped (github_id set) → excluded from the UI axis, and a future
      // sync of the same comment id would dedup against it
      expect(listComments(dir).comments).toHaveLength(0);
      await githubConvos(dir, true);
      expect(
        listComments(dir, undefined, undefined, true).comments.filter(
          (c) => c.id === agentReply.id,
        ),
      ).toHaveLength(1);
    } finally {
      config.githubToAgent = false;
    }
  });

  test("threads already resolved at first sync are never mirrored; unresolve mirrors them", async () => {
    config.githubToAgent = true;
    const dir = makeGithubRepo("gh-mirror-resolved");
    try {
      stubGraphql({ isResolved: true });
      await githubConvos(dir, true);
      // only the conversation comment lands — root and reply are skipped
      const first = listComments(dir, undefined, undefined, true).comments;
      expect(first).toHaveLength(1);
      expect(first[0]!.anchor).toBeNull();

      stubGraphql({ isResolved: false });
      await githubConvos(dir, true);
      expect(
        listComments(dir, undefined, undefined, true).comments,
      ).toHaveLength(3);
    } finally {
      stubGraphql();
      config.githubToAgent = false;
    }
  });
});
