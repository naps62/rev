import { describe, expect, test } from "bun:test";
import { parseUnifiedDiff } from "./diff-parser";

describe("parseUnifiedDiff", () => {
  test("empty input", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });

  test("simple modification with line numbers", () => {
    const diff = [
      "diff --git a/src/app.ts b/src/app.ts",
      "index 1111111..2222222 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,4 +1,4 @@ function main",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      " const c = 4;",
      " const d = 5;",
      "",
    ].join("\n");
    const [f] = parseUnifiedDiff(diff);
    expect(f).toBeDefined();
    expect(f!.path).toBe("src/app.ts");
    expect(f!.status).toBe("modified");
    expect(f!.binary).toBe(false);
    expect(f!.additions).toBe(1);
    expect(f!.deletions).toBe(1);
    expect(f!.hunks).toHaveLength(1);
    const h = f!.hunks[0]!;
    expect(h.oldStart).toBe(1);
    expect(h.oldLines).toBe(4);
    expect(h.newStart).toBe(1);
    expect(h.newLines).toBe(4);
    expect(h.header).toBe("function main");
    expect(h.lines).toEqual([
      { kind: "context", oldLine: 1, newLine: 1, text: "const a = 1;" },
      { kind: "del", oldLine: 2, text: "const b = 2;" },
      { kind: "add", newLine: 2, text: "const b = 3;" },
      { kind: "context", oldLine: 3, newLine: 3, text: "const c = 4;" },
      { kind: "context", oldLine: 4, newLine: 4, text: "const d = 5;" },
    ]);
  });

  test("added and deleted files", () => {
    const diff = [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "index 0000000..3333333",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+hello",
      "+world",
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "index 4444444..0000000",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "",
    ].join("\n");
    const [added, deleted] = parseUnifiedDiff(diff);
    expect(added!.status).toBe("added");
    expect(added!.path).toBe("new.txt");
    expect(added!.hunks[0]!.oldStart).toBe(0);
    expect(added!.hunks[0]!.oldLines).toBe(0);
    expect(added!.additions).toBe(2);
    expect(added!.hunks[0]!.lines.map((l) => l.newLine)).toEqual([1, 2]);
    expect(deleted!.status).toBe("deleted");
    expect(deleted!.path).toBe("gone.txt");
    // "@@ -1 +0,0 @@": omitted count defaults to 1
    expect(deleted!.hunks[0]!.oldLines).toBe(1);
    expect(deleted!.hunks[0]!.newLines).toBe(0);
    expect(deleted!.deletions).toBe(1);
  });

  test("rename + edit", () => {
    const diff = [
      "diff --git a/old/name.ts b/new/name.ts",
      "similarity index 90%",
      "rename from old/name.ts",
      "rename to new/name.ts",
      "index 5555555..6666666 100644",
      "--- a/old/name.ts",
      "+++ b/new/name.ts",
      "@@ -10,3 +10,4 @@",
      " keep",
      "+added line",
      " keep2",
      " keep3",
      "",
    ].join("\n");
    const [f] = parseUnifiedDiff(diff);
    expect(f!.status).toBe("renamed");
    expect(f!.path).toBe("new/name.ts");
    expect(f!.oldPath).toBe("old/name.ts");
    expect(f!.additions).toBe(1);
    expect(f!.hunks[0]!.lines[1]).toEqual({ kind: "add", newLine: 11, text: "added line" });
  });

  test("pure rename (no hunks)", () => {
    const diff = [
      "diff --git a/a.txt b/b.txt",
      "similarity index 100%",
      "rename from a.txt",
      "rename to b.txt",
      "",
    ].join("\n");
    const [f] = parseUnifiedDiff(diff);
    expect(f!.status).toBe("renamed");
    expect(f!.path).toBe("b.txt");
    expect(f!.oldPath).toBe("a.txt");
    expect(f!.hunks).toEqual([]);
  });

  test("binary file", () => {
    const diff = [
      "diff --git a/img.png b/img.png",
      "index 7777777..8888888 100644",
      "Binary files a/img.png and b/img.png differ",
      "",
    ].join("\n");
    const [f] = parseUnifiedDiff(diff);
    expect(f!.binary).toBe(true);
    expect(f!.path).toBe("img.png");
    expect(f!.hunks).toEqual([]);
  });

  test("no trailing newline marker is skipped", () => {
    const diff = [
      "diff --git a/x b/x",
      "index 1..2 100644",
      "--- a/x",
      "+++ b/x",
      "@@ -1 +1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const [f] = parseUnifiedDiff(diff);
    expect(f!.hunks[0]!.lines).toEqual([
      { kind: "del", oldLine: 1, text: "old" },
      { kind: "add", newLine: 1, text: "new" },
    ]);
  });

  test("empty file added (no hunks, no ---/+++ lines)", () => {
    const diff = [
      "diff --git a/empty.txt b/empty.txt",
      "new file mode 100644",
      "index 0000000..e69de29",
      "",
    ].join("\n");
    const [f] = parseUnifiedDiff(diff);
    expect(f!.status).toBe("added");
    expect(f!.path).toBe("empty.txt");
    expect(f!.hunks).toEqual([]);
    expect(f!.additions).toBe(0);
  });

  test("mode-only change parses as modified with zero hunks", () => {
    const diff = [
      "diff --git a/run.sh b/run.sh",
      "old mode 100644",
      "new mode 100755",
      "",
    ].join("\n");
    const [f] = parseUnifiedDiff(diff);
    expect(f!.status).toBe("modified");
    expect(f!.path).toBe("run.sh");
    expect(f!.hunks).toEqual([]);
  });

  test("multiple hunks track their own line numbers", () => {
    const diff = [
      "diff --git a/m.txt b/m.txt",
      "index 1..2 100644",
      "--- a/m.txt",
      "+++ b/m.txt",
      "@@ -1,3 +1,3 @@",
      " one",
      "-two",
      "+TWO",
      " three",
      "@@ -20,3 +20,4 @@ chapter two",
      " twenty",
      " twentyone",
      "+twentyone-and-a-half",
      " twentytwo",
      "",
    ].join("\n");
    const [f] = parseUnifiedDiff(diff);
    expect(f!.hunks).toHaveLength(2);
    const h2 = f!.hunks[1]!;
    expect(h2.header).toBe("chapter two");
    expect(h2.lines[2]).toEqual({ kind: "add", newLine: 22, text: "twentyone-and-a-half" });
    expect(h2.lines[3]).toEqual({ kind: "context", oldLine: 22, newLine: 23, text: "twentytwo" });
  });

  test("quoted paths with spaces", () => {
    const diff = [
      'diff --git "a/with space.txt" "b/with space.txt"',
      "index 1..2 100644",
      '--- "a/with space.txt"',
      '+++ "b/with space.txt"',
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n");
    const [f] = parseUnifiedDiff(diff);
    expect(f!.path).toBe("with space.txt");
  });
});
