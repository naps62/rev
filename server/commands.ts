/**
 * The UI-configurable commands (worktree-create, session-spawn): stored in
 * the settings table. Templates are split into argv (quote-aware, no shell)
 * and placeholders are substituted per token, so a value can never add or
 * split arguments.
 */

import { execFile } from "node:child_process";
import { DEFAULT_SESSION_SPAWN_CMD, DEFAULT_WORKTREE_CMD } from "#shared/commands";
import { TUNING } from "#shared/tuning";
import { getSetting, setSetting } from "./db.ts";
import { run } from "./git.ts";

export class CommandError extends Error {}

const WORKTREE_CMD_KEY = "commands.worktreeCreate";
const SESSION_SPAWN_CMD_KEY = "commands.sessionSpawn";

/**
 * Conservative allowlist rather than full git ref grammar: the branch lands
 * on a subprocess argv, so reject anything option-shaped or traversal-shaped.
 */
export function validBranch(branch: string): boolean {
  return (
    /^[A-Za-z0-9](?:[\w./-]*[\w-])?$/.test(branch) &&
    !branch.includes("..") &&
    !branch.includes("//") &&
    branch.length <= 200
  );
}

/** Split a template into argv tokens; '…' and "…" group whole tokens, no escapes. */
export function splitTemplate(template: string): string[] {
  if (
    (template.match(/'/g) ?? []).length % 2 ||
    (template.match(/"/g) ?? []).length % 2
  ) {
    throw new CommandError("unbalanced quote in template");
  }
  const tokens: string[] = [];
  const re = /'([^']*)'|"([^"]*)"|([^\s'"]+)/g;
  for (const m of template.matchAll(re)) tokens.push(m[1] ?? m[2] ?? m[3]!);
  return tokens;
}

export function substitute(
  tokens: string[],
  vars: Record<string, string>,
): string[] {
  return tokens.map((t) =>
    t.replace(/\{(\w+)\}/g, (whole, name: string) => vars[name] ?? whole),
  );
}

export function worktreeCommand(): string {
  try {
    return getSetting(WORKTREE_CMD_KEY) ?? DEFAULT_WORKTREE_CMD;
  } catch {
    return DEFAULT_WORKTREE_CMD; // DB not opened (tests)
  }
}

/** Validate and persist the template; throws CommandError on a bad one. */
export function setWorktreeCommand(template: string): void {
  const tokens = splitTemplate(template.trim());
  if (tokens.length === 0) throw new CommandError("empty command");
  if (!template.includes("{branch}"))
    throw new CommandError("template must use {branch}");
  setSetting(WORKTREE_CMD_KEY, template.trim());
}

export function sessionSpawnCommand(): string {
  try {
    return getSetting(SESSION_SPAWN_CMD_KEY) ?? DEFAULT_SESSION_SPAWN_CMD;
  } catch {
    return DEFAULT_SESSION_SPAWN_CMD; // DB not opened (tests)
  }
}

/** Validate and persist the session-spawn template; empty disables spawning. */
export function setSessionSpawnCommand(template: string): void {
  const trimmed = template.trim();
  if (trimmed !== "") {
    if (splitTemplate(trimmed).length === 0) throw new CommandError("empty command");
    if (!trimmed.includes("{dir}")) throw new CommandError("template must use {dir}");
  }
  setSetting(SESSION_SPAWN_CMD_KEY, trimmed);
}

/** Run the configured session-spawn command for a checkout; cwd = the checkout. */
export async function runSessionSpawnCommand(
  dir: string,
  branch: string | null,
  repo: string,
): Promise<void> {
  const template = sessionSpawnCommand();
  if (template === "") throw new CommandError("no session-spawn command configured");
  const argv = substitute(splitTemplate(template), { dir, branch: branch ?? "", repo });
  await exec(argv, dir, TUNING.SESSION_SPAWN_CMD_TIMEOUT_MS);
}

function exec(argv: string[], cwd: string, timeout: number = TUNING.WORKTREE_CMD_TIMEOUT_MS): Promise<void> {
  return new Promise((res, rej) => {
    execFile(
      argv[0]!,
      argv.slice(1),
      { cwd, timeout },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || stdout || err.message)
            .trim()
            .split("\n")
            .slice(-3)
            .join(" ");
          rej(new CommandError(`${argv[0]} failed: ${detail}`));
        } else res();
      },
    );
  });
}

/** Worktree dir currently on `branch`, from `git worktree list` in mainDir. */
async function worktreeFor(
  mainDir: string,
  branch: string,
): Promise<string | null> {
  const out = await run(mainDir, ["worktree", "list", "--porcelain"]);
  let dir: string | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) dir = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}` && dir) return dir;
  }
  return null;
}

/**
 * Run the configured command for `branch`. Returns the checkout now on the
 * branch, null when the command created something `git worktree list` can't
 * see (e.g. a separate clone) — discovery picks those up on rescan.
 */
export async function runWorktreeCommand(
  mainDir: string,
  branch: string,
  remoteUrl: string | null,
): Promise<{ dir: string | null }> {
  if (!validBranch(branch))
    throw new CommandError(`invalid branch name: ${branch}`);
  const argv = substitute(splitTemplate(worktreeCommand()), {
    dir: mainDir,
    branch,
    remoteUrl: remoteUrl ?? "",
  });
  if (argv.length === 0) throw new CommandError("empty command");
  if (remoteUrl !== null) {
    try {
      await run(mainDir, ["fetch", "origin"]); // PR branches are often not fetched yet
    } catch {
      // offline or broken remote: let the command itself decide
    }
  }
  await exec(argv, mainDir);
  return { dir: await worktreeFor(mainDir, branch) };
}
