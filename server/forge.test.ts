import { describe, test } from "node:test";
import { expect } from "expect";
import { mapPrs, parseRemoteRepo } from "./forge.ts";

describe("parseRemoteRepo", () => {
  test("https, ssh and scp-like URLs", () => {
    expect(parseRemoteRepo("https://github.com/subvisual/maestro.git")).toEqual({
      host: "github.com", owner: "subvisual", repo: "maestro",
    });
    expect(parseRemoteRepo("https://git.naps.pt/yolo/rev.git")).toEqual({
      host: "git.naps.pt", owner: "yolo", repo: "rev",
    });
    expect(parseRemoteRepo("git@github.com:naps62/dotfiles.git")).toEqual({
      host: "github.com", owner: "naps62", repo: "dotfiles",
    });
    expect(parseRemoteRepo("ssh://git@github.com/naps62/dotfiles")).toEqual({
      host: "github.com", owner: "naps62", repo: "dotfiles",
    });
    expect(parseRemoteRepo("https://user:pass@git.naps.pt/yolo/rev/")).toEqual({
      host: "git.naps.pt", owner: "yolo", repo: "rev",
    });
    expect(parseRemoteRepo("not a url")).toBeNull();
  });
});

describe("mapPrs", () => {
  const pr = (over: object) => ({
    number: 7,
    title: "fix things",
    draft: false,
    html_url: "https://github.com/o/r/pull/7",
    user: { login: "alice" },
    head: { ref: "fix-things", repo: { full_name: "o/r" } },
    ...over,
  });

  test("maps the fields the UI needs", () => {
    expect(mapPrs([pr({})], "o/r")).toEqual([
      {
        number: 7,
        title: "fix things",
        branch: "fix-things",
        url: "https://github.com/o/r/pull/7",
        author: "alice",
        draft: false,
        state: "open",
      },
    ]);
  });

  test("derives state from merged/merged_at/state", () => {
    const states = (rows: object[]) => mapPrs(rows, "o/r").map((p) => p.state);
    expect(
      states([
        pr({ state: "open" }),
        // GitHub's list API: merged shows only as a merged_at timestamp
        pr({ state: "closed", merged_at: "2026-08-01T00:00:00Z" }),
        // Gitea sets a merged boolean
        pr({ state: "closed", merged: true }),
        pr({ state: "closed", merged: false, merged_at: null }),
      ]),
    ).toEqual(["open", "merged", "merged", "closed"]);
  });

  test("drops cross-fork PRs and malformed entries, keeps missing head.repo", () => {
    const rows = [
      pr({}),
      pr({ number: 8, head: { ref: "forked", repo: { full_name: "someone/r" } } }),
      pr({ number: 9, head: null }),
      // Gitea omits head.repo in some responses; branch is still on origin.
      pr({ number: 10, head: { ref: "no-head-repo" } }),
    ];
    expect(mapPrs(rows, "o/r").map((p) => p.number)).toEqual([7, 10]);
    expect(mapPrs({ message: "rate limited" }, "o/r")).toEqual([]);
  });
});
