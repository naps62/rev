import assert from "node:assert/strict";
import { test } from "node:test";
import { computeStack } from "./stack.ts";
import { git, makeRepo, write } from "./testutil.ts";

function commit(dir: string, rel: string, content: string, msg: string): void {
  write(dir, rel, content);
  git(dir, "add", "-A");
  git(dir, "commit", "-m", msg);
}

test("plain branch yields a single segment", async () => {
  const dir = makeRepo("stack-plain");
  git(dir, "checkout", "-b", "feat");
  commit(dir, "a.txt", "changed\n", "one");
  commit(dir, "b.txt", "new\n", "two");
  const stack = await computeStack(dir, "main", new Map());
  assert.equal(stack.segments.length, 1);
  assert.deepEqual(
    stack.segments.map((s) => ({ branch: s.branch, commits: s.commits, parent: s.parent })),
    [{ branch: "feat", commits: 2, parent: "main" }],
  );
});

test("chained branches split into ordered segments", async () => {
  const dir = makeRepo("stack-chain");
  git(dir, "checkout", "-b", "feat-a");
  commit(dir, "a.txt", "a1\n", "a1");
  commit(dir, "a2.txt", "a2\n", "a2");
  git(dir, "checkout", "-b", "feat-b");
  commit(dir, "b.txt", "b1\n", "b1");
  git(dir, "checkout", "-b", "feat-c");
  commit(dir, "c.txt", "c1\n", "c1");
  commit(dir, "c2.txt", "c2\n", "c2");
  commit(dir, "c3.txt", "c3\n", "c3");

  const checkouts = new Map([["feat-a", "/elsewhere/feat-a"]]);
  const stack = await computeStack(dir, "main", checkouts);
  assert.deepEqual(
    stack.segments.map((s) => ({
      branch: s.branch,
      commits: s.commits,
      parent: s.parent,
      checkoutDir: s.checkoutDir,
    })),
    [
      { branch: "feat-c", commits: 3, parent: "feat-b", checkoutDir: null },
      { branch: "feat-b", commits: 1, parent: "feat-a", checkoutDir: null },
      { branch: "feat-a", commits: 2, parent: "main", checkoutDir: "/elsewhere/feat-a" },
    ],
  );
});

test("empty range and detached HEAD yield no segments", async () => {
  const dir = makeRepo("stack-empty");
  git(dir, "checkout", "-b", "feat");
  assert.equal((await computeStack(dir, "main", new Map())).segments.length, 0);
  git(dir, "checkout", "--detach", "HEAD");
  assert.equal((await computeStack(dir, "main", new Map())).segments.length, 0);
});

test("a branch tip sharing HEAD's commit does not split the top segment", async () => {
  const dir = makeRepo("stack-shared-tip");
  git(dir, "checkout", "-b", "feat");
  commit(dir, "a.txt", "x\n", "one");
  git(dir, "branch", "feat-alias"); // same tip as feat
  const stack = await computeStack(dir, "main", new Map());
  assert.equal(stack.segments.length, 1);
  assert.equal(stack.segments[0]!.branch, "feat");
});
