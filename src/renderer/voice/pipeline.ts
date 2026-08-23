import type { FileSystemLike } from "../../core/fslike.js";
import { TranscriptionError } from "../../core/errors.js";
import type { AppSettings, TranscriptRecord } from "../../core/types.js";
import {
  buildProviders,
  getMockProvider,
  getProviderById,
} from "../../core/providers/registry.js";

export interface RecordSessionHandle {
  audioPath: string;
  mimeType: string;
}

export const PIPELINE_CHUNK_BYTES = 96;

export interface TranscribeForReviewOptions {
  fs: FileSystemLike;
  audioPath: string;
  mimeType: string;
  durationMs: number | null;
  language?: string;
  settings: AppSettings;
  onPartial?(text: string): void;
  onProgress?(fraction: number | null): void;
  cancelToken: { cancelled: boolean };
}

export function concatChunks(chunks: Uint8Array[]): Uint8Array {
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

function wrapProviderError(err: unknown): TranscriptionError {
  if (TranscriptionError.is(err)) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new TranscriptionError("unknown", message, { cause: err });
}

export async function transcribeForReview(
  opts: TranscribeForReviewOptions,
): Promise<TranscriptRecord> {
  const providers = buildProviders({
    httpProvider: opts.settings.httpProvider,
    localEngine: opts.settings.localEngine,
  });
  const provider = getProviderById(providers, opts.settings.providerId) ?? getMockProvider();

  const bytes = await opts.fs.readFile(opts.audioPath).catch((cause: unknown) => {
    throw new TranscriptionError("unknown", `could not read audio file ${opts.audioPath}`, {
      cause,
    });
  });

  let session;
  try {
    session = provider.createSession(
      {
        data: bytes,
        mimeType: opts.mimeType,
        durationMs: opts.durationMs,
        language: opts.language,
      },
      {
        onPartial: (partial) => {
          if (opts.onPartial) opts.onPartial(partial.text);
        },
        onProgress: (progress) => {
          if (opts.onProgress) opts.onProgress(progress.fraction);
        },
      },
    );
  } catch (err) {
    throw wrapProviderError(err);
  }

  const failCancelled = async (): Promise<never> => {
    await session.cancel();
    throw new TranscriptionError("cancelled", "transcription cancelled");
  };

  for (let offset = 0; offset < bytes.length; offset += PIPELINE_CHUNK_BYTES) {
    if (opts.cancelToken.cancelled) return await failCancelled();
    session.pushAudio(bytes.subarray(offset, offset + PIPELINE_CHUNK_BYTES));
  }
  if (opts.cancelToken.cancelled) return await failCancelled();

  try {
    const result = await session.finalize();
    if (opts.cancelToken.cancelled) return await failCancelled();
    return {
      text: result.text,
      language: result.language,
      words: result.words,
      providerId: provider.id,
      createdAt: new Date().toISOString(),
    };
  } catch (err) {
    throw wrapProviderError(err);
  }
}
