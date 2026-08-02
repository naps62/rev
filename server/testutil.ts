/** Shared helpers for server tests: throwaway git fixture repos. */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SCRATCH =
  process.env.CLAUDE_SCRATCHPAD ??
  "/tmp/claude-1000/-home-naps62-tea-yolo-rev/5efaa259-21c1-4102-9c79-253053aaa4c9/scratchpad";

export function tmpdir(prefix: string): string {
  mkdirSync(SCRATCH, { recursive: true });
  return mkdtempSync(join(SCRATCH, `${prefix}-`));
}

export function git(dir: string, ...args: string[]): string {
  const proc = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (proc.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr}`);
  }
  return proc.stdout;
}

export function write(dir: string, rel: string, content: string | Uint8Array): void {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

/** git init -b main + local identity + one commit of the given files. */
export function makeRepo(prefix: string, files: Record<string, string> = { "a.txt": "one\ntwo\nthree\n" }): string {
  const dir = tmpdir(prefix);
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "test@rev.local");
  git(dir, "config", "user.name", "rev test");
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "init");
  return dir;
}
