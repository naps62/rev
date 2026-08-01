/**
 * Hand-rolled parser for `git diff --no-color` unified output.
 * Produces FileDiff skeletons; contentHash/seen/stale are filled by callers
 * (git.ts hashes working-tree content, routes.ts joins seen-state).
 */

import type { DiffHunk, DiffLine, FileStatus } from "@shared/types";

export interface ParsedFileDiff {
  path: string;
  oldPath?: string;
  status: FileStatus;
  binary: boolean;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

/** Unquote a git-quoted path ("a/x \"y\"" style). Returns input when unquoted. */
function unquote(s: string): string {
  if (!s.startsWith('"') || !s.endsWith('"') || s.length < 2) return s;
  const inner = s.slice(1, -1);
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = inner[++i];
    if (n === undefined) break;
    if (n === "n") out += "\n";
    else if (n === "t") out += "\t";
    else if (n === "r") out += "\r";
    else if (n >= "0" && n <= "7") {
      out += String.fromCharCode(parseInt(inner.slice(i, i + 3), 8));
      i += 2;
    } else out += n;
  }
  return out;
}

/** Path from a `--- `/`+++ ` line body; undefined for /dev/null. */
function headerPath(raw: string): string | undefined {
  const p = unquote(raw.trim());
  if (p === "/dev/null") return undefined;
  return p.replace(/^[ab]\//, "");
}

/**
 * Best-effort paths from the `diff --git a/X b/Y` line. Ambiguous when paths
 * contain " b/" — the unambiguous ---/+++/rename lines override these when
 * present (they are absent only for binary and mode-only entries).
 */
function parseDiffGitLine(line: string): { old?: string; new?: string } {
  const rest = line.slice("diff --git ".length);
  if (rest.startsWith('"')) {
    // quoted first token: find closing quote respecting escapes
    let i = 1;
    while (i < rest.length && rest[i] !== '"') i += rest[i] === "\\" ? 2 : 1;
    const first = rest.slice(0, i + 1);
    const second = rest.slice(i + 2);
    return { old: headerPath(first), new: headerPath(second) };
  }
  const idx = rest.indexOf(" b/");
  if (idx === -1) return {};
  return { old: rest.slice(2, idx), new: rest.slice(idx + 3) };
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

export function parseUnifiedDiff(text: string): ParsedFileDiff[] {
  const lines = text.split("\n");
  const files: ParsedFileDiff[] = [];
  let i = 0;

  while (i < lines.length) {
    const start = lines[i]!;
    if (!start.startsWith("diff --git ")) {
      i++;
      continue;
    }
    const guess = parseDiffGitLine(start);
    let oldPath = guess.old;
    let newPath = guess.new;
    let status: FileStatus = "modified";
    let renamed = false;
    let binary = false;
    i++;

    // extended headers + ---/+++ lines
    while (i < lines.length) {
      const l = lines[i]!;
      if (l.startsWith("diff --git ") || HUNK_RE.test(l)) break;
      if (l.startsWith("new file mode")) status = "added";
      else if (l.startsWith("deleted file mode")) status = "deleted";
      else if (l.startsWith("rename from ")) {
        renamed = true;
        oldPath = unquote(l.slice("rename from ".length));
      } else if (l.startsWith("rename to ")) {
        renamed = true;
        newPath = unquote(l.slice("rename to ".length));
      } else if (l.startsWith("--- ")) {
        oldPath = headerPath(l.slice(4)) ?? oldPath;
        if (l.slice(4).trim() === "/dev/null") oldPath = undefined;
      } else if (l.startsWith("+++ ")) {
        newPath = headerPath(l.slice(4)) ?? newPath;
        if (l.slice(4).trim() === "/dev/null") newPath = undefined;
      } else if (l.startsWith("Binary files ") || l === "GIT binary patch") {
        binary = true;
      }
      i++;
    }
    if (renamed) status = "renamed";

    const hunks: DiffHunk[] = [];
    let additions = 0;
    let deletions = 0;

    while (i < lines.length) {
      const m = HUNK_RE.exec(lines[i]!);
      if (!m) break;
      const oldStart = Number(m[1]);
      const oldLines = m[2] === undefined ? 1 : Number(m[2]);
      const newStart = Number(m[3]);
      const newLines = m[4] === undefined ? 1 : Number(m[4]);
      const hunkLines: DiffLine[] = [];
      let oldLine = oldStart;
      let newLine = newStart;
      i++;
      while (i < lines.length) {
        const l = lines[i]!;
        if (l.startsWith("@@") || l.startsWith("diff --git ")) break;
        const c = l[0];
        if (c === "+") {
          hunkLines.push({ kind: "add", newLine: newLine++, text: l.slice(1) });
          additions++;
        } else if (c === "-") {
          hunkLines.push({ kind: "del", oldLine: oldLine++, text: l.slice(1) });
          deletions++;
        } else if (c === " ") {
          hunkLines.push({ kind: "context", oldLine: oldLine++, newLine: newLine++, text: l.slice(1) });
        } else if (c === "\\") {
          // "\ No newline at end of file" — metadata, not content
        } else {
          break; // end of diff (trailing "" from split, or unexpected)
        }
        i++;
      }
      hunks.push({ oldStart, oldLines, newStart, newLines, header: m[5] ?? "", lines: hunkLines });
    }

    const path = status === "deleted" ? oldPath : (newPath ?? oldPath);
    if (path === undefined) continue; // unparseable entry; skip rather than crash
    const file: ParsedFileDiff = { path, status, binary, hunks, additions, deletions };
    if (status === "renamed" && oldPath !== undefined) file.oldPath = oldPath;
    files.push(file);
  }

  return files;
}
