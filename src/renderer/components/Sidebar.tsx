import type { RefObject } from "react";
import { formatMonthTitle } from "../../core/dates.js";
import type { Entry } from "../../core/types.js";
import { EntryListRow } from "./EntryListRow.js";

export type ViewName = "today" | "browse" | "search" | "settings";

const NAV_ITEMS: readonly { id: ViewName; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "browse", label: "Browse" },
  { id: "search", label: "Search" },
  { id: "settings", label: "Settings" },
];

interface SidebarProps {
  view: ViewName;
  entries: Entry[];
  activeEntryId: string | null;
  anchorDateKey: string;
  searchQuery: string;
  onNavigate: (view: ViewName) => void;
  onOpenEntry: (id: string) => void;
  onSearchChange: (query: string) => void;
  onSubmitSearch: () => void;
  onHelp: () => void;
  searchInputRef?: RefObject<HTMLInputElement | null>;
}

function matchesQuery(entry: Entry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  return (
    entry.title.toLowerCase().includes(q) ||
    entry.body.toLowerCase().includes(q) ||
    entry.tags.some((tag) => tag.toLowerCase().includes(q)) ||
    entry.markers.some((marker) => marker.toLowerCase().includes(q))
  );
}

export function Sidebar({
  view,
  entries,
  activeEntryId,
  anchorDateKey,
  searchQuery,
  onNavigate,
  onOpenEntry,
  onSearchChange,
  onSubmitSearch,
  onHelp,
  searchInputRef,
}: SidebarProps) {
  const monthPrefix = anchorDateKey.slice(0, 7);
  const year = Number.parseInt(monthPrefix.slice(0, 4), 10);
  const month = Number.parseInt(monthPrefix.slice(5, 7), 10);
  const monthEntries = entries.filter(
    (entry) =>
      entry.dateKey.startsWith(monthPrefix) &&
      (searchQuery.trim().length === 0 || matchesQuery(entry, searchQuery)),
  );

  return (
    <aside className="app-sidebar">
      <div className="sidebar-brand">Quilljournal</div>
      <nav className="sidebar-nav" aria-label="Sections">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            className="nav-button"
            aria-current={view === item.id ? "page" : undefined}
            onClick={() => onNavigate(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <form
        className="sidebar-search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmitSearch();
        }}
      >
        <input
          ref={searchInputRef}
          type="text"
          value={searchQuery}
          placeholder="Search entries…"
          aria-label="Search entries"
          onChange={(e) => onSearchChange(e.target.value)}
        />
      </form>
      <div className="entry-list">
        <h2 className="list-month-title">{formatMonthTitle(year, month)}</h2>
        {monthEntries.length === 0 ? (
          <p className="list-empty">No entries this month.</p>
        ) : (
          monthEntries.map((entry) => (
            <EntryListRow
              key={entry.id}
              entry={entry}
              active={entry.id === activeEntryId}
              onOpen={onOpenEntry}
            />
          ))
        )}
      </div>
      <div className="sidebar-footer">
        <button type="button" className="btn btn-outline" onClick={onHelp} aria-label="Keyboard shortcuts (?)" >
          Shortcuts (?)
        </button>
      </div>
    </aside>
  );
}
