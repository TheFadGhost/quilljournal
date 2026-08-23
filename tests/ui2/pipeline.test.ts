import { describe, expect, it } from "vitest";
import { TranscriptionError } from "../../src/core/errors.js";
import type { AppSettings } from "../../src/core/types.js";
import { DEFAULT_SETTINGS } from "../../src/core/types.js";
import { selectMockTranscript } from "../../src/core/providers/mock.js";
import { concatChunks, transcribeForReview } from "../../src/renderer/voice/pipeline.js";
import { MemFs } from "../helpers/memfs.js";

function settingsWith(patch: Partial<AppSettings> = {}): AppSettings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

const encoder = new TextEncoder();

async function fixtureAudio(bytes: Uint8Array): Promise<{ fs: MemFs; path: string }> {
  const fs = new MemFs();
  const path = "audio/entry_x/audio_1.webm";
  await fs.writeFileAtomic(path, bytes);
  return { fs, path };
}

describe("concatChunks", () => {
  it("returns an empty array for no chunks", () => {
    expect(concatChunks([]).length).toBe(0);
  });

  it("concatenates byte contents in order", () => {
    const out = concatChunks([new Uint8Array([1, 2]), new Uint8Array([]), new Uint8Array([3])]);
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });
});

describe("transcribeForReview", () => {
  it("returns the deterministic mock transcript with record fields", async () => {
    const bytes = encoder.encode("x".repeat(512));
    const { fs, path } = await fixtureAudio(bytes);
    const record = await transcribeForReview({
      fs,
      audioPath: path,
      mimeType: "audio/webm",
      durationMs: 4000,
      settings: settingsWith(),
      cancelToken: { cancelled: false },
    });
    expect(record.text).toBe(selectMockTranscript(bytes));
    expect(record.providerId).toBe("mock");
    expect(record.language).toBe("en");
    expect(Number.isNaN(Date.parse(record.createdAt))).toBe(false);
    expect(record.words?.length).toBe(record.text.split(/\s+/).length);
  });

  it("forwards partials and progress while pushing chunks", async () => {
    const bytes = encoder.encode("y".repeat(800));
    const { fs, path } = await fixtureAudio(bytes);
    const partials: string[] = [];
    const fractions: number[] = [];
    await transcribeForReview({
      fs,
      audioPath: path,
      mimeType: "audio/webm",
      durationMs: null,
      settings: settingsWith(),
      onPartial: (text) => partials.push(text),
      onProgress: (fraction) => {
        if (fraction !== null) fractions.push(fraction);
      },
      cancelToken: { cancelled: false },
    });
    expect(partials.length).toBeGreaterThan(0);
    expect(fractions.length).toBeGreaterThan(0);
    for (let i = 1; i < fractions.length; i++) {
      expect((fractions[i] as number) >= (fractions[i - 1] as number)).toBe(true);
    }
  });

  it("honours a cancelled token mid-flow and never fabricates text", async () => {
    const bytes = encoder.encode("z".repeat(900));
    const { fs, path } = await fixtureAudio(bytes);
    const token = { cancelled: false };
    const promise = transcribeForReview({
      fs,
      audioPath: path,
      mimeType: "audio/webm",
      durationMs: null,
      settings: settingsWith(),
      onPartial: () => {
        token.cancelled = true;
      },
      cancelToken: token,
    });
    await expect(promise).rejects.toMatchObject({
      name: "TranscriptionError",
      code: "cancelled",
    });
  });

  it("propagates provider unsupported-format errors untouched", async () => {
    const bytes = encoder.encode("w".repeat(128));
    const { fs, path } = await fixtureAudio(bytes);
    let caught: unknown = null;
    try {
      await transcribeForReview({
        fs,
        audioPath: path,
        mimeType: "text/plain",
        durationMs: null,
        settings: settingsWith(),
        cancelToken: { cancelled: false },
      });
    } catch (err) {
      caught = err;
    }
    expect(TranscriptionError.is(caught)).toBe(true);
    expect((caught as TranscriptionError).code).toBe("unsupported-format");
  });

  it("falls back to the mock provider when the configured one is missing", async () => {
    const bytes = encoder.encode("q".repeat(256));
    const { fs, path } = await fixtureAudio(bytes);
    const record = await transcribeForReview({
      fs,
      audioPath: path,
      mimeType: "audio/webm",
      durationMs: null,
      settings: settingsWith({ providerId: "http", httpProvider: null }),
      cancelToken: { cancelled: false },
    });
    expect(record.providerId).toBe("mock");
  });

  it("wraps read failures without inventing transcript text", async () => {
    const fs = new MemFs();
    let caught: unknown = null;
    try {
      await transcribeForReview({
        fs,
        audioPath: "audio/none/missing.webm",
        mimeType: "audio/webm",
        durationMs: null,
        settings: settingsWith(),
        cancelToken: { cancelled: false },
      });
    } catch (err) {
      caught = err;
    }
    expect(TranscriptionError.is(caught)).toBe(true);
    expect((caught as TranscriptionError).code).toBe("unknown");
  });
});
