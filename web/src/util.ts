import type { Comment } from "#shared/types";

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
    replies: (byParent.get(root.id) ?? []).sort((a, b) => a.createdAt - b.createdAt),
  }));
}

export const lineKey = (side: "old" | "new", line: number) => `${side}:${line}`;
