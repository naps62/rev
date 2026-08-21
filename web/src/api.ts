/**
 * Typed client for the REST surface in shared/types.ts. With `?fixture` in
 * the URL every call is served from dev-fixture.ts instead, so the UI runs
 * without the server.
 */

import type {
  AgentStatusResponse,
  CommandsResponse,
  CommandsUpdateRequest,
  Comment,
  CommentCreateRequest,
  CommentListResponse,
  CommentPatchRequest,
  CommentsSubmitResponse,
  DiffSummaryResponse,
  FileContentResponse,
  FileDiffResponse,
  FileWriteRequest,
  GithubCommentRequest,
  GithubConvosResponse,
  GithubReplyRequest,
  GithubResolveRequest,
  PrListResponse,
  RefsResponse,
  RepoInfo,
  SeenRequest,
  SemanticDiffResponse,
  StackResponse,
  UiSettings,
  WorktreeCreateRequest,
  WorktreeCreateResponse,
} from "#shared/types";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export function isFixture(): boolean {
  return new URLSearchParams(window.location.search).has("fixture");
}

/** Keeps the fixture flag on internal navigation so the mode is sticky. */
export function href(
  path: string,
  params: Record<string, string> = {},
): string {
  const search = new URLSearchParams(params);
  if (isFixture()) search.set("fixture", "");
  const qs = search.toString().replace(/=(?=&|$)/g, "");
  return qs ? `${path}?${qs}` : path;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    ...init,
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(message, res.status);
  }
  return res.json() as Promise<T>;
}

const fx = () => import("./dev-fixture");

// Fixture calls resolve on a microtask; a tick keeps loading states honest.
const tick = <T>(v: T): Promise<T> =>
  new Promise((r) => setTimeout(() => r(v), 30));

export async function getRepos(): Promise<RepoInfo[]> {
  if (isFixture()) return tick((await fx()).fxGetRepos());
  return request("/api/repos");
}

export async function rescanRepos(): Promise<RepoInfo[]> {
  if (isFixture()) return tick((await fx()).fxGetRepos());
  return request("/api/repos/rescan", { method: "POST" });
}

export async function getPrs(dir: string): Promise<PrListResponse> {
  if (isFixture()) return tick((await fx()).fxGetPrs(dir));
  const q = new URLSearchParams({ dir });
  return request(`/api/prs?${q}`);
}

export async function createWorktree(
  req: WorktreeCreateRequest,
): Promise<WorktreeCreateResponse> {
  if (isFixture()) return tick((await fx()).fxCreateWorktree(req));
  return request("/api/worktrees", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function getCommands(): Promise<CommandsResponse> {
  if (isFixture()) return tick((await fx()).fxGetCommands());
  return request("/api/commands");
}

export async function putCommands(
  req: CommandsUpdateRequest,
): Promise<CommandsResponse> {
  if (isFixture()) return tick((await fx()).fxPutCommands(req));
  return request("/api/commands", { method: "PUT", body: JSON.stringify(req) });
}

export async function getAgentStatus(
  dir: string,
): Promise<AgentStatusResponse> {
  if (isFixture()) return tick((await fx()).fxGetAgentStatus(dir));
  const q = new URLSearchParams({ dir });
  return request(`/api/agent?${q}`);
}

export async function getSettings(): Promise<UiSettings> {
  if (isFixture()) return tick((await fx()).fxGetSettings());
  return request("/api/settings");
}

export async function putSettings(req: UiSettings): Promise<UiSettings> {
  if (isFixture()) return tick((await fx()).fxPutSettings(req));
  return request("/api/settings", { method: "PUT", body: JSON.stringify(req) });
}

export async function getDiffSummary(
  dir: string,
  base: string,
): Promise<DiffSummaryResponse> {
  if (isFixture()) return tick((await fx()).fxGetDiffSummary(dir, base));
  const q = new URLSearchParams({ dir, base });
  return request(`/api/diff/summary?${q}`);
}

export async function getFileDiff(
  dir: string,
  base: string,
  path: string,
  oldPath?: string,
): Promise<FileDiffResponse> {
  if (isFixture()) return tick((await fx()).fxGetFileDiff(dir, base, path));
  const q = new URLSearchParams({ dir, base, path });
  if (oldPath) q.set("oldPath", oldPath);
  return request(`/api/diff/file?${q}`);
}

export async function getSemanticDiff(
  dir: string,
  base: string,
): Promise<SemanticDiffResponse> {
  if (isFixture()) return tick((await fx()).fxGetSemanticDiff(dir, base));
  const q = new URLSearchParams({ dir, base });
  return request(`/api/semantic?${q}`);
}

export async function getRefs(dir: string): Promise<RefsResponse> {
  if (isFixture()) return tick((await fx()).fxGetRefs(dir));
  const q = new URLSearchParams({ dir });
  return request(`/api/refs?${q}`);
}

export async function getStack(
  dir: string,
  base: string,
): Promise<StackResponse> {
  if (isFixture()) return tick((await fx()).fxGetStack(dir, base));
  const q = new URLSearchParams({ dir, base });
  return request(`/api/stack?${q}`);
}

export async function getFile(
  dir: string,
  path: string,
  rev?: string,
): Promise<FileContentResponse> {
  if (isFixture()) return tick((await fx()).fxGetFile(dir, path));
  const q = new URLSearchParams({ dir, path });
  if (rev) q.set("rev", rev);
  return request(`/api/file?${q}`);
}

export function rawFileUrl(
  dir: string,
  path: string,
  rev: string | undefined,
  version: string,
): string {
  if (isFixture()) {
    const old = rev !== undefined;
    const accent = old ? "%23ef6e58" : "%235cc576";
    const offset = old ? 0 : 22;
    return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1200' height='720' viewBox='0 0 1200 720'%3E%3Crect width='1200' height='720' fill='%231a2027'/%3E%3Ccircle cx='${390 + offset}' cy='330' r='210' fill='${accent}' fill-opacity='.72'/%3E%3Crect x='${580 + offset}' y='190' width='370' height='310' rx='48' fill='%2385bcd9' fill-opacity='.7'/%3E%3C/svg%3E`;
  }
  const q = new URLSearchParams({ dir, path, v: version });
  if (rev) q.set("rev", rev);
  return `/api/file/raw?${q}`;
}

export async function putFile(
  req: FileWriteRequest,
): Promise<FileContentResponse> {
  if (isFixture()) return tick((await fx()).fxPutFile(req));
  return request("/api/file", { method: "PUT", body: JSON.stringify(req) });
}

export async function getComments(
  dir: string,
  base?: string,
): Promise<CommentListResponse> {
  if (isFixture()) return tick((await fx()).fxGetComments(dir));
  const q = new URLSearchParams({ dir });
  if (base) q.set("base", base);
  return request(`/api/comments?${q}`);
}

export async function postComment(req: CommentCreateRequest): Promise<Comment> {
  if (isFixture()) return tick((await fx()).fxPostComment(req));
  return request("/api/comments", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function submitComments(
  dir: string,
): Promise<CommentsSubmitResponse> {
  if (isFixture()) return tick((await fx()).fxSubmitComments(dir));
  return request("/api/comments/submit", {
    method: "POST",
    body: JSON.stringify({ dir }),
  });
}

export async function patchComment(
  id: string,
  patch: CommentPatchRequest,
): Promise<Comment> {
  if (isFixture()) return tick((await fx()).fxPatchComment(id, patch));
  return request(`/api/comments/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function getGithubConvos(
  dir: string,
  refresh = false,
): Promise<GithubConvosResponse> {
  if (isFixture()) return tick((await fx()).fxGetGithub(dir));
  const q = new URLSearchParams({ dir });
  if (refresh) q.set("refresh", "1");
  return request(`/api/github?${q}`);
}

export async function postGithubReply(
  req: GithubReplyRequest,
): Promise<{ ok: true }> {
  if (isFixture()) return tick((await fx()).fxPostGithubReply(req));
  return request("/api/github/reply", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function postGithubComment(
  req: GithubCommentRequest,
): Promise<{ ok: true }> {
  if (isFixture()) return tick((await fx()).fxPostGithubComment(req));
  return request("/api/github/comment", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function postGithubResolve(
  req: GithubResolveRequest,
): Promise<{ ok: true }> {
  if (isFixture()) return tick((await fx()).fxPostGithubResolve(req));
  return request("/api/github/resolve", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function putSeen(req: SeenRequest): Promise<{ ok: true }> {
  if (isFixture()) return tick((await fx()).fxPutSeen(req));
  return request("/api/seen", { method: "PUT", body: JSON.stringify(req) });
}

export async function postFetch(req: {
  dir: string;
  base: string;
}): Promise<{ ok: boolean; baseBehind: number | null }> {
  if (isFixture()) return tick((await fx()).fxPostFetch(req));
  return request("/api/fetch", { method: "POST", body: JSON.stringify(req) });
}
