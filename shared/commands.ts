/**
 * Command templates the server runs for UI actions, and the presets the
 * settings UI offers. Templates are argv strings (quote-aware split, no
 * shell); placeholders are substituted per token after splitting.
 */

export interface CommandPreset {
  name: string;
  template: string;
  blurb: string;
}

/** Placeholders available in the worktree-create template. */
export const WORKTREE_CMD_PLACEHOLDERS: Record<string, string> = {
  "{dir}": "absolute path of the repo's main checkout",
  "{branch}": "branch to check out (may exist only on origin)",
  "{remoteUrl}": "the repo's origin URL",
};

export const WORKTREE_CMD_PRESETS: CommandPreset[] = [
  {
    name: "git worktree",
    template: "git -C {dir} worktree add worktrees/{branch} {branch}",
    blurb: "linked worktree under <repo>/worktrees/",
  },
  {
    name: "aoe",
    template: "aoe add {dir} --worktree {branch}",
    blurb: "agent-of-empires worktree + agent session",
  },
  {
    name: "git clone",
    template: "git clone --branch {branch} {remoteUrl} {dir}-{branch}",
    blurb: "separate full clone next to the repo",
  },
];

export const DEFAULT_WORKTREE_CMD = WORKTREE_CMD_PRESETS[0]!.template;

/** Placeholders available in the worktree-remove template. */
export const WORKTREE_REMOVE_PLACEHOLDERS: Record<string, string> = {
  "{dir}": "absolute path of the worktree checkout being removed",
  "{mainDir}": "absolute path of the repo's main checkout",
  "{branch}": "branch the worktree has checked out",
};

export const WORKTREE_REMOVE_PRESETS: CommandPreset[] = [
  {
    name: "git worktree",
    template: "git -C {mainDir} worktree remove {dir}",
    blurb: "plain worktree removal (refuses dirty trees)",
  },
  {
    name: "aoe",
    template: "aoe remove {branch} --delete-worktree",
    blurb: "close the agent-of-empires session, then its worktree",
  },
];

export const DEFAULT_WORKTREE_REMOVE_CMD = WORKTREE_REMOVE_PRESETS[0]!.template;
