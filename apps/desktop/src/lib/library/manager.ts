// The library page's filters and selection, without UI.

import type { LibraryItem } from "./types";

/** All, one collection (loaded from the server), or Untagged: no title and no keywords. */
export type ManagerFilter = { kind: "all" } | { kind: "collection"; id: string } | { kind: "untagged" };

/** What the grid shows: the filter, then the search box over titles and keywords. */
export function filterItems(items: LibraryItem[], filter: ManagerFilter, query: string): LibraryItem[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    if (filter.kind === "untagged" && (item.title.trim() || item.keywords.length > 0)) return false;
    if (filter.kind === "collection" && item.collectionId !== filter.id) return false;
    if (words.length === 0) return true;
    const text = [item.title, ...item.keywords].join(" ").toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** Shift-click: everything from the last plain click to this one, in grid order. */
export function rangeSelect(order: string[], from: string, to: string): string[] {
  const start = order.indexOf(from);
  const end = order.indexOf(to);
  if (start < 0 || end < 0) return [to];
  return order.slice(Math.min(start, end), Math.max(start, end) + 1);
}
