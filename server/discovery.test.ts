import { describe, test } from "node:test";
import { expect } from "expect";
import { parseRemote, scopeFor } from "./discovery.ts";

describe("parseRemote", () => {
  test("captures host, owner and repo across url shapes", () => {
    expect(parseRemote("git@github.com:acme/widget.git")).toEqual({
      host: "github.com",
      owner: "acme",
      repo: "widget",
    });
    expect(parseRemote("https://github.com/acme/widget")).toEqual({
      host: "github.com",
      owner: "acme",
      repo: "widget",
    });
    expect(parseRemote("ssh://git@github.com/acme/widget.git/")).toEqual({
      host: "github.com",
      owner: "acme",
      repo: "widget",
    });
    expect(parseRemote("https://user:token@git.naps.pt/yolo/rev.git")).toEqual({
      host: "git.naps.pt",
      owner: "yolo",
      repo: "rev",
    });
    expect(parseRemote("not a url")).toBeNull();
  });
});

// Default REV_PERSONAL_HOSTS: git.naps.pt (shared/tuning.ts).
describe("scopeFor", () => {
  test("personal-host remotes are personal, whatever the org", () => {
    expect(scopeFor("https://git.naps.pt/yolo/rev.git")).toBe("personal");
    expect(scopeFor("https://git.naps.pt/bullish/mvp.git")).toBe("personal");
    expect(scopeFor("https://user:token@git.naps.pt/yolo/private.git")).toBe(
      "personal",
    );
  });

  test("other remotes bucket by owner org", () => {
    expect(scopeFor("git@github.com:subvisual/bullish.git")).toBe("subvisual");
    expect(scopeFor("https://github.com/subvisual/antseed")).toBe("subvisual");
    expect(scopeFor("https://github.com/tesser-payments/platform.git")).toBe(
      "tesser-payments",
    );
    expect(scopeFor("ssh://git@github.com/Subvisual/x.git")).toBe("subvisual");
  });

  test("no remote or unparseable remote is personal", () => {
    expect(scopeFor(null)).toBe("personal");
    expect(scopeFor("not a url")).toBe("personal");
  });
});

test("personal owners are personal on any host", () => {
  expect(scopeFor("git@github.com:naps62/finance-planning.git")).toBe(
    "personal",
  );
});

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitStateFingerprint, scanForRepos } from "./discovery.ts";
import { git, makeRepo, tmpdir, write } from "./testutil.ts";

describe("scanForRepos", () => {
  /** A home with a repo in a normal dir and one in a macOS-protected dir. */
  function fakeHome(): string {
    const home = realpathSync(tmpdir("home")); // scanForRepos reports real paths
    for (const rel of [
      "tea/proj/.git",
      "Documents/notes/.git",
      "code/deep/nested/repo/.git",
    ]) {
      mkdirSync(join(home, rel), { recursive: true });
    }
    return home;
  }

  test("skips the protected dirs directly in home", () => {
    const home = fakeHome();
    const found = scanForRepos(home, 4, home);
    expect(found).toContain(join(home, "tea/proj"));
    expect(found).not.toContain(join(home, "Documents/notes"));
  });

  test("a root pointing into one is scanned anyway", () => {
    const home = fakeHome();
    expect(scanForRepos(join(home, "Documents"), 4, home)).toEqual([
      join(home, "Documents/notes"),
    ]);
  });

  test("the names are only special in home itself", () => {
    const home = fakeHome();
    mkdirSync(join(home, "tea/Documents/x/.git"), { recursive: true });
    expect(scanForRepos(home, 4, home)).toContain(
      join(home, "tea/Documents/x"),
    );
  });

  test("stops at maxDepth", () => {
    const home = fakeHome();
    expect(scanForRepos(home, 2, home)).not.toContain(
      join(home, "code/deep/nested/repo"),
    );
  });
});

describe("gitStateFingerprint", () => {
  test("stable when nothing changes, moves on commit and on ref updates", () => {
    const dir = makeRepo("fp");
    const fp1 = gitStateFingerprint(dir);
    expect(fp1).not.toBe("");
    expect(gitStateFingerprint(dir)).toBe(fp1);

    write(dir, "a.txt", "changed\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-m", "change");
    const fp2 = gitStateFingerprint(dir);
    expect(fp2).not.toBe(fp1);

    git(dir, "branch", "side");
    expect(gitStateFingerprint(dir)).not.toBe(fp2);
  });

  test("worktrees share ref state with the main repo but have own HEAD/index", () => {
    const dir = makeRepo("fp-wt");
    const linked = `${dir}-linked`;
    git(dir, "worktree", "add", linked, "-b", "linked");
    const before = gitStateFingerprint(linked);
    expect(before).not.toBe("");
    // a branch created in the MAIN repo moves the shared refs → linked fp moves
    git(dir, "branch", "elsewhere");
    expect(gitStateFingerprint(linked)).not.toBe(before);
  });

  test("non-repo returns empty", () => {
    const dir = join(makeRepo("fp-plain"), "sub");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "x.txt"), "x");
    expect(gitStateFingerprint(dir)).toBe("");
  });
});
