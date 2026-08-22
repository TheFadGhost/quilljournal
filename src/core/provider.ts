import type { WordTiming } from "./types.js";
import { TranscriptionError, type TranscriptionErrorCode } from "./errors.js";

export interface ProviderCapabilities {
  streaming: boolean;
  batch: boolean;
  languages: string[];
  maxDurationSeconds: number | null;
  punctuation: boolean;
  speakerLabels: boolean;
}

export interface AudioInput {
  data: Uint8Array;
  mimeType: string;
  durationMs: number | null;
  language?: string;
}

export interface PartialResult {
  text: string;
}

export interface ProgressReport {
  fraction: number | null;
  message?: string;
}

export interface TranscriptResult {
  text: string;
  language?: string;
  words?: WordTiming[];
}

export interface SessionHandlers {
  onPartial?: (partial: PartialResult) => void;
  onProgress?: (progress: ProgressReport) => void;
  onError?: (error: TranscriptionError) => void;
}

export interface TranscriptionSession {
  readonly providerId: string;
  pushAudio(chunk: Uint8Array): void;
  finalize(): Promise<TranscriptResult>;
  cancel(): Promise<void>;
}

export interface TranscriptionProvider {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  capabilities(): ProviderCapabilities;
  isAvailable(): Promise<boolean>;
  createSession(input: AudioInput, handlers?: SessionHandlers): TranscriptionSession;
}

export function describeTranscriptionError(error: unknown): string {
  if (TranscriptionError.is(error)) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

export type { TranscriptionErrorCode };
