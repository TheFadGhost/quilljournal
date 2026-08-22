/// <reference types="node" />
import { TranscriptionError } from "../errors.js";
import type { LocalEngineConfig } from "../types.js";
import type {
  AudioInput,
  ProviderCapabilities,
  SessionHandlers,
  TranscriptResult,
  TranscriptionProvider,
  TranscriptionSession,
} from "../provider.js";

export interface LocalEngineProviderConfig extends LocalEngineConfig {
  extraArgs?: string[];
  tempDir?: string;
}

const MAX_DURATION_SECONDS = 7200;
const ENGINE_TIMEOUT_MS = 600_000;
const STDERR_TAIL_CHARS = 300;
const SUPPORTED_MIME = new Set([
  "audio/webm",
  "audio/wav",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp4",
  "audio/mp4a",
  "audio/ogg",
  "audio/flac",
]);
const EXT_BY_MIME: Record<string, string> = {
  "audio/webm": ".webm",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/mp4a": ".m4a",
  "audio/ogg": ".ogg",
  "audio/flac": ".flac",
};
const ENGINE_STEMS = ["whisper", "whisper-cli", "whisper.cpp", "main"] as const;

interface EngineOutcome {
  code: number | null;
  failure: string | null;
  stdout: string;
  stderr: string;
}

interface ProcessLike {
  platform?: string;
  env?: Record<string, string | undefined>;
}

function getProcess(): ProcessLike | null {
  return (globalThis as { process?: ProcessLike }).process ?? null;
}

function hasProcess(): boolean {
  return getProcess() !== null;
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function joinPath(dir: string, name: string): string {
  const sep = getProcess()?.platform === "win32" ? "\\" : "/";
  if (dir.endsWith("/") || dir.endsWith("\\")) return `${dir}${name}`;
  return `${dir}${sep}${name}`;
}

function matchesEngineStem(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  const base = lower.endsWith(".exe") ? lower.slice(0, -4) : lower;
  return ENGINE_STEMS.some((stem) => base.startsWith(stem));
}

function splitArgs(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of value) {
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === " " && !quoted) {
      if (current.length > 0) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) parts.push(current);
  return parts.filter((part) => part.length > 0);
}

function extractTextFromJson(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  const transcript = record.transcript;
  if (typeof transcript === "object" && transcript !== null) {
    const inner = (transcript as Record<string, unknown>).text;
    if (typeof inner === "string") return inner;
  }
  return null;
}

function parseEngineOutput(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;
  const structured = trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith("<");
  if (structured) {
    try {
      return extractTextFromJson(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }
  return trimmed;
}

class LocalEngineSession implements TranscriptionSession {
  readonly providerId = "local-engine";
  private cancelled = false;
  private child: import("node:child_process").ChildProcess | null = null;
  private readonly buffer: Uint8Array[] = [];

  constructor(
    private readonly config: LocalEngineProviderConfig,
    private readonly input: AudioInput,
    private readonly handlers?: SessionHandlers,
  ) {}

  pushAudio(chunk: Uint8Array): void {
    if (this.cancelled) return;
    this.buffer.push(chunk);
  }

  async finalize(): Promise<TranscriptResult> {
    await nextTick();
    if (this.cancelled) {
      throw new TranscriptionError("cancelled", "transcription cancelled");
    }
    const data = concatBytes([this.input.data, ...this.buffer]);
    if (data.length === 0) this.emitFailure(new TranscriptionError("unknown", "audio contains no data"));
    if (!SUPPORTED_MIME.has(this.input.mimeType)) {
      this.emitFailure(
        new TranscriptionError("unsupported-format", `unsupported mime type: ${this.input.mimeType}`),
      );
    }
    if (this.input.durationMs !== null && this.input.durationMs / 1000 > MAX_DURATION_SECONDS) {
      this.emitFailure(
        new TranscriptionError(
          "audio-too-long",
          `audio duration ${this.input.durationMs}ms exceeds limit of ${MAX_DURATION_SECONDS}s`,
        ),
      );
    }
    const enginePath = this.config.enginePath;
    if (enginePath === undefined || enginePath.length === 0) {
      this.emitFailure(new TranscriptionError("invalid-config", "local engine path is not configured"));
    }
    const fsModule = await import("node:fs");
    const osModule = await import("node:os");
    const pathModule = await import("node:path");
    const childProcessModule = await import("node:child_process");
    const tmpDir = this.config.tempDir ?? getProcess()?.env?.QUILL_TMP ?? osModule.tmpdir();
    await fsModule.promises.mkdir(tmpDir, { recursive: true });
    const ext = EXT_BY_MIME[this.input.mimeType] ?? ".bin";
    const tmpFile = pathModule.join(
      tmpDir,
      `qj-local-engine-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`,
    );
    try {
      await fsModule.promises.writeFile(tmpFile, data);
      if (this.cancelled) {
        throw new TranscriptionError("cancelled", "transcription cancelled");
      }
      const modelArgs =
        this.config.modelArgs !== undefined ? splitArgs(this.config.modelArgs) : [];
      const args = [...modelArgs, tmpFile, ...(this.config.extraArgs ?? [])];
      const child = childProcessModule.spawn(enginePath as string, args, { windowsHide: true });
      this.child = child;
      let timedOut = false;
      const outcome = await new Promise<EngineOutcome>((resolve) => {
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill();
        }, ENGINE_TIMEOUT_MS);
        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        child.on("error", (err: Error) => {
          clearTimeout(timer);
          resolve({ code: null, failure: err.message, stdout, stderr });
        });
        child.on("close", (code: number | null) => {
          clearTimeout(timer);
          resolve({ code, failure: null, stdout, stderr });
        });
      });
      if (this.cancelled) {
        throw new TranscriptionError("cancelled", "transcription cancelled");
      }
      if (outcome.code !== 0 || outcome.failure !== null) {
        const tail = timedOut ? "" : outcome.stderr.slice(-STDERR_TAIL_CHARS).trim();
        const reason =
          outcome.failure !== null
            ? `engine failed to start`
            : timedOut
              ? "engine timed out"
              : `engine exited with code ${outcome.code}`;
        const detail = [reason, outcome.failure ?? tail].filter((part) => part.length > 0).join(": ");
        throw new TranscriptionError("provider-unavailable", detail);
      }
      const text = parseEngineOutput(outcome.stdout);
      if (text === null || text.trim().length === 0) {
        throw new TranscriptionError("provider-unavailable", "could not parse engine output");
      }
      const result: TranscriptResult = { text: text.trim() };
      if (this.input.language !== undefined) result.language = this.input.language;
      return result;
    } finally {
      this.child = null;
      await fsModule.promises.unlink(tmpFile).catch(() => undefined);
    }
  }

  private emitFailure(error: TranscriptionError): never {
    this.handlers?.onError?.(error);
    throw error;
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.child?.kill();
  }
}

export function createLocalEngineProvider(config: LocalEngineProviderConfig): TranscriptionProvider {
  const capabilities: ProviderCapabilities = {
    streaming: false,
    batch: true,
    languages: ["*"],
    maxDurationSeconds: MAX_DURATION_SECONDS,
    punctuation: false,
    speakerLabels: false,
  };
  return {
    id: "local-engine",
    displayName: "Local engine",
    description:
      "Optional batch transcription through a locally installed engine binary; extraArgs exist for advanced setups and tests.",
    capabilities: () => capabilities,
    async isAvailable(): Promise<boolean> {
      if (!hasProcess()) return false;
      try {
        const fsModule = await import("node:fs");
        if (config.enginePath !== undefined && config.enginePath.length > 0) {
          return fsModule.existsSync(config.enginePath);
        }
        const proc = getProcess();
        if (!proc) return false;
        const delimiter = proc.platform === "win32" ? ";" : ":";
        const dirs = (proc.env?.PATH ?? "")
          .split(delimiter)
          .map((dir) => dir.trim())
          .filter((dir) => dir.length > 0);
        for (const dir of dirs) {
          let entries: string[];
          try {
            entries = await fsModule.promises.readdir(dir);
          } catch {
            continue;
          }
          for (const name of entries) {
            if (!matchesEngineStem(name)) continue;
            try {
              const stat = await fsModule.promises.stat(joinPath(dir, name));
              if (stat.isFile()) return true;
            } catch {
              continue;
            }
          }
        }
        return false;
      } catch {
        return false;
      }
    },
    createSession(input: AudioInput, handlers?: SessionHandlers): TranscriptionSession {
      return new LocalEngineSession(config, input, handlers);
    },
  };
}
