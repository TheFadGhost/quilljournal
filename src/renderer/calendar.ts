import {
  daysInMonth,
  formatMonthTitle,
  mmddOf,
  shiftDateKey,
  todayKey as systemTodayKey,
} from "../core/dates.js";
import type { Entry } from "../core/types.js";

export interface CalendarCell {
  dateKey: string;
  inMonth: boolean;
  isToday: boolean;
}

export type CalendarWeek = CalendarCell[];

export interface MonthRef {
  year: number;
  month: number;
}

export function monthLabel(year: number, month1based: number): string {
  return formatMonthTitle(year, month1based);
}

export function monthGrid(
  year: number,
  month1based: number,
  todayK: string = systemTodayKey(),
): CalendarWeek[] {
  const monthStr = String(month1based).padStart(2, "0");
  const firstKey = `${year}-${monthStr}-01`;
  const firstWeekday = new Date(Date.UTC(year, month1based - 1, 1, 12)).getUTCDay();
  const leading = (firstWeekday + 6) % 7;
  const totalCells = leading + daysInMonth(year, month1based);
  const padded = Math.ceil(totalCells / 7) * 7;
  const gridStart = shiftDateKey(firstKey, -leading);
  const weeks: CalendarWeek[] = [];
  for (let week = 0; week < padded / 7; week++) {
    const cells: CalendarCell[] = [];
    for (let day = 0; day < 7; day++) {
      const index = week * 7 + day;
      const dateKey = shiftDateKey(gridStart, index);
      cells.push({
        dateKey,
        inMonth: dateKey.startsWith(`${year}-${monthStr}`),
        isToday: dateKey === todayK,
      });
    }
    weeks.push(cells);
  }
  return weeks;
}

export function listMonthsAround(anchorDateKey: string, span = 3): MonthRef[] {
  const safeSpan = Number.isFinite(span) ? Math.max(0, Math.trunc(span)) : 0;
  const year = Number.parseInt(anchorDateKey.slice(0, 4), 10);
  const month = Number.parseInt(anchorDateKey.slice(5, 7), 10);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return [];
  const months: MonthRef[] = [];
  for (let offset = -safeSpan; offset <= safeSpan; offset++) {
    const d = new Date(Date.UTC(year, month - 1 + offset, 15));
    months.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 });
  }
  return months;
}

export function onThisDay(entries: Entry[], dateKey: string): Entry[] {
  const target = mmddOf(dateKey);
  return entries
    .filter((entry) => entry.dateKey !== dateKey && mmddOf(entry.dateKey) === target)
    .sort((a, b) => (a.dateKey < b.dateKey ? 1 : a.dateKey > b.dateKey ? -1 : 0));
}
