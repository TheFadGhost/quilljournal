import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFsLike, resolveSafe } from "../src/main/nodeFsLike.js";

let root = "";

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

async function makeRoot(): Promise<string> {
  const dir = path.resolve("tests/.tmp", `nfs-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("resolveSafe", () => {
  it("resolves relative paths against the root", async () => {
    root = await makeRoot();
    expect(resolveSafe(root, "a/b.txt")).toBe(path.join(root, "a", "b.txt"));
    expect(resolveSafe(root, ".")).toBe(path.resolve(root));
  });

  it("rejects traversal segments, absolute paths, and drive paths", async () => {
    root = await makeRoot();
    const cases = ["..", "../x", "a/../..", "..\\x", "/abs/path", "\\abs", "C:\\abs\\path", "C:/abs/path", "\\\\srv\\share\\x", "", "   "];
    for (const bad of cases) {
      expect(() => resolveSafe(root, bad), `expected rejection: ${JSON.stringify(bad)}`).toThrow();
    }
  });
});

describe("createNodeFsLike", () => {
  it("rejects unsafe paths through every method without touching disk", async () => {
    root = await makeRoot();
    const fs = createNodeFsLike(root);
    await expect(fs.writeFileAtomic("../escape.txt", "x")).rejects.toThrow();
    await expect(fs.readFile("../escape.txt")).rejects.toThrow();
    await expect(fs.readTextFile("a/../..")).rejects.toThrow();
    await expect(fs.exists("/abs")).rejects.toThrow();
    await expect(fs.stat("C:\\Windows\\x")).rejects.toThrow();
    await expect(fs.unlink("..\\x")).rejects.toThrow();
    await expect(fs.mkdirp("/abs")).rejects.toThrow();
    await expect(fs.listDir("..")).rejects.toThrow();
    await expect(fs.rename("a/../../b", "c")).rejects.toThrow();
    await expect(fs.removeDir("\\\\srv\\share")).rejects.toThrow();
    await expect(fs.appendFile("../outside.bin", new Uint8Array([1]))).rejects.toThrow();
  });

  it("leaves no temp files behind after atomic writes", async () => {
    root = await makeRoot();
    const fs = createNodeFsLike(root);
    await fs.writeFileAtomic("notes/first.json", "{\"a\":1}");
    await fs.writeFileAtomic("notes/second.json", new Uint8Array([2]));
    await fs.writeFileAtomic("notes/second.json", "overwritten");
    const entries = await fs.listDir("notes");
    expect(entries.map((entry) => entry.name).sort()).toEqual(["first.json", "second.json"]);
    for (const entry of entries) {
      expect(entry.isDirectory).toBe(false);
      expect(entry.name.includes(".tmp-")).toBe(false);
    }
    expect(await fs.readTextFile("notes/second.json")).toBe("overwritten");
  });

  it("creates parent directories on append and appends bytes sequentially", async () => {
    root = await makeRoot();
    const fs = createNodeFsLike(root);
    await fs.appendFile("deep/dir/audio.webm", new Uint8Array([1, 2, 3]));
    await fs.appendFile("deep/dir/audio.webm", new Uint8Array([4]));
    expect(await fs.exists("deep/dir/audio.webm")).toBe(true);
    expect(await fs.stat("deep/dir/audio.webm")).toEqual({ size: 4 });
    expect([...(await fs.readFile("deep/dir/audio.webm"))]).toEqual([1, 2, 3, 4]);
  });

  it("round-trips listDir, rename, and removeDir", async () => {
    root = await makeRoot();
    const fs = createNodeFsLike(root);
    await fs.writeFileAtomic("a.txt", "a");
    await fs.writeFileAtomic("b.txt", "b");
    await fs.writeFileAtomic("sub/c.txt", "c");
    const top = await fs.listDir(".");
    expect(top.map((entry) => `${entry.name}${entry.isDirectory ? "/" : ""}`).sort()).toEqual([
      "a.txt",
      "b.txt",
      "sub/",
    ]);
    await fs.rename("a.txt", "renamed.txt");
    expect(await fs.exists("a.txt")).toBe(false);
    expect(await fs.exists("renamed.txt")).toBe(true);
    await fs.rename("renamed.txt", "sub/renamed.txt");
    expect(await fs.exists("sub/renamed.txt")).toBe(true);
    await fs.removeDir("sub");
    expect(await fs.exists("sub")).toBe(false);
    expect((await fs.listDir(".")).map((entry) => entry.name).sort()).toEqual(["b.txt"]);
  });

  it("returns null stat for missing files and tolerates removing missing dirs", async () => {
    root = await makeRoot();
    const fs = createNodeFsLike(root);
    expect(await fs.stat("missing.bin")).toBeNull();
    await fs.removeDir("never-existed");
    await expect(fs.unlink("missing.bin")).rejects.toThrow();
  });
});
