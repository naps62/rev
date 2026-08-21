/**
 * GitHub PR conversations via the `gh` CLI (already authenticated on the
 * machine; rev never touches tokens). Only consulted when dir's origin is a
 * github.com remote and its branch has an open PR — every other outcome
 * (gh missing, no PR, API failure, timeout) degrades to `available: false`,
 * mirroring the semantic.ts contract. Responses are cached per dir for
 * GITHUB_TTL_MS; mutations bust the cache.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TUNING } from "#shared/tuning";
import type {
  CommentAnchor,
  GithubComment,
  GithubConvosResponse,
  GithubPrInfo,
  GithubThread,
  GithubUnavailableReason,
} from "#shared/types";
import { resolveAnchor } from "./anchor.ts";
import { config } from "./config.ts";
import { mirrorGithubComment, stampGithubId } from "./db.ts";
import { parseRemote } from "./discovery.ts";
import { headInfo, remoteUrl } from "./git.ts";

const GH_BIN = process.env.REV_GH_BIN || "gh";

/** Upstream (gh / GitHub API) failure on an explicit user action; routes map it to 502. */
export class GhError extends Error {}

let availability: Promise<boolean> | null = null;

/** Whether the gh binary runs; probed once per process, logged when absent. */
function ghAvailable(): Promise<boolean> {
  availability ??= new Promise((res) => {
    const proc = spawn(GH_BIN, ["--version"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    proc.stdout
      .setEncoding("utf8")
      .on("data", (chunk: string) => (out += chunk));
    proc.on("error", () => {
      console.log(`github conversations disabled: ${GH_BIN} not found`);
      res(false);
    });
    proc.on("close", (code) => {
      if (code !== 0 || !/^gh version/.test(out)) return res(false);
      res(true);
    });
  });
  return availability;
}

function runGh(dir: string, args: string[]): Promise<string> {
  return new Promise((res, rej) => {
    const proc = spawn(GH_BIN, args, {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      rej(new Error(`gh timed out after ${TUNING.GITHUB_TIMEOUT_MS}ms`));
    }, TUNING.GITHUB_TIMEOUT_MS);
    proc.stdout
      .setEncoding("utf8")
      .on("data", (chunk: string) => (out += chunk));
    proc.stderr
      .setEncoding("utf8")
      .on("data", (chunk: string) => (err += chunk));
    proc.on("error", (e) => {
      clearTimeout(timer);
      rej(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0)
        rej(new Error(err.trim() || `gh ${args[0]} failed (exit ${code})`));
      else res(out);
    });
  });
}

// ---------------------------------------------------------------------------
// diffHunk → CommentAnchor
// ---------------------------------------------------------------------------

/**
 * GitHub's diffHunk ends at the commented line. Collect the lines that exist
 * on the comment's side (context + that side's changes), so the last one is
 * the anchored line and the ones before it are its leading context.
 */
export function anchorFromHunk(
  path: string,
  side: "old" | "new",
  line: number,
  diffHunk: string,
): CommentAnchor {
  const keep = side === "new" ? ["+", " "] : ["-", " "];
  const rows: string[] = [];
  for (const raw of diffHunk.split("\n")) {
    if (raw.startsWith("@@")) continue;
    if (keep.includes(raw[0] ?? " ")) rows.push(raw.slice(1).trim());
  }
  const snippet = rows.pop() ?? "";
  return {
    file: path,
    side,
    line,
    snippet,
    context: { before: rows.slice(-3), after: [] },
  };
}

/**
 * Fill resolvedLine like anchor.ts's resolveComments does for local comments:
 * old-side anchors echo their line, new-side anchors re-locate in the working
 * tree (null = orphaned). Empty snippets (no usable diffHunk) are left
 * uncomputed so the UI places the thread at the PR's line number as-is.
 */
function resolveThreads(dir: string, threads: GithubThread[]): void {
  const byFile = new Map<string, GithubThread[]>();
  for (const t of threads) {
    if (!t.anchor) continue;
    if (t.anchor.side === "old" || t.anchor.snippet === "") {
      if (t.anchor.side === "old") t.resolvedLine = t.anchor.line;
      continue;
    }
    let list = byFile.get(t.anchor.file);
    if (!list) {
      list = [];
      byFile.set(t.anchor.file, list);
    }
    list.push(t);
  }
  for (const [file, list] of byFile) {
    let lines: string[] | null = null;
    try {
      lines = readFileSync(join(dir, file), "utf8").split("\n");
    } catch {
      // deleted locally or unreadable: every thread in it is orphaned
    }
    for (const t of list)
      t.resolvedLine = lines ? resolveAnchor(lines, t.anchor!) : null;
  }
}

// ---------------------------------------------------------------------------
// Fetch + cache
// ---------------------------------------------------------------------------

const THREADS_PAGE = 100;
const THREAD_COMMENTS_PAGE = 50;
const DISCUSSION_PAGE = 100;

const CONVOS_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: ${THREADS_PAGE}) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          originalLine
          diffSide
          comments(first: ${THREAD_COMMENTS_PAGE}) {
            nodes { databaseId author { login } body createdAt url diffHunk }
          }
        }
      }
      comments(first: ${DISCUSSION_PAGE}) {
        nodes { databaseId author { login } body createdAt url }
      }
    }
  }
}`;

interface RawGqlComment {
  databaseId: number | null;
  author: { login: string } | null;
  body: string;
  createdAt: string;
  url: string;
  diffHunk?: string | null;
}

interface RawGqlThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  originalLine: number | null;
  diffSide: "LEFT" | "RIGHT" | null;
  comments: { nodes: RawGqlComment[] };
}

function mapComment(c: RawGqlComment): GithubComment {
  return {
    id: c.databaseId ?? 0,
    login: c.author?.login ?? "ghost",
    body: c.body,
    createdAt: Date.parse(c.createdAt) || 0,
    url: c.url,
  };
}

const cache = new Map<string, { at: number; res: GithubConvosResponse }>();
const inFlight = new Map<string, Promise<GithubConvosResponse>>();

export function invalidateGithub(dir: string): void {
  cache.delete(dir);
}

/** GitHub conversations for dir, cached for GITHUB_TTL_MS. */
export function githubConvos(
  dir: string,
  refresh = false,
): Promise<GithubConvosResponse> {
  const hit = cache.get(dir);
  if (!refresh && hit && Date.now() - hit.at < TUNING.GITHUB_TTL_MS) {
    return Promise.resolve(hit.res);
  }
  let p = inFlight.get(dir);
  if (!p) {
    p = computeConvos(dir)
      .then((res) => {
        cache.set(dir, { at: Date.now(), res });
        return res;
      })
      .finally(() => inFlight.delete(dir));
    inFlight.set(dir, p);
  }
  return p;
}

function unavailable(
  dir: string,
  reason: GithubUnavailableReason,
): GithubConvosResponse {
  return {
    dir,
    available: false,
    reason,
    pr: null,
    threads: [],
    discussion: [],
    truncated: false,
    computedAt: Date.now(),
  };
}

/** Origin's owner/repo when it points at github.com, else null. */
async function githubSlug(
  dir: string,
): Promise<{ owner: string; repo: string } | null> {
  const remote = await remoteUrl(dir);
  if (!remote) return null;
  const parsed = parseRemote(remote);
  if (parsed?.host !== "github.com") return null;
  return { owner: parsed.owner, repo: parsed.repo };
}

async function computeConvos(dir: string): Promise<GithubConvosResponse> {
  if (!(await ghAvailable())) return unavailable(dir, "gh-missing");
  const slug = await githubSlug(dir);
  if (!slug) return unavailable(dir, "not-github");
  const { branch } = await headInfo(dir);
  if (!branch) return unavailable(dir, "no-pr");
  try {
    const listOut = await runGh(dir, [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "open",
      "--limit",
      "1",
      "--json",
      "number,title,url,isDraft,headRefOid,baseRefName",
    ]);
    const prs = JSON.parse(listOut) as GithubPrInfo[];
    const pr = prs[0];
    if (!pr) return unavailable(dir, "no-pr");

    const gqlOut = await runGh(dir, [
      "api",
      "graphql",
      "-f",
      `query=${CONVOS_QUERY}`,
      "-f",
      `owner=${slug.owner}`,
      "-f",
      `name=${slug.repo}`,
      "-F",
      `number=${pr.number}`,
    ]);
    const gql = JSON.parse(gqlOut) as {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: { nodes: RawGqlThread[] };
            comments: { nodes: RawGqlComment[] };
          };
        };
      };
    };
    const rawPr = gql.data.repository.pullRequest;

    const threads: GithubThread[] = [];
    for (const t of rawPr.reviewThreads.nodes) {
      const comments = t.comments.nodes;
      const root = comments[0];
      let anchor: CommentAnchor | null = null;
      if (t.path != null) {
        const line = t.line ?? t.originalLine;
        if (line != null) {
          anchor = anchorFromHunk(
            t.path,
            t.diffSide === "LEFT" ? "old" : "new",
            line,
            root?.diffHunk ?? "",
          );
        }
      }
      threads.push({
        id: t.id,
        isResolved: t.isResolved,
        isOutdated: t.isOutdated,
        anchor,
        comments: comments.map(mapComment),
      });
    }
    resolveThreads(dir, threads);

    const discussion = rawPr.comments.nodes.map(mapComment);
    if (config.githubToAgent) mirrorForAgent(dir, pr, threads, discussion);
    const truncated =
      rawPr.reviewThreads.nodes.length >= THREADS_PAGE ||
      rawPr.comments.nodes.length >= DISCUSSION_PAGE ||
      rawPr.reviewThreads.nodes.some(
        (t) => t.comments.nodes.length >= THREAD_COMMENTS_PAGE,
      );

    return {
      dir,
      available: true,
      pr,
      threads,
      discussion,
      truncated,
      computedAt: Date.now(),
    };
  } catch (err) {
    console.error(`github convos failed in ${dir}: ${(err as Error).message}`);
    return unavailable(dir, "gh-failed");
  }
}

// ---------------------------------------------------------------------------
// Agent delivery (REV_GITHUB_TO_AGENT)
// ---------------------------------------------------------------------------

let mirrorNotify: ((dir: string) => void) | null = null;

/** Called after a sync mirrors new comments; routes wire it to broadcast + long-poll wakeup. */
export function onGithubMirrored(fn: (dir: string) => void): void {
  mirrorNotify = fn;
}

/** github_id encoding: rc:<id> = PR review comment, ic:<id> = issue (conversation) comment. */
const GITHUB_ID = /^(rc|ic):(\d+)$/;

function mirrorForAgent(
  dir: string,
  pr: GithubPrInfo,
  threads: GithubThread[],
  discussion: GithubComment[],
): void {
  const label = (c: GithubComment) =>
    `**@${c.login}** (GitHub PR #${pr.number}):\n\n${c.body}`;
  let added = 0;
  const base = pr.baseRefName;
  try {
    for (const t of threads) {
      const [root, ...replies] = t.comments;
      if (!root) continue;
      if (
        mirrorGithubComment({
          dir,
          base,
          githubId: `rc:${root.id}`,
          body: label(root),
          createdAt: root.createdAt,
          anchor: t.anchor ?? undefined,
          resolved: t.isResolved,
        })
      ) {
        added++;
      }
      for (const r of replies) {
        if (
          mirrorGithubComment({
            dir,
            base,
            githubId: `rc:${r.id}`,
            body: label(r),
            createdAt: r.createdAt,
            parentGithubId: `rc:${root.id}`,
          })
        ) {
          added++;
        }
      }
    }
    for (const c of discussion) {
      if (
        mirrorGithubComment({
          dir,
          base,
          githubId: `ic:${c.id}`,
          body: label(c),
          createdAt: c.createdAt,
        })
      ) {
        added++;
      }
    }
  } catch (err) {
    console.error(`github mirror failed in ${dir}: ${(err as Error).message}`);
  }
  if (added > 0) mirrorNotify?.(dir);
}

/**
 * Forward an agent reply on a mirrored thread to GitHub, then stamp the local
 * row with the created comment's github_id — so the next sync's dedup skips
 * it instead of delivering the agent its own words back.
 */
export async function forwardAgentReply(
  dir: string,
  localId: string,
  threadGithubId: string,
  body: string,
): Promise<void> {
  const m = GITHUB_ID.exec(threadGithubId);
  if (!m) return;
  const { owner, repo, pr } = await prContext(dir);
  const out = await mutate(
    dir,
    m[1] === "rc"
      ? [
          "api",
          `repos/${owner}/${repo}/pulls/${pr.number}/comments/${m[2]}/replies`,
          "-f",
          `body=${body}`,
        ]
      : [
          "api",
          `repos/${owner}/${repo}/issues/${pr.number}/comments`,
          "-f",
          `body=${body}`,
        ],
  );
  const created = JSON.parse(out) as { id?: number };
  if (created.id != null) stampGithubId(localId, `${m[1]}:${created.id}`);
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** The cached-or-fresh PR context a mutation needs; throws GhError when absent. */
async function prContext(dir: string): Promise<{
  owner: string;
  repo: string;
  pr: GithubPrInfo;
}> {
  const convos = await githubConvos(dir);
  if (!convos.available || !convos.pr) {
    throw new GhError(`no open GitHub PR for ${dir} (${convos.reason})`);
  }
  const slug = await githubSlug(dir);
  if (!slug) throw new GhError(`not a github.com remote: ${dir}`);
  return { ...slug, pr: convos.pr };
}

async function mutate(dir: string, args: string[]): Promise<string> {
  try {
    const out = await runGh(dir, args);
    invalidateGithub(dir);
    return out;
  } catch (err) {
    throw new GhError((err as Error).message);
  }
}

/** Reply under a review thread (rootId = thread root's databaseId), or to the conversation. */
export async function githubReply(
  dir: string,
  rootId: number | undefined,
  body: string,
): Promise<void> {
  const { owner, repo, pr } = await prContext(dir);
  if (rootId !== undefined) {
    await mutate(dir, [
      "api",
      `repos/${owner}/${repo}/pulls/${pr.number}/comments/${rootId}/replies`,
      "-f",
      `body=${body}`,
    ]);
  } else {
    await mutate(dir, [
      "api",
      `repos/${owner}/${repo}/issues/${pr.number}/comments`,
      "-f",
      `body=${body}`,
    ]);
  }
}

/**
 * New comment posted straight to GitHub (the composer's opt-in destination).
 * Anchored comments attach to the PR head; GitHub 422s when the line isn't in
 * the PR diff (e.g. local uncommitted edits) and that message reaches the UI.
 */
export async function githubComment(
  dir: string,
  anchor: CommentAnchor | undefined,
  body: string,
): Promise<void> {
  const { owner, repo, pr } = await prContext(dir);
  if (anchor === undefined) return githubReply(dir, undefined, body);
  await mutate(dir, [
    "api",
    `repos/${owner}/${repo}/pulls/${pr.number}/comments`,
    "-f",
    `body=${body}`,
    "-f",
    `commit_id=${pr.headRefOid}`,
    "-f",
    `path=${anchor.file}`,
    "-F",
    `line=${anchor.line}`,
    "-f",
    `side=${anchor.side === "old" ? "LEFT" : "RIGHT"}`,
  ]);
}

const RESOLVE_MUTATION = `
mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }`;
const UNRESOLVE_MUTATION = `
mutation($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { thread { id } } }`;

export async function githubResolve(
  dir: string,
  threadId: string,
  resolved: boolean,
): Promise<void> {
  await prContext(dir);
  await mutate(dir, [
    "api",
    "graphql",
    "-f",
    `query=${resolved ? RESOLVE_MUTATION : UNRESOLVE_MUTATION}`,
    "-f",
    `id=${threadId}`,
  ]);
}
