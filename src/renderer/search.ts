import type { Entry } from "../core/types.js";
import { compareDateKeys } from "../core/dates.js";

export interface SearchFilters {
  query: string;
  tags: string[];
  markers: string[];
  from: string | null;
  to: string | null;
}

export interface SearchHit {
  entry: Entry;
  titleHit: boolean;
}

function haystackOf(entry: Entry): { title: string; rest: string[] } {
  const transcript = entry.audio?.transcript?.text ?? "";
  return {
    title: entry.title.toLowerCase(),
    rest: [
      entry.body.toLowerCase(),
      ...entry.tags.map((tag) => tag.toLowerCase()),
      ...entry.markers.map((marker) => marker.toLowerCase()),
      transcript.toLowerCase(),
    ],
  };
}

function containsAll(values: readonly string[], needed: readonly string[]): boolean {
  return needed.every((n) => values.some((v) => v === n));
}

export function filterEntries(entries: Entry[], filters: SearchFilters): Entry[] {
  const query = filters.query.trim().toLowerCase();
  const tags = filters.tags.filter((t) => t.length > 0);
  const markers = filters.markers.filter((m) => m.length > 0);
  const hits: SearchHit[] = [];
  for (const entry of entries) {
    if (filters.from !== null && compareDateKeys(entry.dateKey, filters.from) < 0) continue;
    if (filters.to !== null && compareDateKeys(entry.dateKey, filters.to) > 0) continue;
    if (tags.length > 0 && !containsAll(entry.tags, tags)) continue;
    if (markers.length > 0 && !containsAll(entry.markers, markers)) continue;
    const hay = haystackOf(entry);
    let titleHit = false;
    if (query.length > 0) {
      titleHit = hay.title.includes(query);
      const restHit = hay.rest.some((field) => field.includes(query));
      if (!titleHit && !restHit) continue;
    }
    hits.push({ entry, titleHit });
  }
  hits.sort((a, b) => {
    if (a.titleHit !== b.titleHit) return a.titleHit ? -1 : 1;
    return compareDateKeys(b.entry.dateKey, a.entry.dateKey);
  });
  return hits.map((hit) => hit.entry);
}

export function summarizeFilters(filters: SearchFilters): string {
  const parts: string[] = [];
  const query = filters.query.trim();
  if (query.length > 0) parts.push(`text "${query}"`);
  if (filters.tags.length > 0) parts.push(`tags: ${filters.tags.join(" + ")}`);
  if (filters.markers.length > 0) parts.push(`markers: ${filters.markers.join(" + ")}`);
  if (filters.from !== null && filters.from.length > 0) parts.push(`from ${filters.from}`);
  if (filters.to !== null && filters.to.length > 0) parts.push(`until ${filters.to}`);
  return parts.length > 0 ? parts.join(" · ") : "no filters active";
}
