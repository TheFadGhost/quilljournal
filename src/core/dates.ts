export function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function dateKeyFromInstant(instant: Date, timeZone?: string): string {
  const tz = timeZone ?? systemTimeZone();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const y = get("year");
  const m = get("month");
  const d = get("day");
  if (!/^\d{4}$/.test(y) || !/^\d{2}$/.test(m) || !/^\d{2}$/.test(d)) {
    throw new RangeError(`could not format date key for ${instant.toISOString()} in ${tz}`);
  }
  return `${y}-${m}-${d}`;
}

export function todayKey(timeZone?: string): string {
  return dateKeyFromInstant(new Date(), timeZone);
}

export function isDateKey(key: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  const [y, m, d] = key.split("-").map((n) => Number.parseInt(n, 10));
  if (m === undefined || d === undefined || y === undefined) return false;
  if (m < 1 || m > 12) return false;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d >= 1 && d <= daysInMonth;
}

export function mmddOf(key: string): string {
  return key.slice(5);
}

function utcNoonOfKey(key: string): Date {
  const [y, m, d] = key.split("-").map((n) => Number.parseInt(n, 10));
  return new Date(Date.UTC(y as number, (m as number) - 1, d as number, 12, 0, 0));
}

export function shiftDateKey(key: string, days: number): string {
  const base = utcNoonOfKey(key);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

export function weekdayOfDateKey(key: string): number {
  return utcNoonOfKey(key).getUTCDay();
}

export function daysInMonth(year: number, month1based: number): number {
  return new Date(Date.UTC(year, month1based, 0)).getUTCDate();
}

export function compareDateKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function formatDateKeyLong(key: string, locale = "en"): string {
  const dtf = new Intl.DateTimeFormat(locale, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
  return dtf.format(utcNoonOfKey(key));
}

export function formatMonthTitle(year: number, month1based: number, locale = "en"): string {
  const dtf = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" });
  return dtf.format(new Date(Date.UTC(year, month1based - 1, 15)));
}
