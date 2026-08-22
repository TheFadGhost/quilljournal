import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFsLike } from "../src/main/nodeFsLike.js";
import { RecordingWriter } from "../src/main/recordingWriter.js";

const createdRoots: string[] = [];

afterEach(async () => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

async function makeRoot(): Promise<string> {
  const root = path.resolve("tests/.tmp", `rw-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  createdRoots.push(root);
  return root;
}

function chunk(index: number): Uint8Array {
  const bytes = new Uint8Array(index + 1);
  bytes.fill(((index * 37) % 255) + 1);
  return bytes;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

async function readRaw(root: string, relPath: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path.join(root, relPath)));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

describe("RecordingWriter", () => {
  it("flushes each appended chunk to disk immediately and in order", async () => {
    const root = await makeRoot();
    const fs = createNodeFsLike(root);
    const writer = await RecordingWriter.start(fs, "audio/session.webm");
    const parts: Uint8Array[] = [];
    for (let i = 0; i < 5; i++) {
      const part = chunk(i);
      parts.push(part);
      await writer.append(part);
    }
    expect(writer.path).toBe("audio/session.webm");
    expect(writer.bytesWritten).toBe(concat(parts).byteLength);
    expect(bytesEqual(await readRaw(root, "audio/session.webm"), concat(parts))).toBe(true);
  });

  it("keeps the on-disk prefix when the writer is abandoned mid-recording", async () => {
    const root = await makeRoot();
    const fs = createNodeFsLike(root);
    const abandoned = await RecordingWriter.start(fs, "audio/crash.webm");
    const parts = [chunk(0), chunk(1), chunk(2)];
    for (const part of parts) {
      await abandoned.append(part);
    }
    void abandoned;
    expect(bytesEqual(await readRaw(root, "audio/crash.webm"), concat(parts))).toBe(true);
  });

  it("rejects appends after finish(true) and leaves the file intact", async () => {
    const root = await makeRoot();
    const fs = createNodeFsLike(root);
    const writer = await RecordingWriter.start(fs, "audio/done.webm");
    const first = chunk(3);
    await writer.append(first);
    await writer.finish(true);
    expect(writer.bytesWritten).toBe(first.byteLength);
    await expect(writer.append(chunk(9))).rejects.toThrow(/closed/i);
    expect(bytesEqual(await readRaw(root, "audio/done.webm"), concat([first]))).toBe(true);
  });

  it("rejects appends after abort() and leaves the partial file as-is", async () => {
    const root = await makeRoot();
    const fs = createNodeFsLike(root);
    const writer = await RecordingWriter.start(fs, "audio/partial.webm");
    const parts = [chunk(4), chunk(5)];
    for (const part of parts) {
      await writer.append(part);
    }
    writer.abort();
    await expect(writer.append(chunk(9))).rejects.toThrow(/closed/i);
    expect(bytesEqual(await readRaw(root, "audio/partial.webm"), concat(parts))).toBe(true);
  });

  it("serializes concurrent appends in submission order", async () => {
    const root = await makeRoot();
    const fs = createNodeFsLike(root);
    const writer = await RecordingWriter.start(fs, "audio/concurrent.webm");
    const parts = Array.from({ length: 20 }, (_, i) => chunk(i));
    await Promise.all(parts.map((part) => writer.append(part)));
    expect(writer.bytesWritten).toBe(concat(parts).byteLength);
    expect(bytesEqual(await readRaw(root, "audio/concurrent.webm"), concat(parts))).toBe(true);
  });
});
