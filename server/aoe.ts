/**
 * Shell out to agent-of-empires (`aoe`) to create a worktree + agent session
 * for a branch. aoe fetches the branch if it only exists on origin, creates
 * the worktree under `<mainDir>/worktrees/`, and registers a session for it
 * (not started — the user launches it from the aoe TUI/dashboard).
 */

import { execFile } from "node:child_process";
import { TUNING } from "#shared/tuning";
import { run } from "./git.ts";

export class AoeError extends Error {}

/**
 * Conservative allowlist rather than full git ref grammar: the branch lands
 * on an `aoe` argv, so reject anything option-shaped or traversal-shaped.
 */
export function validBranch(branch: string): boolean {
  return (
    /^[A-Za-z0-9](?:[\w./-]*[\w-])?$/.test(branch) &&
    !branch.includes("..") &&
    !branch.includes("//") &&
    branch.length <= 200
  );
}

function aoe(args: string[]): Promise<string> {
  return new Promise((res, rej) => {
    execFile("aoe", args, { timeout: TUNING.AOE_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || stdout || err.message).trim().split("\n").slice(-3).join(" ");
        rej(new AoeError(`aoe ${args[0]} failed: ${detail}`));
      } else res(stdout);
    });
  });
}

/** Worktree dir currently on `branch`, from `git worktree list` in mainDir. */
async function worktreeFor(mainDir: string, branch: string): Promise<string | null> {
  const out = await run(mainDir, ["worktree", "list", "--porcelain"]);
  let dir: string | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) dir = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}` && dir) return dir;
  }
  return null;
}

export async function createWorktreeSession(
  mainDir: string,
  branch: string,
): Promise<{ dir: string; session: string }> {
  if (!validBranch(branch)) throw new AoeError(`invalid branch name: ${branch}`);
  const out = await aoe(["add", mainDir, "--worktree", branch]);
  const session = /Added session:\s+(.+)/.exec(out)?.[1]?.trim() ?? branch;
  const dir = /Path:\s+(.+)/.exec(out)?.[1]?.trim() ?? (await worktreeFor(mainDir, branch));
  if (!dir) throw new AoeError(`aoe created no worktree for ${branch}`);
  return { dir, session };
}
