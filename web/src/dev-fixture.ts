/**
 * In-memory fixture backing the `?fixture` URL flag. Lets the UI run without
 * the server: api.ts routes every call here when the flag is present.
 * Mutations (comments, seen, edits) mutate this module's state so the whole
 * review flow is exercisable offline.
 */

import type {
  Comment,
  CommentCreateRequest,
  CommentPatchRequest,
  DiffLine,
  DiffResponse,
  DiffSummaryResponse,
  FileContentResponse,
  FileDiff,
  FileDiffResponse,
  InterdiffResponse,
  FileWriteRequest,
  RepoInfo,
  SeenRequest,
  CommandsResponse,
  PrListResponse,
  SemanticDiffResponse,
  StackResponse,
  UiSettings,
  WorktreeCreateRequest,
  WorktreeCreateResponse,
} from "#shared/types";
import { DEFAULT_WORKTREE_CMD } from "#shared/commands";

const now = Date.now();
const min = 60_000;

// ---------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------

const day = 24 * 60 * min;

export const fixtureRepos: RepoInfo[] = [
  {
    dir: "/home/naps62/tea/rev",
    name: "rev",
    branch: "spike/always-on-review",
    head: "9c2f41a",
    isWorktree: false,
    mainDir: "/home/naps62/tea/rev",
    defaultBase: "main",
    dirty: true,
    changedFiles: 8,
    additions: 412,
    deletions: 138,
    seenLines: 305,
    openComments: 3,
    lastActivity: now - 2 * min,
    remoteUrl: "https://git.naps.pt/yolo/rev.git",
    scope: "personal",
    aheadBase: 4,
    behindBase: 0,
  },
  {
    dir: "/home/naps62/tea/maestro/fix-auth",
    name: "maestro/fix-auth",
    branch: "fix-auth",
    head: "1b7d902",
    isWorktree: true,
    mainDir: "/home/naps62/tea/maestro",
    defaultBase: "main",
    dirty: true,
    changedFiles: 3,
    additions: 57,
    deletions: 12,
    seenLines: 0,
    openComments: 1,
    lastActivity: now - 34 * min,
    remoteUrl: "https://git.naps.pt/yolo/maestro.git",
    scope: "personal",
    aheadBase: 2,
    behindBase: 5,
  },
  {
    dir: "/home/naps62/tea/maestro/old-spike",
    name: "maestro/old-spike",
    branch: "spike/queue-rework",
    head: "b91c220",
    isWorktree: true,
    mainDir: "/home/naps62/tea/maestro",
    defaultBase: "main",
    dirty: false,
    changedFiles: 0,
    additions: 0,
    deletions: 0,
    seenLines: 0,
    openComments: 0,
    lastActivity: now - 21 * day,
    remoteUrl: "https://git.naps.pt/yolo/maestro.git",
    scope: "personal",
    aheadBase: 0,
    behindBase: 40,
  },
  {
    dir: "/home/naps62/tea/maestro",
    name: "maestro",
    branch: "main",
    head: "e04c7f3",
    isWorktree: false,
    mainDir: "/home/naps62/tea/maestro",
    defaultBase: "main",
    dirty: false,
    changedFiles: 0,
    additions: 0,
    deletions: 0,
    seenLines: 0,
    openComments: 0,
    lastActivity: now - 26 * 60 * min,
    remoteUrl: "https://git.naps.pt/yolo/maestro.git",
    scope: "personal",
    aheadBase: 0,
    behindBase: 0,
  },
  {
    dir: "/home/naps62/tea/dotfiles",
    name: "dotfiles",
    branch: null,
    head: "77aa10c",
    isWorktree: false,
    mainDir: "/home/naps62/tea/dotfiles",
    defaultBase: "master",
    dirty: false,
    changedFiles: null,
    additions: null,
    deletions: null,
    seenLines: null,
    openComments: 0,
    lastActivity: now - 40 * day,
    remoteUrl: null,
    scope: "personal",
    aheadBase: null,
    behindBase: null,
  },
  {
    dir: "/home/naps62/subvisual/content-hub",
    name: "content-hub",
    branch: "main",
    head: "40d91ac",
    isWorktree: false,
    mainDir: "/home/naps62/subvisual/content-hub",
    defaultBase: "main",
    dirty: false,
    changedFiles: 0,
    additions: 0,
    deletions: 0,
    seenLines: 0,
    openComments: 0,
    lastActivity: now - 3 * 60 * min,
    remoteUrl: "git@github.com:subvisual/content-hub.git",
    scope: "subvisual",
    aheadBase: 0,
    behindBase: 0,
  },
  {
    dir: "/home/naps62/subvisual/content-hub-worktrees/cms-import",
    name: "content-hub/cms-import",
    branch: "cms-import",
    head: "8ac0b17",
    isWorktree: true,
    mainDir: "/home/naps62/subvisual/content-hub",
    defaultBase: "main",
    dirty: true,
    changedFiles: 11,
    additions: 980,
    deletions: 214,
    seenLines: 1194,
    openComments: 2,
    lastActivity: now - 55 * min,
    remoteUrl: "git@github.com:subvisual/content-hub.git",
    scope: "subvisual",
    aheadBase: 6,
    behindBase: 2,
  },
  {
    dir: "/home/naps62/subvisual/antseed",
    name: "antseed",
    branch: "main",
    head: "0f21d77",
    isWorktree: false,
    mainDir: "/home/naps62/subvisual/antseed",
    defaultBase: "main",
    dirty: false,
    changedFiles: 0,
    additions: 0,
    deletions: 0,
    seenLines: 0,
    openComments: 0,
    lastActivity: now - 90 * day,
    remoteUrl: "https://github.com/subvisual/antseed",
    scope: "subvisual",
    aheadBase: 0,
    behindBase: 0,
  },
];

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

let ln = 0;
const ctx = (oldLine: number, newLine: number, text: string): DiffLine => ({
  kind: "context",
  oldLine,
  newLine,
  text,
});
const add = (newLine: number, text: string): DiffLine => ({
  kind: "add",
  newLine,
  text,
});
const del = (oldLine: number, text: string): DiffLine => ({
  kind: "del",
  oldLine,
  text,
});
void ln;

const routesFile: FileDiff = {
  path: "server/routes.ts",
  status: "modified",
  binary: false,
  additions: 14,
  deletions: 5,
  contentHash: "f31a9c04",
  seen: false,
  stale: false,
  hunks: [
    {
      oldStart: 12,
      oldLines: 9,
      newStart: 12,
      newLines: 14,
      header: "app.get(\"/api/diff\")",
      lines: [
        ctx(12, 12, "app.get(\"/api/diff\", async (c) => {"),
        ctx(13, 13, "  const dir = c.req.query(\"dir\");"),
        ctx(14, 14, "  const base = c.req.query(\"base\");"),
        del(15, "  if (!dir) return c.json({ error: \"dir required\" }, 400);"),
        add(15, "  if (!dir || !base) {"),
        add(16, "    return c.json({ error: \"dir and base are required\" }, 400);"),
        add(17, "  }"),
        add(18, "  if (!(await isRepo(dir))) {"),
        add(19, "    return c.json({ error: `not a git repo: ${dir}` }, 404);"),
        add(20, "  }"),
        ctx(16, 21, "  const diff = await computeDiff(dir, base);"),
        ctx(17, 22, "  return c.json(diff);"),
        ctx(18, 23, "});"),
      ],
    },
    {
      oldStart: 41,
      oldLines: 10,
      newStart: 46,
      newLines: 14,
      header: "app.put(\"/api/file\")",
      lines: [
        ctx(41, 46, "app.put(\"/api/file\", async (c) => {"),
        ctx(42, 47, "  const body = (await c.req.json()) as FileWriteRequest;"),
        del(43, "  await Bun.write(join(body.dir, body.path), body.content);"),
        del(44, "  return c.json({ ok: true });"),
        add(48, "  const current = await hashWorkingTree(body.dir, body.path);"),
        add(49, "  if (current !== body.baseHash) {"),
        add(50, "    return c.json({ error: \"file changed underneath you\" }, 409);"),
        add(51, "  }"),
        add(52, "  await Bun.write(join(body.dir, body.path), body.content);"),
        add(53, "  return c.json(await readFileContent(body.dir, body.path));"),
        ctx(45, 54, "});"),
      ],
    },
    {
      oldStart: 88,
      oldLines: 6,
      newStart: 97,
      newLines: 7,
      header: "app.put(\"/api/seen\")",
      lines: [
        ctx(88, 97, "app.put(\"/api/seen\", async (c) => {"),
        ctx(89, 98, "  const body = (await c.req.json()) as SeenRequest;"),
        del(90, "  db.markSeen(body.dir, body.path, body.contentHash);"),
        add(99, "  db.markSeen(body.dir, body.base, body.path, body.contentHash, body.seen);"),
        add(100, "  broadcast({ type: \"comments-changed\", dir: body.dir, seq: db.seq() });"),
        ctx(91, 101, "  return c.json({ ok: true });"),
        ctx(92, 102, "});"),
      ],
    },
  ],
};

const watcherFile: FileDiff = {
  path: "server/watcher.ts",
  status: "added",
  binary: false,
  additions: 24,
  deletions: 0,
  contentHash: "a80be112",
  seen: false,
  stale: false,
  hunks: [
    {
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: 24,
      header: "",
      lines: [
        add(1, "import { watch, type FSWatcher } from \"chokidar\";"),
        add(2, "import { TUNING } from \"#shared/tuning\";"),
        add(3, ""),
        add(4, "const watchers = new Map<string, FSWatcher>();"),
        add(5, "const timers = new Map<string, ReturnType<typeof setTimeout>>();"),
        add(6, ""),
        add(7, "export function ensureWatch(dir: string, onInvalidate: (paths: string[]) => void) {"),
        add(8, "  if (watchers.has(dir)) return;"),
        add(9, "  const pending = new Set<string>();"),
        add(10, "  const w = watch(dir, {"),
        add(11, "    ignored: TUNING.WATCH_IGNORE.map((d) => `**/${d}/**`),"),
        add(12, "    ignoreInitial: true,"),
        add(13, "  });"),
        add(14, "  w.on(\"all\", (_event, path) => {"),
        add(15, "    pending.add(path);"),
        add(16, "    clearTimeout(timers.get(dir));"),
        add(17, "    timers.set(dir, setTimeout(() => {"),
        add(18, "      onInvalidate([...pending]);"),
        add(19, "      pending.clear();"),
        add(20, "    }, TUNING.WATCH_DEBOUNCE_MS));"),
        add(21, "  });"),
        add(22, "  watchers.set(dir, w);"),
        add(23, "}"),
        add(24, ""),
      ],
    },
  ],
};

const dbFile: FileDiff = {
  path: "server/db.ts",
  status: "modified",
  binary: false,
  additions: 7,
  deletions: 2,
  contentHash: "77e02c9d",
  seen: false,
  stale: true,
  hunks: [
    {
      oldStart: 30,
      oldLines: 7,
      newStart: 30,
      newLines: 12,
      header: "export function markSeen",
      lines: [
        ctx(30, 30, "export function markSeen("),
        ctx(31, 31, "  dir: string,"),
        add(32, "  base: string,"),
        ctx(32, 33, "  path: string,"),
        ctx(33, 34, "  contentHash: string,"),
        add(35, "  seen: boolean,"),
        ctx(34, 36, ") {"),
        del(35, "  insertSeen.run(dir, path, contentHash);"),
        add(37, "  if (seen) {"),
        add(38, "    insertSeen.run(dir, base, path, contentHash);"),
        add(39, "  } else {"),
        add(40, "    deleteSeen.run(dir, base, path);"),
        add(41, "  }"),
        ctx(36, 42, "}"),
      ],
    },
  ],
};

const renamedFile: FileDiff = {
  path: "server/job-queue.ts",
  oldPath: "server/queue.ts",
  status: "renamed",
  binary: false,
  additions: 2,
  deletions: 2,
  contentHash: "0d99c1b6",
  seen: false,
  stale: false,
  hunks: [
    {
      oldStart: 4,
      oldLines: 5,
      newStart: 4,
      newLines: 5,
      header: "export class JobQueue",
      lines: [
        ctx(4, 4, "export class JobQueue<T> {"),
        del(5, "  private items: T[] = [];"),
        del(6, "  private draining = false;"),
        add(5, "  #items: T[] = [];"),
        add(6, "  #draining = false;"),
        ctx(7, 7, ""),
        ctx(8, 8, "  push(item: T) {"),
      ],
    },
  ],
};

const deletedFile: FileDiff = {
  path: "server/poller.ts",
  status: "deleted",
  binary: false,
  additions: 0,
  deletions: 12,
  contentHash: "",
  seen: false,
  stale: false,
  hunks: [
    {
      oldStart: 1,
      oldLines: 12,
      newStart: 0,
      newLines: 0,
      header: "",
      lines: [
        del(1, "/** Replaced by the chokidar watcher; polling burned CPU for nothing. */"),
        del(2, "export function startPolling(dir: string, intervalMs: number) {"),
        del(3, "  const timer = setInterval(async () => {"),
        del(4, "    const head = await gitHead(dir);"),
        del(5, "    if (head !== lastHead.get(dir)) {"),
        del(6, "      lastHead.set(dir, head);"),
        del(7, "      invalidate(dir);"),
        del(8, "    }"),
        del(9, "  }, intervalMs);"),
        del(10, "  timers.set(dir, timer);"),
        del(11, "  return () => clearInterval(timer);"),
        del(12, "}"),
      ],
    },
  ],
};

const untrackedFile: FileDiff = {
  path: "scripts/seed-db.ts",
  status: "untracked",
  binary: false,
  additions: 13,
  deletions: 0,
  contentHash: "5be00c31",
  seen: false,
  stale: false,
  hunks: [
    {
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: 13,
      header: "",
      lines: [
        add(1, "#!/usr/bin/env bun"),
        add(2, "/** Seeds a throwaway comments DB for local UI work. */"),
        add(3, "import { Database } from \"bun:sqlite\";"),
        add(4, ""),
        add(5, "const db = new Database(process.env.REV_DB ?? \"/tmp/rev-seed.db\");"),
        add(6, "db.run(`CREATE TABLE IF NOT EXISTS comments ("),
        add(7, "  id TEXT PRIMARY KEY, dir TEXT, base TEXT, body TEXT,"),
        add(8, "  author TEXT, created_at INTEGER, resolved_at INTEGER"),
        add(9, ")`);"),
        add(10, ""),
        add(11, "for (let i = 0; i < 20; i++) {"),
        add(12, "  db.run(\"INSERT INTO comments VALUES (?, ?, ?, ?, ?, ?, NULL)\", [crypto.randomUUID(), \"/tmp/repo\", \"main\", `note ${i}`, i % 2 ? \"agent\" : \"user\", Date.now()]);"),
        add(13, "}"),
      ],
    },
  ],
};

// `web/` holds BOTH files and subdirectories — nested DirRows in the file
// rail regressed once (infinite recursion via a spread `node` prop); this
// shape keeps the fixture exercising it.
const viteConfigFile: FileDiff = {
  path: "web/vite.config.ts",
  status: "modified",
  binary: false,
  additions: 2,
  deletions: 2,
  contentHash: "b2d90e4a",
  seen: false,
  stale: false,
  hunks: [
    {
      oldStart: 5,
      oldLines: 5,
      newStart: 5,
      newLines: 5,
      header: "export default defineConfig",
      lines: [
        ctx(5, 5, "export default defineConfig({"),
        del(6, "  plugins: [react()],"),
        del(7, "  server: { port: 5173 },"),
        add(6, "  plugins: [react(), tailwindcss()],"),
        add(7, "  server: { port: 5173, host: \"0.0.0.0\" },"),
        ctx(8, 8, "});"),
      ],
    },
  ],
};

const hooksFile: FileDiff = {
  path: "web/src/hooks.ts",
  status: "modified",
  binary: false,
  additions: 2,
  deletions: 2,
  contentHash: "3c7f21d9",
  seen: false,
  stale: false,
  hunks: [
    {
      oldStart: 10,
      oldLines: 6,
      newStart: 10,
      newLines: 6,
      header: "export function useDebounced",
      lines: [
        ctx(10, 10, "export function useDebounced<T>(value: T, ms: number): T {"),
        ctx(11, 11, "  const [debounced, setDebounced] = useState(value);"),
        ctx(12, 12, "  useEffect(() => {"),
        del(13, "    const t = setTimeout(() => setDebounced(value), ms);"),
        del(14, "    return () => clearTimeout(t);"),
        add(13, "    const timer = setTimeout(() => setDebounced(value), ms);"),
        add(14, "    return () => clearTimeout(timer);"),
        ctx(15, 15, "  }, [value, ms]);"),
      ],
    },
  ],
};

const binaryFile: FileDiff = {
  path: "web/public/favicon.png",
  status: "modified",
  binary: true,
  additions: 0,
  deletions: 0,
  contentHash: "9a11f0d2",
  seen: false,
  stale: false,
  hunks: [],
};

const seenFile: FileDiff = {
  path: "shared/tuning.ts",
  status: "modified",
  binary: false,
  additions: 1,
  deletions: 1,
  contentHash: "c4d1a77e",
  seen: true,
  stale: false,
  hunks: [
    {
      oldStart: 27,
      oldLines: 3,
      newStart: 27,
      newLines: 3,
      header: "export const TUNING",
      lines: [
        ctx(27, 27, "  /** Files above this many changed lines render collapsed by default. */"),
        del(28, "  COLLAPSE_THRESHOLD_LINES: 200,"),
        add(28, "  COLLAPSE_THRESHOLD_LINES: 400,"),
        ctx(29, 29, ""),
      ],
    },
  ],
};

/** A large generated file (hundreds of changed lines). */
function makeGeneratedFile(): FileDiff {
  const lines: DiffLine[] = [];
  lines.push(ctx(1, 1, "/* AUTO-GENERATED by scripts/gen-schema.ts — do not edit. */"));
  lines.push(ctx(2, 2, "import { z } from \"zod\";"));
  lines.push(ctx(3, 3, ""));
  for (let i = 0; i < 12; i++) {
    lines.push(del(4 + i, `export const LegacyRow${i} = z.object({ id: z.string() });`));
  }
  let n = 4;
  const entities = ["Repo", "Diff", "Hunk", "Line", "Comment", "Anchor", "Seen", "Session", "Event", "Cursor"];
  for (let e = 0; e < entities.length; e++) {
    for (let f = 0; f < 42; f++) {
      const name = `${entities[e]}Field${f}`;
      lines.push(add(n++, `export const ${name} = z.object({`));
      lines.push(add(n++, `  id: z.string().uuid(),`));
      lines.push(add(n++, `  value: z.number().int().min(0).max(${(f + 1) * 100}),`));
      lines.push(add(n++, `});`));
    }
  }
  const additions = lines.filter((l) => l.kind === "add").length;
  const deletions = lines.filter((l) => l.kind === "del").length;
  return {
    path: "shared/generated/schema.ts",
    status: "modified",
    binary: false,
    additions,
    deletions,
    contentHash: "e5f60b88",
    seen: false,
    stale: false,
    hunks: [
      {
        oldStart: 1,
        oldLines: 3 + deletions,
        newStart: 1,
        newLines: 3 + additions,
        header: "",
        lines,
      },
    ],
  };
}

const state = {
  diff: {
    dir: "/home/naps62/tea/rev",
    base: "main",
    mergeBase: "4f0a9e2c1d773605",
    head: "9c2f41a",
    branch: "spike/always-on-review",
    files: [
      routesFile,
      watcherFile,
      dbFile,
      renamedFile,
      deletedFile,
      untrackedFile,
      viteConfigFile,
      hooksFile,
      binaryFile,
      seenFile,
      makeGeneratedFile(),
    ],
    computedAt: now,
    baseBehind: 3,
  } as DiffResponse,
  comments: [] as Comment[],
  seq: 0,
};

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

function seedComment(
  c: Omit<Comment, "id" | "seq" | "dir" | "base" | "status" | "submittedSeq"> & {
    id?: string;
    base?: string;
    status?: Comment["status"];
  },
): Comment {
  const seq = ++state.seq;
  const status = c.status ?? "picked_up";
  const full: Comment = {
    id: c.id ?? `fx-${seq}`,
    dir: state.diff.dir,
    base: c.base ?? state.diff.base,
    seq,
    anchor: c.anchor,
    parentId: c.parentId,
    author: c.author,
    body: c.body,
    createdAt: c.createdAt,
    resolvedAt: c.resolvedAt,
    resolvedLine: c.resolvedLine,
    status,
    submittedSeq: status === "pending" ? null : seq,
  };
  state.comments.push(full);
  return full;
}

const t1 = seedComment({
  anchor: {
    file: "server/routes.ts",
    side: "new",
    line: 50,
    snippet: "return c.json({ error: \"file changed underneath you\" }, 409);",
  },
  parentId: null,
  author: "user",
  body: "409 body should include the current hash so the client can offer a three-way view later. Not blocking for the spike.",
  createdAt: now - 42 * min,
  resolvedAt: null,
});
seedComment({
  anchor: null,
  parentId: t1.id,
  author: "agent",
  body: "Good call — added `currentHash` to the 409 payload in the follow-up commit. The client can ignore it for now.",
  createdAt: now - 38 * min,
  resolvedAt: null,
});

const t2 = seedComment({
  anchor: {
    file: "server/watcher.ts",
    side: "new",
    line: 11,
    snippet: "ignored: TUNING.WATCH_IGNORE.map((d) => `**/${d}/**`),",
  },
  parentId: null,
  author: "user",
  body: "This glob won't match a top-level `node_modules` (no leading segment). Use `**/{${list}}/**` or pass a function matcher.",
  createdAt: now - 20 * min,
  resolvedAt: null,
  resolvedLine: 11,
});
seedComment({
  anchor: null,
  parentId: t2.id,
  author: "agent",
  body: "Good catch — switched to a **function matcher** so depth stops mattering:\n\n```ts\nignored: (p) => TUNING.WATCH_IGNORE.some((d) => p.includes(`/${d}/`)),\n```\n\nThe glob form also missed *dotted* dirs like `.next`. Chokidar docs on filtering: https://github.com/paulmillr/chokidar#path-filtering.",
  createdAt: now - 12 * min,
  resolvedAt: null,
});

// Re-anchored: written when the seen handler sat at line 95; edits above
// pushed it to 97. resolvedLine places it on the current line.
seedComment({
  anchor: {
    file: "server/routes.ts",
    side: "new",
    line: 95,
    snippet: "app.put(\"/api/seen\", async (c) => {",
  },
  parentId: null,
  author: "user",
  body: "Should seen-toggles really broadcast `comments-changed`? A dedicated event would keep clients from refetching comments they already have.",
  createdAt: now - 90 * min,
  resolvedAt: null,
  resolvedLine: 97,
});

// Orphaned: the anchored line was deleted since; resolvedLine is null and
// line 300 isn't in the diff, so it lands in the per-file detached section.
seedComment({
  anchor: {
    file: "server/routes.ts",
    side: "new",
    line: 300,
    snippet: "const LEGACY_TIMEOUT = 5_000;",
  },
  parentId: null,
  author: "user",
  body: "This timeout constant is unused — delete it.",
  createdAt: now - 5 * 60 * min,
  resolvedAt: null,
  resolvedLine: null,
});

// From an earlier review against another base — still shown, tagged.
seedComment({
  base: "develop",
  anchor: {
    file: "server/watcher.ts",
    side: "new",
    line: 4,
    snippet: "const watchers = new Map<string, FSWatcher>();",
  },
  parentId: null,
  author: "agent",
  body: "Watchers are never closed on repo removal — leak is bounded by repo count, deferring cleanup to the follow-up.",
  createdAt: now - 26 * 60 * min,
  resolvedAt: null,
  resolvedLine: 4,
});

const resolved = seedComment({
  anchor: {
    file: "server/job-queue.ts",
    side: "new",
    line: 5,
    snippet: "#items: T[] = [];",
  },
  parentId: null,
  author: "agent",
  body: "Renamed queue.ts to job-queue.ts and switched to native private fields while touching it — flagging in case the rename churn is unwanted.",
  createdAt: now - 3 * 60 * min,
  resolvedAt: now - 50 * min,
});
seedComment({
  anchor: null,
  parentId: resolved.id,
  author: "user",
  body: "Rename is fine, keep it.",
  createdAt: now - 55 * min,
  resolvedAt: null,
});

seedComment({
  anchor: null,
  parentId: null,
  author: "agent",
  body: "Review scope: watcher + seen-state plumbing. schema.ts is generated churn — safe to mark seen without reading.",
  createdAt: now - 60 * min,
  resolvedAt: null,
});

// ---------------------------------------------------------------------------
// Fixture "API"
// ---------------------------------------------------------------------------

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

export function fxGetRepos(): RepoInfo[] {
  return clone(fixtureRepos);
}

export function fxGetPrs(dir: string): PrListResponse {
  const repo = fixtureRepos.find((r) => r.dir === dir);
  if (!repo || repo.remoteUrl === null) return { dir, prs: null };
  const checkouts = new Map(
    fixtureRepos.filter((r) => r.mainDir === repo.mainDir && r.branch).map((r) => [r.branch!, r.dir]),
  );
  const prs = [
    {
      number: 47,
      title: "feat: session hooks for the comment watcher",
      branch: "session-hooks",
      url: "https://example.com/pr/47",
      author: "naps62",
      draft: false,
    },
    {
      number: 52,
      title: "wip: entity-level folding",
      branch: "entity-folding",
      url: "https://example.com/pr/52",
      author: "naps62",
      draft: true,
    },
  ];
  return { dir, prs: prs.map((p) => ({ ...p, checkoutDir: checkouts.get(p.branch) ?? null })) };
}

export function fxCreateWorktree(req: WorktreeCreateRequest): WorktreeCreateResponse {
  return { dir: `${req.dir}/worktrees/${req.branch}`, branch: req.branch };
}

let fxWorktreeCmd = DEFAULT_WORKTREE_CMD;

export function fxGetCommands(): CommandsResponse {
  return { worktreeCreate: fxWorktreeCmd };
}

export function fxPutCommands(req: CommandsResponse): CommandsResponse {
  fxWorktreeCmd = req.worktreeCreate;
  return { worktreeCreate: fxWorktreeCmd };
}

let fxUiSettings: UiSettings = {};

export function fxGetSettings(): UiSettings {
  return fxUiSettings;
}

export function fxPutSettings(req: UiSettings): UiSettings {
  fxUiSettings = req;
  return fxUiSettings;
}

export function fxGetDiff(dir: string, base: string): DiffResponse {
  if (dir !== state.diff.dir) {
    throw Object.assign(new Error(`not a git repo: ${dir}`), { status: 404 });
  }
  if (base !== state.diff.base) {
    throw Object.assign(new Error(`unknown ref: ${base}`), { status: 400 });
  }
  return clone(state.diff);
}

export function fxGetDiffSummary(dir: string, base: string): DiffSummaryResponse {
  const full = fxGetDiff(dir, base);
  return { ...full, files: full.files.map(({ hunks: _hunks, ...summary }) => summary) };
}

export function fxGetFileDiff(dir: string, base: string, path: string): FileDiffResponse {
  const full = fxGetDiff(dir, base);
  const file = full.files.find((f) => f.path === path);
  if (!file) throw Object.assign(new Error(`no changes for ${path}`), { status: 404 });
  return {
    dir,
    base,
    file,
    computedAt: Date.now(),
  };
}

export function fxGetSemanticDiff(dir: string, base: string): SemanticDiffResponse {
  const full = fxGetDiff(dir, base); // validates dir/base like the server would
  return {
    dir: full.dir,
    base: full.base,
    mergeBase: full.mergeBase,
    available: true,
    computedAt: Date.now(),
    files: [
      {
        path: "server/routes.ts",
        entities: [
          { entityType: "function", name: "diffRoute", change: "modified", startLine: 12, endLine: 23, oldStartLine: 12, oldEndLine: 18, oldName: null },
          { entityType: "function", name: "putFile", change: "modified", startLine: 46, endLine: 54, oldStartLine: 41, oldEndLine: 45, oldName: null },
          { entityType: "function", name: "putSeen", change: "renamed", startLine: 97, endLine: 102, oldStartLine: 88, oldEndLine: 92, oldName: "markSeen" },
        ],
      },
      {
        path: "server/watcher.ts",
        entities: [
          { entityType: "function", name: "startWatcher", change: "added", startLine: 1, endLine: 18, oldStartLine: null, oldEndLine: null, oldName: null },
          { entityType: "function", name: "stopWatcher", change: "added", startLine: 20, endLine: 24, oldStartLine: null, oldEndLine: null, oldName: null },
        ],
      },
      {
        path: "server/poller.ts",
        entities: [
          { entityType: "function", name: "poll", change: "deleted", startLine: null, endLine: null, oldStartLine: 3, oldEndLine: 31, oldName: null },
        ],
      },
    ],
  };
}

export function fxGetRefs(dir: string): { dir: string; refs: string[] } {
  return { dir, refs: ["main", "develop", "origin/main", "origin/develop", "spike/always-on-review"] };
}

export function fxGetStack(dir: string, base: string): StackResponse {
  return {
    dir,
    base,
    segments: [
      { branch: "spike/always-on-review", head: "9c2f41ab01de", commits: 4, checkoutDir: dir, parent: "spike/queue-rework" },
      { branch: "spike/queue-rework", head: "b91c220f7742", commits: 2, checkoutDir: "/home/naps62/tea/maestro/old-spike", parent: "fix-auth" },
      { branch: "fix-auth", head: "1b7d90233aa8", commits: 3, checkoutDir: null, parent: base },
    ],
    computedAt: now,
  };
}

/** Stale fixture file (server/db.ts) gets a small delta since seen. */
export function fxGetInterdiff(dir: string, base: string, path: string): InterdiffResponse {
  const f = state.diff.files.find((x) => x.path === path);
  if (!f || !f.stale) {
    throw Object.assign(new Error(`no seen snapshot for ${path}`), { status: 404 });
  }
  return {
    dir,
    base,
    path,
    sinceHash: "77e02c9c",
    file: {
      ...clone(f),
      hunks: [
        {
          oldStart: 36,
          oldLines: 4,
          newStart: 36,
          newLines: 6,
          header: "export function markSeen",
          lines: [
            ctx(36, 36, ") {"),
            del(37, "  if (seen) {"),
            add(37, "  // idempotent: re-marking refreshes the stored hash"),
            add(38, "  if (seen) {"),
            add(39, "    deleteSeen.run(dir, base, path);"),
            ctx(38, 40, "    insertSeen.run(dir, base, path, contentHash);"),
          ],
        },
      ],
      additions: 3,
      deletions: 1,
    },
  };
}

export function fxGetComments(dir: string): { comments: Comment[]; cursor: number } {
  void dir;
  return { comments: clone(state.comments), cursor: state.seq };
}

export function fxPostComment(req: CommentCreateRequest): Comment {
  const seq = ++state.seq;
  const c: Comment = {
    id: `fx-${seq}`,
    dir: req.dir,
    base: req.base,
    anchor: req.anchor ?? null,
    parentId: req.parentId ?? null,
    author: req.author,
    body: req.body,
    createdAt: Date.now(),
    resolvedAt: null,
    seq,
    resolvedLine: req.anchor ? req.anchor.line : undefined,
    status: req.pending ? "pending" : "submitted",
    submittedSeq: req.pending ? null : seq,
  };
  state.comments.push(c);
  return clone(c);
}

export function fxSubmitComments(dir: string): { submitted: number; cursor: number } {
  void dir;
  const pending = state.comments
    .filter((c) => c.status === "pending")
    .sort((a, b) => a.seq - b.seq);
  for (const c of pending) {
    c.status = "submitted";
    c.submittedSeq = ++state.seq;
  }
  return { submitted: pending.length, cursor: state.seq };
}

export function fxPostFetch(req: {
  dir: string;
  base: string;
}): { ok: boolean; baseBehind: number | null } {
  void req;
  state.diff.baseBehind = 0;
  return { ok: true, baseBehind: 0 };
}

export function fxPatchComment(id: string, patch: CommentPatchRequest): Comment {
  const c = state.comments.find((x) => x.id === id);
  if (!c) throw Object.assign(new Error(`no such comment: ${id}`), { status: 404 });
  if (patch.body !== undefined) c.body = patch.body;
  if (patch.resolved !== undefined) c.resolvedAt = patch.resolved ? Date.now() : null;
  state.seq++;
  return clone(c);
}

export function fxPutSeen(req: SeenRequest): { ok: true } {
  const f = state.diff.files.find((x) => x.path === req.path);
  if (f) {
    f.seen = req.seen;
    f.stale = false;
  }
  return { ok: true };
}

const fileContents = new Map<string, string>([
  [
    "server/watcher.ts",
    (watcherFile.hunks[0]?.lines ?? []).map((l) => l.text).join("\n"),
  ],
]);

export function fxGetFile(dir: string, path: string): FileContentResponse {
  const f = state.diff.files.find((x) => x.path === path);
  const content =
    fileContents.get(path) ??
    f?.hunks
      .flatMap((h) => h.lines.filter((l) => l.kind !== "del").map((l) => l.text))
      .join("\n") ??
    `// ${path}\n`;
  return {
    dir,
    path,
    rev: null,
    content,
    contentHash: f?.contentHash ?? "0000000",
  };
}

export function fxPutFile(req: FileWriteRequest): FileContentResponse {
  const f = state.diff.files.find((x) => x.path === req.path);
  if (f && f.contentHash !== req.baseHash) {
    throw Object.assign(new Error("file changed underneath you"), { status: 409 });
  }
  fileContents.set(req.path, req.content);
  const newHash = `wr${(state.seq++).toString(16).padStart(6, "0")}`;
  if (f) {
    f.contentHash = newHash;
    if (f.seen) {
      f.seen = false;
      f.stale = true;
    }
  }
  return { dir: req.dir, path: req.path, rev: null, content: req.content, contentHash: newHash };
}
