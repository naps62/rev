import { join } from "node:path";

import {
  after as afterAll,
  before as beforeAll,
  describe,
  test,
} from "node:test";
import { expect } from "expect";
import {
  DEFAULT_WORKTREE_CMD,
  DEFAULT_WORKTREE_REMOVE_CMD,
} from "#shared/commands";

import {
  CommandError,
  sessionSpawnCommand,
  setSessionSpawnCommand,
  setWorktreeCommand,
  setWorktreeRemoveCommand,
  splitTemplate,
  substitute,
  validBranch,
  worktreeCommand,
  worktreeRemoveCommand,
} from "./commands.ts";
import { closeDb, openDb } from "./db.ts";
import { tmpdir } from "./testutil.ts";

beforeAll(() => {
  closeDb();
  openDb(join(tmpdir("commands-db"), "rev.db"));
});
afterAll(() => closeDb());

describe("validBranch", () => {
  test("accepts normal branch names, rejects option/traversal shapes", () => {
    expect(validBranch("fix-things")).toBe(true);
    expect(validBranch("feat/scope-tabs")).toBe(true);
    expect(validBranch("v1.2.3")).toBe(true);
    expect(validBranch("-rf")).toBe(false);
    expect(validBranch("--delete")).toBe(false);
    expect(validBranch("a..b")).toBe(false);
    expect(validBranch("a//b")).toBe(false);
    expect(validBranch("")).toBe(false);
    expect(validBranch("has space")).toBe(false);
  });
});

describe("splitTemplate / substitute", () => {
  test("splits on whitespace, quotes group whole tokens", () => {
    expect(
      splitTemplate("git -C {dir} worktree add worktrees/{branch} {branch}"),
    ).toEqual([
      "git",
      "-C",
      "{dir}",
      "worktree",
      "add",
      "worktrees/{branch}",
      "{branch}",
    ]);
    expect(splitTemplate(`sh -c 'echo hi there'`)).toEqual([
      "sh",
      "-c",
      "echo hi there",
    ]);
    expect(splitTemplate(`x "a b" y`)).toEqual(["x", "a b", "y"]);
    expect(() => splitTemplate(`x "a b`)).toThrow(CommandError);
  });

  test("substitutes per token; unknown placeholders survive; values can't split tokens", () => {
    const argv = substitute(["worktrees/{branch}", "{dir}", "{nope}"], {
      branch: "feat/x",
      dir: "/tmp/repo with space",
    });
    expect(argv).toEqual([
      "worktrees/feat/x",
      "/tmp/repo with space",
      "{nope}",
    ]);
  });
});

describe("worktreeCommand setting", () => {
  test("defaults, persists, validates", () => {
    expect(worktreeCommand()).toBe(DEFAULT_WORKTREE_CMD);
    setWorktreeCommand("aoe add {dir} --worktree {branch}");
    expect(worktreeCommand()).toBe("aoe add {dir} --worktree {branch}");
    expect(() => setWorktreeCommand("")).toThrow(CommandError);
    expect(() => setWorktreeCommand("echo no-branch")).toThrow(CommandError);
    expect(() => setWorktreeCommand(`echo "oops {branch}`)).toThrow(
      CommandError,
    );
    expect(worktreeCommand()).toBe("aoe add {dir} --worktree {branch}");
  });
});

describe("worktreeRemoveCommand setting", () => {
  test("defaults, persists, validates", () => {
    expect(worktreeRemoveCommand()).toBe(DEFAULT_WORKTREE_REMOVE_CMD);
    setWorktreeRemoveCommand("aoe remove {branch} --delete-worktree");
    expect(worktreeRemoveCommand()).toBe(
      "aoe remove {branch} --delete-worktree",
    );
    expect(() => setWorktreeRemoveCommand("")).toThrow(CommandError);
    expect(() => setWorktreeRemoveCommand("echo no-placeholder")).toThrow(
      CommandError,
    );
    expect(worktreeRemoveCommand()).toBe(
      "aoe remove {branch} --delete-worktree",
    );
    setWorktreeRemoveCommand(DEFAULT_WORKTREE_REMOVE_CMD);
  });
});

describe("sessionSpawnCommand setting", () => {
  test("defaults empty, persists, validates, empty disables", () => {
    expect(sessionSpawnCommand()).toBe("");
    setSessionSpawnCommand("tmux new-session -d -c {dir} claude");
    expect(sessionSpawnCommand()).toBe("tmux new-session -d -c {dir} claude");
    expect(() => setSessionSpawnCommand("echo no-dir")).toThrow(CommandError);
    expect(() => setSessionSpawnCommand(`echo "oops {dir}`)).toThrow(
      CommandError,
    );
    expect(sessionSpawnCommand()).toBe("tmux new-session -d -c {dir} claude");
    setSessionSpawnCommand("  ");
    expect(sessionSpawnCommand()).toBe("");
  });
});
