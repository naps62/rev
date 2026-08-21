import type {
  Comment,
  GithubComment,
  GithubConvosResponse,
} from "#shared/types";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function relativeTime(ts: number | null): string {
  if (ts == null) return "—";
  const delta = Date.now() - ts;
  if (delta < 45_000) return "just now";
  const min = Math.round(delta / 60_000);
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function basename(dir: string): string {
  const parts = dir.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || dir;
}

export interface Thread {
  root: Comment;
  replies: Comment[];
}

/** Groups a flat comment list into threads (roots + ordered replies). */
export function buildThreads(comments: Comment[]): Thread[] {
  const roots = comments
    .filter((c) => !c.parentId)
    .sort((a, b) => a.createdAt - b.createdAt);
  const byParent = new Map<string, Comment[]>();
  for (const c of comments) {
    if (!c.parentId) continue;
    const list = byParent.get(c.parentId) ?? [];
    list.push(c);
    byParent.set(c.parentId, list);
  }
  return roots.map((root) => ({
    root,
    replies: (byParent.get(root.id) ?? []).sort(
      (a, b) => a.createdAt - b.createdAt,
    ),
  }));
}

export const lineKey = (side: "old" | "new", line: number) => `${side}:${line}`;

/**
 * Flatten a GithubConvosResponse into synthetic Comments so GitHub threads
 * ride the exact same thread plumbing (buildThreads, line placement, panel
 * ordering) as local ones. Ids are prefixed "gh:" and never hit local
 * comment endpoints — reply/resolve are routed by `source`.
 */
export function githubToComments(
  res: GithubConvosResponse,
  base: string,
): Comment[] {
  const out: Comment[] = [];
  const common = {
    dir: res.dir,
    base,
    seq: 0,
    status: "picked_up" as const,
    submittedSeq: null,
  };
  const mapOne = (
    c: GithubComment,
    extra: Partial<Comment> & { parentId: string | null },
  ): Comment => ({
    ...common,
    id: `gh:${c.id}`,
    anchor: null,
    author: "reviewer",
    body: c.body,
    createdAt: c.createdAt,
    resolvedAt: null,
    source: "github",
    ghLogin: c.login,
    ghUrl: c.url,
    ...extra,
  });
  for (const t of res.threads) {
    const [root, ...replies] = t.comments;
    if (!root) continue;
    out.push(
      mapOne(root, {
        parentId: null,
        anchor: t.anchor,
        resolvedAt: t.isResolved ? res.computedAt : null,
        resolvedLine: t.resolvedLine,
        ghThreadId: t.id,
        ghRootId: root.id,
      }),
    );
    for (const r of replies) out.push(mapOne(r, { parentId: `gh:${root.id}` }));
  }
  for (const c of res.discussion) out.push(mapOne(c, { parentId: null }));
  return out;
}
