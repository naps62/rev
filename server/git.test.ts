import { describe, expect, test } from "bun:test";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TUNING } from "@shared/tuning";
import {
  changedFileCount,
  computeDiff,
  computeDiffSummary,
  computeFileDiff,
  defaultBase,
  divergence,
  GitError,
  hashContent,
  headInfo,
  isDirty,
  listWorktrees,
  readFile,
  remoteUrl,
  resolveGitDir,
} from "./git";
import { git, makeRepo, tmpdir, write } from "./testutil";

function byPath<T extends { path: string }>(files: T[], path: string): T | undefined {
  return files.find((f) => f.path === path);
}

describe("hashContent", () => {
  test("16 hex chars, stable, bytes == utf8 string", () => {
    const h = hashContent("hello\n");
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(hashContent("hello\n")).toBe(h);
    expect(hashContent(new TextEncoder().encode("hello\n"))).toBe(h);
    expect(hashContent("other")).not.toBe(h);
  });
});

describe("headInfo / isDirty / defaultBase", () => {
  test("on main, clean", async () => {
    const dir = makeRepo("head");
    const hi = await headInfo(dir);
    expect(hi.branch).toBe("main");
    expect(hi.head).toMatch(/^[0-9a-f]{7,}$/);
    expect(await isDirty(dir)).toBe(false);
    expect(await defaultBase(dir)).toBe("main");
  });

  test("detached HEAD → branch null", async () => {
    const dir = makeRepo("detached");
    git(dir, "checkout", "--detach");
    const hi = await headInfo(dir);
    expect(hi.branch).toBeNull();
    expect(hi.head).toMatch(/^[0-9a-f]{7,}$/);
  });

  test("repo with no commits", async () => {
    const dir = tmpdir("unborn");
    git(dir, "init", "-b", "main");
    const hi = await headInfo(dir);
    expect(hi.branch).toBe("main");
    expect(hi.head).toBe("");
    expect(await defaultBase(dir)).toBeNull();
  });

  test("dirty tracked file, untracked ignored by isDirty", async () => {
    const dir = makeRepo("dirty");
    write(dir, "untracked.txt", "x\n");
    expect(await isDirty(dir)).toBe(false);
    write(dir, "a.txt", "changed\n");
    expect(await isDirty(dir)).toBe(true);
  });
});

describe("computeDiff", () => {
  test("bad base ref throws GitError", async () => {
    const dir = makeRepo("badref");
    expect(computeDiff(dir, "no-such-branch")).rejects.toBeInstanceOf(GitError);
  });

  test("committed + uncommitted + untracked changes vs main", async () => {
    const dir = makeRepo("full", {
      "a.txt": "one\ntwo\nthree\n",
      "gone.txt": "bye\n",
    });
    git(dir, "checkout", "-b", "feature");
    // committed change
    write(dir, "a.txt", "one\nTWO\nthree\n");
    rmSync(join(dir, "gone.txt"));
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "feature work");
    // uncommitted edit on top
    write(dir, "a.txt", "one\nTWO\nthree\nfour\n");
    // untracked
    write(dir, "brand/new.txt", "n1\nn2\n");

    const diff = await computeDiff(dir, "main");
    expect(diff.dir).toBe(dir);
    expect(diff.base).toBe("main");
    expect(diff.branch).toBe("feature");
    expect(diff.mergeBase).toMatch(/^[0-9a-f]{40}$/);
    expect(diff.head).toMatch(/^[0-9a-f]{7,}$/);

    const a = byPath(diff.files, "a.txt")!;
    expect(a.status).toBe("modified");
    // uncommitted edit is included: diff is against the working tree
    expect(a.additions).toBe(2); // TWO + four
    expect(a.deletions).toBe(1); // two
    expect(a.hunks).toHaveLength(1);
    const lines = a.hunks[0]!.lines;
    expect(lines).toEqual([
      { kind: "context", oldLine: 1, newLine: 1, text: "one" },
      { kind: "del", oldLine: 2, text: "two" },
      { kind: "add", newLine: 2, text: "TWO" },
      { kind: "context", oldLine: 3, newLine: 3, text: "three" },
      { kind: "add", newLine: 4, text: "four" },
    ]);
    expect(a.contentHash).toBe(hashContent("one\nTWO\nthree\nfour\n"));
    expect(a.seen).toBe(false);
    expect(a.stale).toBe(false);

    const gone = byPath(diff.files, "gone.txt")!;
    expect(gone.status).toBe("deleted");
    expect(gone.contentHash).toBe("");
    expect(gone.deletions).toBe(1);

    const untracked = byPath(diff.files, "brand/new.txt")!;
    expect(untracked.status).toBe("untracked");
    expect(untracked.binary).toBe(false);
    expect(untracked.hunks).toEqual([
      {
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: 2,
        header: "",
        lines: [
          { kind: "add", newLine: 1, text: "n1" },
          { kind: "add", newLine: 2, text: "n2" },
        ],
      },
    ]);
    expect(untracked.additions).toBe(2);
    expect(untracked.contentHash).toBe(hashContent("n1\nn2\n"));
  });

  test("contentHash is stable across recomputes and changes on edit", async () => {
    const dir = makeRepo("stable");
    git(dir, "checkout", "-b", "f");
    write(dir, "a.txt", "edited\n");
    const d1 = await computeDiff(dir, "main");
    const d2 = await computeDiff(dir, "main");
    expect(byPath(d1.files, "a.txt")!.contentHash).toBe(byPath(d2.files, "a.txt")!.contentHash);
    write(dir, "a.txt", "edited again\n");
    const d3 = await computeDiff(dir, "main");
    expect(byPath(d3.files, "a.txt")!.contentHash).not.toBe(byPath(d1.files, "a.txt")!.contentHash);
  });

  test("rename detection", async () => {
    const dir = makeRepo("rename", { "original.txt": "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n" });
    git(dir, "checkout", "-b", "f");
    git(dir, "mv", "original.txt", "renamed.txt");
    git(dir, "commit", "-m", "rename");
    const diff = await computeDiff(dir, "main");
    const f = byPath(diff.files, "renamed.txt")!;
    expect(f.status).toBe("renamed");
    expect(f.oldPath).toBe("original.txt");
    expect(f.hunks).toEqual([]);
    expect(f.contentHash).toBe(hashContent("l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n"));
  });

  test("binary files: tracked change and untracked", async () => {
    const bin = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]);
    const dir = makeRepo("binary", { "a.txt": "x\n" });
    writeFileSync(join(dir, "img.bin"), bin);
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "add binary");
    git(dir, "checkout", "-b", "f");
    const bin2 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0xfd]);
    writeFileSync(join(dir, "img.bin"), bin2);
    writeFileSync(join(dir, "untracked.bin"), bin);

    const diff = await computeDiff(dir, "main");
    const tracked = byPath(diff.files, "img.bin")!;
    expect(tracked.status).toBe("modified");
    expect(tracked.binary).toBe(true);
    expect(tracked.hunks).toEqual([]);
    expect(tracked.contentHash).toBe(hashContent(bin2));

    const untracked = byPath(diff.files, "untracked.bin")!;
    expect(untracked.status).toBe("untracked");
    expect(untracked.binary).toBe(true);
    expect(untracked.hunks).toEqual([]);
    expect(untracked.contentHash).toBe(hashContent(bin));
  });

  test("oversize untracked file listed without hunks or hash", async () => {
    const dir = makeRepo("bigfile");
    write(dir, "big.log", "x".repeat(TUNING.MAX_UNTRACKED_BYTES + 1));
    const diff = await computeDiff(dir, "main");
    const f = byPath(diff.files, "big.log")!;
    expect(f.status).toBe("untracked");
    expect(f.hunks).toEqual([]);
    expect(f.contentHash).toBe("");
  });

  test("untracked file without trailing newline keeps last line", async () => {
    const dir = makeRepo("notrail");
    write(dir, "n.txt", "a\nb");
    const diff = await computeDiff(dir, "main");
    const f = byPath(diff.files, "n.txt")!;
    expect(f.hunks[0]!.lines.map((l) => l.text)).toEqual(["a", "b"]);
    expect(f.additions).toBe(2);
  });

  test("mode-only change → modified with zero hunks", async () => {
    const dir = makeRepo("mode", { "run.sh": "#!/bin/sh\necho hi\n" });
    git(dir, "checkout", "-b", "f");
    chmodSync(join(dir, "run.sh"), 0o755);
    const diff = await computeDiff(dir, "main");
    const f = byPath(diff.files, "run.sh")!;
    expect(f.status).toBe("modified");
    expect(f.hunks).toEqual([]);
    expect(f.contentHash).toBe(hashContent("#!/bin/sh\necho hi\n"));
  });

  test("works from a linked worktree", async () => {
    const dir = makeRepo("wt");
    const wt = join(tmpdir("wt-checkout"), "feature");
    git(dir, "worktree", "add", "-b", "feature", wt);
    write(wt, "a.txt", "worktree edit\n");
    const diff = await computeDiff(wt, "main");
    expect(diff.branch).toBe("feature");
    expect(byPath(diff.files, "a.txt")!.status).toBe("modified");
  });
});

describe("readFile", () => {
  test("working tree, at rev, and 404", async () => {
    const dir = makeRepo("readfile", { "a.txt": "committed\n" });
    write(dir, "a.txt", "working tree\n");
    const wt = await readFile(dir, "a.txt", null);
    expect(wt.content).toBe("working tree\n");
    expect(wt.contentHash).toBe(hashContent("working tree\n"));
    expect(wt.rev).toBeNull();
    const at = await readFile(dir, "a.txt", "main");
    expect(at.content).toBe("committed\n");
    expect(readFile(dir, "missing.txt", null)).rejects.toBeInstanceOf(GitError);
    expect(readFile(dir, "missing.txt", "main")).rejects.toBeInstanceOf(GitError);
  });
});

describe("listWorktrees / resolveGitDir / changedFileCount", () => {
  test("worktree list has main first; gitdir resolves for both kinds", async () => {
    const dir = makeRepo("wtlist");
    const wt = join(tmpdir("wtlist-checkout"), "side");
    git(dir, "worktree", "add", "-b", "side", wt);
    const list = await listWorktrees(wt);
    expect(list[0]).toBe(dir);
    expect(list).toContain(wt);
    expect(resolveGitDir(dir)).toBe(join(dir, ".git"));
    expect(resolveGitDir(wt)).toBe(join(dir, ".git", "worktrees", "side"));
  });

  test("changedFileCount counts tracked + untracked; null on bad base", async () => {
    const dir = makeRepo("count", { "a.txt": "x\n", "b.txt": "y\n" });
    git(dir, "checkout", "-b", "f");
    write(dir, "a.txt", "changed\n");
    write(dir, "new1.txt", "u\n");
    write(dir, "new2.txt", "u\n");
    expect(await changedFileCount(dir, "main")).toBe(3);
    expect(await changedFileCount(dir, "nope")).toBeNull();
  });
});

describe("baseBehind / fetchBase", () => {
  test("clone behind its origin: counts, fetch updates", async () => {
    const { baseBehind, fetchBase } = await import("./git");
    const { git, tmpdir } = await import("./testutil");
    const origin = makeRepo("origin");
    const clone = tmpdir("clone");
    git(clone, "clone", origin, ".");
    git(clone, "config", "user.email", "t@t");
    git(clone, "config", "user.name", "t");
    expect(await baseBehind(clone, "main")).toBe(0);

    writeFileSync(join(origin, "b.txt"), "new\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-m", "upstream moved");

    // local still doesn't know until fetch
    expect(await baseBehind(clone, "main")).toBe(0);
    await fetchBase(clone, "main");
    expect(await baseBehind(clone, "main")).toBe(1);
  });

  test("no remote: baseBehind null, fetchBase throws GitError", async () => {
    const { baseBehind, fetchBase } = await import("./git");
    const dir = makeRepo("noremote");
    expect(await baseBehind(dir, "main")).toBeNull();
    await expect(fetchBase(dir, "main")).rejects.toBeInstanceOf(GitError);
  });
});

describe("divergence", () => {
  test("ahead and behind vs base", async () => {
    const dir = makeRepo("div");
    git(dir, "checkout", "-b", "feature");
    write(dir, "f.txt", "feature\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "feature work");
    write(dir, "f2.txt", "more\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "more feature work");
    git(dir, "checkout", "main");
    write(dir, "m.txt", "main moved\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "main moved");
    git(dir, "checkout", "feature");

    expect(await divergence(dir, "main")).toEqual({ ahead: 2, behind: 1 });
  });

  test("zero for a checkout sitting on base", async () => {
    const dir = makeRepo("div-zero");
    expect(await divergence(dir, "main")).toEqual({ ahead: 0, behind: 0 });
  });

  test("null for a bad ref", async () => {
    const dir = makeRepo("div-bad");
    expect(await divergence(dir, "no-such-branch")).toBeNull();
  });
});

describe("remoteUrl", () => {
  test("null without origin, URL with one", async () => {
    const dir = makeRepo("remote");
    expect(await remoteUrl(dir)).toBeNull();
    git(dir, "remote", "add", "origin", "https://git.naps.pt/yolo/rev.git");
    expect(await remoteUrl(dir)).toBe("https://git.naps.pt/yolo/rev.git");
  });
});

describe("defaultBase ref choice", () => {
  /** Commit with a fixed committer date; merge-base recency needs distinct timestamps. */
  const commitAt = (dir: string, date: string, msg: string) => {
    const proc = Bun.spawnSync(["git", "commit", "-m", msg], {
      cwd: dir,
      env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date },
    });
    if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  };

  test("prefers origin/main over a stale local main", async () => {
    const dir = makeRepo("base-stale");
    const a = git(dir, "rev-parse", "HEAD").trim();
    write(dir, "b.txt", "b\n");
    git(dir, "add", "-A");
    commitAt(dir, "2027-01-02T10:00:00", "b");
    write(dir, "c.txt", "c\n");
    git(dir, "add", "-A");
    commitAt(dir, "2027-01-03T10:00:00", "c");
    const c = git(dir, "rev-parse", "HEAD").trim();
    git(dir, "update-ref", "refs/remotes/origin/main", c);
    git(dir, "checkout", "-b", "feature");
    write(dir, "d.txt", "d\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "d");
    // local main left behind at the first commit
    git(dir, "update-ref", "refs/heads/main", a);

    expect(await defaultBase(dir)).toBe("origin/main");
  });

  test("prefers a local main that is ahead of origin/main", async () => {
    const dir = makeRepo("base-ahead");
    const a = git(dir, "rev-parse", "HEAD").trim();
    git(dir, "update-ref", "refs/remotes/origin/main", a);
    write(dir, "b.txt", "b\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "unpushed");
    git(dir, "checkout", "-b", "feature");

    expect(await defaultBase(dir)).toBe("main");
  });
});

describe("computeDiffSummary / computeFileDiff", () => {
  async function scenario() {
    const dir = makeRepo("summary", {
      "a.txt": "one\ntwo\nthree\n",
      "gone.txt": "bye\n",
      "orig.txt": "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\n",
    });
    writeFileSync(join(dir, "img.bin"), new Uint8Array([0x89, 0x50, 0x00, 0x01]));
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "binary");
    git(dir, "checkout", "-b", "feature");
    write(dir, "a.txt", "one\nTWO\nthree\n");
    rmSync(join(dir, "gone.txt"));
    git(dir, "mv", "orig.txt", "moved.txt");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "feature work");
    write(dir, "a.txt", "one\nTWO\nthree\nfour\n"); // uncommitted on top
    writeFileSync(join(dir, "img.bin"), new Uint8Array([0x89, 0x50, 0xff, 0xfe]));
    write(dir, "brand/new.txt", "n1\nn2\n");
    return dir;
  }

  test("summary lists the same files as the full diff, minus hunks", async () => {
    const dir = await scenario();
    const [full, summary] = await Promise.all([
      computeDiff(dir, "main"),
      computeDiffSummary(dir, "main"),
    ]);
    expect(summary.mergeBase).toBe(full.mergeBase);
    expect(summary.branch).toBe("feature");

    const strip = (fs: Array<Record<string, unknown>>) =>
      fs
        .map(({ hunks: _h, ...rest }) => rest)
        .sort((x, y) => String(x.path).localeCompare(String(y.path)));
    expect(strip(summary.files as never)).toEqual(strip(full.files as never));
    expect(summary.files.every((f) => !("hunks" in f))).toBe(true);
  });

  test("per-file diff matches the corresponding slice of the full diff", async () => {
    const dir = await scenario();
    const full = await computeDiff(dir, "main");
    for (const f of full.files) {
      const single = await computeFileDiff(dir, "main", f.path, f.oldPath);
      expect(single).toEqual(f);
    }
  });

  test("renamed file without oldPath does not crash; unknown path → null", async () => {
    const dir = await scenario();
    expect(await computeFileDiff(dir, "main", "nope.txt")).toBeNull();
    // without the old side in the pathspec, rename pairing degrades but returns the file
    const degraded = await computeFileDiff(dir, "main", "moved.txt");
    expect(degraded).not.toBeNull();
    expect(degraded!.path).toBe("moved.txt");
  });
});
