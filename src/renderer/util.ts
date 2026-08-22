const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const WORD_TOKEN = /[\p{L}\p{N}]/u;
const TRAILING_NOISE = /[\s,.;:!?•·—–-]+$/u;

export function excerptText(text: string, max = 160): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (max <= 0) return "";
  const chars = Array.from(normalized);
  if (chars.length <= max) return normalized;
  let head = chars.slice(0, max).join("");
  const lastSpace = head.lastIndexOf(" ");
  if (lastSpace > 0) head = head.slice(0, lastSpace);
  return head.replace(TRAILING_NOISE, "") + "…";
}

export function countWords(text: string): number {
  if (!text) return 0;
  const cjkCount = text.match(CJK_CHAR)?.length ?? 0;
  const stripped = text.replace(CJK_CHAR, " ");
  const words = stripped
    .split(/\s+/u)
    .filter((token) => WORD_TOKEN.test(token)).length;
  return cjkCount + words;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const unit = units[unitIndex] ?? "KB";
  return `${value.toFixed(1)} ${unit}`;
}

export function plainTextFromMarkdown(md: string): string {
  let text = md;
  text = text.replace(/```[\s\S]*?```/gu, " ");
  text = text.replace(/`([^`]*)`/gu, "$1");
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1");
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1");
  text = text.replace(/^\s{0,3}>+\s?/gmu, "");
  text = text.replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gmu, " ");
  text = text.replace(/^\s{0,3}#{1,6}\s+/gmu, "");
  text = text.replace(/^\s{0,3}[-*+]\s+/gmu, "");
  text = text.replace(/^\s{0,3}\d+[.)]\s+/gmu, "");
  text = text.replace(/(\*{1,3}|_{1,3})([^*_]*)\1/gu, "$2");
  text = text.replace(/\s+/gu, " ");
  return text.trim();
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

export function formatSavedAt(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000);
  if (totalMinutes < 1) return "<1 min";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}
