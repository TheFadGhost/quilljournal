import { describe, expect, it } from "vitest";
import type { Entry } from "../../src/core/types.js";
import { listMonthsAround, monthGrid, monthLabel, onThisDay } from "../../src/renderer/calendar.js";

function makeEntry(id: string, dateKey: string): Entry {
  const now = new Date(2026, 0, 15, 9, 0, 0).toISOString();
  return {
    schemaVersion: 1,
    id,
    dateKey,
    createdAt: now,
    updatedAt: now,
    title: id,
    body: "",
    tags: [],
    markers: [],
    attachments: [],
    audio: null,
    revisions: [],
    writingTimeMs: 0,
  };
}

describe("monthGrid", () => {
  it("starts weeks on Monday; Jan 2026 begins on a Thursday", () => {
    const grid = monthGrid(2026, 1, "2026-03-14");
    expect(grid[0]?.[0]?.dateKey).toBe("2025-12-29");
    expect(grid[0]?.[3]?.dateKey).toBe("2026-01-01");
    expect(grid[0]?.[3]?.inMonth).toBe(true);
    expect(grid[0]?.[0]?.inMonth).toBe(false);
  });

  it("pads January 2026 to five full weeks ending Feb 1", () => {
    const grid = monthGrid(2026, 1, "2026-03-14");
    expect(grid.length).toBe(5);
    expect(grid.every((week) => week.length === 7)).toBe(true);
    expect(grid[4]?.[6]?.dateKey).toBe("2026-02-01");
    expect(grid[4]?.[6]?.inMonth).toBe(false);
  });

  it("renders February 2026 with 28 days and six leading cells", () => {
    const grid = monthGrid(2026, 2, "2026-03-14");
    expect(grid.length).toBe(5);
    expect(grid[0]?.[6]?.dateKey).toBe("2026-02-01");
    const inMonth = grid.flat().filter((cell) => cell.inMonth);
    expect(inMonth.length).toBe(28);
  });

  it("handles the 2024 leap February with 29 days", () => {
    const grid = monthGrid(2024, 2, "2024-03-01");
    const keys = grid.flat().map((cell) => cell.dateKey);
    expect(keys).toContain("2024-02-29");
    const inMonth = grid.flat().filter((cell) => cell.inMonth);
    expect(inMonth.length).toBe(29);
  });

  it("marks today's cell only for the given today key", () => {
    const grid = monthGrid(2026, 3, "2026-03-14");
    const todays = grid.flat().filter((cell) => cell.isToday);
    expect(todays.length).toBe(1);
    expect(todays[0]?.dateKey).toBe("2026-03-14");
  });
});

describe("monthLabel", () => {
  it("formats month and year", () => {
    expect(monthLabel(2026, 3)).toBe("March 2026");
  });
});

describe("listMonthsAround", () => {
  it("lists span months on each side of the anchor inclusive", () => {
    expect(listMonthsAround("2026-03-14", 1)).toEqual([
      { year: 2026, month: 2 },
      { year: 2026, month: 3 },
      { year: 2026, month: 4 },
    ]);
  });

  it("wraps across year boundaries", () => {
    expect(listMonthsAround("2026-01-09", 1)).toEqual([
      { year: 2025, month: 12 },
      { year: 2026, month: 1 },
      { year: 2026, month: 2 },
    ]);
  });
});

describe("onThisDay", () => {
  it("collects other-year entries sharing mm-dd and sorts them descending", () => {
    const entries = [
      makeEntry("a", "2024-03-10"),
      makeEntry("b", "2025-03-10"),
      makeEntry("c", "2026-03-10"),
      makeEntry("d", "2025-04-10"),
    ];
    expect(onThisDay(entries, "2026-03-10").map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("returns nothing when no other years share the date", () => {
    expect(onThisDay([makeEntry("a", "2026-05-05")], "2026-05-05")).toEqual([]);
  });
});
