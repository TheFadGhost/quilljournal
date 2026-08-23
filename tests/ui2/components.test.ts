import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import type { Entry } from "../../src/core/types.js";
import { DEFAULT_SETTINGS } from "../../src/core/types.js";
import { SearchView } from "../../src/renderer/components/SearchView.js";
import { SettingsView } from "../../src/renderer/components/SettingsView.js";
import { ReviewModal } from "../../src/renderer/components/ReviewModal.js";
import { BrowseView } from "../../src/renderer/components/BrowseView.js";

function makeEntry(overrides: Partial<Entry> = {}): Entry {
  const now = new Date(2026, 2, 14, 9, 12, 0);
  return {
    schemaVersion: 1,
    id: "entry_test1",
    dateKey: "2026-03-14",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
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

describe("SearchView (SSR)", () => {
  it("shows the no-results state with filter summary and clear action", () => {
    const html = renderToString(
      h(SearchView, {
        entries: [makeEntry({ title: "Morning", body: "quiet start" })],
        query: "zzz-nothing",
        onQueryChange: () => undefined,
        activeEntryId: null,
        onOpen: () => undefined,
        announce: () => undefined,
      }),
    );
    expect(html).toContain("No entries match.");
    expect(html).toContain("zzz-nothing");
    expect(html).toContain("Clear filters");
  });

  it("renders facet rows for tags and markers plus date inputs", () => {
    const html = renderToString(
      h(SearchView, {
        entries: [
          makeEntry({ tags: ["home"], markers: ["tired"] }),
          makeEntry({ id: "entry_test2", dateKey: "2026-03-15", tags: ["city"] }),
        ],
        query: "",
        onQueryChange: () => undefined,
        activeEntryId: null,
        onOpen: () => undefined,
        announce: () => undefined,
      }),
    );
    expect(html).toContain("home");
    expect(html).toContain("city");
    expect(html).toContain("tired");
    expect(html).toContain('type="date"');
  });
});

describe("SettingsView (SSR)", () => {
  it("states the four required encryption warnings and the crypto facts", () => {
    const html = renderToString(
      h(SettingsView, {
        settings: DEFAULT_SETTINGS,
        storageLocation: "/journal",
        encryptionEnabled: false,
        encryptionUnlocked: false,
        onUpdateSettings: () => undefined,
        onEnableEncryption: async () => undefined,
        onLock: () => undefined,
        onExport: async () => "exports/x",
        onRevealStorage: async () => undefined,
      }),
    );
    expect(html).toContain("at rest only");
    expect(html).toContain("running or unlocked system");
    expect(html).toContain("permanently lost data");
    expect(html).toContain("unaudited");
    expect(html).toContain("PBKDF2-SHA256");
    expect(html).toContain("AES-256-GCM");
    expect(html).toContain("650,000 iterations");
    expect(html).toContain("Enable encryption");
  });

  it("keeps the enable button inert until the confirmation phrase is typed", () => {
    const html = renderToString(
      h(SettingsView, {
        settings: DEFAULT_SETTINGS,
        storageLocation: "/journal",
        encryptionEnabled: false,
        encryptionUnlocked: false,
        onUpdateSettings: () => undefined,
        onEnableEncryption: async () => undefined,
        onLock: () => undefined,
        onExport: async () => "exports/x",
        onRevealStorage: async () => undefined,
      }),
    );
    expect(html).toMatch(/disabled/);
    expect(html).toContain("I understand");
  });

  it("shows storage warning text, export buttons, and about facts", () => {
    const html = renderToString(
      h(SettingsView, {
        settings: DEFAULT_SETTINGS,
        storageLocation: "C:\\Journal",
        encryptionEnabled: true,
        encryptionUnlocked: true,
        onUpdateSettings: () => undefined,
        onEnableEncryption: async () => undefined,
        onLock: () => undefined,
        onExport: async () => "exports/x",
        onRevealStorage: async () => undefined,
      }),
    );
    expect(html).toContain("Takes effect after restart. The new folder must be empty.");
    expect(html).toContain("Markdown folder");
    expect(html).toContain("JSON archive");
    expect(html).toContain("Printable HTML");
    expect(html).toContain("MIT license");
    expect(html).toContain("No telemetry");
    expect(html).toContain("Encryption is on.");
  });
});

describe("ReviewModal (SSR)", () => {
  it("renders the plain empty-transcript notice with retry and discard", () => {
    const html = renderToString(
      h(ReviewModal, {
        request: {
          entryId: "entry_test1",
          audioPath: "audio/entry_test1/a.webm",
          mimeType: "audio/webm",
          durationMs: 1500,
          record: {
            text: "",
            providerId: "mock",
            createdAt: "2026-03-14T09:00:00.000Z",
            words: [],
          },
        },
        discardDefault: false,
        onCommit: async () => undefined,
        onRetry: async () => ({
          text: "x",
          providerId: "mock",
          createdAt: "2026-03-14T09:01:00.000Z",
        }),
        onDiscard: () => undefined,
        onClose: () => undefined,
      }),
    );
    expect(html).toContain("The provider returned nothing.");
    expect(html).toContain("Retry transcription");
    expect(html).toContain("Discard transcript");
    expect(html).not.toContain("Set as entry body");
  });

  it("renders the editable transcript, commit options, and dialog semantics", () => {
    const html = renderToString(
      h(ReviewModal, {
        request: {
          entryId: "entry_test1",
          audioPath: "audio/entry_test1/a.webm",
          mimeType: "audio/webm",
          durationMs: 1500,
          record: {
            text: "The rain kept tapping.",
            language: "en",
            providerId: "mock",
            createdAt: "2026-03-14T09:00:00.000Z",
            words: [
              { word: "The", startMs: 0, endMs: 400 },
              { word: "rain", startMs: 400, endMs: 800 },
            ],
          },
        },
        discardDefault: true,
        onCommit: async () => undefined,
        onRetry: async () => ({
          text: "x",
          providerId: "mock",
          createdAt: "2026-03-14T09:01:00.000Z",
        }),
        onDiscard: () => undefined,
        onClose: () => undefined,
      }),
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Review transcription");
    expect(html).toContain("The rain kept tapping.");
    expect(html).toContain("Set as entry body");
    expect(html).toContain("Append to entry body");
    expect(html).toContain("Discard audio after committing");
    expect(html).toContain("aligned-word");
  });
});

describe("BrowseView (SSR)", () => {
  it("renders the month grid with weekday headers and timeline rows", () => {
    const html = renderToString(
      h(BrowseView, {
        entries: [makeEntry({ title: "Rainy commute" })],
        todayKey: "2026-03-14",
        activeEntryId: null,
        onOpen: () => undefined,
      }),
    );
    expect(html).toContain("March 2026");
    expect(html).toContain("Mon");
    expect(html).toContain("cal-cell");
    expect(html).toContain("Rainy commute");
  });

  it("shows an empty month message when nothing exists", () => {
    const html = renderToString(
      h(BrowseView, {
        entries: [],
        todayKey: "2026-03-14",
        activeEntryId: null,
        onOpen: () => undefined,
      }),
    );
    expect(html).toContain("No entries this month.");
  });
});
