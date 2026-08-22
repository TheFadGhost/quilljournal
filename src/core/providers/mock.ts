import { TranscriptionError } from "../errors.js";
import type { WordTiming } from "../types.js";
import type {
  AudioInput,
  PartialResult,
  ProgressReport,
  ProviderCapabilities,
  SessionHandlers,
  TranscriptResult,
  TranscriptionProvider,
  TranscriptionSession,
} from "../provider.js";

const MAX_DURATION_SECONDS = 3600;
const MS_PER_WORD = 400;
const BYTES_PER_PARTIAL_WORD = 64;

export const MOCK_TRANSCRIPTS: readonly string[] = [
  "The rain kept tapping on the kitchen window while the kettle slowly warmed.",
  "Walked to the corner shop for bread and came back with apples instead.",
  "Finished the shelf today and the living room finally feels settled again.",
  "The morning commute was quiet and I finished two chapters of my book.",
  "Long walk along the river path before dinner and the heron was out again.",
  "Tidied the desk, answered old letters, and planned the weekend trip north.",
  "Cooked the soup from the market vegetables and the whole flat smelled of thyme.",
  "Fixed the squeaky gate after lunch and swept the leaves off the back step.",
  "The bus was late so I sketched the station clock until the sky cleared.",
  "Sorted the winter coats into boxes and found the missing umbrella at last.",
];

export function fnv1a32(data: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    hash ^= data[i] as number;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function selectMockTranscript(data: Uint8Array): string {
  return MOCK_TRANSCRIPTS[fnv1a32(data) % MOCK_TRANSCRIPTS.length] as string;
}

function splitWords(text: string): string[] {
  return text.split(/\s+/).filter((w) => w.length > 0);
}

function wordTimings(words: readonly string[]): WordTiming[] {
  return words.map((word, i) => ({ word, startMs: i * MS_PER_WORD, endMs: (i + 1) * MS_PER_WORD }));
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

class MockSession implements TranscriptionSession {
  readonly providerId = "mock";
  private cancelled = false;
  private finalizedResult: TranscriptResult | null = null;
  private emittedWords = 0;
  private cumulativeBytes = 0;
  private readonly words: string[];

  constructor(
    private readonly input: AudioInput,
    private readonly handlers?: SessionHandlers,
  ) {
    this.words = splitWords(selectMockTranscript(input.data));
    this.validate();
  }

  private validate(): void {
    let error: TranscriptionError | null = null;
    if (this.input.data.length === 0) {
      error = new TranscriptionError("unknown", "audio contains no data");
    } else if (!this.input.mimeType.startsWith("audio/")) {
      error = new TranscriptionError("unsupported-format", `unsupported mime type: ${this.input.mimeType}`);
    } else if (
      this.input.durationMs !== null &&
      this.input.durationMs / 1000 > MAX_DURATION_SECONDS
    ) {
      error = new TranscriptionError(
        "audio-too-long",
        `audio duration ${this.input.durationMs}ms exceeds limit of ${MAX_DURATION_SECONDS}s`,
      );
    }
    if (error) {
      this.handlers?.onError?.(error);
      throw error;
    }
  }

  pushAudio(chunk: Uint8Array): void {
    if (this.cancelled || this.finalizedResult) return;
    this.cumulativeBytes += chunk.length;
    const target = Math.min(this.words.length, Math.floor(this.cumulativeBytes / BYTES_PER_PARTIAL_WORD));
    if (target <= this.emittedWords) return;
    this.emittedWords = target;
    const partial: PartialResult = { text: this.prefix(target) };
    const progress: ProgressReport = {
      fraction: this.words.length === 0 ? 0 : Math.min(1, target / this.words.length),
    };
    this.handlers?.onPartial?.(partial);
    this.handlers?.onProgress?.(progress);
  }

  private prefix(count: number): string {
    return this.words.slice(0, count).join(" ");
  }

  async finalize(): Promise<TranscriptResult> {
    await nextTick();
    if (this.cancelled) {
      throw new TranscriptionError("cancelled", "transcription cancelled");
    }
    if (!this.finalizedResult) {
      const text = selectMockTranscript(this.input.data);
      this.finalizedResult = {
        text,
        language: this.input.language ?? "en",
        words: wordTimings(splitWords(text)),
      };
    }
    return this.finalizedResult;
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
  }
}

export function createMockProvider(): TranscriptionProvider {
  const capabilities: ProviderCapabilities = {
    streaming: true,
    batch: true,
    languages: ["en"],
    maxDurationSeconds: MAX_DURATION_SECONDS,
    punctuation: true,
    speakerLabels: false,
  };
  return {
    id: "mock",
    displayName: "Offline mock",
    description:
      "Deterministic offline provider that produces scripted transcripts for testing; it never performs real speech recognition.",
    capabilities: () => capabilities,
    isAvailable: () => Promise.resolve(true),
    createSession: (input: AudioInput, handlers?: SessionHandlers): TranscriptionSession =>
      new MockSession(input, handlers),
  };
}
