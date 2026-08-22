import { useEffect, useRef, useState } from "react";
import { JournalProvider, useJournal } from "./state/JournalProvider.js";
import { Sidebar } from "./components/Sidebar.js";
import type { ViewName } from "./components/Sidebar.js";
import { EditorPane } from "./components/EditorPane.js";
import { Onboarding } from "./components/Onboarding.js";
import { ShortcutSheet } from "./components/ShortcutSheet.js";
import { ipc } from "./ipc/rendererBridge.js";

export function App() {
  return (
    <JournalProvider>
      <Shell />
    </JournalProvider>
  );
}

function Shell() {
  const {
    settings,
    updateSettings,
    entries,
    storageLocation,
    todayKey,
    activeEntryId,
    openEntry,
    announce,
    announcement,
    searchQuery,
    setSearchQuery,
  } = useJournal();

  const [view, setView] = useState<ViewName>("today");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    document.documentElement.style.setProperty("--font-size", `${settings.fontSizePx}px`);
    document.documentElement.style.setProperty("--measure", `${settings.measureCh}`);
  }, [settings.theme, settings.fontSizePx, settings.measureCh]);

  useEffect(() => {
    void ipc.registerGlobalShortcut(settings.globalNewEntryShortcut).catch(() => false);
    return () => {
      void ipc.unregisterGlobalShortcut().catch(() => undefined);
    };
  }, [settings.globalNewEntryShortcut]);

  useEffect(() => {
    ipc.onNewEntryShortcut(() => {
      openEntry(null);
      setView("today");
    });
  }, [openEntry]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (sheetOpen) {
          setSheetOpen(false);
          return;
        }
        if (focusMode) {
          setFocusMode(false);
          announce("Focus mode off");
        }
        return;
      }
      const primary = e.ctrlKey || e.metaKey;
      if (primary && !e.shiftKey && !e.altKey) {
        const key = e.key.toLowerCase();
        if (key === "s") {
          e.preventDefault();
          window.dispatchEvent(new Event("quill:force-save"));
          return;
        }
        if (key === "e") {
          e.preventDefault();
          window.dispatchEvent(new Event("quill:toggle-preview"));
          return;
        }
      }
      const target = e.target as HTMLElement | null;
      const typing =
        target !== null &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (typing) return;
      if (primary && !e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        openEntry(null);
        setView("today");
        return;
      }
      if (primary && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setFocusMode((prev) => {
          announce(prev ? "Focus mode off" : "Focus mode on");
          return !prev;
        });
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key === "?") {
        setSheetOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sheetOpen, focusMode, openEntry, announce]);

  if (!settings.onboardedAt) {
    return (
      <Onboarding
        storageLocation={storageLocation}
        promptsEnabled={settings.promptsEnabled}
        onPromptsChange={(enabled) => updateSettings({ promptsEnabled: enabled })}
        onBegin={() => updateSettings({ onboardedAt: new Date().toISOString() })}
      />
    );
  }

  const anchorDateKey = entries.find((e) => e.id === activeEntryId)?.dateKey ?? todayKey;

  return (
    <div className={focusMode ? "app-shell focus-mode" : "app-shell"}>
      <Sidebar
        view={view}
        entries={entries}
        activeEntryId={activeEntryId}
        anchorDateKey={anchorDateKey}
        searchQuery={searchQuery}
        onNavigate={setView}
        onOpenEntry={openEntry}
        onSearchChange={setSearchQuery}
        onSubmitSearch={() => setView("browse")}
        onHelp={() => setSheetOpen(true)}
        searchInputRef={searchRef}
      />
      <main className="app-main">
        {view === "today" ? <EditorPane /> : null}
        {view === "browse" ? <section data-view="browse">{null}</section> : null}
        {view === "search" ? <section data-view="search">{null}</section> : null}
        {view === "settings" ? <section data-view="settings">{null}</section> : null}
      </main>
      {sheetOpen ? (
        <ShortcutSheet
          globalAccelerator={settings.globalNewEntryShortcut}
          onClose={() => setSheetOpen(false)}
        />
      ) : null}
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}
