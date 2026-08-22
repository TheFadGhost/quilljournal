import type { FileSystemLike } from "../core/fslike.js";

export interface FileSystemWithSync extends FileSystemLike {
  syncFile?(relPath: string): Promise<void>;
}

export class RecordingWriter {
  private readonly fs: FileSystemWithSync;
  private readonly relPath: string;
  private queueTail: Promise<void> = Promise.resolve();
  private closed = false;
  private totalBytes = 0;

  private constructor(fs: FileSystemWithSync, relPath: string) {
    this.fs = fs;
    this.relPath = relPath;
  }

  static async start(fs: FileSystemWithSync, relPath: string): Promise<RecordingWriter> {
    await fs.writeFileAtomic(relPath, "");
    return new RecordingWriter(fs, relPath);
  }

  get path(): string {
    return this.relPath;
  }

  get bytesWritten(): number {
    return this.totalBytes;
  }

  async append(chunk: Uint8Array): Promise<void> {
    this.assertOpen();
    await this.enqueue(async () => {
      await this.fs.appendFile(this.relPath, chunk);
      this.totalBytes += chunk.byteLength;
    });
  }

  async finish(fsyncFinal: boolean): Promise<void> {
    this.assertOpen();
    await this.queueTail;
    if (fsyncFinal) {
      const sync = this.fs.syncFile;
      if (typeof sync === "function") {
        await sync.call(this.fs, this.relPath);
      }
    }
    this.closed = true;
  }

  abort(): void {
    this.closed = true;
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queueTail.then(task, task);
    this.queueTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("RecordingWriter is closed");
  }
}
