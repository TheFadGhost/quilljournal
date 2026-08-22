import { formatDateKeyLong, isDateKey } from "../dates.js";
import type { Entry } from "../types.js";

const DEFAULT_JOURNAL_TITLE = "Quilljournal";
const PRINT_BUTTON_LABEL = "Print";

const STYLES = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html { background: #faf7f2; }
  body {
    margin: 0;
    padding: 48px 24px 96px;
    background: #faf7f2;
    color: #26221c;
    font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
    font-size: 19px;
    line-height: 1.65;
  }
  main { max-width: 66ch; margin: 0 auto; }
  .print-button {
    position: fixed;
    top: 16px;
    inset-inline-end: 16px;
    font-family: system-ui, sans-serif;
    font-size: 13px;
    padding: 8px 14px;
    border: 1px solid #26221c;
    border-radius: 4px;
    background: #faf7f2;
    color: #26221c;
    cursor: pointer;
  }
  .journal-title { font-size: 28px; line-height: 1.3; margin: 0 0 4px; }
  .range-line { color: #6b6257; font-size: 15px; font-style: italic; margin: 0 0 40px; }
  article { margin-block: 0 56px; }
  article header {
    border-bottom: 1px solid #d9d2c7;
    padding-bottom: 8px;
    margin-bottom: 16px;
  }
  .entry-date {
    font-family: system-ui, sans-serif;
    font-size: 12px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: #6b6257;
    margin: 0 0 4px;
  }
  .entry-title { font-size: 22px; line-height: 1.35; margin: 0; overflow-wrap: break-word; }
  .entry-body p {
    white-space: pre-wrap;
    overflow-wrap: break-word;
    margin-block: 0 0.9em;
  }
  article footer {
    font-family: system-ui, sans-serif;
    font-size: 12px;
    color: #6b6257;
    border-top: 1px solid #d9d2c7;
    padding-top: 8px;
    margin-top: 24px;
  }
  @media print {
    .print-button { display: none; }
    body { padding: 0; background: #ffffff; }
    main { max-width: none; }
    article { break-inside: avoid-page; }
  }
`;

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function longDateOf(key: string): string {
  return isDateKey(key) ? formatDateKeyLong(key) : key;
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/u).length;
}

function bodyParagraphs(body: string): string[] {
  return body
    .split(/\r?\n[ \t]*\r?\n/)
    .filter((paragraph) => paragraph.trim().length > 0);
}

function rangeLineOf(range?: { from?: string; to?: string }): string | null {
  if (!range) return null;
  const from = range.from ?? "";
  const to = range.to ?? "";
  if (from.length === 0 && to.length === 0) return null;
  const fmt = (key: string) => escapeHtml(longDateOf(key));
  let text: string;
  if (from.length > 0 && to.length > 0) text = `${fmt(from)} – ${fmt(to)}`;
  else if (from.length > 0) text = `from ${fmt(from)}`;
  else text = `until ${fmt(to)}`;
  return `<p class="range-line">${text}</p>`;
}

function footerLineOf(entry: Entry): string {
  const parts: string[] = [];
  if (entry.tags.length > 0) {
    parts.push(`tags: ${entry.tags.map((tag) => escapeHtml(tag)).join(", ")}`);
  }
  if (entry.markers.length > 0) {
    parts.push(`markers: ${entry.markers.map((marker) => escapeHtml(marker)).join(", ")}`);
  }
  parts.push(`${wordCount(entry.body)} words`);
  if (entry.audio !== null) parts.push("audio attached");
  return `<footer>${parts.join(" · ")}</footer>`;
}

function renderEntry(entry: Entry): string {
  const heading = entry.title.length > 0 ? entry.title : entry.dateKey;
  const paragraphs = bodyParagraphs(entry.body)
    .map((paragraph) => `<p dir="auto">${escapeHtml(paragraph)}</p>`)
    .join("");
  const lines = [
    "<article>",
    "<header>",
    `<p class="entry-date">${escapeHtml(longDateOf(entry.dateKey))}</p>`,
    `<h2 class="entry-title" dir="auto">${escapeHtml(heading)}</h2>`,
    "</header>",
    `<div class="entry-body" dir="auto">${paragraphs}</div>`,
    footerLineOf(entry),
    "</article>",
  ];
  return lines.join("\n");
}

export interface PrintableOptions {
  journalTitle?: string;
  dateRange?: { from?: string; to?: string };
}

export function buildPrintableHtml(entries: Entry[], options?: PrintableOptions): string {
  const journalTitle = options?.journalTitle ?? DEFAULT_JOURNAL_TITLE;
  const escapedTitle = escapeHtml(journalTitle);
  const rangeLine = rangeLineOf(options?.dateRange);
  const articles = entries.map(renderEntry).join("\n");
  const lines = [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapedTitle} — print</title>`,
    `<style>${STYLES}</style>`,
    "</head>",
    "<body>",
    `<button type="button" class="print-button" onclick="window.print()">${escapeHtml(PRINT_BUTTON_LABEL)}</button>`,
    "<main>",
    `<h1 class="journal-title">${escapedTitle}</h1>`,
  ];
  if (rangeLine !== null) lines.push(rangeLine);
  lines.push(articles, "</main>", "</body>", "</html>");
  return lines.join("\n");
}
