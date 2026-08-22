import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JournalStore, revisionSnapshot } from "../src/core/store/journalStore.js";
import { SCHEMA_VERSION, type Entry } from "../src/core/types.js";
import { StorageError } from "../src/core/errors.js";
import { MemFs } from "./helpers/memfs.js";

const MAGIC_EBML = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]);

function bytesOf(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function patternByte(chunkIndex: number, position: number): number {
  return (chunkIndex * 37 + position * 11 + 5) % 251;
}

async function kindOfRejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "resolved-unexpectedly";
  } catch (caught) {
    if (StorageError.is(caught)) return caught.kind;
    return `other:${String(caught)}`;
  }
}

function makeStore(opts?: { coalesceMs?: number }): { fs: MemFs; store: JournalStore } {
  const fs = new MemFs();
  const store =
    opts?.coalesceMs === undefined
      ? new JournalStore(fs)
      : new JournalStore(fs, { coalesceMs: opts.coalesceMs });
  return { fs, store };
}

describe("storage: entry lifecycle", () => {
  it("persists a created entry and reflects later edits verbatim on read-back", async () => {
    const { store } = makeStore();
    await store.init();
    const created = await store.createEntry({
      dateKey: "2026-05-10",
      title: "morning pages",
      body: "first light",
      createdAt: "2026-05-10T08:00:00.000Z",
    });
    expect(created.schemaVersion).toBe(SCHEMA_VERSION);
    expect(created.id).toMatch(/^entry_/);
    expect(created.tags).toEqual([]);
    expect(created.markers).toEqual([]);
    expect(created.attachments).toEqual([]);
    expect(created.audio).toBeNull();
    expect(created.writingTimeMs).toBe(0);
    expect(created.createdAt).toBe("2026-05-10T08:00:00.000Z");
    expect(created.updatedAt).toBe("2026-05-10T08:00:00.000Z");
    expect(created.revisions).toHaveLength(1);
    expect(created.revisions[0]).toMatchObject({
      title: "morning pages",
      body: "first light",
      at: "2026-05-10T08:00:00.000Z",
    });

    await store.putEntry({
      ...created,
      title: "morning pages, revised",
      body: "first light, then rain",
      tags: ["weather"],
      markers: ["calm"],
      writingTimeMs: 4200,
    });

    const stored = await store.getEntry(created.id);
    expect({
      schemaVersion: stored.schemaVersion,
      id: stored.id,
      dateKey: stored.dateKey,
      createdAt: stored.createdAt,
      title: stored.title,
      body: stored.body,
      tags: stored.tags,
      markers: stored.markers,
      attachments: stored.attachments,
      audio: stored.audio,
      writingTimeMs: stored.writingTimeMs,
    }).toEqual({
      schemaVersion: SCHEMA_VERSION,
      id: created.id,
      dateKey: "2026-05-10",
      createdAt: "2026-05-10T08:00:00.000Z",
      title: "morning pages, revised",
      body: "first light, then rain",
      tags: ["weather"],
      markers: ["calm"],
      attachments: [],
      audio: null,
      writingTimeMs: 4200,
    });
    expect(Date.parse(stored.updatedAt)).toBeGreaterThanOrEqual(Date.parse(stored.createdAt));
    expect(stored.revisions).toHaveLength(2);
    expect(stored.revisions[0]).toMatchObject({
      title: "morning pages",
      body: "first light",
      at: "2026-05-10T08:00:00.000Z",
    });
    expect(stored.revisions[1]).toMatchObject({
      title: "morning pages, revised",
      body: "first light, then rain",
    });
  });

  it("lists entries by dateKey descending then createdAt descending within a day", async () => {
    const { store } = makeStore();
    await store.init();
    const olderDay = await store.createEntry({
      dateKey: "2026-04-02",
      createdAt: "2026-04-02T07:00:00.000Z",
    });
    const sameDayEarly = await store.createEntry({
      dateKey: "2026-05-10",
      createdAt: "2026-05-10T08:00:00.000Z",
    });
    const sameDayLate = await store.createEntry({
      dateKey: "2026-05-10",
      createdAt: "2026-05-10T09:30:00.000Z",
    });
    const listed = await store.listEntries();
    expect(listed.map((entry) => entry.id)).toEqual([
      sameDayLate.id,
      sameDayEarly.id,
      olderDay.id,
    ]);
  });

  it("clones history without aliasing in the revisionSnapshot helper", () => {
    const entry: Entry = {
      schemaVersion: SCHEMA_VERSION,
      id: "entry_x",
      dateKey: "2026-01-01",
      createdAt: "c",
      updatedAt: "u",
      title: "t",
      body: "b",
      tags: [],
      markers: [],
      attachments: [],
      audio: null,
      revisions: [{ id: "rev_1", at: "a", title: "t", body: "b" }],
      writingTimeMs: 0,
    };
    const snapshot = revisionSnapshot(entry);
    expect(snapshot).toEqual(entry.revisions);
    expect(snapshot).not.toBe(entry.revisions);
    snapshot.push({ id: "rev_2", at: "z", title: "", body: "" });
    expect(entry.revisions).toHaveLength(1);
  });
});

describe("storage: revision coalescing", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-03-01T09:00:00.000Z"), toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("appends a new revision after the coalesce window elapses and keeps the prior revision verbatim", async () => {
    const { store } = makeStore();
    await store.init();
    const entry = await store.createEntry({ dateKey: "2026-03-01", title: "v1", body: "v1 body" });
    vi.setSystemTime(new Date("2026-03-01T21:00:00.000Z"));
    await store.putEntry({ ...entry, title: "v2", body: "v2 body" });
    const stored = await store.getEntry(entry.id);
    expect(stored.title).toBe("v2");
    expect(stored.body).toBe("v2 body");
    expect(stored.revisions).toHaveLength(2);
    expect(stored.revisions[0]).toMatchObject({
      title: "v1",
      body: "v1 body",
      at: "2026-03-01T09:00:00.000Z",
    });
    expect(stored.revisions[1]).toMatchObject({ title: "v2", body: "v2 body" });
    expect(Date.parse(stored.revisions[1]?.at ?? "")).toBe(
      Date.parse("2026-03-01T21:00:00.000Z"),
    );
    expect(JSON.stringify(stored.revisions)).toContain("v1 body");
  });

  it("replaces the latest revision in place when two saves land within the coalesce window", async () => {
    const { store } = makeStore();
    await store.init();
    const entry = await store.createEntry({ dateKey: "2026-03-01", title: "draft", body: "seed" });
    vi.setSystemTime(new Date("2026-03-01T09:01:00.000Z"));
    await store.putEntry({ ...entry, title: "draft", body: "expanded body" });
    vi.setSystemTime(new Date("2026-03-01T09:02:00.000Z"));
    await store.putEntry({ ...entry, title: "draft", body: "final body" });
    const stored = await store.getEntry(entry.id);
    expect(stored.revisions).toHaveLength(1);
    expect(stored.revisions[0]).toMatchObject({
      title: "draft",
      body: "final body",
      at: "2026-03-01T09:02:00.000Z",
    });
    expect(JSON.stringify(stored.revisions)).not.toContain("expanded body");
    expect(JSON.stringify(stored.revisions)).not.toContain("expanded");
  });

  it("adds nothing when saved content is identical to the previous revision", async () => {
    const { store } = makeStore();
    await store.init();
    const entry = await store.createEntry({
      dateKey: "2026-03-01",
      title: "stable",
      body: "stable body",
    });
    const before = await store.getEntry(entry.id);
    expect(before.revisions).toHaveLength(1);
    vi.setSystemTime(new Date("2026-03-01T09:30:00.000Z"));
    await store.putEntry({ ...before });
    const after = await store.getEntry(entry.id);
    expect(after.revisions).toHaveLength(1);
    expect(after.revisions.map((rev) => [rev.title, rev.body])).toEqual([["stable", "stable body"]]);
    expect(after.updatedAt).not.toBe(before.updatedAt);
    expect(Date.parse(after.updatedAt)).toBeGreaterThan(Date.parse(before.updatedAt));
  });

  it("keeps revision timestamps strictly ascending across appended history", async () => {
    const { store } = makeStore();
    await store.init();
    const entry = await store.createEntry({ dateKey: "2026-03-01" });
    const times = [
      "2026-03-02T08:00:00.000Z",
      "2026-03-02T19:00:00.000Z",
      "2026-03-03T08:00:00.000Z",
    ];
    for (const [index, time] of times.entries()) {
      vi.setSystemTime(new Date(time));
      await store.putEntry({ ...entry, body: `generation ${index + 1}` });
    }
    const stored = await store.getEntry(entry.id);
    expect(stored.revisions).toHaveLength(times.length + 1);
    const stamps = stored.revisions.map((rev) => Date.parse(rev.at));
    for (let i = 1; i < stamps.length; i++) {
      expect(stamps[i]).toBeGreaterThan(stamps[i - 1] ?? Number.NEGATIVE_INFINITY);
    }
    expect(stored.revisions[stored.revisions.length - 1]?.body).toBe("generation 3");
  });
});

describe("storage: atomic write crash safety", () => {
  it("keeps either the complete old or complete new entry file when a crash hits between write and rename, then recovers on retry", async () => {
    const { fs, store } = makeStore();
    await store.init();
    const entry = await store.createEntry({ dateKey: "2026-06-01", title: "v1", body: "v1" });
    await store.putEntry({ ...entry, body: "v2" });
    const path = `entries/${entry.id}.json`;

    fs.setFault({ failAt: "after-write-before-rename" });
    await expect(store.putEntry({ ...entry, body: "v3" })).rejects.toThrow("simulated-crash");
    let raw = JSON.parse(new TextDecoder().decode(await fs.readFile(path))) as Entry;
    expect([["v2", 1], ["v3", 1]]).toContainEqual([raw.body, raw.revisions.length]);
    expect(raw.body).toBe(raw.revisions[raw.revisions.length - 1]?.body);

    fs.setFault(null);
    await store.putEntry({ ...entry, body: "v3" });
    raw = JSON.parse(new TextDecoder().decode(await fs.readFile(path))) as Entry;
    expect(raw.body).toBe("v3");
    expect(raw.revisions).toHaveLength(1);
  });

  it("leaves a fully-formed entry file when a crash hits during rename, then recovers on retry", async () => {
    const { fs, store } = makeStore();
    await store.init();
    const entry = await store.createEntry({ dateKey: "2026-06-02", title: "v1", body: "v1" });
    await store.putEntry({ ...entry, body: "v2" });
    const path = `entries/${entry.id}.json`;

    fs.setFault({ failAt: "during-rename" });
    await expect(store.putEntry({ ...entry, body: "v3" })).rejects.toThrow("simulated-crash");
    const raw = JSON.parse(new TextDecoder().decode(await fs.readFile(path))) as Entry;
    expect([["v2", 1], ["v3", 1]]).toContainEqual([raw.body, raw.revisions.length]);
    expect(raw.body).toBe(raw.revisions[raw.revisions.length - 1]?.body);

    fs.setFault(null);
    await store.putEntry({ ...entry, body: "v3" });
    const stored = await store.getEntry(entry.id);
    expect(stored.body).toBe("v3");
    expect(stored.revisions).toHaveLength(1);
  });
});

describe("storage: incremental audio recording", () => {
  it("keeps a playable-prefix file and stays finalizable after a crash mid-recording", async () => {
    const { fs, store } = makeStore();
    await store.init();
    const entry = await store.createEntry({ dateKey: "2026-07-04" });
    const audioPath = await store.beginAudio(entry.id, "audio/webm");
    const chunkSizes = [64, 48, 80, 32, 56];
    const chunks = chunkSizes.map((size, index) => {
      const chunk = new Uint8Array(size);
      for (let i = 0; i < size; i++) chunk[i] = patternByte(index, i);
      return chunk;
    });
    chunks[0]?.set(MAGIC_EBML, 0);

    for (let i = 0; i < 4; i++) {
      await store.appendAudioChunk(audioPath, chunks[i] as Uint8Array);
    }
    fs.setFault({ failAt: "before-append" });
    await expect(store.appendAudioChunk(audioPath, chunks[4] as Uint8Array)).rejects.toThrow(
      "simulated-crash",
    );
    fs.setFault(null);

    const reopened = new JournalStore(fs);
    await reopened.init();

    expect(await fs.exists(audioPath)).toBe(true);
    const expectedSize = chunkSizes.slice(0, 4).reduce((sum, size) => sum + size, 0);
    expect((await fs.stat(audioPath))?.size).toBe(expectedSize);
    const kept = await fs.readFile(audioPath);
    expect(Array.from(kept.slice(0, 4))).toEqual([0x1a, 0x45, 0xdf, 0xa3]);

    await expect(reopened.finalizeAudio(audioPath, 42_000, null)).resolves.toBeUndefined();
    expect((await fs.stat(audioPath))?.size).toBe(expectedSize);
  });
});

describe("storage: encryption lifecycle", () => {
  it("wraps every content file, blocks locked reads, rejects wrong passphrases, and restores data byte-exactly after unlock", async () => {
    const { fs, store } = makeStore();
    await store.init();
    const bodyText = "harbourlight and lanternkeep at dusk";
    const entry = await store.createEntry({
      dateKey: "2026-08-01",
      title: "sea log",
      body: bodyText,
    });
    const attachmentBytes = bytesOf(1, 2, 3, 4, 250, 251);
    const attachment = await store.addAttachment(
      entry.id,
      "field-notes.txt",
      "text/plain",
      attachmentBytes,
    );
    const audioPath = await store.beginAudio(entry.id, "audio/webm");
    await store.appendAudioChunk(audioPath, bytesOf(...MAGIC_EBML, 7, 7, 7, 7));
    await store.finalizeAudio(audioPath, null, null);
    await store.setEntryAudio(entry.id, {
      storedPath: audioPath,
      mimeType: "audio/webm",
      durationMs: null,
      transcript: null,
    });

    await store.enableEncryption("quiet harbour");
    expect(store.isEncrypted()).toBe(true);
    expect(store.isUnlocked()).toBe(true);

    for (const file of fs.dump()) {
      if (!/^(entries|attachments|audio)\//.test(file.path)) continue;
      const text = new TextDecoder().decode(file.bytes);
      expect(text.includes("sea log")).toBe(false);
      expect(text.includes("harbourlight")).toBe(false);
      expect(text.includes("lanternkeep")).toBe(false);
      expect(text.slice(0, 6)).toBe("QJENC1");
    }

    store.lock();
    expect(store.isUnlocked()).toBe(false);
    expect(await kindOfRejection(store.listEntries())).toBe("locked");
    expect(await kindOfRejection(store.getEntry(entry.id))).toBe("locked");

    expect(await kindOfRejection(store.unlock("wrong-guess"))).toBe("wrong-passphrase");
    expect(store.isUnlocked()).toBe(false);
    expect(await kindOfRejection(store.getEntry(entry.id))).toBe("locked");

    await store.unlock("quiet harbour");
    const restored = await store.getEntry(entry.id);
    expect(restored.title).toBe("sea log");
    expect(restored.body).toBe(bodyText);
    expect(restored.attachments).toHaveLength(1);
    const attachmentRef = restored.attachments[0];
    expect(attachmentRef?.id).toBe(attachment.id);
    expect(attachmentRef?.fileName).toBe("field-notes.txt");
    expect(await store.readAttachment(attachmentRef as typeof attachment)).toEqual(
      attachmentBytes,
    );
    expect(restored.audio?.storedPath).toBe(audioPath);

    const encryption = store.manifest().encryption;
    expect(encryption?.cipher).toBe("AES-256-GCM");
    expect(encryption?.kdf).toBe("PBKDF2-SHA256");
    expect(encryption?.iterations).toBe(650000);
  });
});

describe("storage: deletion and cleanup", () => {
  it("deleteEntry removes the entry file, its attachment directory, and its audio directory", async () => {
    const { fs, store } = makeStore();
    await store.init();
    const entry = await store.createEntry({ dateKey: "2026-08-10" });
    const attachment = await store.addAttachment(
      entry.id,
      "photo.dat",
      "application/octet-stream",
      bytesOf(9, 9, 9),
    );
    const audioPath = await store.beginAudio(entry.id, "audio/webm");
    await store.appendAudioChunk(audioPath, bytesOf(1, 2, 3));
    await store.setEntryAudio(entry.id, {
      storedPath: audioPath,
      mimeType: "audio/webm",
      durationMs: 1500,
      transcript: null,
    });

    expect(await fs.exists(`attachments/${attachment.id}`)).toBe(true);
    expect(await fs.exists(`audio/${entry.id}`)).toBe(true);

    await store.deleteEntry(entry.id);

    expect(await fs.exists(`entries/${entry.id}.json`)).toBe(false);
    expect(await fs.exists(`attachments/${attachment.id}`)).toBe(false);
    expect(await fs.exists(audioPath)).toBe(false);
    expect(await fs.exists(`audio/${entry.id}`)).toBe(false);
    expect(await kindOfRejection(store.getEntry(entry.id))).toBe("not-found");
  });

  it("removeAttachment deletes the stored file, drops only that reference, and leaves revisions untouched", async () => {
    const { fs, store } = makeStore();
    await store.init();
    const entry = await store.createEntry({ dateKey: "2026-08-11", title: "t", body: "b" });
    const first = await store.addAttachment(entry.id, "one.txt", "text/plain", bytesOf(1));
    const second = await store.addAttachment(entry.id, "two.txt", "text/plain", bytesOf(2));

    await store.removeAttachment(entry.id, first.id);

    const stored = await store.getEntry(entry.id);
    expect(stored.attachments.map((att) => att.id)).toEqual([second.id]);
    expect(await fs.exists(first.storedPath)).toBe(false);
    expect(await fs.exists(`attachments/${first.id}`)).toBe(false);
    expect(await fs.exists(second.storedPath)).toBe(true);
    expect(stored.revisions).toHaveLength(1);
    expect(stored.revisions[0]).toMatchObject({ title: "t", body: "b" });
  });

  it("discardAudio deletes the recording file, clears entry.audio, and keeps the entry itself", async () => {
    const { fs, store } = makeStore();
    await store.init();
    const entry = await store.createEntry({ dateKey: "2026-08-12", title: "spoken", body: "words" });
    const audioPath = await store.beginAudio(entry.id, "audio/webm");
    await store.appendAudioChunk(audioPath, bytesOf(5, 6, 7));
    await store.setEntryAudio(entry.id, {
      storedPath: audioPath,
      mimeType: "audio/webm",
      durationMs: null,
      transcript: null,
    });

    await store.discardAudio(entry.id);

    expect(await fs.exists(audioPath)).toBe(false);
    const stored = await store.getEntry(entry.id);
    expect(stored.audio).toBeNull();
    expect(await fs.exists(`entries/${entry.id}.json`)).toBe(true);
    expect(stored.body).toBe("words");
  });

  it("sanitizes hostile attachment file names onto a single safe base name under its own directory", async () => {
    const { fs, store } = makeStore();
    await store.init();
    const entry = await store.createEntry({ dateKey: "2026-08-13" });
    const traversal = await store.addAttachment(
      entry.id,
      "../../etc/passwd",
      "text/plain",
      bytesOf(1),
    );
    const backslash = await store.addAttachment(
      entry.id,
      "..\\..\\secret notes.txt",
      "text/plain",
      bytesOf(2),
    );
    const controlChars = await store.addAttachment(
      entry.id,
        "\u0000\u0001bad\u0002name.png",
      "image/png",
      bytesOf(3),
    );
    const dotsOnly = await store.addAttachment(entry.id, "....", "text/plain", bytesOf(4));

    expect(traversal.fileName).toBe("passwd");
    expect(backslash.fileName).toBe("secret notes.txt");
    expect(controlChars.fileName).toBe("badname.png");
    expect(dotsOnly.fileName).toBe("file");
    for (const att of [traversal, backslash, controlChars, dotsOnly]) {
      expect(att.storedPath.startsWith(`attachments/${att.id}/`)).toBe(true);
      expect(att.storedPath.includes("..")).toBe(false);
      expect(await fs.exists(att.storedPath)).toBe(true);
    }
  });
});

describe("storage: manifest guard rails", () => {
  it("refuses to open a journal written by a newer schema version", async () => {
    const { fs, store } = makeStore();
    await store.init();
    await fs.writeFileAtomic(
      "manifest.json",
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION + 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        encryption: null,
      }),
    );
    const reopened = new JournalStore(fs);
    expect(await kindOfRejection(reopened.init())).toBe("corrupt");
  });

  it("migrates an older manifest forward and rewrites it atomically", async () => {
    const { fs, store } = makeStore();
    await store.init();
    await fs.writeFileAtomic(
      "manifest.json",
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION - 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        encryption: null,
      }),
    );
    const reopened = new JournalStore(fs);
    await reopened.init();
    expect(reopened.manifest().schemaVersion).toBe(SCHEMA_VERSION);
    const raw = JSON.parse(new TextDecoder().decode(await fs.readFile("manifest.json")));
    expect(raw.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("refuses a manifest that is not valid JSON", async () => {
    const { fs, store } = makeStore();
    await store.init();
    await fs.writeFileAtomic("manifest.json", "{definitely not json");
    const reopened = new JournalStore(fs);
    expect(await kindOfRejection(reopened.init())).toBe("corrupt");
  });
});

describe("storage: fault injection fidelity of the in-memory filesystem", () => {
  it("fires simulated crashes at exactly the requested stages and recovers when cleared", async () => {
    const fs = new MemFs();
    fs.setFault({ failAt: "before-write", once: true });
    await expect(fs.writeFileAtomic("a.txt", "x")).rejects.toThrow("simulated-crash");
    await expect(fs.writeFileAtomic("a.txt", "x")).resolves.toBeUndefined();
    expect(await fs.readTextFile("a.txt")).toBe("x");

    fs.setFault({ failAt: "after-n-appends", remainingAppends: 2 });
    await fs.appendFile("log.bin", new Uint8Array([1]));
    await fs.appendFile("log.bin", new Uint8Array([2]));
    await expect(fs.appendFile("log.bin", new Uint8Array([3]))).rejects.toThrow("simulated-crash");
    expect((await fs.stat("log.bin"))?.size).toBe(2);
    fs.setFault(null);
    await fs.appendFile("log.bin", new Uint8Array([3]));
    expect((await fs.stat("log.bin"))?.size).toBe(3);
    const dumped = fs.dump("log.bin");
    expect(dumped).toHaveLength(1);
    expect(Array.from(dumped[0]?.bytes ?? [])).toEqual([1, 2, 3]);
  });
});
