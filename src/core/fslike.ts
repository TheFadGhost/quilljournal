export interface StatInfo {
  size: number;
}

export interface DirEntryInfo {
  name: string;
  isDirectory: boolean;
}

export interface FileSystemLike {
  writeFileAtomic(relPath: string, data: Uint8Array | string): Promise<void>;
  appendFile(relPath: string, data: Uint8Array): Promise<void>;
  readFile(relPath: string): Promise<Uint8Array>;
  readTextFile(relPath: string): Promise<string>;
  exists(relPath: string): Promise<boolean>;
  stat(relPath: string): Promise<StatInfo | null>;
  unlink(relPath: string): Promise<void>;
  mkdirp(relPath: string): Promise<void>;
  listDir(relPath: string): Promise<DirEntryInfo[]>;
  rename(fromRel: string, toRel: string): Promise<void>;
  removeDir(relPath: string): Promise<void>;
}
