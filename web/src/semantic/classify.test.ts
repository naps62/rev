import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FileSummary } from "#shared/types";
import { buildClassSections, classifyFile } from "./classify.ts";

describe("classifyFile", () => {
  it("classifies tests before anything else", () => {
    assert.equal(classifyFile("server/git.test.ts"), "tests");
    assert.equal(classifyFile("tests/fixtures/big.json"), "tests");
    assert.equal(classifyFile("src/__tests__/util.ts"), "tests");
    assert.equal(classifyFile("test/Vault.t.sol"), "tests");
    assert.equal(classifyFile("pkg/test_helpers.py"), "tests");
    assert.equal(classifyFile("web/Button.stories.tsx"), "tests");
  });

  it("classifies lockfiles and build output as generated", () => {
    assert.equal(classifyFile("pnpm-lock.yaml"), "generated");
    assert.equal(classifyFile("Cargo.lock"), "generated");
    assert.equal(classifyFile("web/dist/index.js"), "generated");
    assert.equal(classifyFile("src/__snapshots__/a.snap"), "generated");
    assert.equal(classifyFile("api/schema.gen.ts"), "generated");
  });

  it("classifies docs", () => {
    assert.equal(classifyFile("README.md"), "docs");
    assert.equal(classifyFile("docs/ARCHITECTURE.md"), "docs");
    assert.equal(classifyFile("LICENSE"), "docs");
    assert.equal(classifyFile("notes.txt"), "docs");
  });

  it("classifies tooling and config", () => {
    assert.equal(classifyFile(".github/workflows/ci.yml"), "config");
    assert.equal(classifyFile("package.json"), "config");
    assert.equal(classifyFile(".gitignore"), "config");
    assert.equal(classifyFile("Dockerfile"), "config");
    assert.equal(classifyFile("vite.config.ts"), "config");
    assert.equal(classifyFile("systemd/rev.service"), "config");
  });

  it("defaults to code", () => {
    assert.equal(classifyFile("server/git.ts"), "code");
    assert.equal(classifyFile("src/lib.rs"), "code");
    assert.equal(classifyFile("contracts/Vault.sol"), "code");
    assert.equal(classifyFile("app/main.py"), "code");
  });

  it("precedence: tests beat docs and config paths", () => {
    assert.equal(classifyFile("docs/example.test.ts"), "tests");
    assert.equal(classifyFile(".github/scripts/deploy.test.ts"), "tests");
  });
});

const file = (path: string): FileSummary => ({
  path,
  status: "modified",
  binary: false,
  additions: 1,
  deletions: 0,
  contentHash: "x",
  seen: false,
  stale: false,
});

describe("buildClassSections", () => {
  it("orders sections code → tests → config → docs → generated, omitting empties", () => {
    const sections = buildClassSections([
      file("README.md"),
      file("server/git.ts"),
      file("pnpm-lock.yaml"),
      file("server/git.test.ts"),
    ]);
    assert.deepEqual(
      sections.map((s) => s.cls),
      ["code", "tests", "docs", "generated"],
    );
    assert.deepEqual(sections[0]!.files.map((f) => f.path), ["server/git.ts"]);
  });
});
