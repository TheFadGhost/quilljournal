import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { formatDateKeyLong, shiftDateKey } from "../../core/dates.js";
import { BUNDLED_PROMPTS } from "../../core/prompts/bundled.js";
import { pickPromptForDate } from "../../core/prompts/pick.js";
import type { Entry, EntryAttachment } from "../../core/types.js";
import { useJournal } from "../state/JournalProvider.js";
import { countWords, formatBytes, formatDuration, formatSavedAt } from "../util.js";

type SaveStatus = "clean" | "saving" | "saved" | "error";

const AUTOSAVE_MS = 800;
const BURST_IDLE_MS = 5000;
const CONFIRM_MS = 3000;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function EditorPane() {
  const {
    store,
    settings,
    entries,
    reloadEntries,
    activeEntryId,
    openEntry,
    todayKey,
    announce,
  } = useJournal();

  const [entry, setEntry] = useState<Entry | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [markers, setMarkers] = useState<string[]>([]);
  const [attachments, setAttachments] = useState<EntryAttachment[]>([]);
  const [status, setStatus] = useState<SaveStatus>("clean");
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [markerDraft, setMarkerDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [busyFiles, setBusyFiles] = useState(false);

  const dirtyRef = useRef(false);
  const saveTimer = useRef<number | undefined>(undefined);
  const confirmTimer = useRef<number | undefined>(undefined);
  const creatingRef = useRef(false);
  const pendingFocusRef = useRef(false);
  const writingBaseRef = useRef(0);
  const burstAccumRef = useRef(0);
  const burstStartRef = useRef<number | null>(null);
  const burstIdleTimer = useRef<number | undefined>(undefined);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const previewBodyRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const buildDraftRef = useRef<() => Entry | null>(() => null);
  const flushRef = useRef<() => void>(() => undefined);

  const endBurst = useCallback(() => {
    if (burstStartRef.current !== null) {
      burstAccumRef.current += Date.now() - burstStartRef.current;
      burstStartRef.current = null;
    }
    if (burstIdleTimer.current !== undefined) {
      window.clearTimeout(burstIdleTimer.current);
      burstIdleTimer.current = undefined;
    }
  }, []);

  const noteTyping = useCallback(() => {
    if (burstStartRef.current === null) burstStartRef.current = Date.now();
    if (burstIdleTimer.current !== undefined) window.clearTimeout(burstIdleTimer.current);
    burstIdleTimer.current = window.setTimeout(endBurst, BURST_IDLE_MS);
  }, [endBurst]);

  const applyEntry = useCallback((loaded: Entry) => {
    setEntry(loaded);
    setTitle(loaded.title);
    setBody(loaded.body);
    setTags([...loaded.tags]);
    setMarkers([...loaded.markers]);
    setAttachments([...loaded.attachments]);
    writingBaseRef.current = loaded.writingTimeMs;
    burstAccumRef.current = 0;
    burstStartRef.current = null;
    dirtyRef.current = false;
    setStatus("clean");
    setSavedAt(null);
    setSaveError(null);
    setPreview(false);
    setConfirmDelete(false);
    setConfirmRemoveId(null);
    setTagDraft("");
    setMarkerDraft("");
  }, []);

  useEffect(() => {
    flushRef.current();
    if (saveTimer.current !== undefined) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = undefined;
    }
    let cancelled = false;
    if (activeEntryId === null) {
      setEntry(null);
      setTitle("");
      setBody("");
      setTags([]);
      setMarkers([]);
      setAttachments([]);
      writingBaseRef.current = 0;
      burstAccumRef.current = 0;
      burstStartRef.current = null;
      dirtyRef.current = false;
      setStatus("clean");
      setSavedAt(null);
      setSaveError(null);
      setPreview(false);
      return () => {
        cancelled = true;
      };
    }
    void (async () => {
      try {
        const loaded = await store.getEntryOrNull(activeEntryId);
        if (cancelled) return;
        if (!loaded) {
          openEntry(null);
          return;
        }
        applyEntry(loaded);
        if (pendingFocusRef.current) {
          pendingFocusRef.current = false;
          textareaRef.current?.focus();
        }
      } catch (err) {
        if (cancelled) return;
        setStatus("error");
        setSaveError(messageOf(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeEntryId, store, openEntry, applyEntry]);

  const ensureTodayEntry = useCallback(async () => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    try {
      const existing = entries.find((e) => e.dateKey === todayKey);
      if (existing) {
        openEntry(existing.id);
        return;
      }
      const created = await store.createEntry({ dateKey: todayKey });
      await reloadEntries();
      openEntry(created.id);
    } finally {
      creatingRef.current = false;
    }
  }, [entries, todayKey, store, reloadEntries, openEntry]);

  useEffect(() => {
    if (activeEntryId !== null || entries.length === 0) return;
    void ensureTodayEntry();
  }, [activeEntryId, entries.length, ensureTodayEntry]);

  const buildDraft = useCallback((): Entry | null => {
    const base = entry;
    if (!base) return null;
    const burstMs =
      burstAccumRef.current +
      (burstStartRef.current !== null ? Date.now() - burstStartRef.current : 0);
    return {
      ...base,
      title,
      body,
      tags,
      markers,
      attachments,
      writingTimeMs: writingBaseRef.current + burstMs,
    };
  }, [entry, title, body, tags, markers, attachments]);

  useEffect(() => {
    buildDraftRef.current = buildDraft;
  }, [buildDraft]);

  const flush = useCallback(async () => {
    if (saveTimer.current !== undefined) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = undefined;
    }
    if (!dirtyRef.current) return;
    const draft = buildDraftRef.current();
    if (!draft) {
      dirtyRef.current = false;
      return;
    }
    setStatus("saving");
    try {
      await store.putEntry(draft);
      dirtyRef.current = false;
      setStatus("saved");
      const at = new Date();
      setSavedAt(at);
      setSaveError(null);
      announce(`Saved ${formatSavedAt(at)}`);
    } catch (err) {
      setStatus("error");
      setSaveError(messageOf(err));
    }
  }, [store, announce]);

  useEffect(() => {
    flushRef.current = () => {
      void flush();
    };
  }, [flush]);

  const scheduleSave = useCallback(() => {
    dirtyRef.current = true;
    if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = undefined;
      void flush();
    }, AUTOSAVE_MS);
  }, [flush]);

  useEffect(
    () => () => {
      flushRef.current();
    },
    [],
  );

  useEffect(() => {
    const onForceSave = () => flushRef.current();
    const onTogglePreview = () => setPreview((p) => !p);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushRef.current();
    };
    const onBeforeUnload = () => flushRef.current();
    window.addEventListener("quill:force-save", onForceSave as EventListener);
    window.addEventListener("quill:toggle-preview", onTogglePreview as EventListener);
    window.addEventListener("quill:pre-lock", onForceSave as EventListener);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("quill:force-save", onForceSave as EventListener);
      window.removeEventListener("quill:toggle-preview", onTogglePreview as EventListener);
      window.removeEventListener("quill:pre-lock", onForceSave as EventListener);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, []);

  const html = useMemo(() => {
    if (!preview) return "";
    const raw = marked.parse(body, { async: false });
    return DOMPurify.sanitize(raw);
  }, [preview, body]);

  useLayoutEffect(() => {
    if (!preview) return;
    const node = previewBodyRef.current;
    if (!node) return;
    node.innerHTML = html;
    for (const a of Array.from(node.querySelectorAll("a"))) {
      a.setAttribute("rel", "noreferrer noopener");
      a.setAttribute("target", "_blank");
    }
  }, [html, preview]);

  const goToDay = useCallback(
    async (key: string) => {
      const existing = entries.find((e) => e.dateKey === key);
      if (existing) {
        openEntry(existing.id);
        return;
      }
      try {
        const created = await store.createEntry({ dateKey: key });
        await reloadEntries();
        openEntry(created.id);
      } catch (err) {
        setStatus("error");
        setSaveError(messageOf(err));
      }
    },
    [entries, store, reloadEntries, openEntry],
  );

  const deleteCurrentEntry = useCallback(async () => {
    const current = entry;
    if (!current) return;
    dirtyRef.current = false;
    if (saveTimer.current !== undefined) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = undefined;
    }
    try {
      await store.deleteEntry(current.id);
      announce("Entry deleted");
      await reloadEntries();
      openEntry(null);
    } catch (err) {
      setStatus("error");
      setSaveError(messageOf(err));
    }
  }, [entry, store, announce, reloadEntries, openEntry]);

  const armConfirmDelete = useCallback(() => {
    setConfirmDelete(true);
    setConfirmRemoveId(null);
    if (confirmTimer.current !== undefined) window.clearTimeout(confirmTimer.current);
    confirmTimer.current = window.setTimeout(() => {
      setConfirmDelete(false);
      confirmTimer.current = undefined;
    }, CONFIRM_MS);
  }, []);

  const removeAttachment = useCallback(
    async (attachmentId: string) => {
      const current = entry;
      if (!current) return;
      try {
        await store.removeAttachment(current.id, attachmentId);
        setAttachments((prev) => prev.filter((a) => a.id !== attachmentId));
        setConfirmRemoveId(null);
        setStatus("saved");
        setSavedAt(new Date());
        await reloadEntries();
      } catch (err) {
        setStatus("error");
        setSaveError(messageOf(err));
      }
    },
    [entry, store, reloadEntries],
  );

  const beginConfirmRemove = useCallback((attachmentId: string) => {
    setConfirmRemoveId(attachmentId);
    setConfirmDelete(false);
    if (confirmTimer.current !== undefined) window.clearTimeout(confirmTimer.current);
    confirmTimer.current = window.setTimeout(() => {
      setConfirmRemoveId(null);
      confirmTimer.current = undefined;
    }, CONFIRM_MS);
  }, []);

  const onFilesChosen = useCallback(
    async (fileList: FileList | null) => {
      const current = entry;
      if (!current || !fileList || fileList.length === 0) return;
      setBusyFiles(true);
      try {
        for (const file of Array.from(fileList)) {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const att = await store.addAttachment(
            current.id,
            file.name,
            file.type.length > 0 ? file.type : "application/octet-stream",
            bytes,
          );
          setAttachments((prev) => [...prev, att]);
        }
        setStatus("saved");
        setSavedAt(new Date());
        setSaveError(null);
        await reloadEntries();
      } catch (err) {
        setStatus("error");
        setSaveError(messageOf(err));
      } finally {
        setBusyFiles(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [entry, store, reloadEntries],
  );

  const addTag = useCallback(() => {
    const value = tagDraft.trim();
    if (value.length === 0) return;
    if (!tags.includes(value)) setTags((prev) => [...prev, value]);
    setTagDraft("");
    scheduleSave();
  }, [tagDraft, tags, scheduleSave]);

  const addMarker = useCallback(() => {
    const value = markerDraft.trim();
    if (value.length === 0) return;
    if (!markers.includes(value)) setMarkers((prev) => [...prev, value]);
    setMarkerDraft("");
    scheduleSave();
  }, [markerDraft, markers, scheduleSave]);

  const dateKey = entry ? entry.dateKey : todayKey;
  const dateLabel = formatDateKeyLong(dateKey, "en");
  const wordCount = useMemo(() => countWords(body), [body]);
  const writingMs =
    writingBaseRef.current +
    burstAccumRef.current +
    (burstStartRef.current !== null ? Date.now() - burstStartRef.current : 0);
  const promptLine = settings.promptsEnabled ? pickPromptForDate(BUNDLED_PROMPTS, todayKey) : "";
  const firstRunEmpty = !entry && entries.length === 0 && activeEntryId === null;
  const indicator =
    status === "saving"
      ? "Saving…"
      : status === "saved" && savedAt
        ? `Saved ${formatSavedAt(savedAt)}`
        : "";

  if (firstRunEmpty) {
    return (
      <article className="editor-pane">
        <div className="empty-state">
          <p className="empty-date">{dateLabel}</p>
          {promptLine.length > 0 ? <p className="empty-prompt">{promptLine}</p> : null}
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              pendingFocusRef.current = true;
              void ensureTodayEntry();
            }}
          >
            Write today’s entry
          </button>
        </div>
      </article>
    );
  }

  if (!entry) {
    return (
      <article className="editor-pane" aria-busy="true">
        <div className="skeleton-line" />
        <div className="skeleton-line" />
        <div className="skeleton-line" />
      </article>
    );
  }

  return (
    <article className="editor-pane">
      <EditorHeader
        dateLabel={dateLabel}
        title={title}
        preview={preview}
        confirmDelete={confirmDelete}
        onPrevDay={() => void goToDay(shiftDateKey(dateKey, -1))}
        onNextDay={() => void goToDay(shiftDateKey(dateKey, 1))}
        onTitleChange={(v) => {
          setTitle(v);
          noteTyping();
          scheduleSave();
        }}
        onTitleBlur={() => flushRef.current()}
        onTogglePreview={() => setPreview((p) => !p)}
        onRequestDelete={armConfirmDelete}
        onConfirmDelete={() => void deleteCurrentEntry()}
      />

      <section className="tag-editor" aria-label="Tags and markers">
        <div className="chip-row">
          {tags.map((tag) => (
            <span key={`tag-${tag}`} className="chip">
              {tag}
              <button
                type="button"
                className="chip-remove"
                aria-label={`Remove tag ${tag}`}
                onClick={() => {
                  setTags((prev) => prev.filter((t) => t !== tag));
                  scheduleSave();
                }}
              >
                ×
              </button>
            </span>
          ))}
          {tags.length === 0 ? <span className="row-date">No tags</span> : null}
          <form
            className="tag-adder"
            onSubmit={(e) => {
              e.preventDefault();
              addTag();
            }}
          >
            <input
              type="text"
              value={tagDraft}
              placeholder="Add tag"
              aria-label="New tag"
              onChange={(e) => setTagDraft(e.target.value)}
            />
            <button type="submit" className="btn btn-outline">
              Add
            </button>
          </form>
        </div>
        <div className="chip-row">
          {markers.map((marker) => (
            <span key={`marker-${marker}`} className="chip chip-marker">
              {marker}
              <button
                type="button"
                className="chip-remove"
                aria-label={`Remove marker ${marker}`}
                onClick={() => {
                  setMarkers((prev) => prev.filter((m) => m !== marker));
                  scheduleSave();
                }}
              >
                ×
              </button>
            </span>
          ))}
          {markers.length === 0 ? <span className="row-date">No markers</span> : null}
          <form
            className="tag-adder"
            onSubmit={(e) => {
              e.preventDefault();
              addMarker();
            }}
          >
            <input
              type="text"
              value={markerDraft}
              placeholder="Add marker"
              aria-label="New marker"
              onChange={(e) => setMarkerDraft(e.target.value)}
            />
            <button type="submit" className="btn btn-outline">
              Add
            </button>
          </form>
        </div>
      </section>

      <section className="attachments" aria-label="Attachments">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => void onFilesChosen(e.target.files)}
        />
        <div className="chip-row">
          <button type="button" className="btn btn-outline" onClick={() => fileInputRef.current?.click()} disabled={busyFiles}>
            Add files
          </button>
          {attachments.map((att) =>
            confirmRemoveId === att.id ? (
              <button
                key={att.id}
                type="button"
                className="btn btn-danger"
                onClick={() => void removeAttachment(att.id)}
              >
                Confirm remove?
              </button>
            ) : (
              <span key={att.id} className="attachment-item">
                <span className="attachment-name">{att.fileName}</span>
                <span className="attachment-size">{formatBytes(att.byteSize)}</span>
                <button
                  type="button"
                  className="chip-remove"
                  aria-label={`Remove attachment ${att.fileName}`}
                  onClick={() => beginConfirmRemove(att.id)}
                >
                  ×
                </button>
              </span>
            ),
          )}
        </div>
      </section>

      {status === "error" && saveError ? (
        <div role="alert" className="save-banner">
          <span>{`Saving failed: ${saveError}`}</span>
          <button type="button" className="btn btn-outline" onClick={() => void flush()}>
            Retry
          </button>
        </div>
      ) : null}

      <div className="composition-scroll">
        {preview ? (
          <div className="composition-frame">
            <div className="preview" ref={previewBodyRef} />
          </div>
        ) : (
          <div className="composition-frame">
            <textarea
              ref={textareaRef}
              className="composition"
              dir="auto"
              spellCheck
              value={body}
              placeholder="Write…"
              aria-label="Entry body"
              onChange={(e) => {
                setBody(e.target.value);
                noteTyping();
                scheduleSave();
              }}
              onBlur={() => flushRef.current()}
            />
          </div>
        )}
      </div>

      <footer className="editor-footer">
        <div className="footer-counts">
          <span>{`${wordCount} words`}</span>
          <span>{formatDuration(writingMs)}</span>
        </div>
        <span className="save-indicator">{indicator}</span>
      </footer>
    </article>
  );
}

interface EditorHeaderProps {
  dateLabel: string;
  title: string;
  preview: boolean;
  confirmDelete: boolean;
  onPrevDay: () => void;
  onNextDay: () => void;
  onTitleChange: (value: string) => void;
  onTitleBlur: () => void;
  onTogglePreview: () => void;
  onRequestDelete: () => void;
  onConfirmDelete: () => void;
}

function EditorHeader(props: EditorHeaderProps) {
  return (
    <header className="editor-header">
      <button type="button" className="icon-button" aria-label="Previous day" onClick={props.onPrevDay}>
        ‹
      </button>
      <span className="header-date">{props.dateLabel}</span>
      <button type="button" className="icon-button" aria-label="Next day" onClick={props.onNextDay}>
        ›
      </button>
      <input
        className="title-input"
        type="text"
        value={props.title}
        placeholder="Title"
        aria-label="Entry title"
        onChange={(e) => props.onTitleChange(e.target.value)}
        onBlur={props.onTitleBlur}
      />
      <div className="editor-actions">
        <button
          type="button"
          className="btn btn-outline"
          aria-pressed={props.preview}
          onClick={props.onTogglePreview}
        >
          {props.preview ? "Write" : "Preview"}
        </button>
        {props.confirmDelete ? (
          <button type="button" className="btn btn-danger" onClick={props.onConfirmDelete}>
            Confirm delete?
          </button>
        ) : (
          <button type="button" className="btn btn-danger" onClick={props.onRequestDelete}>
            Delete
          </button>
        )}
      </div>
    </header>
  );
}
