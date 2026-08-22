export interface TimedWord {
  startMs: number;
  endMs: number;
}

export function currentWordIndex(words: readonly TimedWord[], tMs: number): number {
  validateTimings(words);
  if (words.length === 0) return -1;
  if (!Number.isFinite(tMs)) return -1;
  const first = words[0] as TimedWord;
  if (tMs < first.startMs) return -1;
  let lo = 0;
  let hi = words.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const candidate = words[mid] as TimedWord;
    if (tMs < candidate.startMs) {
      hi = mid - 1;
    } else if (tMs >= candidate.endMs) {
      best = mid;
      lo = mid + 1;
    } else {
      return mid;
    }
  }
  return best;
}

function validateTimings(words: readonly TimedWord[]): void {
  for (let i = 0; i < words.length; i++) {
    const word = words[i] as TimedWord;
    if (
      !Number.isFinite(word.startMs) ||
      !Number.isFinite(word.endMs) ||
      word.endMs < word.startMs
    ) {
      throw new RangeError(`word timing at index ${i} is invalid`);
    }
    if (i > 0) {
      const prev = words[i - 1] as TimedWord;
      if (word.startMs < prev.startMs) {
        throw new RangeError(`word timings are not sorted at index ${i}`);
      }
    }
  }
}

export function wordAtFraction(words: readonly TimedWord[], fraction: number): number {
  if (words.length === 0) return -1;
  const first = words[0] as TimedWord;
  const last = words[words.length - 1] as TimedWord;
  const span = last.endMs - first.startMs;
  const clamped = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  const tMs = span <= 0 ? first.startMs : first.startMs + clamped * span;
  return currentWordIndex(words, tMs);
}

export function formatClock(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const totalSeconds = Math.floor(safe / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  if (hours > 0) return `${String(hours).padStart(2, "0")}:${mm}:${ss}`;
  return `${mm}:${ss}`;
}

export function estimateElapsedFromChunks(chunkCount: number, timesliceMs = 1000): number {
  const count = Number.isFinite(chunkCount) ? Math.max(0, Math.trunc(chunkCount)) : 0;
  const slice = Number.isFinite(timesliceMs) && timesliceMs > 0 ? timesliceMs : 0;
  return count * slice;
}
