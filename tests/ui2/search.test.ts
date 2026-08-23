import { describe, expect, it } from "vitest";
import type { Entry } from "../../src/core/types.js";
import { filterEntries, summarizeFilters } from "../../src/renderer/search.js";

function makeEntry(overrides: Partial<Entry> & { id: string; dateKey: string }): Entry {
  const now = new Date(2026, 0, 15, 9, 0, 0).toISOString();
  return {
    schemaVersion: 1,
    id: overrides.id,
    dateKey: overrides.dateKey,
    createdAt: now,
    updatedAt: now,
    title: "",
    body: "",
    tags: [],
    markers: [],
    attachments: [],
    audio: null,
    revisions: [],
    writingTimeMs: 0,
    ...overrides,
  };
}

const entries: Entry[] = [
  makeEntry({
    id: "a",
    dateKey: "2026-03-10",
    title: "Rainy commute",
    body: "The bus window fogged over.",
    tags: ["city"],
    markers: ["tired"],
  }),
  makeEntry({
    id: "b",
    dateKey: "2026-03-12",
    title: "Garden notes",
    body: "Planted basil beside the fence.",
    tags: ["home", "garden"],
  }),
  makeEntry({
    id: "c",
    dateKey: "2025-03-10",
    title: "Old spring",
    body: "A year ago today the heron returned.",
    audio: {
      storedPath: "audio/c/a.webm",
      mimeType: "audio/webm",
      durationMs: 1000,
      transcript: {
        text: "spoken memory of the river bank",
        providerId: "mock",
        createdAt: "2025-03-10T08:00:00.000Z",
      },
    },
  }),
];

function ids(list: Entry[]): string[] {
  return list.map((e) => e.id);
}

describe("filterEntries", () => {
  it("returns all entries ordered by date desc when no filters are active", () => {
    expect(ids(filterEntries(entries, { query: "", tags: [], markers: [], from: null, to: null }))).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("matches the query across title, body, tags, markers, and transcript text", () => {
    const base = { tags: [], markers: [], from: null, to: null };
    expect(ids(filterEntries(entries, { ...base, query: "rainy" }))).toEqual(["a"]);
    expect(ids(filterEntries(entries, { ...base, query: "basil" }))).toEqual(["b"]);
    expect(ids(filterEntries(entries, { ...base, query: "city" }))).toEqual(["a"]);
    expect(ids(filterEntries(entries, { ...base, query: "tired" }))).toEqual(["a"]);
    expect(ids(filterEntries(entries, { ...base, query: "river bank" }))).toEqual(["c"]);
    expect(ids(filterEntries(entries, { ...base, query: "zzz" }))).toEqual([]);
  });

  it("is case-insensitive and handles unicode queries", () => {
    const unicode = makeEntry({
      id: "u",
      dateKey: "2026-01-02",
      title: "Café morning",
      body: "Ein Kaffee am Fenster.",
    });
    const all = [...entries, unicode];
    expect(
      ids(
        filterEntries(all, {
          query: "café",
          tags: [],
          markers: [],
          from: null,
          to: null,
        }),
      ),
    ).toEqual(["u"]);
  });

  it("requires every selected tag (AND within facet)", () => {
    const base = { query: "", markers: [], from: null, to: null };
    expect(ids(filterEntries(entries, { ...base, tags: ["home"] }))).toEqual(["b"]);
    expect(ids(filterEntries(entries, { ...base, tags: ["home", "garden"] }))).toEqual(["b"]);
    expect(ids(filterEntries(entries, { ...base, tags: ["home", "city"] }))).toEqual([]);
  });

  it("requires every selected marker", () => {
    const base = { query: "", tags: [], from: null, to: null };
    expect(ids(filterEntries(entries, { ...base, markers: ["tired"] }))).toEqual(["a"]);
  });

  it("applies inclusive date range bounds", () => {
    const base = { query: "", tags: [], markers: [] };
    expect(
      ids(filterEntries(entries, { ...base, from: "2026-03-10", to: "2026-03-10" })),
    ).toEqual(["a"]);
    expect(ids(filterEntries(entries, { ...base, from: "2026-01-01", to: null }))).toEqual([
      "b",
      "a",
    ]);
    expect(ids(filterEntries(entries, { ...base, from: null, to: "2025-12-31" }))).toEqual(["c"]);
  });

  it("AND-combines facets and orders title hits first then date desc", () => {
    const hitBodyOnly = makeEntry({
      id: "d",
      dateKey: "2026-04-02",
      title: "Elsewhere",
      body: "mention rainy streets again",
    });
    const hitTitle = makeEntry({
      id: "e",
      dateKey: "2026-02-01",
      title: "Rainy attic",
      body: "dust and boxes",
    });
    const result = filterEntries([...entries, hitBodyOnly, hitTitle], {
      query: "rainy",
      tags: [],
      markers: [],
      from: null,
      to: null,
    });
    expect(ids(result)).toEqual(["a", "e", "d"]);
  });
});

describe("summarizeFilters", () => {
  it("joins active filters with separators", () => {
    expect(
      summarizeFilters({
        query: "heron",
        tags: ["home"],
        markers: ["tired"],
        from: "2026-01-01",
        to: null,
      }),
    ).toBe('text "heron" · tags: home · markers: tired · from 2026-01-01');
  });

  it("describes an empty filter set", () => {
    expect(summarizeFilters({ query: "", tags: [], markers: [], from: null, to: null })).toBe(
      "no filters active",
    );
  });
});
