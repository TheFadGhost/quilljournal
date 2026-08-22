import { describe, expect, it } from "vitest";
import {
  currentWordIndex,
  estimateElapsedFromChunks,
  formatClock,
  wordAtFraction,
  type TimedWord,
} from "../../src/renderer/audio/alignment.js";

function w(startMs: number, endMs: number): TimedWord {
  return { startMs, endMs };
}

describe("currentWordIndex", () => {
  it("returns -1 for an empty word list", () => {
    expect(currentWordIndex([], 0)).toBe(-1);
    expect(currentWordIndex([], 99999)).toBe(-1);
  });

  it("returns -1 before the first word starts", () => {
    const words = [w(100, 200), w(300, 400)];
    expect(currentWordIndex(words, 0)).toBe(-1);
    expect(currentWordIndex(words, 99)).toBe(-1);
  });

  it("finds a word while inside its span", () => {
    const words = [w(0, 10), w(10, 20), w(20, 30)];
    expect(currentWordIndex(words, 5)).toBe(0);
    expect(currentWordIndex(words, 15)).toBe(1);
    expect(currentWordIndex(words, 25)).toBe(2);
  });

  it("treats start as inclusive and end as exclusive at exact boundaries", () => {
    const words = [w(0, 500), w(500, 1000)];
    expect(currentWordIndex(words, 0)).toBe(0);
    expect(currentWordIndex(words, 499)).toBe(0);
    expect(currentWordIndex(words, 500)).toBe(1);
    expect(currentWordIndex(words, 999)).toBe(1);
    expect(currentWordIndex(words, 1000)).toBe(1);
  });

  it("returns the last ended word when inside a gap", () => {
    const words = [w(0, 10), w(100, 110)];
    expect(currentWordIndex(words, 50)).toBe(0);
    expect(currentWordIndex(words, 99)).toBe(0);
  });

  it("returns the last index after the final word ends", () => {
    const words = [w(0, 10), w(20, 30)];
    expect(currentWordIndex(words, 40)).toBe(1);
    expect(currentWordIndex(words, 100000)).toBe(1);
  });

  it("handles a single word", () => {
    const words = [w(50, 60)];
    expect(currentWordIndex(words, 49)).toBe(-1);
    expect(currentWordIndex(words, 50)).toBe(0);
    expect(currentWordIndex(words, 55)).toBe(0);
    expect(currentWordIndex(words, 60)).toBe(0);
  });

  it("handles zero-duration words", () => {
    const words = [w(50, 50)];
    expect(currentWordIndex(words, 49)).toBe(-1);
    expect(currentWordIndex(words, 50)).toBe(0);
  });

  it("handles adjacent words with identical starts", () => {
    const words = [w(0, 10), w(0, 20)];
    expect(currentWordIndex(words, 15)).toBe(1);
    expect(currentWordIndex(words, 5)).toBe(0);
    expect(currentWordIndex(words, 25)).toBe(1);
  });

  it("rejects unsorted input with RangeError", () => {
    expect(() => currentWordIndex([w(10, 20), w(0, 5)], 0)).toThrow(RangeError);
    expect(() => currentWordIndex([w(0, 10), w(5, 6), w(3, 4)], 0)).toThrow(RangeError);
  });

  it("rejects end before start with RangeError", () => {
    expect(() => currentWordIndex([w(10, 5)], 0)).toThrow(RangeError);
    expect(() => currentWordIndex([w(0, 10), w(20, 19)], 0)).toThrow(RangeError);
  });

  it("matches a linear scan on a large sorted list", () => {
    const words: TimedWord[] = [];
    for (let i = 0; i < 500; i++) {
      words.push(w(i * 10, i * 10 + 7));
    }
    for (let t = -5; t <= 5005; t += 7) {
      let expected = -1;
      for (let i = 0; i < words.length; i++) {
        if (t < (words[i] as TimedWord).startMs) break;
        expected = i;
      }
      expect(currentWordIndex(words, t)).toBe(expected);
    }
  });
});

describe("wordAtFraction", () => {
  it("returns -1 for an empty list", () => {
    expect(wordAtFraction([], 0.5)).toBe(-1);
  });

  it("maps fraction 0 to the first word and fraction 1 to the last word", () => {
    const words = [w(0, 100), w(150, 250)];
    expect(wordAtFraction(words, 0)).toBe(0);
    expect(wordAtFraction(words, 1)).toBe(1);
  });

  it("maps intermediate fractions proportionally over the full span", () => {
    const words = [w(0, 100), w(900, 1100)];
    expect(wordAtFraction(words, 0.5)).toBe(0);
    expect(wordAtFraction(words, 0.9)).toBe(1);
    expect(wordAtFraction(words, 0.81)).toBe(0);
    expect(wordAtFraction(words, 0.82)).toBe(1);
  });

  it("clamps out-of-range fractions into [0, 1]", () => {
    const words = [w(0, 100), w(150, 250)];
    expect(wordAtFraction(words, -3)).toBe(0);
    expect(wordAtFraction(words, 42)).toBe(1);
  });

  it("works when the first word does not start at zero", () => {
    const words = [w(500, 600), w(700, 800)];
    expect(wordAtFraction(words, 0)).toBe(0);
    expect(wordAtFraction(words, 1)).toBe(1);
  });

  it("handles a single zero-duration word", () => {
    expect(wordAtFraction([w(50, 50)], 0)).toBe(0);
    expect(wordAtFraction([w(50, 50)], 1)).toBe(0);
  });
});

describe("formatClock", () => {
  it("formats mm:ss below an hour", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(1000)).toBe("00:01");
    expect(formatClock(59_000)).toBe("00:59");
    expect(formatClock(61_000)).toBe("01:01");
    expect(formatClock(3_599_999)).toBe("59:59");
  });

  it("switches to hh:mm:ss past an hour", () => {
    expect(formatClock(3_600_000)).toBe("01:00:00");
    expect(formatClock(3_661_000)).toBe("01:01:01");
    expect(formatClock(7_385_000)).toBe("02:03:05");
  });

  it("clamps negative and non-finite input to zero", () => {
    expect(formatClock(-1)).toBe("00:00");
    expect(formatClock(Number.NaN)).toBe("00:00");
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe("00:00");
  });

  it("ignores sub-second remainder", () => {
    expect(formatClock(90_500)).toBe("01:30");
    expect(formatClock(999)).toBe("00:00");
  });
});

describe("estimateElapsedFromChunks", () => {
  it("multiplies chunk count by the default one-second timeslice", () => {
    expect(estimateElapsedFromChunks(0)).toBe(0);
    expect(estimateElapsedFromChunks(5)).toBe(5000);
  });

  it("honors a custom timeslice", () => {
    expect(estimateElapsedFromChunks(3, 250)).toBe(750);
    expect(estimateElapsedFromChunks(1, 1234)).toBe(1234);
  });

  it("clamps negative counts to zero", () => {
    expect(estimateElapsedFromChunks(-2)).toBe(0);
    expect(estimateElapsedFromChunks(-2, 500)).toBe(0);
  });
});
