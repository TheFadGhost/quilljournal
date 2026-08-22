import { describe, expect, it } from "vitest";
import {
  AmplitudeRing,
  drawWaveform,
  type WaveformDrawContext,
} from "../../src/renderer/audio/waveformCanvas.js";

const COLORS = { live: "#b3261e", idle: "#79747e", bg: "#faf7f2" };

interface Op {
  cmd: "M" | "L" | "A";
  x: number;
  y: number;
  r?: number;
}

interface RecordedFill {
  style: string;
  ops: Op[];
}

function makeCtx() {
  let style = "";
  const fillRects: Array<{ x: number; y: number; w: number; h: number; style: string }> = [];
  const fills: RecordedFill[] = [];
  let path: Op[] = [];
  const ctx: WaveformDrawContext = {
    get fillStyle() {
      return style;
    },
    set fillStyle(value) {
      style = value;
    },
    fillRect(x, y, w, h) {
      fillRects.push({ x, y, w, h, style });
    },
    beginPath() {
      path = [];
    },
    moveTo(x, y) {
      path.push({ cmd: "M", x, y });
    },
    lineTo(x, y) {
      path.push({ cmd: "L", x, y });
    },
    arc(x, y, radius) {
      path.push({ cmd: "A", x, y, r: radius });
    },
    fill() {
      fills.push({ style, ops: [...path] });
    },
  };
  return { ctx, fillRects, fills };
}

function bounds(fill: RecordedFill): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const op of fill.ops) {
    const rx = op.r ?? 0;
    minX = Math.min(minX, op.x - rx);
    minY = Math.min(minY, op.y - rx);
    maxX = Math.max(maxX, op.x + rx);
    maxY = Math.max(maxY, op.y + rx);
  }
  return { minX, minY, maxX, maxY };
}

describe("AmplitudeRing", () => {
  it("keeps insertion order below capacity", () => {
    const ring = new AmplitudeRing(4);
    ring.push(0.1);
    ring.push(0.5);
    expect(ring.toArray()).toEqual([0.1, 0.5]);
  });

  it("evicts the oldest sample once full", () => {
    const ring = new AmplitudeRing(3);
    for (const v of [1, 2, 3, 4, 5]) ring.push(v);
    expect(ring.toArray()).toEqual([3, 4, 5]);
  });

  it("returns an independent snapshot from toArray", () => {
    const ring = new AmplitudeRing(2);
    ring.push(0.2);
    const snapshot = ring.toArray();
    snapshot.push(9);
    expect(ring.toArray()).toEqual([0.2]);
  });

  it("clear resets to empty and accepts new pushes", () => {
    const ring = new AmplitudeRing(2);
    ring.push(0.1);
    ring.clear();
    expect(ring.toArray()).toEqual([]);
    ring.push(0.9);
    expect(ring.toArray()).toEqual([0.9]);
  });

  it("drops samples with zero capacity", () => {
    const ring = new AmplitudeRing(0);
    ring.push(0.4);
    expect(ring.toArray()).toEqual([]);
  });
});

describe("drawWaveform", () => {
  it("paints the background first in the bg color", () => {
    const { ctx, fillRects, fills } = makeCtx();
    drawWaveform(ctx, [0.5], COLORS, { width: 100, height: 30 });
    expect(fillRects).toHaveLength(1);
    expect(fillRects[0]).toMatchObject({ x: 0, y: 0, w: 100, h: 30, style: COLORS.bg });
    expect(fills.length).toBeGreaterThan(0);
  });

  it("draws exactly one bar in reduced-motion mode encoding the latest amplitude", () => {
    const { ctx, fillRects, fills } = makeCtx();
    drawWaveform(ctx, [0.9, 0.1, 0.5], COLORS, {
      width: 100,
      height: 30,
      reducedMotion: true,
    });
    expect(fills).toHaveLength(1);
    expect(fills[0]?.style).toBe(COLORS.live);
    const b = bounds(fills[0] as RecordedFill);
    expect(b.minX).toBeCloseTo(97, 5);
    expect(b.maxX).toBeCloseTo(100, 5);
    expect(b.maxY - b.minY).toBeCloseTo(0.5 * 26, 5);
    expect(fillRects).toHaveLength(1);
  });

  it("draws a bar count determined by width in normal mode", () => {
    const { ctx, fills } = makeCtx();
    drawWaveform(ctx, [0.25, 0.75, 0.5], COLORS, { width: 100, height: 30 });
    expect(fills).toHaveLength(20);
    for (const f of fills) expect(f.style).toBe(COLORS.live);
    expect(bounds(fills[0] as RecordedFill).minX).toBeCloseTo(0, 5);
    expect(bounds(fills[19] as RecordedFill).maxX).toBeCloseTo(98, 5);
  });

  it("distributes fewer amplitudes than slots across the whole width", () => {
    const { ctx, fills } = makeCtx();
    drawWaveform(ctx, [1, 0, 1, 0], COLORS, { width: 100, height: 30 });
    expect(fills).toHaveLength(20);
    const heights = fills.map(
      (f) => bounds(f as RecordedFill).maxY - bounds(f as RecordedFill).minY,
    );
    expect(heights[0]).toBeCloseTo(26, 5);
    expect(heights[7]).toBeCloseTo(1, 5);
    expect(heights[12]).toBeCloseTo(26, 5);
  });

  it("uses the idle color when there are no amplitudes yet", () => {
    const { ctx, fills } = makeCtx();
    drawWaveform(ctx, [], COLORS, { width: 100, height: 30 });
    expect(fills).toHaveLength(20);
    for (const f of fills) expect(f.style).toBe(COLORS.idle);
  });

  it("anchors bars to the bottom when mirror is false", () => {
    const { ctx, fills } = makeCtx();
    drawWaveform(ctx, [0.5], COLORS, { width: 50, height: 30, mirror: false });
    const b = bounds(fills[0] as RecordedFill);
    expect(b.maxY).toBeCloseTo(28, 5);
    expect(b.minY).toBeCloseTo(15, 5);
  });

  it("mirrors bars around the vertical center by default", () => {
    const { ctx, fills } = makeCtx();
    drawWaveform(ctx, [1], COLORS, { width: 50, height: 30 });
    const b = bounds(fills[0] as RecordedFill);
    expect((b.maxY + b.minY) / 2).toBeCloseTo(15, 5);
  });

  it("no-ops on zero or negative canvas sizes without throwing", () => {
    const a = makeCtx();
    expect(() =>
      drawWaveform(a.ctx, [0.5], COLORS, { width: 0, height: 30 }),
    ).not.toThrow();
    const b = makeCtx();
    expect(() =>
      drawWaveform(b.ctx, [0.5], COLORS, { width: 100, height: -4 }),
    ).not.toThrow();
    const c = makeCtx();
    expect(() => drawWaveform(c.ctx, [], COLORS, { width: 0, height: 0 })).not.toThrow();
    expect(a.fillRects).toHaveLength(0);
    expect(a.fills).toHaveLength(0);
    expect(b.fills).toHaveLength(0);
    expect(c.fills).toHaveLength(0);
  });
});
