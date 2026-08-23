import { StorageError } from "../errors.js";
import {
  SCHEMA_VERSION,
  type Entry,
  type EntryAttachment,
  type EntryAudio,
  type EntryRevision,
  type JournalManifest,
  type JournalManifestEncryption,
  type TranscriptRecord,
} from "../types.js";
import { newAttachmentId, newEntryId, newId, newRevisionId } from "../ids.js";
import {
  KDF_ITERATIONS,
  decodeEnvelope,
  decrypt,
  deriveKey,
  encodeEnvelope,
  encrypt,
  hasEnvelopeMagic,
  randomBytes,
  type AesKey,
} from "../crypto.js";
import type { FileSystemLike } from "../fslike.js";

const ENTRIES_DIR = "entries";
const ATTACHMENTS_DIR = "attachments";
const AUDIO_DIR = "audio";
const MANIFEST_FILE = "manifest.json";
const VERIFIER_MESSAGE = "quilljournal-verifier-v1";
const DEFAULT_COALESCE_MS = 600_000;
const FRAME_LENGTH_BYTES = 4;

function isFramedEnvelopes(raw: Uint8Array): boolean {
  if (raw.length < FRAME_LENGTH_BYTES) return false;
  const firstLength = new DataView(
    raw.buffer,
    raw.byteOffset,
    FRAME_LENGTH_BYTES,
  ).getUint32(0, false);
  return (
    firstLength > 0 &&
    firstLength + FRAME_LENGTH_BYTES <= raw.length &&
    !hasEnvelopeMagic(raw)
  );
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface CreateEntryInput {
  dateKey: string;
  title?: string;
  body?: string;
  createdAt?: string;
}

export function revisionSnapshot(entry: Entry): EntryRevision[] {
  return entry.revisions.map((rev) => ({ ...rev }));
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function joinPath(...parts: string[]): string {
  return parts.join("/");
}

function sanitizeFileName(name: string): string {
  const segments = name.split(/[/\\]/);
  const base = segments[segments.length - 1] ?? "";
  let cleaned = "";
  for (const ch of base) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) cleaned += ch;
  }
  cleaned = cleaned.replace(/[. ]+$/u, "");
  if (!cleaned || cleaned === "." || cleaned === "..") return "file";
  return cleaned;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function parseJsonBytes<T>(bytes: Uint8Array, what: string): T {
  try {
    return JSON.parse(decoder.decode(bytes)) as T;
  } catch (cause) {
    throw new StorageError("corrupt", `${what} is not valid JSON`, { cause });
  }
}

export class JournalStore {
  private readonly fs: FileSystemLike;
  private readonly coalesceMs: number;
  private manifestData: JournalManifest | null = null;
  private key: AesKey | null = null;

  constructor(fs: FileSystemLike, opts?: { coalesceMs?: number }) {
    this.fs = fs;
    this.coalesceMs = opts?.coalesceMs ?? DEFAULT_COALESCE_MS;
  }

  async init(): Promise<void> {
    await this.fs.mkdirp(ENTRIES_DIR);
    await this.fs.mkdirp(ATTACHMENTS_DIR);
    await this.fs.mkdirp(AUDIO_DIR);
    if (!(await this.fs.exists(MANIFEST_FILE))) {
      this.manifestData = {
        schemaVersion: SCHEMA_VERSION,
        createdAt: new Date().toISOString(),
        encryption: null,
      };
      await this.writeManifest();
      return;
    }
    const raw = await this.fs.readFile(MANIFEST_FILE);
    const loaded = parseJsonBytes<JournalManifest>(raw, MANIFEST_FILE);
    if (typeof loaded.schemaVersion !== "number") {
      throw new StorageError("corrupt", `${MANIFEST_FILE} has no numeric schemaVersion`);
    }
    if (loaded.schemaVersion > SCHEMA_VERSION) {
      throw new StorageError(
        "corrupt",
        `${MANIFEST_FILE} schemaVersion ${loaded.schemaVersion} is newer than supported version ${SCHEMA_VERSION}`,
      );
    }
    this.manifestData =
      loaded.schemaVersion < SCHEMA_VERSION ? this.migrateManifest(loaded) : loaded;
    if (this.manifestData !== loaded) await this.writeManifest();
  }

  private migrateManifest(manifest: JournalManifest): JournalManifest {
    const migrated: JournalManifest = { ...manifest };
    switch (manifest.schemaVersion) {
      default:
        migrated.schemaVersion = SCHEMA_VERSION;
        break;
    }
    return migrated;
  }

  manifest(): JournalManifest {
    const manifest = this.requireManifest();
    return {
      schemaVersion: manifest.schemaVersion,
      createdAt: manifest.createdAt,
      encryption: manifest.encryption ? { ...manifest.encryption } : null,
    };
  }

  private requireManifest(): JournalManifest {
    if (!this.manifestData) throw new Error("JournalStore.init() must complete before use");
    return this.manifestData;
  }

  private async writeManifest(): Promise<void> {
    const manifest = this.requireManifest();
    await this.fs.writeFileAtomic(MANIFEST_FILE, encoder.encode(JSON.stringify(manifest, null, 2)));
  }

  isEncrypted(): boolean {
    return this.manifestData?.encryption != null;
  }

  isUnlocked(): boolean {
    return this.key !== null;
  }

  lock(): void {
    this.key = null;
  }

  async enableEncryption(passphrase: string): Promise<void> {
    const manifest = this.requireManifest();
    if (passphrase.length === 0) throw new RangeError("passphrase must not be empty");
    if (manifest.encryption) throw new Error("encryption already enabled");
    const salt = randomBytes(16);
    const key = await deriveKey(passphrase, salt, KDF_ITERATIONS);
    const verifier = await encrypt(key, encoder.encode(VERIFIER_MESSAGE));
    const encryption: JournalManifestEncryption = {
      cipher: "AES-256-GCM",
      kdf: "PBKDF2-SHA256",
      iterations: KDF_ITERATIONS,
      saltB64: toBase64(salt),
      verifierIvB64: toBase64(verifier.iv),
      verifierCtB64: toBase64(verifier.ct),
    };
    this.manifestData = { ...manifest, encryption };
    this.key = key;
    await this.writeManifest();
    await this.reencryptAllExistingFiles(key);
  }

  private async reencryptAllExistingFiles(key: AesKey): Promise<void> {
    const entryItems = await this.fs.listDir(ENTRIES_DIR);
    for (const item of entryItems) {
      if (item.isDirectory || !item.name.endsWith(".json")) continue;
      await this.wrapFileWithEnvelope(joinPath(ENTRIES_DIR, item.name), key);
    }
    const attachmentDirs = await this.fs.listDir(ATTACHMENTS_DIR);
    for (const dir of attachmentDirs) {
      if (!dir.isDirectory) continue;
      const dirRel = joinPath(ATTACHMENTS_DIR, dir.name);
      const files = await this.fs.listDir(dirRel);
      for (const file of files) {
        if (file.isDirectory) continue;
        await this.wrapFileWithEnvelope(joinPath(dirRel, file.name), key);
      }
    }
    const audioDirs = await this.fs.listDir(AUDIO_DIR);
    for (const dir of audioDirs) {
      if (!dir.isDirectory) continue;
      const dirRel = joinPath(AUDIO_DIR, dir.name);
      const files = await this.fs.listDir(dirRel);
      for (const file of files) {
        if (file.isDirectory) continue;
        await this.wrapFileWithEnvelope(joinPath(dirRel, file.name), key);
      }
    }
  }

  private async wrapFileWithEnvelope(relPath: string, key: AesKey): Promise<void> {
    const plaintext = await this.fs.readFile(relPath);
    const wrapped = encodeEnvelope(await encrypt(key, plaintext));
    await this.fs.writeFileAtomic(relPath, wrapped);
  }

  async unlock(passphrase: string): Promise<void> {
    const manifest = this.requireManifest();
    const encryption = manifest.encryption;
    if (!encryption) return;
    const key = await deriveKey(passphrase, fromBase64(encryption.saltB64), encryption.iterations);
    try {
      const verifier = await decrypt(
        key,
        fromBase64(encryption.verifierIvB64),
        fromBase64(encryption.verifierCtB64),
      );
      if (decoder.decode(verifier) !== VERIFIER_MESSAGE) throw new Error("verifier mismatch");
    } catch (cause) {
      throw new StorageError("wrong-passphrase", "passphrase does not match this journal", {
        cause,
      });
    }
    this.key = key;
  }

  private assertUsableForContent(): void {
    const manifest = this.requireManifest();
    if (manifest.encryption && !this.key) {
      throw new StorageError("locked", "journal is encrypted and locked; unlock first");
    }
  }

  async sealAudioChunk(chunk: Uint8Array): Promise<Uint8Array> {
    if (!this.isEncrypted()) return chunk;
    const key = this.requireKey();
    const envelope = encodeEnvelope(await encrypt(key, chunk));
    const frame = new Uint8Array(FRAME_LENGTH_BYTES + envelope.length);
    new DataView(frame.buffer).setUint32(0, envelope.length, false);
    frame.set(envelope, FRAME_LENGTH_BYTES);
    return frame;
  }

  async consolidateAudioFile(relPath: string): Promise<void> {
    if (!this.isEncrypted()) return;
    const raw = await this.fs.readFile(relPath);
    if (!isFramedEnvelopes(raw)) return;
    const plaintextParts: Uint8Array[] = [];
    let offset = 0;
    while (offset < raw.length) {
      if (offset + FRAME_LENGTH_BYTES > raw.length) {
        throw new StorageError("corrupt", `${relPath} has a truncated audio frame length`);
      }
      const view = new DataView(raw.buffer, raw.byteOffset + offset, FRAME_LENGTH_BYTES);
      const length = view.getUint32(0, false);
      offset += FRAME_LENGTH_BYTES;
      if (offset + length > raw.length) {
        throw new StorageError("corrupt", `${relPath} has a truncated audio frame`);
      }
      const envelope = decodeEnvelope(raw.subarray(offset, offset + length));
      plaintextParts.push(await decrypt(this.requireKey(), envelope.iv, envelope.ct));
      offset += length;
    }
    let total = 0;
    for (const part of plaintextParts) total += part.length;
    const merged = new Uint8Array(total);
    let cursor = 0;
    for (const part of plaintextParts) {
      merged.set(part, cursor);
      cursor += part.length;
    }
    await this.writeContent(relPath, merged);
  }

  async readAudio(storedPath: string): Promise<Uint8Array> {
    return this.readContent(storedPath);
  }

  async disableEncryption(passphrase: string): Promise<void> {
    const manifest = this.requireManifest();
    if (!manifest.encryption) throw new Error("encryption is not enabled");
    await this.unlock(passphrase);
    this.manifestData = {
      ...manifest,
      encryption: { ...manifest.encryption, transitioning: true },
    };
    await this.writeManifest();
    await this.decryptAllExistingFiles();
    this.manifestData = { ...this.manifestData, encryption: null };
    this.key = null;
    await this.writeManifest();
  }

  async changePassphrase(oldPassphrase: string, newPassphrase: string): Promise<void> {
    if (newPassphrase.length === 0) throw new RangeError("passphrase must not be empty");
    await this.disableEncryption(oldPassphrase);
    await this.enableEncryption(newPassphrase);
  }

  private requireKey(): AesKey {
    const key = this.key;
    if (!key) throw new StorageError("locked", "journal is encrypted and locked; unlock first");
    return key;
  }

  private async decryptAllExistingFiles(): Promise<void> {
    for (const relPath of await this.listAllContentFiles()) {
      const plain = await this.readContent(relPath);
      await this.fs.writeFileAtomic(relPath, plain);
    }
  }

  private async listAllContentFiles(): Promise<string[]> {
    const paths: string[] = [];
    for (const item of await this.fs.listDir(ENTRIES_DIR)) {
      if (!item.isDirectory && item.name.endsWith(".json")) {
        paths.push(joinPath(ENTRIES_DIR, item.name));
      }
    }
    for (const dir of await this.fs.listDir(ATTACHMENTS_DIR)) {
      if (!dir.isDirectory) continue;
      const dirRel = joinPath(ATTACHMENTS_DIR, dir.name);
      for (const file of await this.fs.listDir(dirRel)) {
        if (!file.isDirectory) paths.push(joinPath(dirRel, file.name));
      }
    }
    for (const dir of await this.fs.listDir(AUDIO_DIR)) {
      if (!dir.isDirectory) continue;
      const dirRel = joinPath(AUDIO_DIR, dir.name);
      for (const file of await this.fs.listDir(dirRel)) {
        if (!file.isDirectory) paths.push(joinPath(dirRel, file.name));
      }
    }
    return paths;
  }

  private async readContent(relPath: string): Promise<Uint8Array> {
    this.assertUsableForContent();
    const raw = await this.fs.readFile(relPath);
    if (!this.isEncrypted()) return raw;
    const key = this.key;
    if (!key) throw new StorageError("locked", "journal is encrypted and locked; unlock first");
    if (!hasEnvelopeMagic(raw)) {
      const encryption = this.requireManifest().encryption;
      if (encryption?.transitioning) return raw;
      throw new StorageError("corrupt", `${relPath} is not an encrypted envelope`);
    }
    const envelope = decodeEnvelope(raw);
    return decrypt(key, envelope.iv, envelope.ct);
  }

  private async writeContent(relPath: string, data: Uint8Array): Promise<void> {
    this.assertUsableForContent();
    if (!this.isEncrypted()) {
      await this.fs.writeFileAtomic(relPath, data);
      return;
    }
    const key = this.key;
    if (!key) throw new StorageError("locked", "journal is encrypted and locked; unlock first");
    const wrapped = encodeEnvelope(await encrypt(key, data));
    await this.fs.writeFileAtomic(relPath, wrapped);
  }

  private entryPath(id: string): string {
    return joinPath(ENTRIES_DIR, `${id}.json`);
  }

  async createEntry(input: CreateEntryInput): Promise<Entry> {
    const now = input.createdAt ?? new Date().toISOString();
    const title = input.title ?? "";
    const body = input.body ?? "";
    const entry: Entry = {
      schemaVersion: SCHEMA_VERSION,
      id: newEntryId(),
      dateKey: input.dateKey,
      createdAt: now,
      updatedAt: now,
      title,
      body,
      tags: [],
      markers: [],
      attachments: [],
      audio: null,
      revisions: [{ id: newRevisionId(), at: now, title, body }],
      writingTimeMs: 0,
    };
    await this.persistEntryFile(entry);
    return entry;
  }

  async putEntry(entry: Entry): Promise<void> {
    const nowIso = new Date().toISOString();
    const stored = await this.tryReadStoredEntry(entry.id);
    const revisions = stored
      ? this.mergeRevisions(stored.revisions, entry.title, entry.body, nowIso)
      : revisionSnapshot(entry);
    await this.persistEntryFile({ ...entry, updatedAt: nowIso, revisions });
  }

  private mergeRevisions(
    storedRevisions: EntryRevision[],
    incomingTitle: string,
    incomingBody: string,
    nowIso: string,
  ): EntryRevision[] {
    const revisions = storedRevisions.map((rev) => ({ ...rev }));
    const latest = revisions[revisions.length - 1];
    if (!latest) {
      revisions.push({ id: newRevisionId(), at: nowIso, title: incomingTitle, body: incomingBody });
    } else if (latest.title !== incomingTitle || latest.body !== incomingBody) {
      const snapshot: EntryRevision = {
        id: newRevisionId(),
        at: nowIso,
        title: incomingTitle,
        body: incomingBody,
      };
      const latestAgeMs = Date.now() - Date.parse(latest.at);
      if (Number.isNaN(latestAgeMs) || latestAgeMs >= this.coalesceMs) {
        revisions.push(snapshot);
      } else {
        revisions[revisions.length - 1] = snapshot;
      }
    }
    const newer = revisions[revisions.length - 1];
    const older = revisions[revisions.length - 2];
    if (newer && older && newer.title === older.title && newer.body === older.body) {
      revisions.pop();
    }
    return revisions;
  }

  private async tryReadStoredEntry(id: string): Promise<Entry | null> {
    const path = this.entryPath(id);
    if (!(await this.fs.exists(path))) return null;
    return this.readEntryFile(path);
  }

  private async readEntryFile(path: string): Promise<Entry> {
    const bytes = await this.readContent(path);
    const parsed = parseJsonBytes<Entry>(bytes, `entry file ${path}`);
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.dateKey !== "string" ||
      !Array.isArray(parsed.revisions)
    ) {
      throw new StorageError("corrupt", `entry file ${path} is malformed`);
    }
    return parsed;
  }

  async getEntry(id: string): Promise<Entry> {
    this.assertUsableForContent();
    const path = this.entryPath(id);
    if (!(await this.fs.exists(path))) {
      throw new StorageError("not-found", `entry ${id} not found`);
    }
    return this.readEntryFile(path);
  }

  async getEntryOrNull(id: string): Promise<Entry | null> {
    this.assertUsableForContent();
    const stored = await this.tryReadStoredEntry(id);
    return stored;
  }

  async putEntryRaw(entry: Entry): Promise<void> {
    this.assertUsableForContent();
    await this.persistEntryFile(entry);
  }

  async writeFileRaw(relPath: string, bytes: Uint8Array): Promise<void> {
    await this.writeContent(relPath, bytes);
  }

  async listEntries(): Promise<Entry[]> {
    this.assertUsableForContent();
    const items = await this.fs.listDir(ENTRIES_DIR);
    const entries: Entry[] = [];
    for (const item of items) {
      if (item.isDirectory || !item.name.endsWith(".json")) continue;
      entries.push(await this.readEntryFile(joinPath(ENTRIES_DIR, item.name)));
    }
    entries.sort((a, b) => {
      if (a.dateKey !== b.dateKey) return a.dateKey < b.dateKey ? 1 : -1;
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
      return 0;
    });
    return entries;
  }

  private async persistEntryFile(entry: Entry): Promise<void> {
    await this.writeContent(this.entryPath(entry.id), encoder.encode(JSON.stringify(entry, null, 2)));
  }

  async deleteEntry(id: string): Promise<void> {
    this.assertUsableForContent();
    const entry = await this.getEntry(id);
    for (const attachment of entry.attachments) {
      if (await this.fs.exists(attachment.storedPath)) {
        await this.fs.unlink(attachment.storedPath);
      }
      await this.fs.removeDir(joinPath(ATTACHMENTS_DIR, attachment.id));
    }
    await this.fs.removeDir(joinPath(AUDIO_DIR, id));
    const path = this.entryPath(id);
    if (await this.fs.exists(path)) await this.fs.unlink(path);
  }

  async addAttachment(
    entryId: string,
    fileName: string,
    mimeType: string,
    bytes: Uint8Array,
  ): Promise<EntryAttachment> {
    const entry = await this.getEntry(entryId);
    const safeName = sanitizeFileName(fileName);
    const attachmentId = newAttachmentId();
    const storedPath = joinPath(ATTACHMENTS_DIR, attachmentId, safeName);
    await this.writeContent(storedPath, bytes);
    const attachment: EntryAttachment = {
      id: attachmentId,
      fileName: safeName,
      storedPath,
      byteSize: bytes.length,
      mimeType,
      addedAt: new Date().toISOString(),
    };
    await this.persistEntryFile({
      ...entry,
      attachments: [...entry.attachments, attachment],
      updatedAt: new Date().toISOString(),
    });
    return attachment;
  }

  async readAttachment(att: EntryAttachment): Promise<Uint8Array> {
    return this.readContent(att.storedPath);
  }

  async removeAttachment(entryId: string, attachmentId: string): Promise<void> {
    const entry = await this.getEntry(entryId);
    const target = entry.attachments.find((att) => att.id === attachmentId);
    if (!target) {
      throw new StorageError("not-found", `attachment ${attachmentId} not found on entry ${entryId}`);
    }
    if (await this.fs.exists(target.storedPath)) await this.fs.unlink(target.storedPath);
    await this.fs.removeDir(joinPath(ATTACHMENTS_DIR, attachmentId));
    await this.persistEntryFile({
      ...entry,
      attachments: entry.attachments.filter((att) => att.id !== attachmentId),
      updatedAt: new Date().toISOString(),
    });
  }

  async beginAudio(entryId: string, _mimeType: string): Promise<string> {
    await this.getEntry(entryId);
    const audioId = newId("audio");
    const relPath = joinPath(AUDIO_DIR, entryId, `${audioId}.webm`);
    await this.fs.writeFileAtomic(relPath, new Uint8Array(0));
    return relPath;
  }

  async appendAudioChunk(path: string, chunk: Uint8Array): Promise<void> {
    this.assertUsableForContent();
    await this.fs.appendFile(path, await this.sealAudioChunk(chunk));
  }

  async finalizeAudio(
    path: string,
    _durationMs: number | null,
    _transcript: TranscriptRecord | null,
  ): Promise<void> {
    this.assertUsableForContent();
    if (!(await this.fs.exists(path))) {
      throw new StorageError("not-found", `audio recording ${path} not found`);
    }
    await this.consolidateAudioFile(path);
  }

  async discardAudio(entryId: string): Promise<void> {
    const entry = await this.getEntry(entryId);
    const audio = entry.audio;
    if (audio && (await this.fs.exists(audio.storedPath))) {
      await this.fs.unlink(audio.storedPath);
    }
    await this.persistEntryFile({ ...entry, audio: null, updatedAt: new Date().toISOString() });
  }

  async setEntryAudio(entryId: string, audio: EntryAudio | null): Promise<void> {
    const entry = await this.getEntry(entryId);
    await this.persistEntryFile({ ...entry, audio, updatedAt: new Date().toISOString() });
  }
}
