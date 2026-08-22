import type { AppSettings, JournalManifest } from "../core/types.js";

export interface WriteRequest {
  path: string;
  data: Uint8Array | string;
}

export interface RecordingWriterStart {
  writerId: string;
  path: string;
}

export interface IpcBridge {
  writeFileAtomic(req: WriteRequest): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ size: number } | null>;
  unlink(path: string): Promise<void>;
  mkdirp(path: string): Promise<void>;
  listDir(path: string): Promise<{ name: string; isDirectory: boolean }[]>;
  rename(from: string, to: string): Promise<void>;
  removeDir(path: string): Promise<void>;

  startRecordingWriter(path: string): Promise<RecordingWriterStart>;
  appendRecordingChunk(writerId: string, chunk: Uint8Array): Promise<void>;
  finishRecordingWriter(writerId: string, fsync: boolean): Promise<void>;
  abortRecordingWriter(writerId: string): Promise<void>;

  pickDirectory(): Promise<string | null>;
  getStorageLocation(): Promise<string>;
  setStorageLocation(absPath: string): Promise<void>;
  getSettings(): Promise<AppSettings>;
  saveSettings(settings: AppSettings): Promise<void>;
  getManifest(): Promise<JournalManifest>;
  revealStorage(): Promise<void>;
  setRecordingIndicator(visible: boolean, label: string): Promise<void>;
  registerGlobalShortcut(accelerator: string): Promise<boolean>;
  unregisterGlobalShortcut(): Promise<void>;
  onNewEntryShortcut(cb: () => void): void;
  onOpenEntry(cb: (entryId: string) => void): void;
}

export const IPC_CHANNELS = {
  fsWriteAtomic: "fs:write-atomic",
  fsReadFile: "fs:read-file",
  fsExists: "fs:exists",
  fsStat: "fs:stat",
  fsUnlink: "fs:unlink",
  fsMkdirp: "fs:mkdirp",
  fsListDir: "fs:list-dir",
  fsRename: "fs:rename",
  fsRemoveDir: "fs:remove-dir",
  recStart: "rec:start",
  recAppend: "rec:append",
  recFinish: "rec:finish",
  recAbort: "rec:abort",
  appPickDir: "app:pick-dir",
  appGetStorage: "app:get-storage",
  appSetStorage: "app:set-storage",
  appGetSettings: "app:get-settings",
  appSaveSettings: "app:save-settings",
  appGetManifest: "app:get-manifest",
  appRevealStorage: "app:reveal-storage",
  appIndicator: "app:set-indicator",
  shortcutRegister: "shortcut:register",
  shortcutUnregister: "shortcut:unregister",
  pushNewEntry: "push:new-entry",
  pushOpenEntry: "push:open-entry",
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

