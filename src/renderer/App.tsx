import { useCallback, useEffect, useRef, useState } from "react";
import { JournalProvider, useJournal } from "./state/JournalProvider.js";
import { Sidebar } from "./components/Sidebar.js";
import type { ViewName } from "./components/Sidebar.js";
import { EditorPane } from "./components/EditorPane.js";
import { Onboarding } from "./components/Onboarding.js";
import { ShortcutSheet } from "./components/ShortcutSheet.js";
import { BackupReminder } from "./components/BackupReminder.js";
import { BrowseView } from "./components/BrowseView.js";
import { RecordingBar } from "./components/RecordingBar.js";
import { ReviewModal } from "./components/ReviewModal.js";
import type { CommitMode, ReviewRequest } from "./components/ReviewModal.js";
import { SearchView } from "./components/SearchView.js";
import { SettingsView } from "./components/SettingsView.js";
import type { ExportKind } from "./components/SettingsView.js";
import { transcribeForReview } from "./voice/pipeline.js";
import { ipc, getQuillRaw, RendererFileSystem } from "./ipc/rendererBridge.js";
import { buildPrintableHtml } from "../core/export/printable.js";
import { buildArchive, writeArchiveFile } from "../core/export/archive.js";
import { exportMarkdown } from "../core/export/markdown.js";
import type { TranscriptRecord } from "../core/types.js";
import "./styles/views.css";

export function App() {
  return (
    <JournalProvider>
      <Shell />
    </JournalProvider>
  );
}

function Shell() {
  const {
    store,
    settings,
    updateSettings,
    entries,
    reloadEntries,
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
  const [review, setReview] = useState<ReviewRequest | null>(null);
  const [encState, setEncState] = useState(() => ({
    enabled: store.isEncrypted(),
    unlocked: store.isUnlocked(),
  }));
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
  const shellClass = [
    "app-shell",
    focusMode ? "focus-mode" : "",
    activeEntryId !== null ? "has-rec-bar" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={shellClass}>
      <Sidebar
        view={view}
        entries={entries}
        activeEntryId={activeEntryId}
        anchorDateKey={anchorDateKey}
        searchQuery={searchQuery}
        onNavigate={setView}
        onOpenEntry={(id) => {
          openEntry(id);
          setView("today");
        }}
        onSearchChange={setSearchQuery}
        onSubmitSearch={() => setView("browse")}
        onHelp={() => setSheetOpen(true)}
        searchInputRef={searchRef}
      />
      <main className="app-main">
        {view === "today" ? (
          <>
            <BackupReminder
              lastExportAt={settings.lastExportAt}
              reminderDays={settings.backupReminderDays}
              onGoToExport={() => setView("settings")}
            />
            <EditorPane />
          </>
        ) : null}
        {view === "browse" ? (
          <BrowseView
            entries={entries}
            todayKey={todayKey}
            activeEntryId={activeEntryId}
            onOpen={(id) => {
              openEntry(id);
              setView("today");
            }}
          />
        ) : null}
        {view === "search" ? (
          <SearchView
            entries={entries}
            query={searchQuery}
            onQueryChange={setSearchQuery}
            activeEntryId={activeEntryId}
            onOpen={(id) => {
              openEntry(id);
              setView("today");
            }}
            announce={announce}
          />
        ) : null}
        {view === "settings" ? (
          <SettingsView
            settings={settings}
            storageLocation={storageLocation}
            encryptionEnabled={encState.enabled}
            encryptionUnlocked={encState.unlocked}
            onUpdateSettings={updateSettings}
            onEnableEncryption={async (passphrase) => {
              await store.enableEncryption(passphrase);
              await reloadEntries();
              setEncState({ enabled: true, unlocked: true });
              announce("Encryption enabled");
            }}
            onDisableEncryption={async (passphrase) => {
              await store.disableEncryption(passphrase);
              await reloadEntries();
              setEncState({ enabled: false, unlocked: false });
              announce("Encryption disabled; journal decrypted");
            }}
            onChangePassphrase={async (oldPassphrase, newPassphrase) => {
              await store.changePassphrase(oldPassphrase, newPassphrase);
              announce("Passphrase changed");
            }}
            onLock={() => {
              store.lock();
              announce("Journal locked");
              window.location.reload();
            }}
            onExport={(kind) => runExport(kind)}
            onRevealStorage={async () => {
              await getQuillRaw().invoke("app:reveal-storage");
            }}
          />
        ) : null}
      </main>
      {sheetOpen ? (
        <ShortcutSheet
          globalAccelerator={settings.globalNewEntryShortcut}
          onClose={() => setSheetOpen(false)}
        />
      ) : null}
      {review ? (
        <ReviewModal
          request={review}
          discardDefault={settings.discardAudioAfterTranscriptionDefault}
          onCommit={(draft, mode, discardAudio) => commitTranscript(review, draft, mode, discardAudio)}
          onRetry={async () => {
            const record = await transcribeForReview({
              fs: new RendererFileSystem(),
              audioPath: review.audioPath,
              mimeType: review.mimeType,
              durationMs: review.durationMs,
              settings,
              cancelToken: { cancelled: false },
            });
            setReview({ ...review, record });
            return record;
          }}
          onDiscard={() => {
            announce("Transcript discarded; audio retained");
            setReview(null);
          }}
          onClose={() => setReview(null)}
        />
      ) : null}
      {activeEntryId !== null ? (
        <RecordingBar onTranscribed={(req) => setReview(req)} />
      ) : null}
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
    </div>
  );

  async function commitTranscript(
    req: ReviewRequest,
    draft: string,
    mode: CommitMode,
    discardAudio: boolean,
  ): Promise<void> {
    const edited = draft !== req.record.text;
    const transcript: TranscriptRecord = edited
      ? { ...req.record, text: draft, words: undefined }
      : req.record;
    await store.setEntryAudio(req.entryId, {
      storedPath: req.audioPath,
      mimeType: req.mimeType,
      durationMs: req.durationMs,
      transcript,
    });
    const entry = await store.getEntry(req.entryId);
    const body =
      mode === "append"
        ? entry.body.length > 0
          ? `${entry.body}\n\n${draft}`
          : draft
        : draft;
    await store.putEntry({ ...entry, body });
    if (discardAudio) await store.discardAudio(req.entryId);
    await reloadEntries();
    announce("Transcript committed");
    setReview(null);
  }

  async function runExport(kind: ExportKind): Promise<string> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = `exports/${stamp}`;
    const fs = new RendererFileSystem();
    if (kind === "markdown") {
      await exportMarkdown(fs, dir, entries, {
        readAttachment: (att) => store.readAttachment(att),
      });
    } else if (kind === "archive") {
      const attachmentsByPath = new Map(
        entries.flatMap((entry) =>
          entry.attachments.map((att) => [att.storedPath, att] as const),
        ),
      );
      const archive = await buildArchive(entries, {
        readFile: async (storedPath) => {
          const att = attachmentsByPath.get(storedPath);
          if (att) return store.readAttachment(att);
          if (storedPath.startsWith("audio/")) return store.readAudio(storedPath);
          return fs.readFile(storedPath);
        },
      });
      await writeArchiveFile(fs, `${dir}/quilljournal-archive.json`, archive);
    } else {
      const html = buildPrintableHtml(entries);
      await fs.writeFileAtomic(`${dir}/quilljournal-print.html`, new TextEncoder().encode(html));
    }
    updateSettings({ lastExportAt: new Date().toISOString() });
    return dir;
  }
}
