import { TranscriptionError } from "../../core/errors.js";

export type RecorderState =
  | "idle"
  | "arming"
  | "recording"
  | "paused"
  | "processing"
  | "error";

export interface AudioTrackLike {
  stop(): void;
}

export interface AudioStreamLike {
  getTracks(): AudioTrackLike[];
  addEventListener?(type: "ended", listener: () => void): void;
  removeEventListener?(type: "ended", listener: () => void): void;
}

export interface RecorderDataEventLike {
  data: unknown;
}

export interface RecorderErrorEventLike {
  error?: unknown;
}

export interface MediaRecorderLike {
  start(timesliceMs?: number): void;
  stop(): void;
  pause(): void;
  resume(): void;
  readonly state: "inactive" | "recording" | "paused";
  ondataavailable: ((event: RecorderDataEventLike) => void) | null;
  onerror: ((event: RecorderErrorEventLike) => void) | null;
}

export interface MediaRecorderCtorLike {
  new (stream: unknown, options?: { mimeType?: string }): MediaRecorderLike;
}

export interface LevelMeter {
  getRms(): number;
}

export interface RecorderDeps {
  getUserMedia(constraints: {
    audio: boolean | { deviceId: { exact: string } };
  }): Promise<AudioStreamLike>;
  MediaRecorderCtor: MediaRecorderCtorLike;
  now(): number;
  meter?: LevelMeter;
  recorderOptions?: { mimeType?: string };
  toBytes?(data: unknown): Uint8Array | Promise<Uint8Array>;
}

export interface RecorderCallbacks {
  onChunk(chunk: Uint8Array): void;
  onStateChange(state: RecorderState): void;
  onError(error: TranscriptionError): void;
  onLevel(rms: number): void;
  onElapsed(ms: number): void;
}

export const TIMESLICE_MS = 1000;
export const METER_INTERVAL_MS = 100;
export const STOP_FLUSH_TIMEOUT_MS = 2000;

type IntervalHandle = ReturnType<typeof setInterval>;
type TimeoutHandle = ReturnType<typeof setTimeout>;

function isUint8Array(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

export function defaultToBytes(data: unknown): Uint8Array | Promise<Uint8Array> {
  if (isUint8Array(data)) return data;
  const maybe = data as { arrayBuffer?: () => Promise<ArrayBuffer> } | null;
  if (maybe !== null && typeof maybe === "object" && typeof maybe.arrayBuffer === "function") {
    return maybe.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }
  return new Uint8Array(0);
}

function errorName(err: unknown): string {
  if (err instanceof Error) return err.name;
  if (typeof err === "object" && err !== null && "name" in err) {
    const name = (err as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  return "";
}

function describeArmFailure(err: unknown): TranscriptionError {
  const name = errorName(err);
  if (
    name === "NotFoundError" ||
    name === "DevicesNotFoundError" ||
    name === "OverconstrainedError"
  ) {
    return new TranscriptionError(
      "no-audio-device",
      "No microphone found — connect a microphone and try again.",
      { cause: err },
    );
  }
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new TranscriptionError(
      "permission-denied",
      "Microphone access is denied — allow it for Quilljournal in system settings.",
      { cause: err },
    );
  }
  return new TranscriptionError("unknown", "Could not open the microphone.", { cause: err });
}

function describeStartFailure(err: unknown): TranscriptionError {
  const name = errorName(err);
  if (name === "NotSupportedError") {
    return new TranscriptionError(
      "unsupported-format",
      "This system cannot record with the selected audio format.",
      { cause: err },
    );
  }
  return new TranscriptionError("unknown", "Recording could not be started.", { cause: err });
}

export class RecorderController {
  private readonly deps: RecorderDeps;
  private readonly cb: RecorderCallbacks;
  private stateValue: RecorderState = "idle";
  private streamRef: AudioStreamLike | null = null;
  private recorderRef: MediaRecorderLike | null = null;
  private endedHandler: (() => void) | null = null;
  private meterTimer: IntervalHandle | null = null;
  private flushTimer: TimeoutHandle | null = null;
  private accumulatedMs = 0;
  private segmentStart = 0;
  private byteChain: Promise<void> = Promise.resolve();
  private finalize: (() => void) | null = null;

  constructor(deps: RecorderDeps, callbacks: RecorderCallbacks) {
    this.deps = deps;
    this.cb = callbacks;
  }

  getState(): RecorderState {
    return this.stateValue;
  }

  getElapsedMs(): number {
    return this.currentElapsed();
  }

  async arm(deviceId?: string): Promise<void> {
    if (this.stateValue === "arming") return;
    if (this.stateValue !== "idle" && this.stateValue !== "error") {
      this.cb.onError(
        new TranscriptionError(
          "invalid-config",
          "Cannot arm the microphone while a recording session is active.",
        ),
      );
      return;
    }
    this.releaseSession();
    this.accumulatedMs = 0;
    this.setState("arming");
    try {
      const stream = await this.deps.getUserMedia({
        audio: deviceId === undefined ? true : { deviceId: { exact: deviceId } },
      });
      this.streamRef = stream;
      const onEnded = (): void => this.deviceLost();
      this.endedHandler = onEnded;
      stream.addEventListener?.("ended", onEnded);
      this.setState("idle");
    } catch (err) {
      this.setState("idle");
      this.cb.onError(describeArmFailure(err));
    }
  }

  start(): void {
    if (this.stateValue === "recording") return;
    if (this.stateValue !== "idle" || this.streamRef === null) {
      this.cb.onError(
        new TranscriptionError(
          "invalid-config",
          "Cannot start recording before the microphone is armed.",
        ),
      );
      return;
    }
    let recorder: MediaRecorderLike;
    try {
      recorder = new this.deps.MediaRecorderCtor(this.streamRef, this.deps.recorderOptions);
    } catch (err) {
      this.releaseSession();
      this.setState("error");
      this.cb.onError(describeStartFailure(err));
      return;
    }
    this.recorderRef = recorder;
    recorder.ondataavailable = (event) => this.handleData(event.data);
    recorder.onerror = (event) => this.handleRecorderError(event.error);
    try {
      recorder.start(TIMESLICE_MS);
    } catch (err) {
      this.releaseSession();
      this.setState("error");
      this.cb.onError(describeStartFailure(err));
      return;
    }
    this.accumulatedMs = 0;
    this.segmentStart = this.deps.now();
    this.setState("recording");
    this.startMeter();
  }

  pause(): void {
    if (this.stateValue !== "recording") return;
    this.accumulatedMs = this.currentElapsed();
    try {
      this.recorderRef?.pause();
    } catch {
      return;
    }
    this.stopMeter();
    this.setState("paused");
  }

  resume(): void {
    if (this.stateValue !== "paused") return;
    try {
      this.recorderRef?.resume();
    } catch {
      return;
    }
    this.segmentStart = this.deps.now();
    this.startMeter();
    this.setState("recording");
  }

  stop(): void {
    if (this.stateValue !== "recording" && this.stateValue !== "paused") return;
    if (this.stateValue === "recording") this.accumulatedMs = this.currentElapsed();
    this.stopMeter();
    this.setState("processing");
    this.beginFlush(null);
  }

  markIdle(): void {
    if (this.stateValue !== "processing") return;
    this.accumulatedMs = 0;
    this.setState("idle");
  }

  deviceLost(): void {
    if (this.stateValue !== "recording" && this.stateValue !== "paused") return;
    const keptMs = this.currentElapsed();
    this.accumulatedMs = keptMs;
    this.stopMeter();
    this.setState("processing");
    this.beginFlush(this.deviceLostError(keptMs));
  }

  private deviceLostError(keptMs: number): TranscriptionError {
    const seconds = Math.max(0, Math.round(keptMs / 1000));
    return new TranscriptionError(
      "device-lost",
      `microphone disappeared; kept ${seconds} seconds of audio`,
    );
  }

  private setState(next: RecorderState): void {
    if (this.stateValue === next) return;
    this.stateValue = next;
    this.cb.onStateChange(next);
  }

  private currentElapsed(): number {
    if (this.stateValue === "recording") {
      return this.accumulatedMs + Math.max(0, this.deps.now() - this.segmentStart);
    }
    return this.accumulatedMs;
  }

  private startMeter(): void {
    if (this.meterTimer !== null) return;
    this.meterTimer = setInterval(() => {
      if (this.stateValue !== "recording") return;
      this.cb.onElapsed(this.currentElapsed());
      const meter = this.deps.meter;
      if (meter !== undefined) {
        try {
          this.cb.onLevel(meter.getRms());
        } catch {
          return;
        }
      }
    }, METER_INTERVAL_MS);
  }

  private stopMeter(): void {
    if (this.meterTimer !== null) {
      clearInterval(this.meterTimer);
      this.meterTimer = null;
    }
  }

  private beginFlush(failure: TranscriptionError | null): void {
    const recorder = this.recorderRef;
    const finish = (): void => {
      this.finalize = null;
      if (this.flushTimer !== null) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      this.releaseSession();
      if (failure !== null) {
        this.setState("error");
        this.cb.onError(failure);
      }
    };
    this.finalize = finish;
    if (recorder === null || recorder.state === "inactive") {
      finish();
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      finish();
    }, STOP_FLUSH_TIMEOUT_MS);
    try {
      recorder.stop();
    } catch {
      finish();
    }
  }

  private handleData(data: unknown): void {
    if (this.recorderRef === null) return;
    const convert = this.deps.toBytes ?? defaultToBytes;
    let converted: Uint8Array | Promise<Uint8Array>;
    try {
      converted = convert(data);
    } catch {
      return;
    }
    if (converted instanceof Promise) {
      this.byteChain = this.byteChain
        .then(() => converted)
        .then((bytes) => this.forwardChunk(bytes))
        .catch(() => undefined);
      return;
    }
    this.forwardChunk(converted);
  }

  private forwardChunk(bytes: Uint8Array): void {
    if (bytes.length > 0) this.cb.onChunk(bytes);
    const finish = this.finalize;
    if (finish !== null) {
      this.finalize = null;
      finish();
    }
  }

  private handleRecorderError(err: unknown): void {
    if (this.stateValue !== "recording" && this.stateValue !== "paused") return;
    const failure = TranscriptionError.is(err)
      ? err
      : new TranscriptionError("unknown", "The audio recorder reported an error.", { cause: err });
    const keptMs = this.currentElapsed();
    this.accumulatedMs = keptMs;
    this.stopMeter();
    this.setState("processing");
    this.beginFlush(failure);
  }

  private releaseSession(): void {
    this.stopMeter();
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const stream = this.streamRef;
    const recorder = this.recorderRef;
    const ended = this.endedHandler;
    this.streamRef = null;
    this.recorderRef = null;
    this.endedHandler = null;
    this.finalize = null;
    if (recorder !== null) {
      recorder.ondataavailable = null;
      recorder.onerror = null;
    }
    if (stream !== null) {
      if (ended !== null) stream.removeEventListener?.("ended", ended);
      this.stopTracksOf(stream);
    }
  }

  private stopTracksOf(stream: AudioStreamLike): void {
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        return;
      }
    }
  }
}
