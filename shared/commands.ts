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

/** Placeholders available in the session-spawn template. */
export const SESSION_SPAWN_PLACEHOLDERS: Record<string, string> = {
  "{dir}": "absolute path of the checkout the comments target",
  "{branch}": "the checkout's branch (empty when detached)",
};

export const SESSION_SPAWN_PRESETS: CommandPreset[] = [
  {
    name: "tmux",
    template: "tmux new-session -d -c {dir} claude",
    blurb: "detached tmux session running claude",
  },
  {
    name: "kitty",
    template: "kitty --detach --directory {dir} claude",
    blurb: "new kitty OS window running claude",
  },
];

/** Empty template = spawning disabled; submit just queues the batch. */
export const DEFAULT_SESSION_SPAWN_CMD = "";
