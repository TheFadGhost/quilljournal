import { describe, expect, it } from "vitest";
import {
  countWords,
  excerptText,
  formatBytes,
  formatDuration,
  formatSavedAt,
  plainTextFromMarkdown,
} from "../../src/renderer/util.js";

describe("excerptText", () => {
  it("returns the text unchanged when short enough", () => {
    expect(excerptText("Short entry", 160)).toBe("Short entry");
    expect(excerptText("   spaced   out   ", 40)).toBe("spaced out");
  });

  it("collapses whitespace and normalizes newlines", () => {
    expect(excerptText("one\ntwo\n\nthree", 40)).toBe("one two three");
  });

  it("cuts at a word boundary and appends an ellipsis", () => {
    const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
    const out = excerptText(text, 20);
    expect(out).toBe("alpha beta gamma…");
    expect(out).not.toContain("delta");
    expect(out.length).toBeLessThanOrEqual(21);
  });

  it("never cuts mid-word even without spaces before the limit", () => {
    const out = excerptText("supercalifragilisticexpialidocious and more words here", 10);
    expect(out.endsWith("…")).toBe(true);
  });

  it("handles unicode text by code points, not utf-16 units", () => {
    const text = "日本語のテキストです。これは切り詰められるべき長い文です。";
    const out = excerptText(text, 10);
    expect(Array.from(out.replace(/…$/u, "")).length).toBeLessThanOrEqual(10);
    expect(out.endsWith("…")).toBe(true);
  });

  it("returns empty string for empty input or non-positive max", () => {
    expect(excerptText("", 160)).toBe("");
    expect(excerptText("anything", 0)).toBe("");
  });
});

describe("countWords", () => {
  it("counts english words separated by whitespace", () => {
    expect(countWords("Hello world")).toBe(2);
    expect(countWords("one two three four")).toBe(4);
  });

  it("counts CJK characters individually", () => {
    expect(countWords("今天天气很好")).toBe(6);
    expect(countWords("ひらがな")).toBe(4);
  });

  it("ignores punctuation-only tokens", () => {
    expect(countWords("Hello, world!")).toBe(2);
    expect(countWords("— … –")).toBe(0);
  });

  it("counts korean via whitespace like english", () => {
    expect(countWords("안녕 하세요")).toBe(2);
  });

  it("returns zero for empty input and at least one for any word", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   ")).toBe(0);
    expect(countWords("x")).toBe(1);
  });

  it("mixes CJK and latin words", () => {
    expect(countWords("today 今日 was 明日 good")).toBe(7);
  });
});

describe("formatBytes", () => {
  it("formats bytes and zero", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("formats kilobytes with one decimal", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  it("climbs to megabytes and gigabytes", () => {
    expect(formatBytes(1048576)).toBe("1.0 MB");
    expect(formatBytes(3_221_225_472)).toBe("3.0 GB");
  });
});

describe("plainTextFromMarkdown", () => {
  it("strips headings, emphasis, links, and images", () => {
    const md = "# Title\n\nSome **bold** and *italic* with [a link](https://example.com).";
    expect(plainTextFromMarkdown(md)).toBe("Title Some bold and italic with a link.");
  });

  it("drops code fences and inline code markers", () => {
    const md = "before\n\n```\nconst x = 1;\n```\n\nafter `code` tail";
    const out = plainTextFromMarkdown(md);
    expect(out).toBe("before after code tail");
    expect(out).not.toContain("`");
  });

  it("strips list markers and blockquotes", () => {
    const md = "- first\n- second\n\n> quoted thought\n\n1. numbered";
    const out = plainTextFromMarkdown(md);
    expect(out).toBe("first second quoted thought numbered");
  });
});

describe("formatSavedAt", () => {
  it("zero-pads hours and minutes in 24-hour form", () => {
    expect(formatSavedAt(new Date(2026, 2, 14, 9, 7))).toBe("09:07");
    expect(formatSavedAt(new Date(2026, 2, 14, 23, 59))).toBe("23:59");
    expect(formatSavedAt(new Date(2026, 2, 14, 0, 0))).toBe("00:00");
  });
});

describe("formatDuration", () => {
  it("renders sub-minute, minutes, and hours", () => {
    expect(formatDuration(30_000)).toBe("<1 min");
    expect(formatDuration(5 * 60_000)).toBe("5 min");
    expect(formatDuration(90 * 60_000)).toBe("1 h 30 min");
    expect(formatDuration(120 * 60_000)).toBe("2 h");
  });
});
