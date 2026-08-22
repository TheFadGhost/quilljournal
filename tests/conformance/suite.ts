import { describe, expect, it } from "vitest";
import { TranscriptionError } from "../../src/core/errors.js";
import type { AudioInput, TranscriptionProvider } from "../../src/core/provider.js";

export interface ConformanceExpectations {
  textFor(scenario: string): string;
}

export type ProviderMaker = (
  scenario: string,
) => TranscriptionProvider | Promise<TranscriptionProvider>;

function fnv1aSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function syntheticBytes(seed: string, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = fnv1aSeed(seed);
  for (let i = 0; i < length; i++) {
    state ^= i + 1;
    state = Math.imul(state, 0x01000193);
    out[i] = state & 0xff;
  }
  return out;
}

export function syntheticAudio(scenario: string, overrides: Partial<AudioInput> = {}): AudioInput {
  return {
    data: syntheticBytes(`qj:${scenario}`, 512),
    mimeType: "audio/webm",
    durationMs: null,
    ...overrides,
  };
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function codeOf(failure: unknown): string | null {
  return TranscriptionError.is(failure) ? failure.code : null;
}

async function collectFailure(
  provider: TranscriptionProvider,
  input: AudioInput,
): Promise<unknown> {
  let received: unknown = null;
  try {
    const session = provider.createSession(input, {
      onError: (error) => {
        received = error;
      },
    });
    await session.finalize();
  } catch (error) {
    return error;
  }
  return received;
}

export function runProviderConformance(
  name: string,
  makeProvider: ProviderMaker,
  expectations: ConformanceExpectations,
): void {
  describe(`${name} conformance`, () => {
    it("finalizes batch audio to the expected text", async () => {
      const provider = await makeProvider("ok");
      expect(await provider.isAvailable()).toBe(true);
      const session = provider.createSession(syntheticAudio("ok"));
      const result = await session.finalize();
      expect(result.text).toBe(expectations.textFor("ok"));
      expect(session.providerId).toBe(provider.id);
    });

    it("emits monotonic non-shrinking streaming partials", async (ctx) => {
      const provider = await makeProvider("ok");
      if (!provider.capabilities().streaming) ctx.skip();
      const partials: string[] = [];
      const session = provider.createSession(syntheticAudio("ok"), {
        onPartial: (partial) => {
          partials.push(partial.text);
        },
      });
      const data = syntheticBytes("ok", 576);
      for (let i = 0; i < 6; i++) {
        session.pushAudio(data.subarray(i * 96, (i + 1) * 96));
      }
      const result = await session.finalize();
      expect(partials.length).toBeGreaterThan(0);
      for (let i = 1; i < partials.length; i++) {
        expect(partials[i]!.startsWith(partials[i - 1]!)).toBe(true);
      }
      for (const partial of partials) {
        expect(result.text.startsWith(partial)).toBe(true);
      }
    });

    it("rejects finalize with cancelled and stops partials after cancel", async () => {
      const provider = await makeProvider("ok");
      let partialCount = 0;
      const session = provider.createSession(syntheticAudio("ok"), {
        onPartial: () => {
          partialCount++;
        },
      });
      const data = syntheticBytes("ok", 384);
      session.pushAudio(data.subarray(0, 128));
      const finalizeOutcome = session.finalize().catch((error) => error);
      await session.cancel();
      const failure = await finalizeOutcome;
      expect(TranscriptionError.is(failure)).toBe(true);
      expect(TranscriptionError.is(failure) ? failure.code : null).toBe("cancelled");
      session.pushAudio(data.subarray(128, 256));
      const countAfterCancel = partialCount;
      await nextTick();
      await nextTick();
      expect(partialCount).toBe(countAfterCancel);
    });

    it("rejects unsupported mime types with unsupported-format", async () => {
      const provider = await makeProvider("ok");
      const failure = await collectFailure(provider, syntheticAudio("ok", { mimeType: "text/plain" }));
      expect(codeOf(failure)).toBe("unsupported-format");
    });

    it("rejects empty audio payloads with unknown", async () => {
      const provider = await makeProvider("ok");
      const failure = await collectFailure(provider, syntheticAudio("ok", { data: new Uint8Array(0) }));
      expect(codeOf(failure)).toBe("unknown");
    });

    it("rejects audio beyond the duration cap with audio-too-long", async (ctx) => {
      const provider = await makeProvider("ok");
      const cap = provider.capabilities().maxDurationSeconds;
      if (cap === null) ctx.skip();
      const limit = provider.capabilities().maxDurationSeconds ?? Number.MAX_SAFE_INTEGER;
      const failure = await collectFailure(
        provider,
        syntheticAudio("ok", { durationMs: (limit + 1) * 1000 }),
      );
      expect(codeOf(failure)).toBe("audio-too-long");
    });

    it("surfaces broken configurations as unavailable or config/unavailability errors", async () => {
      const provider = await makeProvider("broken");
      let available = true;
      try {
        available = await provider.isAvailable();
      } catch {
        available = false;
      }
      if (!available) return;
      const failure = await collectFailure(provider, syntheticAudio("broken"));
      const code = codeOf(failure);
      expect(code === "provider-unavailable" || code === "invalid-config").toBe(true);
    });
  });
}
