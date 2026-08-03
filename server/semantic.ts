/**
 * Entity-level diff via the optional `sem` CLI (Ataraxy-Labs/sem,
 * tree-sitter). sem diffs <merge-base sha> → working tree natively,
 * excluding untracked files, and keeps its own entity cache under the OS
 * cache dir — invocations measured ~20ms, so there is no rev-side cache.
 * Every sem failure (missing binary, crash, timeout, bad JSON) degrades to
 * `available: false` — the UI falls back to text heuristics. A bad base ref
 * still throws GitError → 400, same as every other diff route.
 */

import { spawn } from "node:child_process";
import type {
  EntityChange,
  EntityChangeKind,
  SemanticDiffResponse,
  SemanticFileEntities,
} from "#shared/types";
import { TUNING } from "#shared/tuning";
import { run } from "./git.ts";

const SEM_BIN = process.env.REV_SEM_BIN || "sem";

/** One `sem diff --format json` change record (v0.21); extra fields ignored. */
interface RawChange {
  changeType?: string;
  entityType?: string;
  entityName?: string;
  startLine?: number | null;
  endLine?: number | null;
  oldStartLine?: number | null;
  oldEndLine?: number | null;
  oldEntityName?: string | null;
  filePath?: string;
}

const CHANGE_KINDS = new Set<string>([
  "added",
  "modified",
  "deleted",
  "renamed",
  "moved",
  "reordered",
]);

// "chunk" (line ranges in unsupported files) and "orphan" (module-level code
// outside any entity) carry nothing the hunks don't already show.
const SKIP_TYPES = new Set(["chunk", "orphan"]);

let availability: Promise<boolean> | null = null;

/** Whether the sem binary runs; probed once per process, logged when absent. */
export function semAvailable(): Promise<boolean> {
  availability ??= new Promise((res) => {
    const proc = spawn(SEM_BIN, ["--version"], { stdio: ["ignore", "ignore", "ignore"] });
    proc.on("error", () => {
      console.log(`semantic entity data disabled: ${SEM_BIN} not found`);
      res(false);
    });
    proc.on("close", (code) => res(code === 0));
  });
  return availability;
}

function runSem(dir: string, args: string[]): Promise<string> {
  return new Promise((res, rej) => {
    const proc = spawn(SEM_BIN, args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      rej(new Error(`sem timed out after ${TUNING.SEM_TIMEOUT_MS}ms`));
    }, TUNING.SEM_TIMEOUT_MS);
    proc.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
    proc.stderr.setEncoding("utf8").on("data", (chunk: string) => (err += chunk));
    proc.on("error", (e) => {
      clearTimeout(timer);
      rej(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) rej(new Error(err.trim() || `sem ${args[0]} failed (exit ${code})`));
      else res(out);
    });
  });
}

/**
 * Group raw sem changes into per-file entity lists, dropping non-entity
 * records and anything that doesn't match the expected shape (lenient on
 * schema drift: a bad record is skipped, not fatal).
 */
export function mapChanges(raw: unknown): SemanticFileEntities[] {
  const changes = (raw as { changes?: unknown })?.changes;
  if (!Array.isArray(changes)) return [];
  const byPath = new Map<string, EntityChange[]>();
  for (const c of changes as RawChange[]) {
    if (
      typeof c?.filePath !== "string" ||
      typeof c.entityName !== "string" ||
      typeof c.entityType !== "string" ||
      typeof c.changeType !== "string"
    ) {
      continue;
    }
    if (SKIP_TYPES.has(c.entityType) || !CHANGE_KINDS.has(c.changeType)) continue;
    let list = byPath.get(c.filePath);
    if (!list) byPath.set(c.filePath, (list = []));
    list.push({
      entityType: c.entityType,
      name: c.entityName,
      change: c.changeType as EntityChangeKind,
      startLine: c.startLine ?? null,
      endLine: c.endLine ?? null,
      oldStartLine: c.oldStartLine ?? null,
      oldEndLine: c.oldEndLine ?? null,
      oldName: c.oldEntityName ?? null,
    });
  }
  return [...byPath.entries()].map(([path, entities]) => ({ path, entities }));
}

/** Entity-level diff of `dir`'s working tree vs merge-base(base, HEAD). */
export async function computeSemanticDiff(dir: string, base: string): Promise<SemanticDiffResponse> {
  const unavailable = (mergeBase: string, reason: string): SemanticDiffResponse => ({
    dir,
    base,
    mergeBase,
    available: false,
    reason,
    files: [],
    computedAt: Date.now(),
  });
  if (!(await semAvailable())) return unavailable("", "sem-missing");
  const mergeBase = (await run(dir, ["merge-base", base, "HEAD"])).trim();
  try {
    // Branch names don't resolve through sem's libgit2 revspec; the sha does.
    const out = await runSem(dir, ["diff", "--format", "json", mergeBase]);
    return {
      dir,
      base,
      mergeBase,
      available: true,
      files: mapChanges(JSON.parse(out)),
      computedAt: Date.now(),
    };
  } catch (err) {
    console.error(`sem diff failed in ${dir}: ${(err as Error).message}`);
    return unavailable(mergeBase, "sem-failed");
  }
}
