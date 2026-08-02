import { describe, expect, test } from "bun:test";
import { onRepoChange, subscribe, unsubscribe } from "./watcher";
import { makeRepo, write } from "./testutil";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("watcher", () => {
  test("edits emit; gitignored subtrees stay silent", async () => {
    const dir = makeRepo("watch", { ".gitignore": "junk/\n", "a.txt": "x\n" });
    write(dir, "junk/pre.bin", "z");

    const batches: string[][] = [];
    onRepoChange((d, paths) => {
      if (d === dir) batches.push(paths);
    });
    subscribe(dir);
    await sleep(500); // async start (git calls) + chokidar ready

    write(dir, "junk/more.bin", "y");
    await sleep(500);
    expect(batches.flat().filter((p) => p.startsWith("junk/"))).toEqual([]);

    write(dir, "a.txt", "edited\n");
    await sleep(700);
    expect(batches.flat()).toContain("a.txt");

    unsubscribe(dir);
  }, 10_000);
});
