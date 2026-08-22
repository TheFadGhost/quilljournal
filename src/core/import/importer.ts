import { StorageError } from "../errors.js";
import type {
  Entry,
  EntryAttachment,
  EntryAudio,
  EntryRevision,
  TranscriptRecord,
  WordTiming,
} from "../types.js";
import { fromBase64, type ArchiveBlob, type QuillArchive } from "../export/archive.js";

export interface ImportSink {
  init(): Promise<void>;
  getEntry(id: string): Promise<Entry | null>;
  putEntryRaw(entry: Entry): Promise<void>;
  writeFileRaw(relPath: string, bytes: Uint8Array): Promise<void>;
  isEncrypted(): boolean;
  unlock(passphrase: string): Promise<void>;
}

export interface ImportOptions {
  conflictPolicy?: "keep-both" | "skip-existing";
}

export interface ImportResult {
  imported: number;
  skipped: number;
  conflicts: number;
}

const ARCHIVE_FORMAT = "quilljournal-archive@1";
const IMPORT_SUFFIX = "@imported";
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function fail(message: string): never {
  throw new StorageError("corrupt", message);
}

function objectField(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(obj: Record<string, unknown>, key: string, what: string): string {
  const value = obj[key];
  if (typeof value !== "string") fail(`${what}.${key} must be a string`);
  return value;
}

function numberField(obj: Record<string, unknown>, key: string, what: string): number {
  const value = obj[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${what}.${key} must be a number`);
  }
  return value;
}

function optionalString(
  obj: Record<string, unknown>,
  key: string,
  what: string,
): string | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") fail(`${what}.${key} must be a string or null`);
  return value;
}

function stringArrayField(obj: Record<string, unknown>, key: string, what: string): string[] {
  const value = obj[key];
  if (!Array.isArray(value)) fail(`${what}.${key} must be an array`);
  for (const item of value) {
    if (typeof item !== "string") fail(`${what}.${key} must contain only strings`);
  }
  return value as string[];
}

function wordTimingsField(
  obj: Record<string, unknown>,
  key: string,
  what: string,
): WordTiming[] | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) fail(`${what}.${key} must be an array`);
  return value.map((item, index) => {
    const path = `${what}.${key}[${index}]`;
    const timing = objectField(item, path);
    return {
      word: stringField(timing, "word", path),
      startMs: numberField(timing, "startMs", path),
      endMs: numberField(timing, "endMs", path),
    };
  });
}

function transcriptField(obj: Record<string, unknown>, what: string): TranscriptRecord | null {
  const value = obj["transcript"];
  if (value === undefined || value === null) return null;
  const path = `${what}.transcript`;
  const transcript = objectField(value, path);
  return {
    text: stringField(transcript, "text", path),
    language: optionalString(transcript, "language", path),
    words: wordTimingsField(transcript, "words", path),
    providerId: stringField(transcript, "providerId", path),
    createdAt: stringField(transcript, "createdAt", path),
  };
}

function audioField(obj: Record<string, unknown>, what: string): EntryAudio | null {
  const value = obj["audio"];
  if (value === undefined || value === null) return null;
  const path = `${what}.audio`;
  const audio = objectField(value, path);
  const durationMs = audio["durationMs"];
  if (
    durationMs !== undefined &&
    durationMs !== null &&
    (typeof durationMs !== "number" || !Number.isFinite(durationMs))
  ) {
    fail(`${path}.durationMs must be a number or null`);
  }
  return {
    storedPath: stringField(audio, "storedPath", path),
    mimeType: stringField(audio, "mimeType", path),
    durationMs: typeof durationMs === "number" ? durationMs : null,
    transcript: transcriptField(audio, path),
  };
}

function attachmentsField(obj: Record<string, unknown>, what: string): EntryAttachment[] {
  const value = obj["attachments"];
  if (!Array.isArray(value)) fail(`${what}.attachments must be an array`);
  return value.map((item, index) => {
    const path = `${what}.attachments[${index}]`;
    const attachment = objectField(item, path);
    return {
      id: stringField(attachment, "id", path),
      fileName: stringField(attachment, "fileName", path),
      storedPath: stringField(attachment, "storedPath", path),
      byteSize: numberField(attachment, "byteSize", path),
      mimeType: stringField(attachment, "mimeType", path),
      addedAt: stringField(attachment, "addedAt", path),
    };
  });
}

function revisionsField(obj: Record<string, unknown>, what: string): EntryRevision[] {
  const value = obj["revisions"];
  if (!Array.isArray(value)) fail(`${what}.revisions must be an array`);
  return value.map((item, index) => {
    const path = `${what}.revisions[${index}]`;
    const revision = objectField(item, path);
    return {
      id: stringField(revision, "id", path),
      at: stringField(revision, "at", path),
      title: stringField(revision, "title", path),
      body: stringField(revision, "body", path),
    };
  });
}

function entryField(value: unknown, index: number): Entry {
  const what = `entries[${index}]`;
  const obj = objectField(value, what);
  return {
    schemaVersion: numberField(obj, "schemaVersion", what),
    id: stringField(obj, "id", what),
    dateKey: stringField(obj, "dateKey", what),
    createdAt: stringField(obj, "createdAt", what),
    updatedAt: stringField(obj, "updatedAt", what),
    title: stringField(obj, "title", what),
    body: stringField(obj, "body", what),
    tags: stringArrayField(obj, "tags", what),
    markers: stringArrayField(obj, "markers", what),
    attachments: attachmentsField(obj, what),
    audio: audioField(obj, what),
    revisions: revisionsField(obj, what),
    writingTimeMs: numberField(obj, "writingTimeMs", what),
  };
}

function isDecodableBase64(value: string): boolean {
  try {
    atob(value);
    return true;
  } catch {
    return false;
  }
}

function blobField(value: unknown, key: string): ArchiveBlob {
  const what = `blobs[${JSON.stringify(key)}]`;
  const obj = objectField(value, what);
  const mime = obj["mime"];
  if (typeof mime !== "string") fail(`${what}.mime must be a string`);
  const b64 = obj["b64"];
  if (typeof b64 !== "string") fail(`${what}.b64 must be a string`);
  if (!BASE64_PATTERN.test(b64) || !isDecodableBase64(b64)) {
    fail(`${what}.b64 is not valid base64`);
  }
  return { mime, b64 };
}

export function parseArchive(text: string): QuillArchive {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new StorageError("corrupt", "archive is not valid JSON", { cause });
  }
  const root = objectField(parsed, "archive");
  if (root["format"] !== ARCHIVE_FORMAT) {
    fail(`archive.format must be exactly "${ARCHIVE_FORMAT}"`);
  }
  const exportedAt = stringField(root, "exportedAt", "archive");
  const entriesRaw = root["entries"];
  if (!Array.isArray(entriesRaw)) fail("archive.entries must be an array");
  const entries = entriesRaw.map(entryField);
  const blobsRaw = root["blobs"];
  if (typeof blobsRaw !== "object" || blobsRaw === null || Array.isArray(blobsRaw)) {
    fail("archive.blobs must be an object");
  }
  const blobs: Record<string, ArchiveBlob> = {};
  for (const [key, value] of Object.entries(blobsRaw as Record<string, unknown>)) {
    blobs[key] = blobField(value, key);
  }
  return { format: ARCHIVE_FORMAT, exportedAt, entries, blobs };
}

function importRewrittenPath(storedPath: string): string {
  const segments = storedPath.split("/");
  if (segments.length >= 2 && segments[1] !== undefined) {
    segments[1] = `${segments[1]}${IMPORT_SUFFIX}`;
    return segments.join("/");
  }
  return `${storedPath}${IMPORT_SUFFIX}`;
}

function withImportPaths(entry: Entry, rewrites: Map<string, string>): Entry {
  return {
    ...entry,
    id: `${entry.id}${IMPORT_SUFFIX}`,
    attachments: entry.attachments.map((attachment) => ({
      ...attachment,
      storedPath: rewrites.get(attachment.storedPath) ?? attachment.storedPath,
    })),
    audio:
      entry.audio === null
        ? null
        : {
            ...entry.audio,
            storedPath: rewrites.get(entry.audio.storedPath) ?? entry.audio.storedPath,
          },
  };
}

export async function importArchive(
  archive: QuillArchive,
  sink: ImportSink,
  options?: ImportOptions,
): Promise<ImportResult> {
  await sink.init();
  const policy = options?.conflictPolicy ?? "keep-both";
  let imported = 0;
  let skipped = 0;
  let conflicts = 0;
  const pathRewrites = new Map<string, string>();
  const blockedPaths = new Set<string>();
  for (const entry of archive.entries) {
    const existing = await sink.getEntry(entry.id);
    if (policy === "skip-existing") {
      if (existing !== null) {
        skipped++;
        for (const attachment of entry.attachments) blockedPaths.add(attachment.storedPath);
        if (entry.audio !== null) blockedPaths.add(entry.audio.storedPath);
        continue;
      }
    } else if (existing !== null) {
      if (existing.updatedAt === entry.updatedAt) {
        skipped++;
        for (const attachment of entry.attachments) blockedPaths.add(attachment.storedPath);
        if (entry.audio !== null) blockedPaths.add(entry.audio.storedPath);
        continue;
      }
      const rewrites = new Map<string, string>();
      for (const attachment of entry.attachments) {
        rewrites.set(attachment.storedPath, importRewrittenPath(attachment.storedPath));
      }
      if (entry.audio !== null) {
        rewrites.set(entry.audio.storedPath, importRewrittenPath(entry.audio.storedPath));
      }
      for (const [from, to] of rewrites) pathRewrites.set(from, to);
      await sink.putEntryRaw(withImportPaths(entry, rewrites));
      imported++;
      conflicts++;
      continue;
    }
    await sink.putEntryRaw(entry);
    imported++;
  }
  for (const [storedPath, blob] of Object.entries(archive.blobs)) {
    const rewritten = pathRewrites.get(storedPath);
    if (rewritten !== undefined) {
      await sink.writeFileRaw(rewritten, fromBase64(blob.b64));
      continue;
    }
    if (blockedPaths.has(storedPath)) continue;
    await sink.writeFileRaw(storedPath, fromBase64(blob.b64));
  }
  return { imported, skipped, conflicts };
}
