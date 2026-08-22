import { describe, expect, it, vi } from "vitest";
import { TranscriptionError } from "../../src/core/errors.js";
import { createMockProvider, MOCK_TRANSCRIPTS, selectMockTranscript } from "../../src/core/providers/mock.js";
import { runProviderConformance, syntheticAudio, syntheticBytes } from "../conformance/suite.js";

const provider = createMockProvider();

function makeMockProvider(scenario: string): typeof provider {
  if (scenario === "broken") {
    return { ...provider, isAvailable: () => Promise.resolve(false) };
  }
  return provider;
}

runProviderConformance("mock", makeMockProvider, {
  textFor: (scenario) => selectMockTranscript(syntheticBytes(`qj:${scenario}`, 512)),
});

describe("mock provider", () => {
  it("is deterministic for identical input bytes", async () => {
    const input = syntheticAudio("determinism");
    const first = await provider.createSession(input).finalize();
    const second = await provider.createSession({ ...input }).finalize();
    expect(second.text).toBe(first.text);
    expect(second.words).toEqual(first.words);
  });

  it("selects only corpus entries and varies across distinct inputs", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 64; i++) {
      const data = new Uint8Array(97).map((_, index) => (index * (i + 3) + i) & 0xff);
      const text = selectMockTranscript(data);
      expect(MOCK_TRANSCRIPTS).toContain(text);
      seen.add(text);
    }
    expect(seen.size).toBeGreaterThanOrEqual(2);
  });

  it("bundles a corpus of at least eight neutral transcripts", () => {
    expect(MOCK_TRANSCRIPTS.length).toBeGreaterThanOrEqual(8);
    for (const entry of MOCK_TRANSCRIPTS) {
      expect(entry.trim().length).toBeGreaterThan(0);
    }
  });

  it("produces fixed-grid word timings", async () => {
    const result = await provider.createSession(syntheticAudio("timings")).finalize();
    const words = result.text.split(" ");
    expect(result.words?.length).toBe(words.length);
    result.words?.forEach((word, i) => {
      expect(word.word).toBe(words[i]);
      expect(word.startMs).toBe(i * 400);
      expect(word.endMs).toBe((i + 1) * 400);
    });
  });

  it("keeps progress fractions within [0,1] and non-decreasing", () => {
    const fractions: number[] = [];
    const session = provider.createSession(syntheticAudio("progress"), {
      onProgress: (report) => {
        if (report.fraction !== null) fractions.push(report.fraction);
      },
    });
    const data = syntheticBytes("progress", 640);
    for (let i = 0; i < 5; i++) session.pushAudio(data.subarray(i * 128, (i + 1) * 128));
    expect(fractions.length).toBeGreaterThan(0);
    fractions.forEach((fraction) => {
      expect(fraction).toBeGreaterThanOrEqual(0);
      expect(fraction).toBeLessThanOrEqual(1);
    });
    for (let i = 1; i < fractions.length; i++) {
      expect(fractions[i]!).toBeGreaterThanOrEqual(fractions[i - 1]!);
    }
  });

  it("throws synchronously and fires onError exactly once per validation failure", () => {
    const cases = [
      { overrides: { data: new Uint8Array(0) }, code: "unknown" as const },
      { overrides: { mimeType: "text/plain" }, code: "unsupported-format" as const },
      { overrides: { durationMs: 3601 * 1000 }, code: "audio-too-long" as const },
    ];
    for (const testCase of cases) {
      const onError = vi.fn();
      let thrown: unknown = null;
      try {
        provider.createSession(syntheticAudio("invalid", testCase.overrides), { onError });
      } catch (error) {
        thrown = error;
      }
      expect(TranscriptionError.is(thrown)).toBe(true);
      expect(thrown instanceof TranscriptionError ? thrown.code : null).toBe(testCase.code);
      expect(onError).toHaveBeenCalledTimes(1);
    }
  });

  it("never emits partials or progress after cancel", async () => {
    let partials = 0;
    let progress = 0;
    const session = provider.createSession(syntheticAudio("cancel"), {
      onPartial: () => {
        partials++;
      },
      onProgress: () => {
        progress++;
      },
    });
    const data = syntheticBytes("cancel", 512);
    session.pushAudio(data.subarray(0, 256));
    await session.cancel();
    await session.cancel();
    session.pushAudio(data.subarray(256, 512));
    expect(partials).toBeGreaterThanOrEqual(1);
    expect(progress).toBeGreaterThanOrEqual(1);
    const counts = [partials, progress];
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(partials).toBe(counts[0]);
    expect(progress).toBe(counts[1]);
    await expect(session.finalize()).rejects.toMatchObject({ code: "cancelled" });
  });

  it("reports the scripted language when none is requested", async () => {
    const result = await provider.createSession(syntheticAudio("lang")).finalize();
    expect(result.language).toBe("en");
  });
});
