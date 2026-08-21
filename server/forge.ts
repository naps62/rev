/**
 * Pull requests on a repo's `origin`, via the forge's REST API: every open
 * PR plus a page of recently-updated closed ones, so local worktrees can be
 * matched to merged/closed PRs.
 *
 * github.com uses the GitHub API; every other host is assumed to be a Gitea
 * instance (its API mirrors GitHub's for the fields used here). Tokens come
 * from config (REV_GH_TOKEN/GH_TOKEN/GITHUB_TOKEN, REV_GITEA_TOKEN/
 * GITEA_TOKEN); without one, the request is tried unauthenticated — public
 * repos still work. Any failure yields null, cached like a success, so the
 * homepage doesn't hammer an unreachable forge.
 */


import type { PrInfo, PrState } from "#shared/types";


import { TUNING } from "#shared/tuning";
import type { PrInfo } from "#shared/types";
import { config } from "./config.ts";

export type ForgePr = Omit<PrInfo, "checkoutDir">;

/** Host, owner and repo name from an https or scp-like ssh remote URL. */
export function parseRemoteRepo(
  url: string,
): { host: string; owner: string; repo: string } | null {
  const ssh =
    /^(?:ssh:\/\/)?(?:[\w.-]+@)?([\w.-]+)[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/;
  const http =
    /^https?:\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/;
  const m = http.exec(url) ?? ssh.exec(url);
  return m ? { host: m[1]!, owner: m[2]!, repo: m[3]! } : null;
}

/** Raw PR shape shared by the GitHub and Gitea APIs (the fields we read). */
interface RawPr {
  number?: unknown;
  title?: unknown;
  draft?: unknown;
  html_url?: unknown;
  state?: unknown;
  /** Gitea sets `merged: true`; GitHub's list API only sets `merged_at`. */
  merged?: unknown;
  merged_at?: unknown;
  user?: { login?: unknown } | null;
  head?: { ref?: unknown; repo?: { full_name?: unknown } | null } | null;
}

function prState(p: RawPr): PrState {
  if (p.merged === true || typeof p.merged_at === "string") return "merged";
  return p.state === "closed" ? "closed" : "open";
}

/**
 * Map an API response to ForgePr[], dropping PRs whose head branch is not on
 * origin (cross-fork PRs, deleted head repos) — those can't be worktree'd.
 */
export function mapPrs(raw: unknown, ownerRepo: string): ForgePr[] {
  if (!Array.isArray(raw)) return [];
  const out: ForgePr[] = [];
  for (const p of raw as RawPr[]) {
    const branch = p.head?.ref;
    if (typeof p.number !== "number" || typeof branch !== "string") continue;
    const headRepo = p.head?.repo?.full_name;
    if (
      typeof headRepo === "string" &&
      headRepo.toLowerCase() !== ownerRepo.toLowerCase()
    )
      continue;
    out.push({
      number: p.number,
      title: typeof p.title === "string" ? p.title : "",
      branch,
      url: typeof p.html_url === "string" ? p.html_url : "",
      author: typeof p.user?.login === "string" ? p.user.login : null,
      draft: p.draft === true,
      state: prState(p),
    });
  }
  return out;
}

async function fetchPrs(remoteUrl: string): Promise<ForgePr[] | null> {
  const parsed = parseRemoteRepo(remoteUrl);
  if (!parsed) return null;
  const { host, owner, repo } = parsed;
  const github = host === "github.com";
  const base = github
    ? `https://api.github.com/repos/${owner}/${repo}/pulls`
    : `https://${host}/api/v1/repos/${owner}/${repo}/pulls`;
  // Open PRs in full; closed ones only the most recently updated page —
  // enough to match local worktrees to their finished PRs.
  const urls = github
    ? [
        `${base}?state=open&per_page=100`,
        `${base}?state=closed&sort=updated&direction=desc&per_page=100`,
      ]
    : [`${base}?state=open&limit=100`, `${base}?state=closed&sort=recentupdate&limit=100`];
  const headers: Record<string, string> = { accept: "application/json", "user-agent": "rev" };
  if (github && config.ghToken) headers.authorization = `Bearer ${config.ghToken}`;
  if (!github && config.giteaToken) headers.authorization = `token ${config.giteaToken}`;
  try {
    const pages = await Promise.all(
      urls.map(async (url) => {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`${res.status}`);
        return mapPrs(await res.json(), `${owner}/${repo}`);
      }),
    );
    return pages.flat();
  } catch {
    return null;
  }
}

const cache = new Map<string, { at: number; prs: ForgePr[] | null }>();
const inFlight = new Map<string, Promise<ForgePr[] | null>>();

/** Cached per remote for PR_CACHE_TTL_MS; null when the forge can't be queried. */
export async function listPrs(remoteUrl: string): Promise<ForgePr[] | null> {
  const hit = cache.get(remoteUrl);
  if (hit && Date.now() - hit.at < TUNING.PR_CACHE_TTL_MS) return hit.prs;
  let p = inFlight.get(remoteUrl);
  if (!p) {
    p = fetchPrs(remoteUrl)
      .then((prs) => {
        cache.set(remoteUrl, { at: Date.now(), prs });
        return prs;
      })
      .finally(() => inFlight.delete(remoteUrl));
    inFlight.set(remoteUrl, p);
  }
  return p;
}
