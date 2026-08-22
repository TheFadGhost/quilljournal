import { access, appendFile, mkdir, open, readFile, readdir, rename, rm, stat as fsStat, unlink } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { DirEntryInfo, FileSystemLike, StatInfo } from "../core/fslike.js";

const DRIVE_LETTER_PREFIX = /^[a-zA-Z]:/;
const PATH_SEPARATORS = /[\\/]+/;

export function resolveSafe(root: string, relPath: string): string {
  if (!path.isAbsolute(root)) throw new Error("root must be an absolute path");
  if (typeof relPath !== "string" || relPath.trim().length === 0) throw new Error("path must be a non-empty string");
  if (relPath.includes("\0")) throw new Error("path must not contain NUL characters");
  if (DRIVE_LETTER_PREFIX.test(relPath) || path.isAbsolute(relPath)) {
    throw new Error(`absolute paths are not allowed: ${relPath}`);
  }
  const segments = relPath.split(PATH_SEPARATORS).filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.some((segment) => segment === "..")) {
    throw new Error(`path traversal is not allowed: ${relPath}`);
  }
  return path.resolve(root, ...segments);
}

export async function atomicWriteAbs(absPath: string, data: Uint8Array | string): Promise<void> {
  const dir = path.dirname(absPath);
  await mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(absPath)}.tmp-${randomBytes(8).toString("hex")}`);
  try {
    const handle = await open(tmpPath, "w+");
    try {
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      await handle.write(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmpPath, absPath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export interface NodeFileSystemLike extends FileSystemLike {
  syncFile(relPath: string): Promise<void>;
}

export function createNodeFsLike(root: string): NodeFileSystemLike {
  const baseRoot = path.resolve(root);
  const safe = (relPath: string): string => resolveSafe(baseRoot, relPath);

  return {
    async writeFileAtomic(relPath: string, data: Uint8Array | string): Promise<void> {
      await atomicWriteAbs(safe(relPath), data);
    },

    async appendFile(relPath: string, data: Uint8Array): Promise<void> {
      const absPath = safe(relPath);
      await mkdir(path.dirname(absPath), { recursive: true });
      await appendFile(absPath, data);
    },

    async readFile(relPath: string): Promise<Uint8Array> {
      return readFile(safe(relPath));
    },

    async readTextFile(relPath: string): Promise<string> {
      return readFile(safe(relPath), "utf8");
    },

    async exists(relPath: string): Promise<boolean> {
      const absPath = safe(relPath);
      try {
        await access(absPath);
        return true;
      } catch {
        return false;
      }
    },

    async stat(relPath: string): Promise<StatInfo | null> {
      const absPath = safe(relPath);
      try {
        const info = await fsStat(absPath);
        return { size: info.size };
      } catch (error) {
        if (isEnoent(error)) return null;
        throw error;
      }
    },

    async unlink(relPath: string): Promise<void> {
      await unlink(safe(relPath));
    },

    async mkdirp(relPath: string): Promise<void> {
      await mkdir(safe(relPath), { recursive: true });
    },

    async listDir(relPath: string): Promise<DirEntryInfo[]> {
      const absPath = safe(relPath);
      let dirents;
      try {
        dirents = await readdir(absPath, { withFileTypes: true });
      } catch (error) {
        if (isEnoent(error)) return [];
        throw error;
      }
      return dirents.map((dirent) => ({ name: dirent.name, isDirectory: dirent.isDirectory() }));
    },

    async rename(fromRel: string, toRel: string): Promise<void> {
      await rename(safe(fromRel), safe(toRel));
    },

    async removeDir(relPath: string): Promise<void> {
      await rm(safe(relPath), { recursive: true, force: true });
    },

    async syncFile(relPath: string): Promise<void> {
      const handle = await open(safe(relPath), "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
  };
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}
