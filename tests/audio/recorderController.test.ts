import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  METER_INTERVAL_MS,
  RecorderController,
  STOP_FLUSH_TIMEOUT_MS,
  TIMESLICE_MS,
  type MediaRecorderCtorLike,
  type MediaRecorderLike,
  type RecorderDataEventLike,
  type RecorderDeps,
  type RecorderErrorEventLike,
  type RecorderState,
} from "../../src/renderer/audio/recorderController.js";
import { TranscriptionError } from "../../src/core/errors.js";

class FakeTrack {
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
}

class FakeStream {
  private readonly track = new FakeTrack();
  readonly endedListeners: Array<() => void> = [];
  addEventListener(type: string, listener: () => void): void {
    if (type === "ended") this.endedListeners.push(listener);
  }
  removeEventListener(type: string, listener: () => void): void {
    if (type !== "ended") return;
    const i = this.endedListeners.indexOf(listener);
    if (i >= 0) this.endedListeners.splice(i, 1);
  }
  getTracks(): FakeTrack[] {
    return [this.track];
  }
  emitEnded(): void {
    for (const listener of [...this.endedListeners]) listener();
  }
}

class FakeRecorder implements MediaRecorderLike {
  static all: FakeRecorder[] = [];
  state: "inactive" | "recording" | "paused" = "inactive";
  ondataavailable: ((event: RecorderDataEventLike) => void) | null = null;
  onerror: ((event: RecorderErrorEventLike) => void) | null = null;
  readonly startCalls: number[] = [];
  stopCalls = 0;
  pauseCalls = 0;
  resumeCalls = 0;
  constructor(
    public readonly stream: FakeStream,
    public readonly options?: { mimeType?: string },
  ) {
    FakeRecorder.all.push(this);
  }
  start(timesliceMs?: number): void {
    this.startCalls.push(timesliceMs ?? -1);
    this.state = "recording";
  }
  stop(): void {
    this.stopCalls += 1;
    if (this.state === "inactive") return;
    this.state = "inactive";
    this.emitChunk(new Uint8Array([255]));
  }
  pause(): void {
    this.pauseCalls += 1;
    this.state = "paused";
    this.emitChunk(new Uint8Array([7]));
  }
  resume(): void {
    this.resumeCalls += 1;
    this.state = "recording";
  }
  emitChunk(bytes: Uint8Array): void {
    this.ondataavailable?.({ data: bytes });
  }
  emitError(err: unknown): void {
    this.onerror?.({ error: err });
  }
}

interface Harness {
  controller: RecorderController;
  clock: { now: number };
  chunks: Uint8Array[];
  states: RecorderState[];
  errors: TranscriptionError[];
  levels: number[];
  elapsedValues: number[];
  streams: FakeStream[];
  gumCalls: Array<{ audio: boolean | { deviceId: { exact: string } } }>;
}

function harness(overrides?: {
  getUserMedia?: RecorderDeps["getUserMedia"];
  meter?: { getRms(): number };
}): Harness {
  FakeRecorder.all = [];
  const clock = { now: 1000 };
  const h: Harness = {
    clock,
    chunks: [],
    states: [],
    errors: [],
    levels: [],
    elapsedValues: [],
    streams: [],
    gumCalls: [],
    controller: undefined as unknown as RecorderController,
  };
  const deps: RecorderDeps = {
    getUserMedia:
      overrides?.getUserMedia ??
      (async (constraints) => {
        h.gumCalls.push(constraints);
        const stream = new FakeStream();
        h.streams.push(stream);
        return stream;
      }),
    MediaRecorderCtor: FakeRecorder as unknown as MediaRecorderCtorLike,
    now: () => clock.now,
    meter: overrides?.meter,
  };
  h.controller = new RecorderController(deps, {
    onChunk: (chunk) => h.chunks.push(chunk),
    onStateChange: (state) => h.states.push(state),
    onError: (err) => h.errors.push(err),
    onLevel: (rms) => h.levels.push(rms),
    onElapsed: (ms) => h.elapsedValues.push(ms),
  });
  return h;
}

async function armed(h: Harness): Promise<FakeRecorder> {
  await h.controller.arm();
  h.controller.start();
  return FakeRecorder.all[0] as FakeRecorder;
}

function last<T>(values: T[]): T {
  return values[values.length - 1] as T;
}

function bytesOf(chunks: Uint8Array[]): number[][] {
  return chunks.map((c) => Array.from(c));
}

function failingGetUserMedia(name: string): RecorderDeps["getUserMedia"] {
  return async () => {
    throw Object.assign(new Error(name), { name });
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("arm and start", () => {
  it("arms the microphone and returns to idle", async () => {
    const h = harness();
    await h.controller.arm();
    expect(h.states).toEqual(["arming", "idle"]);
    expect(h.gumCalls).toEqual([{ audio: true }]);
    expect(h.controller.getState()).toBe("idle");
  });

  it("requests the exact device when a deviceId is given", async () => {
    const h = harness();
    await h.controller.arm("mic-42");
    expect(h.gumCalls).toEqual([{ audio: { deviceId: { exact: "mic-42" } } }]);
  });

  it("starts recording with a one-second timeslice bound to the armed stream", async () => {
    const h = harness();
    await h.controller.arm();
    const stream = h.streams[0] as FakeStream;
    h.controller.start();
    const recorder = FakeRecorder.all[0] as FakeRecorder;
    expect(recorder.stream).toBe(stream);
    expect(recorder.startCalls).toEqual([TIMESLICE_MS]);
    expect(h.states).toEqual(["arming", "idle", "recording"]);
  });

  it("start before arm is rejected without creating a recorder", () => {
    const h = harness();
    h.controller.start();
    expect(h.errors.map((e) => e.code)).toEqual(["invalid-config"]);
    expect(h.controller.getState()).toBe("idle");
    expect(FakeRecorder.all).toHaveLength(0);
  });

  it("double start is a safe no-op", async () => {
    const h = harness();
    await armed(h);
    h.controller.start();
    const recorder = FakeRecorder.all[0] as FakeRecorder;
    expect(recorder.startCalls).toHaveLength(1);
    expect(h.errors).toHaveLength(0);
    expect(h.controller.getState()).toBe("recording");
  });

  it("arm during an active session is rejected without disturbing it", async () => {
    const h = harness();
    await armed(h);
    await h.controller.arm();
    expect(h.errors.map((e) => e.code)).toEqual(["invalid-config"]);
    expect(h.controller.getState()).toBe("recording");
    expect(FakeRecorder.all).toHaveLength(1);
  });
});

describe("chunk flow", () => {
  it("delivers chunks synchronously in emission order including the container header", async () => {
    const h = harness();
    const recorder = await armed(h);
    recorder.emitChunk(new Uint8Array([26, 69]));
    expect(bytesOf(h.chunks)).toEqual([[26, 69]]);
    recorder.emitChunk(new Uint8Array([1]));
    recorder.emitChunk(new Uint8Array([2, 2]));
    expect(bytesOf(h.chunks)).toEqual([[26, 69], [1], [2, 2]]);
  });

  it("stop flushes the trailing chunk, releases tracks, and markIdle returns to idle", async () => {
    const h = harness();
    const recorder = await armed(h);
    recorder.emitChunk(new Uint8Array([1]));
    h.controller.stop();
    expect(h.controller.getState()).toBe("processing");
    expect(bytesOf(h.chunks)).toEqual([[1], [255]]);
    expect((h.streams[0] as FakeStream).getTracks()[0]?.stopped).toBe(true);
    expect(recorder.stopCalls).toBe(1);
    h.controller.markIdle();
    expect(h.controller.getState()).toBe("idle");
  });

  it("stop before start is a no-op", () => {
    const h = harness();
    h.controller.stop();
    expect(h.controller.getState()).toBe("idle");
    expect(h.errors).toHaveLength(0);
    expect(FakeRecorder.all).toHaveLength(0);
  });

  it("double stop during processing does not flush twice", async () => {
    const h = harness();
    const recorder = await armed(h);
    h.controller.stop();
    h.controller.stop();
    expect(recorder.stopCalls).toBe(1);
    expect(bytesOf(h.chunks)).toEqual([[255]]);
    expect(h.errors).toHaveLength(0);
  });

  it("releases tracks via the controllable timeout when no final chunk arrives", async () => {
    const h = harness();
    const recorder = await armed(h);
    recorder.stop = (): void => {
      recorder.stopCalls += 1;
      recorder.state = "inactive";
    };
    h.controller.stop();
    expect(h.controller.getState()).toBe("processing");
    expect((h.streams[0] as FakeStream).getTracks()[0]?.stopped).toBe(false);
    vi.advanceTimersByTime(STOP_FLUSH_TIMEOUT_MS);
    expect((h.streams[0] as FakeStream).getTracks()[0]?.stopped).toBe(true);
    h.controller.markIdle();
    expect(h.controller.getState()).toBe("idle");
  });
});

describe("arm failures", () => {
  it("maps NotAllowedError to permission-denied", async () => {
    const h = harness({ getUserMedia: failingGetUserMedia("NotAllowedError") });
    await h.controller.arm();
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0] instanceof TranscriptionError).toBe(true);
    expect(h.errors[0]?.code).toBe("permission-denied");
    expect(h.controller.getState()).toBe("idle");
    expect(h.states).toEqual(["arming", "idle"]);
  });

  it("maps SecurityError to permission-denied", async () => {
    const h = harness({ getUserMedia: failingGetUserMedia("SecurityError") });
    await h.controller.arm();
    expect(h.errors[0]?.code).toBe("permission-denied");
  });

  it("maps NotFoundError to no-audio-device with a helpful message", async () => {
    const h = harness({ getUserMedia: failingGetUserMedia("NotFoundError") });
    await h.controller.arm();
    expect(h.errors[0]?.code).toBe("no-audio-device");
    expect(h.errors[0]?.message.toLowerCase()).toContain("microphone");
  });

  it("maps DevicesNotFoundError to no-audio-device", async () => {
    const h = harness({ getUserMedia: failingGetUserMedia("DevicesNotFoundError") });
    await h.controller.arm();
    expect(h.errors[0]?.code).toBe("no-audio-device");
  });

  it("maps unexpected failures to unknown and stays re-armable", async () => {
    let calls = 0;
    const h = harness({
      getUserMedia: async (constraints) => {
        calls += 1;
        if (calls === 1) throw new Error("usb hiccup");
        h.gumCalls.push(constraints);
        const stream = new FakeStream();
        h.streams.push(stream);
        return stream;
      },
    });
    await h.controller.arm();
    expect(h.errors[0]?.code).toBe("unknown");
    expect(h.controller.getState()).toBe("idle");
    await h.controller.arm();
    expect(h.controller.getState()).toBe("idle");
    expect(h.streams).toHaveLength(1);
    h.controller.start();
    expect(h.controller.getState()).toBe("recording");
  });
});

describe("pause and resume", () => {
  it("accumulates elapsed only while recording", async () => {
    const h = harness();
    await armed(h);
    h.clock.now = 4000;
    vi.advanceTimersByTime(METER_INTERVAL_MS * 5);
    expect(last(h.elapsedValues)).toBe(3000);
    h.controller.pause();
    h.clock.now = 7000;
    vi.advanceTimersByTime(METER_INTERVAL_MS * 10);
    expect(last(h.elapsedValues)).toBe(3000);
    expect(h.controller.getState()).toBe("paused");
    h.controller.resume();
    h.clock.now = 8000;
    vi.advanceTimersByTime(METER_INTERVAL_MS * 10);
    expect(last(h.elapsedValues)).toBe(4000);
    expect(h.controller.getState()).toBe("recording");
  });

  it("does not drop the in-flight timeslice when pausing", async () => {
    const h = harness();
    const recorder = await armed(h);
    recorder.emitChunk(new Uint8Array([1]));
    h.controller.pause();
    expect(recorder.pauseCalls).toBe(1);
    expect(bytesOf(h.chunks)).toEqual([[1], [7]]);
    recorder.emitChunk(new Uint8Array([8]));
    expect(bytesOf(h.chunks)).toEqual([[1], [7], [8]]);
    h.controller.resume();
    recorder.emitChunk(new Uint8Array([9]));
    expect(bytesOf(h.chunks)).toEqual([[1], [7], [8], [9]]);
  });

  it("resume before any recording is ignored", () => {
    const h = harness();
    h.controller.resume();
    expect(h.states).toEqual([]);
    expect(FakeRecorder.all).toHaveLength(0);
  });

  it("pause outside recording is ignored", async () => {
    const h = harness();
    await h.controller.arm();
    h.controller.pause();
    expect(h.controller.getState()).toBe("idle");
    expect(FakeRecorder.all).toHaveLength(0);
  });
});

describe("metering", () => {
  it("emits levels on each tick while recording only", async () => {
    const h = harness({ meter: { getRms: () => 0.42 } });
    await armed(h);
    vi.advanceTimersByTime(METER_INTERVAL_MS * 3);
    expect(h.levels).toHaveLength(3);
    expect(h.levels.every((v) => v === 0.42)).toBe(true);
    h.controller.pause();
    const frozen = h.levels.length;
    vi.advanceTimersByTime(METER_INTERVAL_MS * 5);
    expect(h.levels).toHaveLength(frozen);
    h.controller.resume();
    vi.advanceTimersByTime(METER_INTERVAL_MS * 2);
    expect(h.levels.length).toBeGreaterThan(frozen);
    h.controller.stop();
    const afterStop = h.levels.length;
    vi.advanceTimersByTime(METER_INTERVAL_MS * 10);
    expect(h.levels).toHaveLength(afterStop);
  });
});

describe("device lost", () => {
  it("keeps flushed chunks, reports device-lost, ends in error, and can re-arm", async () => {
    const h = harness();
    const recorder = await armed(h);
    recorder.emitChunk(new Uint8Array([1]));
    recorder.emitChunk(new Uint8Array([2]));
    recorder.emitChunk(new Uint8Array([3]));
    h.clock.now = 6000;
    h.controller.deviceLost();
    expect(h.controller.getState()).toBe("error");
    expect(bytesOf(h.chunks)).toEqual([[1], [2], [3], [255]]);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]?.code).toBe("device-lost");
    expect(h.errors[0]?.message).toBe("microphone disappeared; kept 5 seconds of audio");
    expect((h.streams[0] as FakeStream).getTracks()[0]?.stopped).toBe(true);

    await h.controller.arm();
    h.controller.start();
    expect(h.states[h.states.length - 1]).toBe("recording");
    expect(h.streams).toHaveLength(2);
    expect(FakeRecorder.all).toHaveLength(2);
    (FakeRecorder.all[1] as FakeRecorder).emitChunk(new Uint8Array([4]));
    expect(bytesOf(h.chunks)).toEqual([[1], [2], [3], [255], [4]]);
  });

  it("fires automatically when the stream reports ended", async () => {
    const h = harness();
    const recorder = await armed(h);
    recorder.emitChunk(new Uint8Array([1]));
    h.streams[0]?.emitEnded();
    expect(h.errors.map((e) => e.code)).toEqual(["device-lost"]);
    expect(bytesOf(h.chunks)).toEqual([[1], [255]]);
    expect(h.controller.getState()).toBe("error");
  });

  it("is a no-op outside an active recording", async () => {
    const h = harness();
    await h.controller.arm();
    h.controller.deviceLost();
    expect(h.errors).toHaveLength(0);
    expect(h.controller.getState()).toBe("idle");
  });
});

describe("recorder errors", () => {
  it("flushes preserved audio and surfaces a mapped TranscriptionError", async () => {
    const h = harness();
    const recorder = await armed(h);
    recorder.emitChunk(new Uint8Array([1]));
    h.clock.now = 2500;
    recorder.emitError(new Error("encoder died"));
    expect(bytesOf(h.chunks)).toEqual([[1], [255]]);
    expect(h.controller.getState()).toBe("error");
    expect(h.errors[0]?.code).toBe("unknown");
    expect(h.errors[0] instanceof TranscriptionError).toBe(true);
    expect((h.streams[0] as FakeStream).getTracks()[0]?.stopped).toBe(true);
  });

  it("passes through TranscriptionError instances from the recorder", async () => {
    const h = harness();
    const recorder = await armed(h);
    recorder.emitError(new TranscriptionError("device-lost", "track ended"));
    expect(h.errors.map((e) => e.code)).toEqual(["device-lost"]);
    expect(h.controller.getState()).toBe("error");
  });
});

describe("session hygiene", () => {
  it("re-arming releases the previous stream's tracks", async () => {
    const h = harness();
    await h.controller.arm();
    const first = h.streams[0] as FakeStream;
    await h.controller.arm();
    expect(first.getTracks()[0]?.stopped).toBe(true);
    expect(h.streams).toHaveLength(2);
    expect(h.controller.getState()).toBe("idle");
  });
});
