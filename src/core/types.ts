export const SCHEMA_VERSION = 1;

export interface WordTiming {
  word: string;
  startMs: number;
  endMs: number;
}

export interface TranscriptRecord {
  text: string;
  language?: string;
  words?: WordTiming[];
  providerId: string;
  createdAt: string;
}

export interface EntryRevision {
  id: string;
  at: string;
  title: string;
  body: string;
}

export interface EntryAttachment {
  id: string;
  fileName: string;
  storedPath: string;
  byteSize: number;
  mimeType: string;
  addedAt: string;
}

export interface EntryAudio {
  storedPath: string;
  mimeType: string;
  durationMs: number | null;
  transcript: TranscriptRecord | null;
}

export interface Entry {
  schemaVersion: number;
  id: string;
  dateKey: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  body: string;
  tags: string[];
  markers: string[];
  attachments: EntryAttachment[];
  audio: EntryAudio | null;
  revisions: EntryRevision[];
  writingTimeMs: number;
}

export type EncryptionCipher = "AES-256-GCM";
export type EncryptionKdf = "PBKDF2-SHA256";

export interface JournalManifestEncryption {
  cipher: EncryptionCipher;
  kdf: EncryptionKdf;
  iterations: number;
  saltB64: string;
  verifierIvB64: string;
  verifierCtB64: string;
  transitioning?: boolean;
}

export interface JournalManifest {
  schemaVersion: number;
  createdAt: string;
  encryption: JournalManifestEncryption | null;
}

export type ThemeName = "light" | "dark" | "night" | "high-contrast";

export interface HttpProviderConfig {
  endpointUrl: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface LocalEngineConfig {
  enginePath?: string;
  modelArgs?: string;
}

export interface AppSettings {
  theme: ThemeName;
  fontSizePx: number;
  measureCh: number;
  promptsEnabled: boolean;
  userPrompts: string[];
  providerId: "mock" | "local-engine" | "http";
  httpProvider: HttpProviderConfig | null;
  localEngine: LocalEngineConfig;
  encryptionEnabled: boolean;
  idleLockMinutes: number | null;
  backupReminderDays: number | null;
  discardAudioAfterTranscriptionDefault: boolean;
  globalNewEntryShortcut: string;
  onboardedAt: string | null;
  lastExportAt: string | null;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "light",
  fontSizePx: 19,
  measureCh: 66,
  promptsEnabled: false,
  userPrompts: [],
  providerId: "mock",
  httpProvider: null,
  localEngine: {},
  encryptionEnabled: false,
  idleLockMinutes: null,
  backupReminderDays: 30,
  discardAudioAfterTranscriptionDefault: false,
  globalNewEntryShortcut: "Control+Alt+N",
  onboardedAt: null,
  lastExportAt: null,
};
