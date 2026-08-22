import type { DirEntryInfo, FileSystemLike, StatInfo } from "../../src/core/fslike.js";

export type FaultStage =
  | "before-write"
  | "after-write-before-rename"
  | "during-rename"
  | "before-append"
  | "after-n-appends";

export interface FaultSpec {
  failAt: FaultStage;
  remainingAppends?: number;
  once?: boolean;
}

export interface DumpedFile {
  path: string;
  bytes: Uint8Array;
}

const encoder = new TextEncoder();

function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === "string" ? encoder.encode(data) : data;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export class MemFs implements FileSystemLike {
  private readonly files = new Map<string, Uint8Array>();
  private readonly dirs = new Set<string>();
  private fault: FaultSpec | null = null;
  private successfulAppends = 0;
  private tmpCounter = 0;

  setFault(fault: FaultSpec | null): void {
    this.fault = fault;
    this.successfulAppends = 0;
  }

  async writeFileAtomic(relPath: string, data: Uint8Array | string): Promise<void> {
    const path = this.normalize(relPath);
    if (this.takeStage("before-write")) throw new Error("simulated-crash");
    const payload = toBytes(data);
    const tmpPath = `${path}.tmp-${this.tmpCounter++}`;
    this.files.set(tmpPath, payload);
    if (this.takeStage("after-write-before-rename")) throw new Error("simulated-crash");
    const failDuringRename = this.takeStage("during-rename");
    this.files.delete(tmpPath);
    this.files.set(path, payload);
    this.markParentDirs(path);
    if (failDuringRename) throw new Error("simulated-crash");
  }

  async appendFile(relPath: string, data: Uint8Array): Promise<void> {
    const path = this.normalize(relPath);
    const fault = this.fault;
    if (fault?.failAt === "before-append") {
      if (fault.once) this.fault = null;
      throw new Error("simulated-crash");
    }
    if (fault?.failAt === "after-n-appends") {
      const limit = fault.remainingAppends ?? Number.POSITIVE_INFINITY;
      if (this.successfulAppends >= limit) {
        if (fault.once) this.fault = null;
        throw new Error("simulated-crash");
      }
    }
    const existing = this.files.get(path);
    const chunk = toBytes(data);
    this.files.set(path, existing ? concat(existing, chunk) : chunk);
    this.markParentDirs(path);
    this.successfulAppends++;
  }

  async readFile(relPath: string): Promise<Uint8Array> {
    const path = this.normalize(relPath);
    const bytes = this.files.get(path);
    if (!bytes) throw new Error(`ENOENT: no such file ${path}`);
    return bytes;
  }

  async readTextFile(relPath: string): Promise<string> {
    return new TextDecoder().decode(await this.readFile(relPath));
  }

  async exists(relPath: string): Promise<boolean> {
    const path = this.normalize(relPath);
    return this.files.has(path) || this.dirs.has(path);
  }

  async stat(relPath: string): Promise<StatInfo | null> {
    const bytes = this.files.get(this.normalize(relPath));
    return bytes ? { size: bytes.length } : null;
  }

  async unlink(relPath: string): Promise<void> {
    const path = this.normalize(relPath);
    if (!this.files.has(path)) throw new Error(`ENOENT: no such file ${path}`);
    this.files.delete(path);
  }

  async mkdirp(relPath: string): Promise<void> {
    const path = this.normalize(relPath);
    if (!path) return;
    let current = "";
    for (const segment of path.split("/")) {
      current = current ? `${current}/${segment}` : segment;
      this.dirs.add(current);
    }
  }

  async listDir(relPath: string): Promise<DirEntryInfo[]> {
    const dirPath = this.normalize(relPath);
    const prefix = dirPath ? `${dirPath}/` : "";
    const names = new Map<string, boolean>();
    for (const filePath of this.files.keys()) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf("/");
      names.set(slash === -1 ? rest : rest.slice(0, slash), slash !== -1);
    }
    for (const dir of this.dirs) {
      if (!dir.startsWith(prefix) || dir === dirPath) continue;
      const rest = dir.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf("/");
      names.set(slash === -1 ? rest : rest.slice(0, slash), true);
    }
    return [...names.entries()]
      .map(([name, isDirectory]) => ({ name, isDirectory }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  async rename(fromRel: string, toRel: string): Promise<void> {
    const from = this.normalize(fromRel);
    const to = this.normalize(toRel);
    const bytes = this.files.get(from);
    if (!bytes) throw new Error(`ENOENT: no such file ${from}`);
    this.files.delete(from);
    this.files.set(to, bytes);
    this.markParentDirs(to);
  }

  async removeDir(relPath: string): Promise<void> {
    const dirPath = this.normalize(relPath);
    if (!dirPath) return;
    const prefix = `${dirPath}/`;
    for (const filePath of [...this.files.keys()]) {
      if (filePath.startsWith(prefix)) this.files.delete(filePath);
    }
    for (const dir of [...this.dirs]) {
      if (dir === dirPath || dir.startsWith(prefix)) this.dirs.delete(dir);
    }
  }

  dump(pathPrefix = ""): DumpedFile[] {
    const prefix = this.normalize(pathPrefix);
    return [...this.files.entries()]
      .filter(([path]) => !prefix || path.startsWith(prefix))
      .map(([path, bytes]) => ({ path, bytes }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  private takeStage(stage: FaultStage): boolean {
    const fault = this.fault;
    if (!fault || fault.failAt !== stage) return false;
    if (fault.once) this.fault = null;
    return true;
  }

  private normalize(relPath: string): string {
    return relPath
      .split(/[\\/]+/)
      .filter((segment) => segment.length > 0 && segment !== ".")
      .join("/");
  }

  private markParentDirs(filePath: string): void {
    const segments = filePath.split("/");
    segments.pop();
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      this.dirs.add(current);
    }
  }
}
