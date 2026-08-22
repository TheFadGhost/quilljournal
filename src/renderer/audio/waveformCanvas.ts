export interface WaveformDrawContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
  ): void;
  fill(): void;
}

export interface WaveformColors {
  live: string;
  idle: string;
  bg: string;
}

export interface WaveformOptions {
  width?: number;
  height?: number;
  mirror?: boolean;
  reducedMotion?: boolean;
}

export class AmplitudeRing {
  private items: Float64Array;
  private head = 0;
  private count = 0;

  constructor(capacity: number) {
    const cap = Number.isFinite(capacity) ? Math.max(0, Math.trunc(capacity)) : 0;
    this.items = new Float64Array(cap);
  }

  get length(): number {
    return this.count;
  }

  push(rms: number): void {
    const cap = this.items.length;
    if (cap === 0) return;
    const index = (this.head + this.count) % cap;
    this.items[index] = rms;
    if (this.count < cap) {
      this.count += 1;
    } else {
      this.head = (this.head + 1) % cap;
    }
  }

  toArray(): number[] {
    const out: number[] = [];
    const cap = this.items.length;
    for (let i = 0; i < this.count; i++) {
      out.push(this.items[(this.head + i) % cap] as number);
    }
    return out;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }
}

const BAR_WIDTH = 3;
const GAP = 2;
const PAD_Y = 2;
const DEFAULT_WIDTH = 120;
const DEFAULT_HEIGHT = 32;

export function drawWaveform(
  ctx: WaveformDrawContext,
  amplitudes: readonly number[],
  colors: WaveformColors,
  opts: WaveformOptions = {},
): void {
  const width = opts.width ?? DEFAULT_WIDTH;
  const height = opts.height ?? DEFAULT_HEIGHT;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, width, height);
  const pitch = BAR_WIDTH + GAP;
  const slots = Math.floor((width + GAP) / pitch);
  if (slots <= 0) return;
  const usable = Math.max(1, height - PAD_Y * 2);
  const mirror = opts.mirror !== false;
  const reducedMotion = opts.reducedMotion === true;
  const clamp01 = (v: number): number =>
    Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
  const drawBar = (x: number, amplitude: number, color: string): void => {
    const h = Math.max(1, clamp01(amplitude) * usable);
    const top = mirror ? (height - h) / 2 : height - PAD_Y - h;
    drawCapsule(ctx, x, top, BAR_WIDTH, h, color);
  };
  if (reducedMotion) {
    const latest = amplitudes.length > 0 ? (amplitudes[amplitudes.length - 1] as number) : 0;
    drawBar(width - BAR_WIDTH, latest, colors.live);
    return;
  }
  const color = amplitudes.length > 0 ? colors.live : colors.idle;
  for (let i = 0; i < slots; i++) {
    const amp =
      amplitudes.length > 0
        ? (amplitudes[
            Math.min(amplitudes.length - 1, Math.floor((i * amplitudes.length) / slots))
          ] as number)
        : 0;
    drawBar(i * pitch, amp, color);
  }
}

function drawCapsule(
  ctx: WaveformDrawContext,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
): void {
  const r = Math.min(w / 2, h / 2);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2);
  ctx.lineTo(x + w - r, y + h - r);
  ctx.arc(x + r, y + h - r, r, Math.PI / 2, (Math.PI * 3) / 2);
  ctx.fill();
}
