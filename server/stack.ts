/**
 * Branch-stack detection: split HEAD's first-parent history down to
 * merge-base(base, HEAD) at commits that are tips of other local branches.
 * Read-only over refs the repo already has — no object-DB diffing, per
 * docs/DECISIONS.md a segment's diff is reviewed from that branch's own
 * checkout (checkoutDir), never synthesized here.
 */

import type { StackResponse, StackSegment } from "#shared/types";
import { TUNING } from "#shared/tuning";
import { headInfo, run } from "./git.ts";

/**
 * `checkouts` maps local branch name → checkout dir across all worktrees of
 * the repo (from discovery). Detached HEAD, unborn/no merge-base, or an empty
 * range all yield `segments: []`.
 */
export async function computeStack(
  dir: string,
  base: string,
  checkouts: Map<string, string>,
): Promise<StackResponse> {
  const computedAt = Date.now();
  const empty: StackResponse = { dir, base, segments: [], computedAt };
  const { branch } = await headInfo(dir);
  if (branch === null) return empty;
  let mergeBase: string;
  try {
    mergeBase = (await run(dir, ["merge-base", base, "HEAD"])).trim();
  } catch {
    return empty;
  }
  const chain = (
    await run(dir, [
      "rev-list",
      "--first-parent",
      `--max-count=${TUNING.STACK_MAX_COMMITS}`,
      "HEAD",
      `^${mergeBase}`,
    ])
  )
    .split("\n")
    .filter(Boolean);
  if (chain.length === 0) return empty;

  // Tips of every other local branch; several branches on one commit keep
  // the checked-out one (a stack segment you can open), else first by name.
  const tips = new Map<string, string[]>();
  const refs = await run(dir, ["for-each-ref", "--format=%(objectname)%09%(refname:short)", "refs/heads"]);
  for (const line of refs.split("\n")) {
    const [sha, name] = line.split("\t");
    if (!sha || !name || name === branch) continue;
    tips.set(sha, [...(tips.get(sha) ?? []), name]);
  }
  const pick = (names: string[]) =>
    names.find((n) => checkouts.has(n)) ?? [...names].sort()[0]!;

  const seg = (b: string, tip: string): StackSegment => ({
    branch: b,
    head: tip.slice(0, 12),
    commits: 0,
    checkoutDir: checkouts.get(b) ?? null,
    parent: base,
  });
  const segments: StackSegment[] = [seg(branch, chain[0]!)];
  for (const sha of chain) {
    const names = sha === chain[0] ? undefined : tips.get(sha);
    if (names !== undefined) segments.push(seg(pick(names), sha));
    segments[segments.length - 1]!.commits++;
  }
  for (let i = 0; i < segments.length - 1; i++) {
    segments[i]!.parent = segments[i + 1]!.branch;
  }
  return { dir, base, segments, computedAt };
}
