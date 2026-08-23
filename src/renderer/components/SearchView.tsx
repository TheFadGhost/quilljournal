import { useEffect, useMemo, useRef, useState } from "react";
import type { Entry } from "../../core/types.js";
import { filterEntries, summarizeFilters } from "../search.js";
import { EntryListRow } from "./EntryListRow.js";

interface SearchViewProps {
  entries: Entry[];
  query: string;
  onQueryChange(query: string): void;
  activeEntryId: string | null;
  onOpen(id: string): void;
  announce(message: string): void;
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function SearchView({
  entries,
  query,
  onQueryChange,
  activeEntryId,
  onOpen,
  announce,
}: SearchViewProps) {
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedMarkers, setSelectedMarkers] = useState<string[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const announceTimer = useRef<number | undefined>(undefined);

  const allTags = useMemo(
    () => uniqueSorted(entries.flatMap((entry) => entry.tags)),
    [entries],
  );
  const allMarkers = useMemo(
    () => uniqueSorted(entries.flatMap((entry) => entry.markers)),
    [entries],
  );

  const filters = useMemo(
    () => ({
      query,
      tags: selectedTags,
      markers: selectedMarkers,
      from: from.length > 0 ? from : null,
      to: to.length > 0 ? to : null,
    }),
    [query, selectedTags, selectedMarkers, from, to],
  );

  const results = useMemo(() => filterEntries(entries, filters), [entries, filters]);

  useEffect(() => {
    if (announceTimer.current !== undefined) window.clearTimeout(announceTimer.current);
    const count = results.length;
    announceTimer.current = window.setTimeout(() => {
      announceTimer.current = undefined;
      announce(
        count === 1 ? "1 entry matches." : `${count} entries match.`,
      );
    }, 400);
    return () => {
      if (announceTimer.current !== undefined) {
        window.clearTimeout(announceTimer.current);
        announceTimer.current = undefined;
      }
    };
  }, [results.length, announce]);

  const toggle = (list: string[], value: string): string[] =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  const clearFilters = () => {
    setSelectedTags([]);
    setSelectedMarkers([]);
    setFrom("");
    setTo("");
    onQueryChange("");
  };

  const noActiveFilters =
    query.trim().length === 0 &&
    selectedTags.length === 0 &&
    selectedMarkers.length === 0 &&
    from.length === 0 &&
    to.length === 0;

  return (
    <section className="view-section" data-view="search" aria-label="Search">
      <h2 className="view-heading">Search</h2>
      <input
        type="text"
        className="search-input"
        value={query}
        placeholder="Search title, body, tags, markers, transcripts…"
        aria-label="Search entries"
        onChange={(e) => onQueryChange(e.target.value)}
      />
      <div className="facet-row">
        <span className="facet-label">Tags</span>
        {allTags.length === 0 ? <span className="settings-note">No tags yet.</span> : null}
        {allTags.map((tag) => (
          <button
            key={`tag-${tag}`}
            type="button"
            className="facet-chip"
            aria-pressed={selectedTags.includes(tag)}
            onClick={() => setSelectedTags((prev) => toggle(prev, tag))}
          >
            {tag}
          </button>
        ))}
      </div>
      <div className="facet-row">
        <span className="facet-label">Markers</span>
        {allMarkers.length === 0 ? <span className="settings-note">No markers yet.</span> : null}
        {allMarkers.map((marker) => (
          <button
            key={`marker-${marker}`}
            type="button"
            className="facet-chip"
            aria-pressed={selectedMarkers.includes(marker)}
            onClick={() => setSelectedMarkers((prev) => toggle(prev, marker))}
          >
            {marker}
          </button>
        ))}
      </div>
      <div className="facet-row">
        <span className="facet-label">From</span>
        <input
          type="date"
          value={from}
          aria-label="From date"
          onChange={(e) => setFrom(e.target.value)}
        />
        <span className="facet-label">Until</span>
        <input
          type="date"
          value={to}
          aria-label="Until date"
          onChange={(e) => setTo(e.target.value)}
        />
      </div>

      <p className="results-summary">
        {results.length === 1 ? "1 entry matches." : `${results.length} entries match.`}{" "}
        {summarizeFilters(filters)}.
      </p>

      {results.length === 0 ? (
        <div className="no-results">
          <p className="no-results-line">No entries match.</p>
          <p className="no-results-line settings-note">{summarizeFilters(filters)}</p>
          {!noActiveFilters ? (
            <button type="button" className="btn btn-outline" onClick={clearFilters}>
              Clear filters
            </button>
          ) : null}
        </div>
      ) : (
        results.map((entry) => (
          <EntryListRow
            key={entry.id}
            entry={entry}
            active={entry.id === activeEntryId}
            onOpen={onOpen}
          />
        ))
      )}
    </section>
  );
}
