import { useEffect, useMemo, useRef, useState } from "react";
import type { TranscriptRecord } from "../../core/types.js";
import { currentWordIndex } from "../audio/alignment.js";
import { useJournalOptional } from "../state/JournalProvider.js";
import { RendererFileSystem } from "../ipc/rendererBridge.js";

export interface ReviewRequest {
  entryId: string;
  audioPath: string;
  mimeType: string;
  durationMs: number | null;
  record: TranscriptRecord;
}

export type CommitMode = "replace" | "append";

interface ReviewModalProps {
  request: ReviewRequest;
  discardDefault: boolean;
  onCommit(draft: string, mode: CommitMode, discardAudio: boolean): Promise<void>;
  onRetry(): Promise<TranscriptRecord>;
  onDiscard(): void;
  onClose(): void;
}

const RATES: readonly number[] = [0.75, 1, 1.25, 1.5];

export function ReviewModal({
  request,
  discardDefault,
  onCommit,
  onRetry,
  onDiscard,
  onClose,
}: ReviewModalProps) {
  const empty = request.record.text.trim().length === 0;
  const journal = useJournalOptional();
  const readAudioBytes = (path: string): Promise<Uint8Array> =>
    journal ? journal.store.readAudio(path) : new RendererFileSystem().readFile(path);
  const [draft, setDraft] = useState(request.record.text);
  const [mode, setMode] = useState<CommitMode>("replace");
  const [discardAudio, setDiscardAudio] = useState(discardDefault);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [playtimeMs, setPlaytimeMs] = useState(0);
  const [rate, setRate] = useState(1);
  const [busy, setBusy] = useState(false);
  const [retryError, setRetryError] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    let revoked: string | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const bytes = await readAudioBytes(request.audioPath);
        if (cancelled) return;
        const url = URL.createObjectURL(new Blob([bytes.slice()], { type: request.mimeType }));
        revoked = url;
        setAudioUrl(url);
      } catch {
        if (!cancelled) setAudioError("The audio file could not be opened.");
      }
    })();
    return () => {
      cancelled = true;
      if (revoked !== null) URL.revokeObjectURL(revoked);
    };
  }, [readAudioBytes, request.audioPath, request.mimeType]);

  const words = request.record.words ?? [];
  const currentWord = useMemo(() => {
    if (words.length === 0) return -1;
    try {
      return currentWordIndex(words, playtimeMs * 1000);
    } catch {
      return -1;
    }
  }, [words, playtimeMs]);

  const seekTo = (startMs: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = startMs / 1000;
  };

  const commit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onCommit(draft, mode, discardAudio);
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    if (busy) return;
    setBusy(true);
    setRetryError(false);
    try {
      const record = await onRetry();
      setDraft(record.text);
    } catch {
      setRetryError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="overlay-region"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Review transcription"
        className="modal-panel review-panel"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <h2 className="modal-title">Review transcription</h2>
        <div className="review-grid">
          <div className="review-player">
            {audioUrl ? (
              <audio
                ref={audioRef}
                controls
                src={audioUrl}
                onTimeUpdate={(e) => setPlaytimeMs(e.currentTarget.currentTime)}
              />
            ) : (
              <p className="settings-note">{audioError ?? "Loading audio…"}</p>
            )}
            <label className="settings-row">
              Speed
              <select
                value={rate}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  setRate(value);
                  if (audioRef.current) audioRef.current.playbackRate = value;
                }}
              >
                {RATES.map((r) => (
                  <option key={r} value={r}>
                    {r}×
                  </option>
                ))}
              </select>
            </label>
            {words.length > 0 && !empty ? (
              <div className="aligned-line" dir="auto" data-testid="aligned-line">
                {words.map((word, i) => (
                  <button
                    key={`${i}-${word.startMs}`}
                    type="button"
                    className={
                      i === currentWord ? "aligned-word aligned-word-current" : "aligned-word"
                    }
                    onClick={() => seekTo(word.startMs)}
                  >
                    {word.word}
                    {i < words.length - 1 ? " " : ""}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div>
            {empty ? (
              <div className="no-results" role="status">
                <p className="no-results-line">The provider returned nothing.</p>
                <p className="no-results-line settings-note">
                  No text was invented to fill the gap. Retry the transcription or keep the audio.
                </p>
                {retryError ? (
                  <p className="settings-status-fail" role="alert">
                    Transcription failed. The audio was kept — try again.
                  </p>
                ) : null}
                <div className="review-actions">
                  <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void retry()}>
                    Retry transcription
                  </button>
                  <button type="button" className="btn btn-danger" onClick={onDiscard}>
                    Discard transcript
                  </button>
                </div>
              </div>
            ) : (
              <>
                <textarea
                  className="review-textarea"
                  dir="auto"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  aria-label="Transcript text"
                />
                <fieldset className="review-commit">
                  <legend className="visually-hidden">Commit choice</legend>
                  <label className="radio-line">
                    <input
                      type="radio"
                      name="commit-mode"
                      checked={mode === "replace"}
                      onChange={() => setMode("replace")}
                    />
                    Set as entry body
                  </label>
                  <label className="radio-line">
                    <input
                      type="radio"
                      name="commit-mode"
                      checked={mode === "append"}
                      onChange={() => setMode("append")}
                    />
                    Append to entry body
                  </label>
                  <label className="checkbox-line">
                    <input
                      type="checkbox"
                      checked={discardAudio}
                      onChange={(e) => setDiscardAudio(e.target.checked)}
                    />
                    Discard audio after committing
                  </label>
                </fieldset>
                {retryError ? (
                  <p className="settings-status-fail" role="alert">
                    Transcription failed. The previous text is kept — try again.
                  </p>
                ) : null}
                <div className="review-actions">
                  <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void commit()}>
                    Commit
                  </button>
                  <button type="button" className="btn btn-outline" onClick={onDiscard}>
                    Discard transcript
                  </button>
                  <button type="button" className="btn btn-outline" disabled={busy} onClick={() => void retry()}>
                    Retry transcription
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
        <div className="review-actions">
          <button ref={closeRef} type="button" className="btn btn-outline" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
