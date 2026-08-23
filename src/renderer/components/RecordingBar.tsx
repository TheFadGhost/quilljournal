import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TranscriptionError } from "../../core/errors.js";
import { newId } from "../../core/ids.js";
import {
  RecorderController,
  STOP_FLUSH_TIMEOUT_MS,
  type MediaRecorderCtorLike,
  type RecorderState,
} from "../audio/recorderController.js";
import { formatClock } from "../audio/alignment.js";
import { AmplitudeRing, drawWaveform } from "../audio/waveformCanvas.js";
import { transcribeForReview } from "../voice/pipeline.js";
import { audioAwareFileSystem } from "../ipc/rendererBridge.js";
import { ipc } from "../ipc/rendererBridge.js";
import { useJournal } from "../state/JournalProvider.js";
import type { ReviewRequest } from "./ReviewModal.js";

const AUDIO_MIME = "audio/webm";
const CANVAS_WIDTH = 220;
const CANVAS_HEIGHT = 36;
const RING_CAPACITY = 96;

type Phase = "idle" | "recording" | "paused" | "processing" | "error";

interface MicMeter {
  getRms(): number;
  close(): void;
}

function createMicMeter(stream: MediaStream): MicMeter | null {
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    const ctx = new Ctor();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const buffer = new Float32Array(analyser.fftSize);
    return {
      getRms() {
        analyser.getFloatTimeDomainData(buffer);
        let sum = 0;
        for (let i = 0; i < buffer.length; i++) {
          const v = buffer[i] ?? 0;
          sum += v * v;
        }
        return Math.sqrt(sum / buffer.length);
      },
      close() {
        source.disconnect();
        void ctx.close().catch(() => undefined);
      },
    };
  } catch {
    return null;
  }
}

function recordingErrorCopy(err: TranscriptionError, elapsedMs: number): string {
  switch (err.code) {
    case "no-audio-device":
      return "No microphone found — connect one and try again.";
    case "permission-denied":
      return "Microphone access was denied. Allow it in your system settings, then retry.";
    case "device-lost": {
      const seconds = Math.max(0, Math.round(elapsedMs / 1000));
      return `The microphone disappeared. ${seconds} seconds kept — audio was saved.`;
    }
    default:
      return err.message.length > 0
        ? `Recording problem: ${err.message}`
        : "Recording failed. Try again.";
  }
}

function transcriptionErrorCopy(err: unknown): string {
  const code = TranscriptionError.is(err) ? err.code : "unknown";
  const message = err instanceof Error ? err.message : String(err);
  switch (code) {
    case "unsupported-format":
      return "The provider cannot read this recording format.";
    case "provider-unavailable":
      return "The transcription provider is unavailable.";
    case "cancelled":
      return "Transcription cancelled.";
    case "audio-too-long":
      return "The recording is too long for this provider.";
    default:
      return message.length > 0 ? `Transcription failed: ${message} Audio was saved.` : "Transcription failed. Audio was saved.";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RecordingBarProps {
  onTranscribed(request: ReviewRequest): void;
}

export function RecordingBar({ onTranscribed }: RecordingBarProps) {
  const { store, settings, activeEntryId, announce } = useJournal();

  const [phase, setPhase] = useState<Phase>("idle");
  const [arming, setArming] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [progress, setProgress] = useState<number | null>(null);
  const [errorLine, setErrorLine] = useState<string | null>(null);

  const controllerRef = useRef<RecorderController | null>(null);
  const meterRef = useRef<MicMeter | null>(null);
  const writerIdRef = useRef<string | null>(null);
  const writerPathRef = useRef<string | null>(null);
  const writerChainRef = useRef<Promise<void>>(Promise.resolve());
  const chunkCountRef = useRef(0);
  const ringRef = useRef<AmplitudeRing>(new AmplitudeRing(RING_CAPACITY));
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const phaseRef = useRef<Phase>("idle");
  const elapsedRef = useRef(0);
  const armedOkRef = useRef(false);
  const stoppingRef = useRef(false);
  const indicatorVisibleRef = useRef(false);
  const indicatorMinuteRef = useRef(-1);
  const reducedMotionRef = useRef(false);
  const settingsRef = useRef(settings);
  const entryIdRef = useRef<string | null>(activeEntryId);

  phaseRef.current = phase;
  elapsedRef.current = elapsedMs;
  settingsRef.current = settings;
  entryIdRef.current = activeEntryId;

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotionRef.current = mq.matches;
    const onChange = (e: MediaQueryListEvent) => {
      reducedMotionRef.current = e.matches;
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const drawWave = useCallback((amplitudes: number[]) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const style = getComputedStyle(document.documentElement);
    const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
    drawWaveform(
      ctx,
      amplitudes,
      {
        live: read("--waveform-live", "#a2332b"),
        idle: read("--waveform-idle", "#857a6c"),
        bg: read("--bg-surface", "#fffdf9"),
      },
      { width: CANVAS_WIDTH, height: CANVAS_HEIGHT, reducedMotion: reducedMotionRef.current },
    );
  }, []);

  useEffect(() => {
    if (phase !== "recording") drawWave(ringRef.current.toArray());
  }, [phase, drawWave]);

  const enqueueChunk = useCallback(
    (chunk: Uint8Array) => {
      chunkCountRef.current += 1;
      writerChainRef.current = writerChainRef.current
        .then(async () => {
          if (writerIdRef.current === null) {
            if (writerPathRef.current === null) return;
            const res = await ipc.startRecordingWriter(writerPathRef.current);
            writerIdRef.current = res.writerId;
          }
          const sealed = await store.sealAudioChunk(chunk);
          await ipc.appendRecordingChunk(writerIdRef.current as string, sealed);
        })
        .catch(() => undefined);
    },
    [store],
  );

  const beginSessionRefs = useCallback(() => {
    writerIdRef.current = null;
    writerChainRef.current = Promise.resolve();
    chunkCountRef.current = 0;
    ringRef.current.clear();
    armedOkRef.current = false;
    stoppingRef.current = false;
    setElapsedMs(0);
    setProgress(null);
    setErrorLine(null);
  }, []);

  const closeMeter = useCallback(() => {
    meterRef.current?.close();
    meterRef.current = null;
  }, []);

  const drainWriter = useCallback(async () => {
    const deadline = Date.now() + STOP_FLUSH_TIMEOUT_MS + 500;
    let lastCount = -1;
    while (Date.now() < deadline) {
      await writerChainRef.current;
      const count = chunkCountRef.current;
      if (count === lastCount && count >= 0 && controllerRef.current?.getState() !== "recording") {
        return;
      }
      lastCount = count;
      await delay(100);
    }
    await writerChainRef.current;
  }, []);

  const finishWriter = useCallback(async () => {
    await writerChainRef.current;
    const writerId = writerIdRef.current;
    if (writerId !== null) {
      await ipc.finishRecordingWriter(writerId, true).catch(() => undefined);
      writerIdRef.current = null;
    }
  }, []);

  const teardownSession = useCallback(() => {
    closeMeter();
    controllerRef.current = null;
    stoppingRef.current = false;
    setPhase("idle");
    setProgress(null);
  }, [closeMeter]);

  const startController = useCallback(() => {
    if (controllerRef.current) return controllerRef.current;
    beginSessionRefs();
    const audioId = newId("audio");
    const entryId = entryIdRef.current ?? "unknown-entry";
    writerPathRef.current = `audio/${entryId}/${audioId}.webm`;
    const meterBridge = {
      getRms(): number {
        return meterRef.current?.getRms() ?? 0;
      },
    };
    const controller = new RecorderController(
      {
        getUserMedia: async (constraints) => {
          const stream = await navigator.mediaDevices.getUserMedia(
            constraints as MediaStreamConstraints,
          );
          meterRef.current = createMicMeter(stream);
          armedOkRef.current = true;
          return stream;
        },
        MediaRecorderCtor: window.MediaRecorder as unknown as MediaRecorderCtorLike,
        now: () => performance.now(),
        meter: meterBridge,
      },
      {
        onChunk: (chunk) => enqueueChunk(chunk),
        onStateChange: (state: RecorderState) => {
          switch (state) {
            case "arming":
              break;
            case "idle":
              if (phaseRef.current !== "processing") setPhase("idle");
              break;
            case "recording":
              setPhase("recording");
              announce("Recording");
              break;
            case "paused":
              setPhase("paused");
              announce("Recording paused");
              break;
            case "processing":
              setPhase("processing");
              announce("Processing");
              break;
            case "error":
              setPhase("error");
              break;
          }
        },
        onError: (err) => {
          setErrorLine(recordingErrorCopy(err, elapsedRef.current));
          announce("Transcription failed");
          setArming(false);
        },
        onLevel: (rms) => {
          ringRef.current.push(rms);
          drawWave(ringRef.current.toArray());
        },
        onElapsed: (ms) => setElapsedMs(ms),
      },
    );
    controllerRef.current = controller;
    return controller;
  }, [announce, beginSessionRefs, drawWave, enqueueChunk]);

  const stopAndTranscribe = useCallback(() => {
    const controller = controllerRef.current;
    if (!controller || stoppingRef.current) return;
    stoppingRef.current = true;
    setProgress(null);
    setErrorLine(null);
    controller.stop();
    void (async () => {
      await drainWriter();
      await finishWriter();
      const durationMs = controller.getElapsedMs();
      const audioPath = writerPathRef.current ?? "";
      try {
        await store.consolidateAudioFile(audioPath);
        const record = await transcribeForReview({
          fs: audioAwareFileSystem(store),
          audioPath,
          mimeType: AUDIO_MIME,
          durationMs,
          settings: settingsRef.current,
          onProgress: (fraction) => setProgress(fraction),
          cancelToken: { cancelled: false },
        });
        controller.markIdle();
        teardownSession();
        announce("Transcription complete");
        onTranscribed({
          entryId: entryIdRef.current ?? "unknown-entry",
          audioPath,
          mimeType: AUDIO_MIME,
          durationMs,
          record,
        });
      } catch (err) {
        controller.markIdle();
        teardownSession();
        setErrorLine(transcriptionErrorCopy(err));
        announce("Transcription failed");
      }
    })();
  }, [announce, drainWriter, finishWriter, onTranscribed, teardownSession]);

  const cancelSession = useCallback(() => {
    const controller = controllerRef.current;
    if (!controller || stoppingRef.current) return;
    stoppingRef.current = true;
    controller.stop();
    void (async () => {
      await drainWriter();
      await finishWriter();
      const audioPath = writerPathRef.current ?? "";
      await store.consolidateAudioFile(audioPath).catch(() => undefined);
      controller.markIdle();
      teardownSession();
      announce("Recording cancelled; audio kept");
    })();
  }, [announce, drainWriter, finishWriter, teardownSession]);

  const startClicked = useCallback(() => {
    setErrorLine(null);
    setArming(true);
    const controller = startController();
    void controller.arm().then(() => {
      if (armedOkRef.current && controllerRef.current === controller) {
        controller.start();
      }
      setArming(false);
    });
  }, [startController]);

  useEffect(() => {
    return () => {
      const controller = controllerRef.current;
      if (controller) {
        const state = controller.getState();
        if (state === "recording" || state === "paused") controller.stop();
      }
      void writerChainRef.current.then(() => {
        const writerId = writerIdRef.current;
        if (writerId !== null) void ipc.finishRecordingWriter(writerId, false).catch(() => undefined);
      });
      meterRef.current?.close();
      meterRef.current = null;
      document.body.classList.remove("recording-danger");
    };
  }, []);

  const showIndicator = useCallback((label: string) => {
    indicatorVisibleRef.current = true;
    document.body.classList.add("recording-danger");
    void ipc.setRecordingIndicator(true, label).catch(() => undefined);
  }, []);

  const hideIndicator = useCallback(() => {
    if (!indicatorVisibleRef.current) return;
    indicatorVisibleRef.current = false;
    indicatorMinuteRef.current = -1;
    document.body.classList.remove("recording-danger");
    void ipc.setRecordingIndicator(false, "").catch(() => undefined);
  }, []);

  const sessionLive = phase === "recording" || phase === "paused";

  useEffect(() => {
    if (!sessionLive) {
      hideIndicator();
      return;
    }
    const minute = Math.floor(elapsedMs / 60000);
    if (indicatorVisibleRef.current && minute === indicatorMinuteRef.current) return;
    indicatorMinuteRef.current = minute;
    if (indicatorVisibleRef.current) {
      showIndicator(`Recording · ${formatClock(elapsedMs)}`);
    }
  }, [sessionLive, elapsedMs, showIndicator, hideIndicator]);

  useEffect(() => {
    if (!sessionLive) return;
    const onBlur = () => showIndicator(`Recording · ${formatClock(elapsedRef.current)}`);
    const onFocus = () => hideIndicator();
    const onVisibility = () => {
      if (document.hidden) onBlur();
      else onFocus();
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      hideIndicator();
    };
  }, [sessionLive, showIndicator, hideIndicator]);

  const timerLabel = useMemo(() => formatClock(elapsedMs), [elapsedMs]);
  const progressPct =
    progress === null ? null : Math.round(Math.min(1, Math.max(0, progress)) * 100);

  return (
    <div className="recording-bar" role="region" aria-label="Recording">
      <div className="recording-bar-inner">
        <span
          className={
            phase === "recording"
              ? "rec-dot rec-dot-live"
              : phase === "paused"
                ? "rec-dot rec-dot-paused"
                : "rec-dot"
          }
          aria-hidden="true"
        />
        <span className={phase === "idle" ? "rec-timer rec-timer-dimmed" : "rec-timer"}>
          {timerLabel}
        </span>
        {reducedMotionRef.current && phase === "recording" ? (
          <span className="rec-badge">REC</span>
        ) : (
          <canvas
            ref={canvasRef}
            width={CANVAS_WIDTH}
            height={CANVAS_HEIGHT}
            className="wave-frame"
            aria-hidden="true"
          />
        )}
        {phase === "processing" ? (
          progressPct === null ? (
            <>
              <div className="rec-progress-track rec-progress-indeterminate" aria-hidden="true" />
              <span className="settings-note">Processing…</span>
            </>
          ) : (
            <>
              <div
                className="rec-progress-track"
                role="progressbar"
                aria-valuenow={progressPct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Transcription progress"
              >
                <div className="rec-progress-fill" style={{ inlineSize: `${progressPct}%` }} />
              </div>
              <span className="settings-note">{`${progressPct}%`}</span>
            </>
          )
        ) : null}
        {errorLine ? (
          <p className="rec-error" role="alert">
            {errorLine}
          </p>
        ) : null}
        <div className="rec-buttons">
          {phase === "idle" || phase === "error" ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={arming || activeEntryId === null}
              title="Start recording"
              aria-label="Start recording"
              onClick={startClicked}
            >
              Record
            </button>
          ) : null}
          {phase === "recording" ? (
            <button
              type="button"
              className="btn btn-outline"
              title="Pause recording"
              aria-label="Pause recording"
              onClick={() => controllerRef.current?.pause()}
            >
              Pause
            </button>
          ) : null}
          {phase === "paused" ? (
            <button
              type="button"
              className="btn btn-outline"
              title="Resume recording"
              aria-label="Resume recording"
              onClick={() => controllerRef.current?.resume()}
            >
              Resume
            </button>
          ) : null}
          {phase === "recording" || phase === "paused" ? (
            <>
              <button
                type="button"
                className="btn btn-primary"
                title="Stop and transcribe"
                aria-label="Stop and transcribe"
                onClick={stopAndTranscribe}
              >
                Stop &amp; transcribe
              </button>
              <button
                type="button"
                className="btn btn-danger"
                title="Cancel recording; the audio file is kept"
                aria-label="Cancel recording; audio kept"
                onClick={cancelSession}
              >
                Cancel
              </button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

