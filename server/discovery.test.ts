import { describe, test } from "node:test";
import { expect } from "expect";
import { scopeFor } from "./discovery.ts";

// Default REV_PERSONAL_HOSTS: git.naps.pt (shared/tuning.ts).
describe("scopeFor", () => {
  test("personal-host remotes are personal, whatever the org", () => {
    expect(scopeFor("https://git.naps.pt/yolo/rev.git")).toBe("personal");
    expect(scopeFor("https://git.naps.pt/bullish/mvp.git")).toBe("personal");
    expect(scopeFor("https://user:token@git.naps.pt/yolo/private.git")).toBe("personal");
  });

  test("other remotes bucket by owner org", () => {
    expect(scopeFor("git@github.com:subvisual/bullish.git")).toBe("subvisual");
    expect(scopeFor("https://github.com/subvisual/antseed")).toBe("subvisual");
    expect(scopeFor("https://github.com/tesser-payments/platform.git")).toBe("tesser-payments");
    expect(scopeFor("ssh://git@github.com/Subvisual/x.git")).toBe("subvisual");
  });

  test("no remote or unparseable remote is personal", () => {
    expect(scopeFor(null)).toBe("personal");
    expect(scopeFor("not a url")).toBe("personal");
  });
});

test("personal owners are personal on any host", () => {
  expect(scopeFor("git@github.com:naps62/finance-planning.git")).toBe("personal");
});

import { mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { gitStateFingerprint } from "./discovery";
import { git, makeRepo, write } from "./testutil";

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
