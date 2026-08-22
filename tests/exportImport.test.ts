import { describe, expect, it } from "vitest";
import { MemFs } from "./helpers/memfs.js";
import { JournalStore } from "../src/core/store/journalStore.js";
import { StorageError } from "../src/core/errors.js";
import {
  SCHEMA_VERSION,
  type Entry,
  type EntryAttachment,
  type TranscriptRecord,
} from "../src/core/types.js";
import { exportMarkdown } from "../src/core/export/markdown.js";
import {
  archiveToJson,
  buildArchive,
  toBase64,
  writeArchiveFile,
  type QuillArchive,
} from "../src/core/export/archive.js";
import { buildPrintableHtml } from "../src/core/export/printable.js";
import { importArchive, parseArchive, type ImportSink } from "../src/core/import/importer.js";
import { formatDateKeyLong } from "../src/core/dates.js";

const encoder = new TextEncoder();

class StoreSink implements ImportSink {
  readonly fs: MemFs;
  private readonly store: JournalStore;

  constructor(fs: MemFs, store: JournalStore) {
    this.fs = fs;
    this.store = store;
  }

  init(): Promise<void> {
    return this.store.init();
  }

  async getEntry(id: string): Promise<Entry | null> {
    try {
      return await this.store.getEntry(id);
    } catch (caught) {
      if (StorageError.is(caught) && caught.kind === "not-found") return null;
      throw caught;
    }
  }

  async putEntryRaw(entry: Entry): Promise<void> {
    await this.fs.writeFileAtomic(
      `entries/${entry.id}.json`,
      encoder.encode(JSON.stringify(entry, null, 2)),
    );
  }

  async writeFileRaw(relPath: string, bytes: Uint8Array): Promise<void> {
    await this.fs.writeFileAtomic(relPath, bytes);
  }

  isEncrypted(): boolean {
    return false;
  }

  unlock(_passphrase: string): Promise<void> {
    return Promise.resolve();
  }
}

function baseEntry(overrides: Partial<Entry>): Entry {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: "entry_default01",
    dateKey: "2026-05-10",
    createdAt: "2026-05-10T08:00:00.000Z",
    updatedAt: "2026-05-10T09:30:00.000Z",
    title: "",
    body: "",
    tags: [],
    markers: [],
    attachments: [],
    audio: null,
    revisions: [],
    writingTimeMs: 0,
    ...overrides,
  };
}

function splitMarkdown(content: string): {
  frontmatter: Record<string, string>;
  heading: string;
  body: string;
} {
  const prefix = "---\n";
  if (!content.startsWith(prefix)) throw new Error("missing frontmatter");
  const rest = content.slice(prefix.length);
  const end = rest.indexOf("\n---\n");
  if (end === -1) throw new Error("unterminated frontmatter");
  const frontmatter: Record<string, string> = {};
  for (const line of rest.slice(0, end).split("\n")) {
    const sep = line.indexOf(": ");
    if (sep === -1) throw new Error(`bad frontmatter line: ${line}`);
    frontmatter[line.slice(0, sep)] = line.slice(sep + 2);
  }
  const after = rest.slice(end + "\n---\n".length);
  if (!after.startsWith("\n")) throw new Error("missing blank line after frontmatter");
  const afterBlank = after.slice(1);
  const headingEnd = afterBlank.indexOf("\n\n");
  if (headingEnd === -1) throw new Error("missing blank line after heading");
  return {
    frontmatter,
    heading: afterBlank.slice(0, headingEnd),
    body: afterBlank.slice(headingEnd + 2),
  };
}

function expectCorrupt(parse: () => unknown): void {
  try {
    parse();
  } catch (caught) {
    if (StorageError.is(caught) && caught.kind === "corrupt") return;
    throw new Error(`expected corrupt StorageError but got ${String(caught)}`);
  }
  throw new Error("expected parseArchive to reject the input");
}

describe("markdown export", () => {
  it("round-trips entries with byte-identical bodies and exact media bytes", async () => {
    const fs = new MemFs();
    const outRoot = "export-out";
    const photoBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]);
    const attachment: EntryAttachment = {
      id: "att_photo01",
      fileName: "holiday photo.png",
      storedPath: "attachments/att_photo01/holiday photo.png",
      byteSize: photoBytes.length,
      mimeType: "image/png",
      addedAt: "2026-05-10T09:00:00.000Z",
    };
    const body =
      "Morning pages.\nSecond line with café and 日本語.\n\nRTL check: السلام عليكم\nEmoji: 📓\nTrailing newline follows\n";
    const e1 = baseEntry({
      id: "entry_ab12cd",
      title: "Hello, World!",
      body,
      tags: ["morning"],
      markers: ["focused"],
      attachments: [attachment],
      revisions: [
        { id: "rev_1", at: "2026-05-10T08:00:00.000Z", title: "", body: "draft" },
        { id: "rev_2", at: "2026-05-10T09:30:00.000Z", title: "Hello, World!", body },
      ],
      writingTimeMs: 130_000,
    });
    const e2 = baseEntry({
      id: "entry_ef45gh",
      dateKey: "2026-05-11",
      body: "Single paragraph.",
      writingTimeMs: 45_000,
    });
    const longTitle = "abcdefghijklmnopqrst".repeat(3);
    const e3 = baseEntry({
      id: "entry_ij90kl",
      dateKey: "2026-05-12",
      title: longTitle,
      body: "Long title entry.",
    });
    const attachmentBytes = new Map<string, Uint8Array>([[attachment.id, photoBytes]]);
    const written = await exportMarkdown(fs, outRoot, [e1, e2, e3], {
      readAttachment: async (att) => {
        const bytes = attachmentBytes.get(att.id);
        if (!bytes) throw new Error(`no bytes staged for ${att.id}`);
        return bytes;
      },
    });

    expect(written).toEqual([
      `2026-05-10-hello-world-${e1.id.slice(-6)}.md`,
      "media/att_photo01-holiday photo.png",
      `2026-05-11-entry-${e2.id.slice(-6)}.md`,
      `2026-05-12-${longTitle.slice(0, 40)}-${e3.id.slice(-6)}.md`,
    ]);

    const content1 = await fs.readTextFile(`${outRoot}/2026-05-10-hello-world-ab12cd.md`);
    const expected1 =
      [
        "---",
        `id: ${e1.id}`,
        "date: 2026-05-10",
        "created: 2026-05-10T08:00:00.000Z",
        "updated: 2026-05-10T09:30:00.000Z",
        'tags: ["morning"]',
        'markers: ["focused"]',
        "revisions: 2",
        "writing-time-min: 2",
        "---",
        "",
        "# Hello, World!",
        "",
        body,
        "",
        "Attachments:",
        "- media/att_photo01-holiday photo.png",
      ].join("\n");
    expect(encoder.encode(content1)).toEqual(encoder.encode(expected1));
    const parsed1 = splitMarkdown(content1);
    expect(parsed1.frontmatter["id"]).toBe(e1.id);
    expect(parsed1.frontmatter["date"]).toBe("2026-05-10");
    expect(parsed1.frontmatter["created"]).toBe(e1.createdAt);
    expect(parsed1.frontmatter["updated"]).toBe(e1.updatedAt);
    expect(JSON.parse(parsed1.frontmatter["tags"] ?? "")).toEqual(["morning"]);
    expect(JSON.parse(parsed1.frontmatter["markers"] ?? "")).toEqual(["focused"]);
    expect(parsed1.frontmatter["revisions"]).toBe("2");
    expect(parsed1.frontmatter["writing-time-min"]).toBe("2");
    expect(parsed1.heading).toBe("# Hello, World!");
    expect(parsed1.body).toBe(
      `${body}\n\nAttachments:\n- media/att_photo01-holiday photo.png`,
    );

    const content2 = await fs.readTextFile(`${outRoot}/2026-05-11-entry-${e2.id.slice(-6)}.md`);
    const parsed2 = splitMarkdown(content2);
    expect(parsed2.heading).toBe("# 2026-05-11");
    expect(parsed2.body).toBe("Single paragraph.");
    expect(parsed2.frontmatter["writing-time-min"]).toBe("1");

    const storedPhoto = await fs.readFile(`${outRoot}/media/att_photo01-holiday photo.png`);
    expect(storedPhoto).toEqual(photoBytes);

    const name3 = written[3] ?? "";
    expect(name3).toMatch(/^2026-05-12-[a-z]{40}-ij90kl\.md$/u);
  });
});

describe("archive round-trip", () => {
  it("moves a full journal between two JournalStores losslessly", async () => {
    const fsA = new MemFs();
    const storeA = new JournalStore(fsA, { coalesceMs: 0 });
    await storeA.init();

    const e1 = await storeA.createEntry({
      dateKey: "2026-03-01",
      title: "First day",
      body: "first body",
      createdAt: "2026-03-01T08:00:00.000Z",
    });
    await storeA.putEntry({ ...e1, title: "First day, revised", body: "first body\nmore lines" });
    const e1Current = await storeA.getEntry(e1.id);
    await storeA.putEntry({ ...e1Current, tags: ["week"], markers: ["early"] });

    const pngBytes = Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 3) % 256);
    await storeA.addAttachment(e1.id, "scan.png", "image/png", pngBytes);

    const audioPath = await storeA.beginAudio(e1.id, "audio/webm");
    await storeA.appendAudioChunk(audioPath, Uint8Array.from({ length: 32 }, (_, i) => i * 5));
    await storeA.appendAudioChunk(audioPath, Uint8Array.from({ length: 16 }, (_, i) => i * 9));
    const transcript: TranscriptRecord = {
      text: "hello world",
      language: "en",
      words: [
        { word: "hello", startMs: 0, endMs: 400 },
        { word: "world", startMs: 400, endMs: 900 },
      ],
      providerId: "mock",
      createdAt: "2026-03-01T08:05:00.000Z",
    };
    await storeA.finalizeAudio(audioPath, 2400, transcript);
    await storeA.setEntryAudio(e1.id, {
      storedPath: audioPath,
      mimeType: "audio/webm",
      durationMs: 2400,
      transcript,
    });

    const e2 = await storeA.createEntry({
      dateKey: "2026-03-02",
      body: "untitled day",
      createdAt: "2026-03-02T07:00:00.000Z",
    });

    const e3 = await storeA.createEntry({
      dateKey: "2026-03-03",
      title: "Third",
      body: "third body",
      createdAt: "2026-03-03T21:00:00.000Z",
    });
    await storeA.putEntry({ ...e3, body: "third body, edited" });
    await storeA.addAttachment(e3.id, "note.txt", "text/plain", encoder.encode("hello attachment"));

    const entries = await storeA.listEntries();
    expect(entries).toHaveLength(3);

    const archive = await buildArchive(entries, { readFile: (p) => fsA.readFile(p) });
    expect(Object.keys(archive.blobs)).toHaveLength(3);

    const json = archiveToJson(archive);
    expect(JSON.parse(json)).toMatchObject({ format: "quilljournal-archive@1" });

    await writeArchiveFile(fsA, "backups/quill-archive.json", archive);
    const reparsed = parseArchive(await fsA.readTextFile("backups/quill-archive.json"));

    const fsB = new MemFs();
    const storeB = new JournalStore(fsB, { coalesceMs: 0 });
    const sinkB = new StoreSink(fsB, storeB);
    const result = await importArchive(reparsed, sinkB);
    expect(result).toEqual({ imported: 3, skipped: 0, conflicts: 0 });

    const importedEntries = await storeB.listEntries();
    expect(importedEntries).toEqual(entries);

    const e1Imported = importedEntries.find((entry) => entry.dateKey === "2026-03-01");
    const e1Source = entries.find((entry) => entry.dateKey === "2026-03-01");
    expect(e1Imported).toBeDefined();
    expect(e1Source).toBeDefined();
    const attImported = (e1Imported as Entry).attachments[0];
    const attSource = (e1Source as Entry).attachments[0];
    expect(attImported).toBeDefined();
    expect(attSource).toBeDefined();
    const bytesA = await storeA.readAttachment(attSource as EntryAttachment);
    const bytesB = await storeB.readAttachment(attImported as EntryAttachment);
    expect(Buffer.from(bytesB).equals(Buffer.from(bytesA))).toBe(true);
    expect(await fsB.readFile((e1Imported as Entry).audio?.storedPath ?? "")).toEqual(
      await fsA.readFile(audioPath),
    );

    const att3 = importedEntries.find((entry) => entry.dateKey === "2026-03-03")?.attachments[0];
    expect(att3).toBeDefined();
    const textA = await storeA.readAttachment(att3 as EntryAttachment);
    const textB = await storeB.readAttachment(att3 as EntryAttachment);
    expect(new TextDecoder().decode(textB)).toBe("hello attachment");
    expect(textB).toEqual(textA);
  });
});

describe("conflict policies", () => {
  const blobPath = "attachments/att_000001/blob.bin";

  function sourceEntry(): Entry {
    return baseEntry({
      id: "entry_conflict1",
      title: "source title",
      body: "source body",
      updatedAt: "2026-05-10T10:00:00.000Z",
      attachments: [
        {
          id: "att_000001",
          fileName: "blob.bin",
          storedPath: blobPath,
          byteSize: 3,
          mimeType: "application/octet-stream",
          addedAt: "2026-05-10T09:00:00.000Z",
        },
      ],
      revisions: [
        { id: "rev_000001", at: "2026-05-10T08:00:00.000Z", title: "source title", body: "source body" },
      ],
      writingTimeMs: 65_000,
    });
  }

  function sourceArchive(entry: Entry): QuillArchive {
    return {
      format: "quilljournal-archive@1",
      exportedAt: "2026-06-01T00:00:00.000Z",
      entries: [entry],
      blobs: {
        [blobPath]: { mime: "application/octet-stream", b64: toBase64(new Uint8Array([9, 9, 9])) },
      },
    };
  }

  it("keep-both re-ids conflicting imports and rewrites their blob paths", async () => {
    const fs = new MemFs();
    const store = new JournalStore(fs);
    const sink = new StoreSink(fs, store);
    await sink.init();
    const existing = baseEntry({
      id: "entry_conflict1",
      title: "older title",
      body: "older body",
      updatedAt: "2026-05-10T09:00:00.000Z",
    });
    await sink.putEntryRaw(existing);
    await sink.writeFileRaw(blobPath, new Uint8Array([1, 1, 1]));

    const result = await importArchive(sourceArchive(sourceEntry()), sink);
    expect(result).toEqual({ imported: 1, skipped: 0, conflicts: 1 });

    const untouched = await store.getEntry("entry_conflict1");
    expect(untouched.updatedAt).toBe("2026-05-10T09:00:00.000Z");
    expect(untouched.body).toBe("older body");

    const importedCopy = await store.getEntry("entry_conflict1@imported");
    expect(importedCopy.title).toBe("source title");
    expect(importedCopy.attachments[0]?.storedPath).toBe("attachments/att_000001@imported/blob.bin");

    expect(await fs.readFile("attachments/att_000001@imported/blob.bin")).toEqual(
      new Uint8Array([9, 9, 9]),
    );
    expect(await fs.readFile(blobPath)).toEqual(new Uint8Array([1, 1, 1]));
  });

  it("keep-both skips an identical existing entry without conflicts", async () => {
    const fs = new MemFs();
    const store = new JournalStore(fs);
    const sink = new StoreSink(fs, store);
    await sink.init();
    await sink.putEntryRaw(sourceEntry());

    const result = await importArchive(sourceArchive(sourceEntry()), sink);
    expect(result).toEqual({ imported: 0, skipped: 1, conflicts: 0 });
    expect(await fs.exists(`entries/${sourceEntry().id}@imported.json`)).toBe(false);
  });

  it("skip-existing never touches an existing id", async () => {
    const fs = new MemFs();
    const store = new JournalStore(fs);
    const sink = new StoreSink(fs, store);
    await sink.init();
    const existing = baseEntry({
      id: "entry_conflict1",
      title: "resident",
      body: "resident body",
      updatedAt: "2026-05-10T08:00:00.000Z",
    });
    await sink.putEntryRaw(existing);
    await sink.writeFileRaw(blobPath, new Uint8Array([7, 7, 7]));

    const result = await importArchive(sourceArchive(sourceEntry()), sink, {
      conflictPolicy: "skip-existing",
    });
    expect(result).toEqual({ imported: 0, skipped: 1, conflicts: 0 });

    const resident = await store.getEntry("entry_conflict1");
    expect(resident.body).toBe("resident body");
    expect(await fs.exists(`entries/${existing.id}@imported.json`)).toBe(false);
    expect(await fs.exists("attachments/att_000001@imported/blob.bin")).toBe(false);
    expect(await fs.readFile(blobPath)).toEqual(new Uint8Array([7, 7, 7]));
  });
});

describe("parseArchive validation", () => {
  function validArchiveJson(): string {
    const archive: QuillArchive = {
      format: "quilljournal-archive@1",
      exportedAt: "2026-06-01T00:00:00.000Z",
      entries: [sourceEntryForValidation()],
      blobs: {
        "attachments/att_000001/blob.bin": {
          mime: "application/octet-stream",
          b64: toBase64(new Uint8Array([1, 2, 3])),
        },
      },
    };
    return JSON.stringify(archive);
  }

  function sourceEntryForValidation(): Entry {
    return baseEntry({
      id: "entry_validate1",
      title: "t",
      body: "b",
      attachments: [
        {
          id: "att_000001",
          fileName: "blob.bin",
          storedPath: "attachments/att_000001/blob.bin",
          byteSize: 3,
          mimeType: "application/octet-stream",
          addedAt: "2026-05-10T09:00:00.000Z",
        },
      ],
    });
  }

  it("accepts a well-formed archive", () => {
    const archive = parseArchive(validArchiveJson());
    expect(archive.format).toBe("quilljournal-archive@1");
    expect(archive.entries[0]?.id).toBe("entry_validate1");
  });

  it("rejects a wrong format string", () => {
    const obj = JSON.parse(validArchiveJson()) as Record<string, unknown>;
    obj["format"] = "some-other-archive@9";
    expectCorrupt(() => parseArchive(JSON.stringify(obj)));
  });

  it("rejects an entry missing its body field", () => {
    const obj = JSON.parse(validArchiveJson()) as {
      entries: Array<Record<string, unknown>>;
    };
    delete obj.entries[0]?.["body"];
    expectCorrupt(() => parseArchive(JSON.stringify(obj)));
  });

  it("rejects an invalid base64 blob payload", () => {
    const obj = JSON.parse(validArchiveJson()) as {
      blobs: Record<string, Record<string, unknown>>;
    };
    const blob = obj.blobs["attachments/att_000001/blob.bin"];
    if (!blob) throw new Error("blob missing from fixture");
    blob["b64"] = "!!not-base64!!";
    expectCorrupt(() => parseArchive(JSON.stringify(obj)));
  });

  it("rejects truncated JSON", () => {
    const full = validArchiveJson();
    expectCorrupt(() => parseArchive(full.slice(0, full.length - 12)));
  });
});

describe("printable html", () => {
  it("escapes all user text, shows both dates, and references nothing remote", () => {
    const dangerousBody = '<script>alert(1)</script>\n\nSecond ¶ with "quotes" & <tags> \'apostrophes\'';
    const e1 = baseEntry({
      id: "entry_print001",
      dateKey: "2026-05-10",
      title: "Dangerous <title>",
      body: dangerousBody,
      tags: ["work"],
      audio: null,
    });
    const e2 = baseEntry({
      id: "entry_print002",
      dateKey: "2026-05-11",
      title: "Spoken note",
      body: "Transcribed line.",
      markers: ["late"],
      audio: {
        storedPath: "audio/entry_print002/rec.webm",
        mimeType: "audio/webm",
        durationMs: 1200,
        transcript: null,
      },
    });
    const html = buildPrintableHtml([e1, e2], {
      journalTitle: "Zoë's Notes <vol 1>",
      dateRange: { from: "2026-05-10", to: "2026-05-11" },
    });

    expect(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;")).toBe(true);
    expect(html.includes("<script")).toBe(false);
    expect(html.includes("&quot;quotes&quot; &amp; &lt;tags&gt; &#39;apostrophes&#39;")).toBe(true);
    expect(html.includes("Zoë&#39;s Notes &lt;vol 1&gt;")).toBe(true);
    expect(html.includes(formatDateKeyLong("2026-05-10"))).toBe(true);
    expect(html.includes(formatDateKeyLong("2026-05-11"))).toBe(true);
    expect(html.includes("audio attached")).toBe(true);
    expect(html.includes("tags: work")).toBe(true);
    expect(html.includes("markers: late")).toBe(true);
    expect((html.match(/<article/gu) ?? []).length).toBe(2);
    expect(html.includes('onclick="window.print()"')).toBe(true);
    expect(html.includes("<style")).toBe(true);
    expect(html.includes("http://")).toBe(false);
    expect(html.includes("https://")).toBe(false);
  });
});
