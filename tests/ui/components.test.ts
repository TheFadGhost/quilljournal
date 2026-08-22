import { describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import type { Entry } from "../../src/core/types.js";
import { EntryListRow } from "../../src/renderer/components/EntryListRow.js";
import { Onboarding } from "../../src/renderer/components/Onboarding.js";
import { ShortcutSheet } from "../../src/renderer/components/ShortcutSheet.js";
import { LockOverlay } from "../../src/renderer/components/LockOverlay.js";

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

describe("EntryListRow (SSR)", () => {
  it("renders date line, fallback date title, excerpt, and meta", () => {
    const entry = makeEntry({
      title: "",
      body: "# Morning pages\n\nWrote about **rain** and the [garden](notes.md) all afternoon.",
      tags: ["home"],
      markers: ["tired"],
      audio: {
        storedPath: "audio/entry_test1/a.webm",
        mimeType: "audio/webm",
        durationMs: 1200,
        transcript: null,
      },
    });
    const html = renderToString(
      h(EntryListRow, { entry, active: true, onOpen: () => undefined }),
    );
    expect(html).toContain("entry-row");
    expect(html).toContain("aria-current");
    expect(html).toContain("March 2026");
    expect(html).toContain("09:12");
    expect(html).toContain("Morning pages Wrote about rain and the garden");
    expect(html).toContain("chip-marker");
    expect(html).toContain("tired");
    expect(html).toContain("words");
    expect(html).toContain("audio");
  });

  it("shows the entry title when present", () => {
    const entry = makeEntry({ title: "A named day", body: "text" });
    const html = renderToString(
      h(EntryListRow, { entry, active: false, onOpen: () => undefined }),
    );
    expect(html).toContain("A named day");
  });
});

describe("Onboarding (SSR)", () => {
  it("explains locality, shows the storage path, and offers Begin", () => {
    const html = renderToString(
      h(Onboarding, {
        storageLocation: "C:\\Users\\Work\\Journal",
        promptsEnabled: false,
        onPromptsChange: () => undefined,
        onBegin: () => undefined,
      }),
    );
    expect(html).toContain("no account");
    expect(html).toContain("C:\\Users\\Work\\Journal");
    expect(html).toContain("offline mock provider");
    expect(html).toContain("Encryption");
    expect(html).toContain("Begin");
  });

  it("reflects the prompts opt-in default off", () => {
    const html = renderToString(
      h(Onboarding, {
        storageLocation: "/tmp/journal",
        promptsEnabled: false,
        onPromptsChange: () => undefined,
        onBegin: () => undefined,
      }),
    );
    expect(html).not.toContain("checked");
  });
});

describe("ShortcutSheet (SSR)", () => {
  it("is a modal dialog listing every shortcut including the global one", () => {
    const html = renderToString(
      h(ShortcutSheet, { globalAccelerator: "Control+Alt+N", onClose: () => undefined }),
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("Keyboard shortcuts");
    expect(html).toContain("Ctrl+N");
    expect(html).toContain("Control+Alt+N");
    expect(html).toContain("Ctrl+S");
    expect(html).toContain("Ctrl+E");
    expect(html).toContain("Ctrl+Shift+F");
    expect(html).toContain("Esc");
  });
});

describe("LockOverlay (SSR)", () => {
  it("asks for a passphrase when the journal is encrypted", () => {
    const html = renderToString(
      h(LockOverlay, {
        passphraseRequired: true,
        onUnlock: async () => undefined,
        onDismiss: () => undefined,
      }),
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('type="password"');
    expect(html).toContain("passphrase");
    expect(html).toContain("Unlock");
  });

  it("offers plain click-to-dismiss when encryption is off", () => {
    const html = renderToString(
      h(LockOverlay, {
        passphraseRequired: false,
        onUnlock: async () => undefined,
        onDismiss: () => undefined,
      }),
    );
    expect(html).toContain("inactivity");
    expect(html).toContain("Unlock");
    expect(html).not.toContain('type="password"');
  });
});
