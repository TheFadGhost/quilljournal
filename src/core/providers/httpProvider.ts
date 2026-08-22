import { TranscriptionError } from "../errors.js";
import type { HttpProviderConfig, WordTiming } from "../types.js";
import type {
  AudioInput,
  ProviderCapabilities,
  SessionHandlers,
  TranscriptResult,
  TranscriptionProvider,
  TranscriptionSession,
} from "../provider.js";

const DEFAULT_TIMEOUT_MS = 120_000;

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

function createTimedController(timeoutMs: number): AbortController {
  const controller = new AbortController();
  const timeoutSignal =
    typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(timeoutMs) : null;
  if (timeoutSignal) {
    timeoutSignal.addEventListener(
      "abort",
      () => {
        controller.abort();
      },
      { once: true },
    );
  }
  return controller;
}

function isValidWord(value: unknown): value is WordTiming {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.word === "string" &&
    typeof record.startMs === "number" &&
    Number.isFinite(record.startMs) &&
    typeof record.endMs === "number" &&
    Number.isFinite(record.endMs)
  );
}

function parseResponseBody(raw: string): TranscriptResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.text !== "string") return null;
  const result: TranscriptResult = { text: record.text };
  if (record.language !== undefined) {
    if (typeof record.language !== "string") return null;
    result.language = record.language;
  }
  if (record.words !== undefined) {
    if (!Array.isArray(record.words) || !record.words.every(isValidWord)) return null;
    result.words = record.words.map((word) => ({
      word: word.word,
      startMs: word.startMs,
      endMs: word.endMs,
    }));
  }
  return result;
}

class HttpTranscriptionSession implements TranscriptionSession {
  readonly providerId = "http";
  private cancelled = false;
  private controller: AbortController | null = null;
  private readonly buffer: Uint8Array[] = [];

  constructor(
    private readonly config: HttpProviderConfig,
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
    if (data.length === 0) {
      const error = new TranscriptionError("unknown", "audio contains no data");
      this.handlers?.onError?.(error);
      throw error;
    }
    if (!this.input.mimeType.startsWith("audio/")) {
      const error = new TranscriptionError(
        "unsupported-format",
        `unsupported mime type: ${this.input.mimeType}`,
      );
      this.handlers?.onError?.(error);
      throw error;
    }
    this.controller = createTimedController(this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (this.cancelled) {
      throw new TranscriptionError("cancelled", "transcription cancelled");
    }
    const signal = this.controller.signal;
    const headers: Record<string, string> = { "Content-Type": this.input.mimeType };
    for (const [key, value] of Object.entries(this.config.headers ?? {})) {
      headers[key] = value;
    }
    let response: Response;
    try {
      response = await fetch(this.config.endpointUrl, {
        method: "POST",
        headers,
        body: new Uint8Array(data),
        signal,
      });
    } catch (err) {
      if (this.cancelled) {
        throw new TranscriptionError("cancelled", "transcription cancelled");
      }
      const detail = err instanceof Error ? err.message : String(err);
      throw new TranscriptionError("provider-unavailable", `request failed: ${detail}`, { cause: err });
    }
    if (!response.ok) {
      throw new TranscriptionError("provider-unavailable", `HTTP ${response.status}`);
    }
    let rawBody: string;
    try {
      rawBody = await response.text();
    } catch (err) {
      if (this.cancelled) {
        throw new TranscriptionError("cancelled", "transcription cancelled");
      }
      const detail = err instanceof Error ? err.message : String(err);
      throw new TranscriptionError("provider-unavailable", `failed reading response: ${detail}`, {
        cause: err,
      });
    }
    const result = parseResponseBody(rawBody);
    if (result === null) {
      const error = new TranscriptionError("unknown", "provider returned malformed response");
      this.handlers?.onError?.(error);
      throw error;
    }
    return result;
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.controller?.abort();
  }
}

export function createHttpProvider(config: HttpProviderConfig): TranscriptionProvider {
  const capabilities: ProviderCapabilities = {
    streaming: false,
    batch: true,
    languages: ["*"],
    maxDurationSeconds: null,
    punctuation: false,
    speakerLabels: false,
  };
  return {
    id: "http",
    displayName: "HTTP endpoint",
    description:
      "Batch transcription through a user-configured HTTP endpoint; quilljournal ships no vendor endpoint and never selects one itself.",
    capabilities: () => capabilities,
    isAvailable: () => Promise.resolve(true),
    createSession(input: AudioInput, handlers?: SessionHandlers): TranscriptionSession {
      const session = new HttpTranscriptionSession(config, input, handlers);
      if (typeof config.endpointUrl !== "string" || config.endpointUrl.length === 0) {
        const error = new TranscriptionError("invalid-config", "http provider requires endpointUrl");
        handlers?.onError?.(error);
        throw error;
      }
      return session;
    },
  };
}
