import type { FileSystemLike } from "../fslike.js";
import type { Entry } from "../types.js";

export interface ArchiveBlob {
  mime: string;
  b64: string;
}

export interface QuillArchive {
  format: "quilljournal-archive@1";
  exportedAt: string;
  entries: Entry[];
  blobs: Record<string, ArchiveBlob>;
}

const ARCHIVE_FORMAT = "quilljournal-archive@1";
const BASE64_CHUNK = 0x8000;

const encoder = new TextEncoder();

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK));
  }
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function storedRefsOf(entry: Entry): Array<{ path: string; mime: string }> {
  const refs: Array<{ path: string; mime: string }> = [];
  for (const attachment of entry.attachments) {
    refs.push({ path: attachment.storedPath, mime: attachment.mimeType });
  }
  if (entry.audio) refs.push({ path: entry.audio.storedPath, mime: entry.audio.mimeType });
  return refs;
}

export async function buildArchive(
  entries: Entry[],
  loaders: { readFile(storedPath: string): Promise<Uint8Array> },
): Promise<QuillArchive> {
  const pending = new Map<string, string>();
  for (const entry of entries) {
    for (const ref of storedRefsOf(entry)) {
      if (!pending.has(ref.path)) pending.set(ref.path, ref.mime);
    }
  }
  const blobs: Record<string, ArchiveBlob> = {};
  for (const [storedPath, mime] of pending) {
    try {
      const bytes = await loaders.readFile(storedPath);
      blobs[storedPath] = { mime, b64: toBase64(bytes) };
    } catch {
      continue;
    }
  }
  return {
    format: ARCHIVE_FORMAT,
    exportedAt: new Date().toISOString(),
    entries: entries.map((entry) => ({ ...entry })),
    blobs,
  };
}

export function archiveToJson(archive: QuillArchive): string {
  return JSON.stringify(archive, null, 2);
}

export async function writeArchiveFile(
  fs: FileSystemLike,
  outPath: string,
  archive: QuillArchive,
): Promise<void> {
  const segments = outPath.split(/[/\\]/).filter((segment) => segment.length > 0);
  segments.pop();
  if (segments.length > 0) await fs.mkdirp(segments.join("/"));
  await fs.writeFileAtomic(outPath, encoder.encode(archiveToJson(archive)));
}
