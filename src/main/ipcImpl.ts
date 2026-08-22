import { dialog, globalShortcut, ipcMain, shell } from "electron";
import type { BrowserWindow, IpcMain } from "electron";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile as fsReadFile, readdir, stat as fsStat } from "node:fs/promises";
import type { FileSystemLike } from "../core/fslike.js";
import { DEFAULT_SETTINGS, SCHEMA_VERSION } from "../core/types.js";
import type { AppSettings, JournalManifest } from "../core/types.js";
import { IPC_CHANNELS } from "../shared/ipc.js";
import type { WriteRequest } from "../shared/ipc.js";
import { atomicWriteAbs, createNodeFsLike } from "./nodeFsLike.js";
import type { NodeFileSystemLike } from "./nodeFsLike.js";
import { RecordingWriter } from "./recordingWriter.js";
import type { IndicatorWindow } from "./indicatorWindow.js";

const POINTER_FILE_NAME = "quill.json";
const SETTINGS_FILE_NAME = "settings.json";
const MANIFEST_FILE_NAME = "manifest.json";
const DEFAULT_ROOT_DIR_NAME = "journal";

export interface IpcRegistrationOptions {
  userDataPath: string;
  getWindow: () => BrowserWindow | null;
  indicator: IndicatorWindow;
}

export interface RegisteredIpc {
  getSettings(): Promise<AppSettings>;
  saveSettings(settings: AppSettings): Promise<void>;
  registerGlobalShortcut(accelerator: string): Promise<boolean>;
  unregisterGlobalShortcut(): Promise<void>;
  hasActiveRecordings(): boolean;
  shutdown(timeoutMs: number): Promise<void>;
}

interface StoragePointer {
  storageDir: string;
}

export function registerIpc(ipcMain: IpcMain, options: IpcRegistrationOptions): RegisteredIpc {
  const { userDataPath, getWindow, indicator } = options;
  const pointerPath = path.join(userDataPath, POINTER_FILE_NAME);
  const defaultRoot = path.join(userDataPath, DEFAULT_ROOT_DIR_NAME);

  let cachedRoot: string | null = null;
  let cachedFs: NodeFileSystemLike | null = null;
  let registeredAccelerator: string | null = null;
  const writers = new Map<string, RecordingWriter>();

  async function currentRoot(): Promise<string> {
    try {
      const raw = await fsReadFile(pointerPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (isStoragePointer(parsed) && path.isAbsolute(parsed.storageDir)) {
        return parsed.storageDir;
      }
    } catch {
      return defaultRoot;
    }
    return defaultRoot;
  }

  async function storageFs(): Promise<NodeFileSystemLike> {
    const root = await currentRoot();
    if (cachedFs === null || cachedRoot !== root) {
      cachedRoot = root;
      cachedFs = createNodeFsLike(root);
      await cachedFs.mkdirp(".");
    }
    return cachedFs;
  }

  function invalidateCache(): void {
    cachedRoot = null;
    cachedFs = null;
  }

  function fireNewEntry(): void {
    getWindow()?.webContents.send(IPC_CHANNELS.pushNewEntry);
  }

  function requireWriter(payload: unknown): RecordingWriter {
    const writerId = asStringField(asObject(payload), "writerId");
    const writer = writers.get(writerId);
    if (!writer) throw new Error(`unknown recording writer: ${writerId}`);
    return writer;
  }

  ipcMain.handle(IPC_CHANNELS.fsWriteAtomic, async (_event, payload: unknown) => {
    const request = asWriteRequest(payload);
    const fs = await storageFs();
    await fs.writeFileAtomic(request.path, request.data);
  });

  ipcMain.handle(IPC_CHANNELS.fsReadFile, async (_event, payload: unknown) => {
    const fs = await storageFs();
    return fs.readFile(asString(payload));
  });

  ipcMain.handle(IPC_CHANNELS.fsExists, async (_event, payload: unknown) => {
    const fs = await storageFs();
    return fs.exists(asString(payload));
  });

  ipcMain.handle(IPC_CHANNELS.fsStat, async (_event, payload: unknown) => {
    const fs = await storageFs();
    return fs.stat(asString(payload));
  });

  ipcMain.handle(IPC_CHANNELS.fsUnlink, async (_event, payload: unknown) => {
    const fs = await storageFs();
    await fs.unlink(asString(payload));
  });

  ipcMain.handle(IPC_CHANNELS.fsMkdirp, async (_event, payload: unknown) => {
    const fs = await storageFs();
    await fs.mkdirp(asString(payload));
  });

  ipcMain.handle(IPC_CHANNELS.fsListDir, async (_event, payload: unknown) => {
    const fs = await storageFs();
    return fs.listDir(asString(payload));
  });

  ipcMain.handle(IPC_CHANNELS.fsRename, async (_event, payload: unknown) => {
    const obj = asObject(payload);
    const from = asStringField(obj, "from");
    const to = asStringField(obj, "to");
    const fs = await storageFs();
    await fs.rename(from, to);
  });

  ipcMain.handle(IPC_CHANNELS.fsRemoveDir, async (_event, payload: unknown) => {
    const fs = await storageFs();
    await fs.removeDir(asString(payload));
  });

  ipcMain.handle(IPC_CHANNELS.recStart, async (_event, payload: unknown) => {
    const relPath = asString(payload);
    const fs = await storageFs();
    const writer = await RecordingWriter.start(fs, relPath);
    const writerId = randomUUID();
    writers.set(writerId, writer);
    return { writerId, path: writer.path };
  });

  ipcMain.handle(IPC_CHANNELS.recAppend, async (_event, payload: unknown) => {
    const writer = requireWriter(payload);
    const chunk = asObject(payload).chunk;
    if (!(chunk instanceof Uint8Array)) throw new Error("chunk must be a Uint8Array");
    await writer.append(chunk);
  });

  ipcMain.handle(IPC_CHANNELS.recFinish, async (_event, payload: unknown) => {
    const writer = requireWriter(payload);
    const fsync = asObject(payload).fsync;
    if (typeof fsync !== "boolean") throw new Error("fsync must be a boolean");
    await writer.finish(fsync);
    writers.delete(writerIdOf(payload));
  });

  ipcMain.handle(IPC_CHANNELS.recAbort, async (_event, payload: unknown) => {
    const writer = requireWriter(payload);
    writer.abort();
    writers.delete(writerIdOf(payload));
  });

  ipcMain.handle(IPC_CHANNELS.appPickDir, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
    });
    const [first] = result.filePaths;
    return result.canceled || !first ? null : first;
  });

  ipcMain.handle(IPC_CHANNELS.appGetStorage, async () => {
    await storageFs();
    return cachedRoot ?? defaultRoot;
  });

  ipcMain.handle(IPC_CHANNELS.appSetStorage, async (_event, payload: unknown) => {
    const target = asString(payload, "storage location");
    if (!path.isAbsolute(target)) throw new Error("target must be an absolute path");
    const info = await fsStat(target).catch(() => null);
    if (info) {
      if (!info.isDirectory()) throw new Error("target not empty");
      const entries = await readdir(target);
      if (entries.length > 0) throw new Error("target not empty");
    }
    await mkdir(userDataPath, { recursive: true });
    const pointer: StoragePointer = { storageDir: target };
    await atomicWriteAbs(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`);
    invalidateCache();
    await storageFs();
  });

  ipcMain.handle(IPC_CHANNELS.appGetSettings, async () => {
    return readSettings();
  });

  ipcMain.handle(IPC_CHANNELS.appSaveSettings, async (_event, payload: unknown) => {
    const settings = mergeSettings(payload);
    await saveSettings(settings);
    return settings;
  });

  ipcMain.handle(IPC_CHANNELS.appGetManifest, async () => {
    return readManifest();
  });

  ipcMain.handle(IPC_CHANNELS.appRevealStorage, async () => {
    await storageFs();
    const root = cachedRoot ?? defaultRoot;
    const errorMessage = await shell.openPath(root);
    if (errorMessage) throw new Error(errorMessage);
  });

  ipcMain.handle(IPC_CHANNELS.appIndicator, async (_event, payload: unknown) => {
    const obj = asObject(payload);
    const visible = obj.visible;
    const label = obj.label;
    if (typeof visible !== "boolean") throw new Error("visible must be a boolean");
    if (visible) {
      indicator.show(typeof label === "string" ? label : "");
    } else {
      indicator.hide();
    }
  });

  ipcMain.handle(IPC_CHANNELS.shortcutRegister, async (_event, payload: unknown) => {
    return registerGlobalShortcut(asString(payload, "accelerator"));
  });

  ipcMain.handle(IPC_CHANNELS.shortcutUnregister, async () => {
    unregisterGlobalShortcut();
  });

  async function readSettings(): Promise<AppSettings> {
    const fs = await storageFs();
    try {
      if (!(await fs.exists(SETTINGS_FILE_NAME))) return { ...DEFAULT_SETTINGS };
      const parsed: unknown = JSON.parse(await fs.readTextFile(SETTINGS_FILE_NAME));
      return mergeSettings(parsed);
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  async function saveSettings(settings: AppSettings): Promise<void> {
    const fs = await storageFs();
    await fs.writeFileAtomic(SETTINGS_FILE_NAME, JSON.stringify(settings, null, 2));
  }

  async function readManifest(): Promise<JournalManifest> {
    const fs = await storageFs();
    try {
      if (!(await fs.exists(MANIFEST_FILE_NAME))) return defaultManifest();
      const parsed: unknown = JSON.parse(await fs.readTextFile(MANIFEST_FILE_NAME));
      if (isValidManifest(parsed)) return parsed;
      return defaultManifest();
    } catch {
      return defaultManifest();
    }
  }

  async function registerGlobalShortcut(accelerator: string): Promise<boolean> {
    if (registeredAccelerator === accelerator) return true;
    if (registeredAccelerator !== null) globalShortcut.unregister(registeredAccelerator);
    const success = globalShortcut.register(accelerator, fireNewEntry);
    registeredAccelerator = success ? accelerator : null;
    return success;
  }

  async function unregisterGlobalShortcut(): Promise<void> {
    if (registeredAccelerator !== null) {
      globalShortcut.unregister(registeredAccelerator);
      registeredAccelerator = null;
    }
  }

  function hasActiveRecordings(): boolean {
    return writers.size > 0;
  }

  async function shutdown(timeoutMs: number): Promise<void> {
    const active = [...writers.values()];
    if (active.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.all(active.map((writer) => writer.finish(false).catch(() => undefined))),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    writers.clear();
  }

  return {
    getSettings: readSettings,
    saveSettings,
    registerGlobalShortcut,
    unregisterGlobalShortcut,
    hasActiveRecordings,
    shutdown,
  };
}

function isStoragePointer(value: unknown): value is StoragePointer {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { storageDir?: unknown };
  return typeof candidate.storageDir === "string" && candidate.storageDir.length > 0;
}

function mergeSettings(value: unknown): AppSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ...DEFAULT_SETTINGS };
  }
  return { ...DEFAULT_SETTINGS, ...(value as Partial<AppSettings>) };
}

function isValidManifest(value: unknown): value is JournalManifest {
  if (typeof value !== "object" || value === null) return false;
  return typeof (value as { schemaVersion?: unknown }).schemaVersion === "number";
}

function defaultManifest(): JournalManifest {
  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    encryption: null,
  };
}

function asObject(payload: unknown): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("malformed ipc payload");
  }
  return payload as Record<string, unknown>;
}

function asString(payload: unknown, name = "path"): string {
  if (typeof payload !== "string" || payload.length === 0) throw new Error(`${name} must be a non-empty string`);
  return payload;
}

function asStringField(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${key} must be a non-empty string`);
  return value;
}

function asWriteRequest(payload: unknown): WriteRequest {
  const obj = asObject(payload);
  const relPath = asStringField(obj, "path");
  const data = obj.data;
  if (typeof data !== "string" && !(data instanceof Uint8Array)) {
    throw new Error("data must be a string or Uint8Array");
  }
  return { path: relPath, data };
}

function writerIdOf(payload: unknown): string {
  return asStringField(asObject(payload), "writerId");
}
