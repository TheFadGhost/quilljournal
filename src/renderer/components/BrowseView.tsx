import { useMemo, useRef, useState } from "react";
import type { Entry } from "../../core/types.js";
import { monthGrid, monthLabel, onThisDay } from "../calendar.js";
import { EntryListRow } from "./EntryListRow.js";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

interface BrowseViewProps {
  entries: Entry[];
  todayKey: string;
  activeEntryId: string | null;
  onOpen(id: string): void;
}

export function BrowseView({ entries, todayKey, activeEntryId, onOpen }: BrowseViewProps) {
  const [cursor, setCursor] = useState(() => {
    const year = Number.parseInt(todayKey.slice(0, 4), 10);
    const month = Number.parseInt(todayKey.slice(5, 7), 10);
    return { year, month };
  });
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const cellRefs = useRef(new Map<string, HTMLButtonElement | null>());

  const weeks = useMemo(
    () => monthGrid(cursor.year, cursor.month, todayKey),
    [cursor.year, cursor.month, todayKey],
  );

  const flatCells = useMemo(() => weeks.flat(), [weeks]);

  const shiftCursor = (delta: number) => {
    setSelectedDay(null);
    setCursor((prev) => {
      const d = new Date(Date.UTC(prev.year, prev.month - 1 + delta, 15));
      return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
    });
  };

  const focusCell = (dateKey: string) => {
    cellRefs.current.get(dateKey)?.focus();
  };

  const onCellKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, dateKey: string) => {
    const index = flatCells.findIndex((cell) => cell.dateKey === dateKey);
    if (index < 0) return;
    let target = -1;
    switch (e.key) {
      case "ArrowRight":
        target = index + 1;
        break;
      case "ArrowLeft":
        target = index - 1;
        break;
      case "ArrowDown":
        target = index + 7;
        break;
      case "ArrowUp":
        target = index - 7;
        break;
      default:
        return;
    }
    const next = flatCells[target];
    if (!next) return;
    e.preventDefault();
    focusCell(next.dateKey);
  };

  const selectDay = (dateKey: string) => {
    setSelectedDay((prev) => (prev === dateKey ? null : dateKey));
  };

  const monthPrefix = `${String(cursor.year).padStart(4, "0")}-${String(cursor.month).padStart(2, "0")}`;
  const monthEntries = entries.filter((entry) => entry.dateKey.startsWith(monthPrefix));
  const dayEntries = selectedDay
    ? monthEntries.filter((entry) => entry.dateKey === selectedDay)
    : monthEntries;
  const sameDayEntries = selectedDay ? onThisDay(entries, selectedDay) : [];

  return (
    <section className="view-section" data-view="browse" aria-label="Browse">
      <div className="browse-head">
        <button
          type="button"
          className="icon-button"
          aria-label="Previous month"
          onClick={() => shiftCursor(-1)}
        >
          ‹
        </button>
        <h2 className="browse-month-label">{monthLabel(cursor.year, cursor.month)}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Next month"
          onClick={() => shiftCursor(1)}
        >
          ›
        </button>
      </div>
      <div className="cal-grid" role="grid" aria-label={monthLabel(cursor.year, cursor.month)}>
        {WEEKDAYS.map((day) => (
          <span key={day} className="cal-weekday" role="columnheader">
            {day}
          </span>
        ))}
        {flatCells.map((cell) => {
          const day = Number.parseInt(cell.dateKey.slice(8, 10), 10);
          const selectable =
            cell.dateKey === selectedDay || cell.isToday || cell.inMonth ? 0 : -1;
          return (
            <button
              key={cell.dateKey}
              type="button"
              role="gridcell"
              aria-selected={cell.dateKey === selectedDay}
              tabIndex={selectable}
              ref={(node) => {
                cellRefs.current.set(cell.dateKey, node);
              }}
              className={[
                "cal-cell",
                cell.inMonth ? "" : "cal-cell-out",
                cell.dateKey === selectedDay ? "cal-cell-selected" : "",
                cell.isToday ? "cal-cell-today" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onKeyDown={(e) => onCellKeyDown(e, cell.dateKey)}
              onClick={() => selectDay(cell.dateKey)}
            >
              {day}
            </button>
          );
        })}
      </div>

      <h3 className="timeline-group-title">
        {selectedDay ? `Entries on ${selectedDay}` : `Timeline · ${monthLabel(cursor.year, cursor.month)}`}
      </h3>
      {dayEntries.length === 0 ? (
        <p className="list-empty">No entries this month.</p>
      ) : (
        dayEntries.map((entry) => (
          <EntryListRow
            key={entry.id}
            entry={entry}
            active={entry.id === activeEntryId}
            onOpen={onOpen}
          />
        ))
      )}

      {sameDayEntries.length > 0 ? (
        <>
          <h3 className="subheading">On this day</h3>
          {sameDayEntries.map((entry) => (
            <EntryListRow
              key={`otd-${entry.id}`}
              entry={entry}
              active={entry.id === activeEntryId}
              onOpen={onOpen}
            />
          ))}
        </>
      ) : null}
    </section>
  );
}
