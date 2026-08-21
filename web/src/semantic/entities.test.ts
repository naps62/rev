import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EntityChange } from "#shared/types";
import { entityAnchor, entityLabel } from "./entities.ts";

const e = (over: Partial<EntityChange>): EntityChange => ({
  entityType: "function",
  name: "alpha",
  change: "modified",
  startLine: 10,
  endLine: 20,
  oldStartLine: 8,
  oldEndLine: 18,
  oldName: null,
  ...over,
});

describe("entityAnchor", () => {
  it("prefers the new side", () => {
    assert.deepEqual(entityAnchor(e({})), { side: "new", line: 10 });
  });
  it("falls back to the old side for deletes", () => {
    assert.deepEqual(
      entityAnchor(e({ change: "deleted", startLine: null, endLine: null })),
      {
        side: "old",
        line: 8,
      },
    );
  });
  it("returns null with no range at all", () => {
    assert.equal(
      entityAnchor(e({ startLine: null, oldStartLine: null })),
      null,
    );
  });
});

describe("entityLabel", () => {
  it("shows renames as before → after", () => {
    assert.equal(
      entityLabel(e({ change: "renamed", name: "b", oldName: "a" })),
      "a → b",
    );
  });
  it("is just the name otherwise", () => {
    assert.equal(entityLabel(e({})), "alpha");
  });
});
