import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EntityChange } from "#shared/types";
import { bucketOf, buildRollup } from "./rollup.ts";

const e = (over: Partial<EntityChange>): EntityChange => ({
  entityType: "function",
  name: "alpha",
  change: "added",
  startLine: 1,
  endLine: 5,
  oldStartLine: null,
  oldEndLine: null,
  oldName: null,
  ...over,
});

describe("bucketOf", () => {
  it("maps sem entity types to coarse buckets", () => {
    assert.equal(bucketOf("function"), "functions");
    assert.equal(bucketOf("method"), "functions");
    assert.equal(bucketOf("struct"), "types");
    assert.equal(bucketOf("impl"), "types");
    assert.equal(bucketOf("constant"), "values");
    assert.equal(bucketOf("test"), "tests");
    assert.equal(bucketOf("section"), "other");
  });
});

describe("buildRollup", () => {
  it("groups by bucket × change in display order", () => {
    const groups = buildRollup([
      { path: "a.ts", entities: [e({}), e({ name: "beta", change: "modified" })] },
      { path: "b.ts", entities: [e({ name: "gamma" }), e({ entityType: "struct", name: "S" })] },
    ]);
    assert.deepEqual(
      groups.map((g) => [g.bucket, g.change, g.items.length]),
      [
        ["functions", "added", 2],
        ["functions", "modified", 1],
        ["types", "added", 1],
      ],
    );
    assert.deepEqual(groups[0]!.items.map((i) => i.path), ["a.ts", "b.ts"]);
  });
});
