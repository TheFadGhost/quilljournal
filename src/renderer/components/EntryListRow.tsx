import type { Entry } from "../../core/types.js";
import { countWords, excerptText, formatSavedAt, plainTextFromMarkdown } from "../util.js";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

function dayStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getDate()} ${MONTHS[d.getMonth()] ?? ""} ${d.getFullYear()}`;
}

export function formatRowDate(entry: Entry): string {
  const d = new Date(entry.createdAt);
  if (Number.isNaN(d.getTime())) return dayStamp(`${entry.dateKey}T00:00:00`);
  return `${dayStamp(entry.createdAt)} · ${formatSavedAt(d)}`;
}

interface EntryListRowProps {
  entry: Entry;
  active: boolean;
  onOpen: (id: string) => void;
}

export function EntryListRow({ entry, active, onOpen }: EntryListRowProps) {
  const dateLine = formatRowDate(entry);
  const title = entry.title.trim().length > 0 ? entry.title : dayStamp(`${entry.dateKey}T00:00:00`);
  const excerpt = excerptText(plainTextFromMarkdown(entry.body), 160);
  return (
    <button
      type="button"
      className="entry-row"
      aria-current={active ? "true" : undefined}
      onClick={() => onOpen(entry.id)}
    >
      <span className="row-date">{dateLine}</span>
      <span className="row-title">{title}</span>
      {excerpt.length > 0 ? <span className="row-excerpt">{excerpt}</span> : null}
      <span className="row-meta">
        {entry.tags.map((tag) => (
          <span key={`t-${tag}`} className="chip">
            {tag}
          </span>
        ))}
        {entry.markers.map((marker) => (
          <span key={`m-${marker}`} className="chip chip-marker">
            {marker}
          </span>
        ))}
        <span>{`${countWords(entry.body)} words`}</span>
        {entry.audio ? <span className="chip">audio</span> : null}
      </span>
    </button>
  );
}
