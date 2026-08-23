import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { StorageError } from "../../core/errors.js";
import { todayKey as systemTodayKey } from "../../core/dates.js";
import type { AppSettings, Entry } from "../../core/types.js";
import { JournalStore } from "../../core/store/journalStore.js";
import { ipc, RendererFileSystem } from "../ipc/rendererBridge.js";
import { LockOverlay } from "../components/LockOverlay.js";

export interface JournalContextValue {
  store: JournalStore;
  ready: boolean;
  settings: AppSettings;
  updateSettings(patch: Partial<AppSettings>): void;
  entries: Entry[];
  reloadEntries(): Promise<void>;
  storageLocation: string;
  todayKey: string;
  activeEntryId: string | null;
  openEntry(id: string | null): void;
  announce(message: string): void;
  announcement: string;
  searchQuery: string;
  setSearchQuery(query: string): void;
}

const JournalContext = createContext<JournalContextValue | null>(null);

export function useJournal(): JournalContextValue {
  const value = useContext(JournalContext);
  if (!value) throw new Error("useJournal requires JournalProvider");
  return value;
}

export function useJournalOptional(): JournalContextValue | null {
  return useContext(JournalContext);
}

interface JournalProviderProps {
  children: ReactNode;
}

export function JournalProvider({ children }: JournalProviderProps) {
  const [store] = useState(() => new JournalStore(new RendererFileSystem()));
  const [booted, setBooted] = useState(false);
  const [sessionStarted, setSessionStarted] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [storageLocation, setStorageLocation] = useState("");
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [todayKey, setTodayKey] = useState(() => systemTodayKey());

  const settingsRef = useRef<AppSettings | null>(null);
  const persistTimer = useRef<number | undefined>(undefined);

  const reloadEntries = useCallback(async () => {
    const list = await store.listEntries();
    setEntries(list);
  }, [store]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [loadedSettings, location] = await Promise.all([
          ipc.getSettings(),
          ipc.getStorageLocation(),
        ]);
        if (cancelled) return;
        settingsRef.current = loadedSettings;
        setSettings(loadedSettings);
        setStorageLocation(location);
        await store.init();
        if (cancelled) return;
        if (store.isEncrypted() && !store.isUnlocked()) {
          setLocked(true);
          setBooted(true);
          return;
        }
        const list = await store.listEntries();
        if (cancelled) return;
        setEntries(list);
        setSessionStarted(true);
        setBooted(true);
      } catch (err) {
        if (cancelled) return;
        if (StorageError.is(err) && err.kind === "locked") {
          setLocked(true);
          setBooted(true);
          return;
        }
        setFatal(err instanceof Error ? err.message : String(err));
        setBooted(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [store]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const key = systemTodayKey();
      setTodayKey((prev) => (prev === key ? prev : key));
    }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      settingsRef.current = next;
      if (persistTimer.current !== undefined) window.clearTimeout(persistTimer.current);
      persistTimer.current = window.setTimeout(() => {
        persistTimer.current = undefined;
        const latest = settingsRef.current;
        if (latest) void ipc.saveSettings(latest).catch(() => undefined);
      }, 500);
      return next;
    });
  }, []);

  const openEntry = useCallback((id: string | null) => {
    setActiveEntryId(id);
  }, []);

  const announce = useCallback((message: string) => {
    setAnnouncement(message);
  }, []);

  const handleUnlock = useCallback(
    async (passphrase: string) => {
      await store.unlock(passphrase);
      const list = await store.listEntries();
      setEntries(list);
      setLocked(false);
      setSessionStarted(true);
    },
    [store],
  );

  const handleSoftDismiss = useCallback(() => {
    setLocked(false);
  }, []);

  const idleMinutes = settings === null ? null : settings.idleLockMinutes;

  useEffect(() => {
    if (!booted || idleMinutes === null || idleMinutes <= 0) return;
    let timer = 0;
    const arm = () => {
      if (timer !== 0) window.clearTimeout(timer);
      timer = window.setTimeout(fire, idleMinutes * 60_000);
    };
    const fire = () => {
      window.dispatchEvent(new Event("quill:pre-lock"));
      setLocked((prev) => {
        if (prev) return prev;
        if (store.isEncrypted()) store.lock();
        return true;
      });
    };
    const onActivity = () => {
      if (!document.hidden) arm();
    };
    const events = ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"] as const;
    for (const name of events) window.addEventListener(name, onActivity, { passive: true });
    arm();
    return () => {
      if (timer !== 0) window.clearTimeout(timer);
      for (const name of events) window.removeEventListener(name, onActivity);
    };
  }, [booted, idleMinutes, store]);

  const value = useMemo<JournalContextValue | null>(() => {
    if (!settings) return null;
    return {
      store,
      ready: booted,
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
    };
  }, [
    store,
    booted,
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
  ]);

  if (fatal) {
    return (
      <div className="fatal-error" role="alert">
        <p>Quilljournal could not open its journal storage. Your files were not modified.</p>
        <pre>{fatal}</pre>
      </div>
    );
  }

  const showChildren = value !== null && sessionStarted;

  return (
    <>
      {showChildren && value ? (
        <JournalContext.Provider value={value}>
          <div className="lock-root" inert={locked || undefined}>
            {children}
          </div>
        </JournalContext.Provider>
      ) : (
        <main className="app-loading" aria-busy="true">
          <p>Quilljournal is starting…</p>
        </main>
      )}
      {booted && locked ? (
        <LockOverlay
          passphraseRequired={store.isEncrypted()}
          onUnlock={handleUnlock}
          onDismiss={handleSoftDismiss}
        />
      ) : null}
    </>
  );
}
