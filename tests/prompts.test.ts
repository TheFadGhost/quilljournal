import { describe, expect, it } from "vitest";
import { BUNDLED_PROMPTS } from "../src/core/prompts/bundled.js";
import { nextPromptAfter, pickPromptForDate } from "../src/core/prompts/pick.js";
import { shiftDateKey } from "../src/core/dates.js";

function wordCount(prompt: string): number {
  return prompt.trim().split(/\s+/u).length;
}

describe("bundled prompts", () => {
  it("ships forty distinct concise original prompts", () => {
    expect(BUNDLED_PROMPTS).toHaveLength(40);
    expect(new Set(BUNDLED_PROMPTS).size).toBe(40);
    for (const prompt of BUNDLED_PROMPTS) {
      expect(wordCount(prompt)).toBeGreaterThanOrEqual(8);
      expect(wordCount(prompt)).toBeLessThanOrEqual(16);
    }
  });

  it("avoids wellness, clinical, and emotion-scoring vocabulary", () => {
    const banned =
      /\b(therap\w*|healing|mental health|wellness|gratitude|mood|anxiety|depression|self-care|mindful\w*|trauma|diagnos\w*|symptom)\b/iu;
    for (const prompt of BUNDLED_PROMPTS) {
      expect(banned.test(prompt)).toBe(false);
    }
  });
});

describe("pickPromptForDate", () => {
  it("returns the same prompt for the same dateKey", () => {
    const first = pickPromptForDate(BUNDLED_PROMPTS, "2026-05-10");
    const second = pickPromptForDate(BUNDLED_PROMPTS, "2026-05-10");
    expect(first).toBe(second);
    expect(first).not.toBe("");
  });

  it("always picks from the given pool across many dates", () => {
    const pool = new Set<string>(BUNDLED_PROMPTS);
    let key = "2026-01-01";
    const picked = new Set<string>();
    for (let day = 0; day < 40; day++) {
      const prompt = pickPromptForDate(BUNDLED_PROMPTS, key);
      expect(pool.has(prompt)).toBe(true);
      picked.add(prompt);
      key = shiftDateKey(key, 1);
    }
    expect(picked.size).toBeGreaterThan(20);
  });

  it("returns an empty string for an empty pool", () => {
    expect(pickPromptForDate([], "2026-05-10")).toBe("");
  });

  it("distributes across the pool rather than collapsing onto one prompt", () => {
    const counts = new Map<string, number>();
    let key = "2025-01-01";
    for (let day = 0; day < 400; day++) {
      const prompt = pickPromptForDate(BUNDLED_PROMPTS, key);
      counts.set(prompt, (counts.get(prompt) ?? 0) + 1);
      key = shiftDateKey(key, 1);
    }
    expect(counts.size).toBeGreaterThan(30);
  });
});

describe("nextPromptAfter", () => {
  it("never repeats the current prompt immediately", () => {
    let current = pickPromptForDate(BUNDLED_PROMPTS, "2026-05-10");
    for (let step = 0; step < 200; step++) {
      const next = nextPromptAfter(current, BUNDLED_PROMPTS);
      expect(next).not.toBe(current);
      current = next;
    }
  });

  it("cycles through the whole pool and wraps back to the start", () => {
    const pool = ["a", "b", "c"];
    expect(nextPromptAfter("a", pool)).toBe("b");
    expect(nextPromptAfter("b", pool)).toBe("c");
    expect(nextPromptAfter("c", pool)).toBe("a");
  });

  it("handles empty pools, unknown currents, and single-item pools", () => {
    expect(nextPromptAfter("x", [])).toBe("");
    expect(nextPromptAfter("nope", ["a", "b"])).toBe("a");
    expect(nextPromptAfter("only", ["only"])).toBe("only");
  });
});
