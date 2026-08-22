import type { FileSystemLike } from "../../core/fslike.js";
import type { AppSettings, JournalManifest } from "../../core/types.js";
import { DEFAULT_SETTINGS } from "../../core/types.js";
import type {
  IpcBridge,
  RecordingWriterStart,
  WriteRequest,
} from "../../shared/ipc.js";

interface QuillRaw {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  on(channel: string, cb: (data: unknown) => void): void;
}

declare global {
  interface Window {
    quill?: QuillRaw;
  }
}

export function getQuillRaw(): QuillRaw {
  if (typeof window !== "undefined" && window.quill) return window.quill;
  return browserMockBridge();
}

export class RendererFileSystem implements FileSystemLike {
  async writeFileAtomic(relPath: string, data: Uint8Array | string): Promise<void> {
    const req: WriteRequest = { path: relPath, data };
    await getQuillRaw().invoke("fs:write-atomic", req);
  }
  async readFile(relPath: string): Promise<Uint8Array> {
    const data = await getQuillRaw().invoke("fs:read-file", relPath);
    return toBytes(data);
  }
  async readTextFile(relPath: string): Promise<string> {
    const bytes = await this.readFile(relPath);
    return new TextDecoder().decode(bytes);
  }
  async exists(relPath: string): Promise<boolean> {
    return (await getQuillRaw().invoke("fs:exists", relPath)) === true;
  }
  async stat(relPath: string): Promise<{ size: number } | null> {
    const s = await getQuillRaw().invoke("fs:stat", relPath);
    if (!s || typeof s !== "object") return null;
    const size = (s as { size?: unknown }).size;
    return typeof size === "number" ? { size } : null;
  }
  async unlink(relPath: string): Promise<void> {
    await getQuillRaw().invoke("fs:unlink", relPath);
  }
  async mkdirp(relPath: string): Promise<void> {
    await getQuillRaw().invoke("fs:mkdirp", relPath);
  }
  async listDir(relPath: string): Promise<{ name: string; isDirectory: boolean }[]> {
    const list = await getQuillRaw().invoke("fs:list-dir", relPath);
    if (!Array.isArray(list)) return [];
    return list.filter(
      (x): x is { name: string; isDirectory: boolean } =>
        typeof x === "object" && x !== null && typeof (x as { name?: unknown }).name === "string",
    );
  }
  async rename(fromRel: string, toRel: string): Promise<void> {
    await getQuillRaw().invoke("fs:rename", { from: fromRel, to: toRel });
  }
  async removeDir(relPath: string): Promise<void> {
    await getQuillRaw().invoke("fs:remove-dir", relPath);
  }
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(data);
  throw new TypeError("expected byte payload over IPC");
}

export const ipc = {
  async getSettings(): Promise<AppSettings> {
    const raw = await getQuillRaw().invoke("app:get-settings");
    return mergeSettings(raw);
  },
  async saveSettings(settings: AppSettings): Promise<void> {
    await getQuillRaw().invoke("app:save-settings", settings);
  },
  async getManifest(): Promise<JournalManifest | null> {
    const m = await getQuillRaw().invoke("app:get-manifest");
    return m && typeof m === "object" ? (m as JournalManifest) : null;
  },
  async getStorageLocation(): Promise<string> {
    const loc = await getQuillRaw().invoke("app:get-storage");
    return typeof loc === "string" ? loc : "";
  },
  async setRecordingIndicator(visible: boolean, label: string): Promise<void> {
    await getQuillRaw().invoke("app:set-indicator", { visible, label });
  },
  async registerGlobalShortcut(accelerator: string): Promise<boolean> {
    return (await getQuillRaw().invoke("shortcut:register", accelerator)) === true;
  },
  async unregisterGlobalShortcut(): Promise<void> {
    await getQuillRaw().invoke("shortcut:unregister");
  },
  async startRecordingWriter(path: string): Promise<RecordingWriterStart> {
    const res = await getQuillRaw().invoke("rec:start", path);
    if (
      res &&
      typeof res === "object" &&
      typeof (res as RecordingWriterStart).writerId === "string"
    ) {
      return res as RecordingWriterStart;
    }
    throw new Error("rec:start returned unexpected payload");
  },
  async appendRecordingChunk(writerId: string, chunk: Uint8Array): Promise<void> {
    await getQuillRaw().invoke("rec:append", { writerId, chunk });
  },
  async finishRecordingWriter(writerId: string, fsync: boolean): Promise<void> {
    await getQuillRaw().invoke("rec:finish", { writerId, fsync });
  },
  async abortRecordingWriter(writerId: string): Promise<void> {
    await getQuillRaw().invoke("rec:abort", { writerId });
  },
  onNewEntryShortcut(cb: () => void): void {
    getQuillRaw().on("push:new-entry", () => cb());
  },
};

function mergeSettings(raw: unknown): AppSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SETTINGS };
  const merged: AppSettings = { ...DEFAULT_SETTINGS };
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key in DEFAULT_SETTINGS && value !== undefined && value !== null) {
      (merged as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

type MockFile = { bytes: Uint8Array };

function browserMockBridge(): QuillRaw {
  const files = new Map<string, MockFile>();
  const encoder = new TextEncoder();
  let settings: AppSettings = { ...DEFAULT_SETTINGS };
  const listeners = new Map<string, ((data: unknown) => void)[]>();

  const ensureParent = (p: string) => {
    const parts = p.split("/");
    let cur = "";
    for (let i = 0; i < parts.length - 1; i++) {
      cur = cur ? `${cur}/${parts[i]}` : (parts[i] ?? "");
      if (!files.has(cur + "/.d")) files.set(cur + "/.d", { bytes: new Uint8Array() });
    }
  };
  const isDirMarker = (k: string) => k.endsWith("/.d");

  const bridge: QuillRaw = {
    async invoke(channel: string, payload?: unknown) {
      switch (channel) {
        case "fs:write-atomic": {
          const req = payload as WriteRequest;
          const bytes =
            typeof req.data === "string" ? encoder.encode(req.data) : new Uint8Array(req.data);
          ensureParent(req.path);
          files.set(req.path, { bytes });
          return null;
        }
        case "fs:read-file": {
          const f = files.get(payload as string);
          if (!f) throw new Error(`ENOENT: ${payload}`);
          return f.bytes.slice();
        }
        case "fs:exists":
          return files.has(payload as string);
        case "fs:stat": {
          const f = files.get(payload as string);
          return f ? { size: f.bytes.length } : null;
        }
        case "fs:unlink": {
          files.delete(payload as string);
          return null;
        }
        case "fs:mkdirp": {
          ensureParent(`${payload as string}/x`);
          return null;
        }
        case "fs:list-dir": {
          const prefix = `${payload as string}/`;
          const seen = new Set<string>();
          for (const key of files.keys()) {
            if (isDirMarker(key)) continue;
            if (!key.startsWith(prefix)) continue;
            const rest = key.slice(prefix.length);
            const seg = rest.split("/")[0];
            if (seg) seen.add(rest.includes("/") ? `${seg}/` : seg);
          }
          return Array.from(seen).map((name) => ({
            name,
            isDirectory: name.endsWith("/"),
          }));
        }
        case "fs:rename": {
          const { from, to } = payload as { from: string; to: string };
          const f = files.get(from);
          if (!f) throw new Error(`ENOENT: ${from}`);
          files.delete(from);
          files.set(to, f);
          return null;
        }
        case "fs:remove-dir": {
          const prefix = `${payload as string}/`;
          for (const key of Array.from(files.keys())) {
            if (key.startsWith(prefix)) files.delete(key);
          }
          return null;
        }
        case "rec:start": {
          const path = String(payload);
          ensureParent(path);
          files.set(path, { bytes: new Uint8Array() });
          return { writerId: `mock-${Date.now()}-${Math.random()}`, path };
        }
        case "rec:append": {
          const { writerId: _w, chunk } = payload as { writerId: string; chunk: Uint8Array };
          void _w;
          return null;
        }
        case "rec:finish":
        case "rec:abort":
          return null;
        case "app:get-storage":
          return "in-memory (browser preview mode)";
        case "app:set-storage":
          throw new Error("changing storage location requires the desktop app");
        case "app:get-settings":
          return settings;
        case "app:save-settings":
          settings = mergeSettings(payload);
          return null;
        case "app:get-manifest":
          return null;
        case "app:reveal-storage":
          return null;
        case "app:set-indicator":
          return null;
        case "shortcut:register":
          return true;
        case "shortcut:unregister":
          return null;
        default:
          throw new Error(`channel not allowed: ${channel}`);
      }
    },
    on(channel: string, cb: (data: unknown) => void) {
      const arr = listeners.get(channel) ?? [];
      arr.push(cb);
      listeners.set(channel, arr);
    },
  };
  return bridge;
}
