/**
 * Typed client for the REST surface in shared/types.ts. With `?fixture` in
 * the URL every call is served from dev-fixture.ts instead, so the UI runs
 * without the server.
 */

import type {
  Comment,
  CommentCreateRequest,
  CommentListResponse,
  CommentPatchRequest,
  DiffResponse,
  DiffSummaryResponse,
  FileContentResponse,
  FileDiffResponse,
  FileWriteRequest,
  InterdiffResponse,
  RefsResponse,
  RepoInfo,
  SeenRequest,
  SeenSegmentsRequest,
  SemanticDiffResponse,
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
export function href(path: string, params: Record<string, string> = {}): string {
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
const tick = <T,>(v: T): Promise<T> =>
  new Promise((r) => setTimeout(() => r(v), 30));

export async function getRepos(): Promise<RepoInfo[]> {
  if (isFixture()) return tick((await fx()).fxGetRepos());
  return request("/api/repos");
}

export async function rescanRepos(): Promise<RepoInfo[]> {
  if (isFixture()) return tick((await fx()).fxGetRepos());
  return request("/api/repos/rescan", { method: "POST" });
}

export async function getDiff(dir: string, base: string): Promise<DiffResponse> {
  if (isFixture()) return tick((await fx()).fxGetDiff(dir, base));
  const q = new URLSearchParams({ dir, base });
  return request(`/api/diff?${q}`);
}

export async function getDiffSummary(dir: string, base: string): Promise<DiffSummaryResponse> {
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

export async function getSemanticDiff(dir: string, base: string): Promise<SemanticDiffResponse> {
  if (isFixture()) return tick((await fx()).fxGetSemanticDiff(dir, base));
  const q = new URLSearchParams({ dir, base });
  return request(`/api/semantic?${q}`);
}

export async function getRefs(dir: string): Promise<RefsResponse> {
  if (isFixture()) return tick((await fx()).fxGetRefs(dir));
  const q = new URLSearchParams({ dir });
  return request(`/api/refs?${q}`);
}

export async function getInterdiff(
  dir: string,
  base: string,
  path: string,
): Promise<InterdiffResponse> {
  if (isFixture()) return tick((await fx()).fxGetInterdiff(dir, base, path));
  const q = new URLSearchParams({ dir, base, path });
  return request(`/api/diff/interdiff?${q}`);
}

export async function getFile(dir: string, path: string, rev?: string): Promise<FileContentResponse> {
  if (isFixture()) return tick((await fx()).fxGetFile(dir, path));
  const q = new URLSearchParams({ dir, path });
  if (rev) q.set("rev", rev);
  return request(`/api/file?${q}`);
}

export async function putFile(req: FileWriteRequest): Promise<FileContentResponse> {
  if (isFixture()) return tick((await fx()).fxPutFile(req));
  return request("/api/file", { method: "PUT", body: JSON.stringify(req) });
}

export async function getComments(dir: string, base?: string): Promise<CommentListResponse> {
  if (isFixture()) return tick((await fx()).fxGetComments(dir));
  const q = new URLSearchParams({ dir });
  if (base) q.set("base", base);
  return request(`/api/comments?${q}`);
}

export async function postComment(req: CommentCreateRequest): Promise<Comment> {
  if (isFixture()) return tick((await fx()).fxPostComment(req));
  return request("/api/comments", { method: "POST", body: JSON.stringify(req) });
}

export async function patchComment(id: string, patch: CommentPatchRequest): Promise<Comment> {
  if (isFixture()) return tick((await fx()).fxPatchComment(id, patch));
  return request(`/api/comments/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function putSeen(req: SeenRequest): Promise<{ ok: true }> {
  if (isFixture()) return tick((await fx()).fxPutSeen(req));
  return request("/api/seen", { method: "PUT", body: JSON.stringify(req) });
}

export async function putSeenSegments(req: SeenSegmentsRequest): Promise<{ ok: true }> {
  if (isFixture()) return tick((await fx()).fxPutSeenSegments(req));
  return request("/api/seen-segments", { method: "PUT", body: JSON.stringify(req) });
}

export async function postFetch(req: {
  dir: string;
  base: string;
}): Promise<{ ok: boolean; baseBehind: number | null }> {
  if (isFixture()) return tick((await fx()).fxPostFetch(req));
  return request("/api/fetch", { method: "POST", body: JSON.stringify(req) });
}
