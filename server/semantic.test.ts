import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeSemanticDiff, mapChanges, semAvailable } from "./semantic.ts";
import { git, makeRepo, write } from "./testutil.ts";

const change = (over: Record<string, unknown> = {}) => ({
  changeType: "modified",
  entityType: "function",
  entityName: "alpha",
  startLine: 1,
  endLine: 5,
  oldStartLine: 1,
  oldEndLine: 4,
  oldEntityName: null,
  filePath: "lib.ts",
  ...over,
});

describe("mapChanges", () => {
  it("groups by file and maps fields", () => {
    const files = mapChanges({
      changes: [
        change(),
        change({ entityName: "beta", changeType: "added", oldStartLine: null, oldEndLine: null }),
        change({ filePath: "other.ts", entityName: "gamma" }),
      ],
    });
    assert.equal(files.length, 2);
    const lib = files.find((f) => f.path === "lib.ts")!;
    assert.deepEqual(lib.entities.map((e) => e.name), ["alpha", "beta"]);
    assert.deepEqual(lib.entities[0], {
      entityType: "function",
      name: "alpha",
      change: "modified",
      startLine: 1,
      endLine: 5,
      oldStartLine: 1,
      oldEndLine: 4,
      oldName: null,
    });
  });

  it("drops chunk and orphan records", () => {
    const files = mapChanges({
      changes: [
        change({ entityType: "chunk", entityName: "lines 1-20" }),
        change({ entityType: "orphan", entityName: "module-level" }),
        change(),
      ],
    });
    assert.equal(files.length, 1);
    assert.equal(files[0]!.entities.length, 1);
  });

  it("skips malformed records and unknown change kinds instead of throwing", () => {
    const files = mapChanges({
      changes: [
        { changeType: "modified" }, // no filePath/entityName
        change({ changeType: "exploded" }),
        change({ entityName: 42 }),
        change(),
        "garbage",
        null,
      ],
    });
    assert.equal(files.length, 1);
    assert.equal(files[0]!.entities.length, 1);
  });

  it("returns [] on a payload without a changes array", () => {
    assert.deepEqual(mapChanges({}), []);
    assert.deepEqual(mapChanges(null), []);
    assert.deepEqual(mapChanges({ changes: "no" }), []);
  });

  it("carries the old name through renames", () => {
    const files = mapChanges({
      changes: [change({ changeType: "renamed", entityName: "after", oldEntityName: "before" })],
    });
    assert.equal(files[0]!.entities[0]!.oldName, "before");
  });
});

// Reuses the server's own probe so REV_SEM_BIN and the identity check apply.
const semHere = await semAvailable();

describe("computeSemanticDiff", { skip: !semHere && "sem binary not installed" }, () => {
  it("sees committed and uncommitted entity changes vs merge-base", async () => {
    const dir = makeRepo("semantic", {
      "lib.ts": "export function alpha(a: number) {\n  return a + 1;\n}\n",
    });
    git(dir, "checkout", "-b", "feat");
    write(dir, "lib.ts", "export function alpha(a: number) {\n  return a + 2;\n}\n");
    git(dir, "commit", "-am", "tweak alpha");
    write(
      dir,
      "lib.ts",
      "export function alpha(a: number) {\n  return a + 2;\n}\n\nexport function gamma() {\n  return 42;\n}\n",
    );
    const res = await computeSemanticDiff(dir, "main");
    assert.equal(res.available, true);
    assert.equal(res.mergeBase, git(dir, "rev-parse", "main").trim());
    const lib = res.files.find((f) => f.path === "lib.ts")!;
    const byName = new Map(lib.entities.map((e) => [e.name, e.change]));
    assert.equal(byName.get("alpha"), "modified");
    assert.equal(byName.get("gamma"), "added");
  });

  it("reports clean trees as available with no files", async () => {
    const dir = makeRepo("semantic-clean");
    const res = await computeSemanticDiff(dir, "main");
    assert.equal(res.available, true);
    assert.deepEqual(res.files, []);
  });
});
