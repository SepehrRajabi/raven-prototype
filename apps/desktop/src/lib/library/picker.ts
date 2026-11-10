// What the GIF and sticker picker shows, as pure functions so the order is tested.
//
// Before typing: For this reply, Favourites, Recent, then each collection (collapsed,
// loaded when opened), Not in a collection, and This space. While searching: the
// results grouped as Yours, This space, Server, in the server's order within each.

import { scopeOf, type LibraryItem, type LibraryKind, type LibraryScope } from "./types";

export interface PickerSection {
  id: string;
  title: string;
  items: LibraryItem[];
}

export const RECENT_LIMIT = 24;

const notIn = (seen: Set<string>) => (item: LibraryItem) => !seen.has(item.id);

/**
 * The sections above and below the collections. `items` is the first page of an empty
 * search: the person's own items and this space's set. An item shows once, in the first
 * section that has it, except that Recent and For this reply may repeat what is below.
 */
export function browseSections({
  kind,
  scope = "all",
  suggested,
  recent,
  items,
}: {
  kind: LibraryKind;
  /** A scope chip other than All keeps only that scope's items. */
  scope?: PickerScope;
  suggested: LibraryItem[];
  recent: LibraryItem[];
  items: LibraryItem[];
}): {
  top: PickerSection[];
  bottom: PickerSection[];
} {
  const ofKind = (list: LibraryItem[]) =>
    list.filter((item) => item.kind === kind && item.status === "ready" && (scope === "all" || scopeOf(item) === scope));
  const own = ofKind(items).filter((item) => scopeOf(item) === "personal");
  const favourites = own.filter((item) => item.favourite);
  const shownAbove = new Set(favourites.map((item) => item.id));
  const top: PickerSection[] = [
    { id: "suggested", title: "For this reply", items: ofKind(suggested) },
    { id: "favourites", title: "Favourites", items: favourites },
    { id: "recent", title: "Recent", items: ofKind(recent) },
  ];
  const bottom: PickerSection[] = [
    { id: "uncollected", title: "Not in a collection", items: own.filter((item) => !item.collectionId && notIn(shownAbove)(item)) },
    { id: "space", title: "This space", items: ofKind(items).filter((item) => scopeOf(item) === "tree") },
  ];
  const filled = (section: PickerSection) => section.items.length > 0;
  return { top: top.filter(filled), bottom: bottom.filter(filled) };
}

const RESULT_TITLES: Record<LibraryScope, string> = { personal: "Yours", tree: "This space", public: "Server" };

/** Search results under their headings, keeping the server's order inside each. */
export function groupResults(items: LibraryItem[]): PickerSection[] {
  const groups: PickerSection[] = (["personal", "tree", "public"] as const).map((scope) => ({ id: scope, title: RESULT_TITLES[scope], items: [] }));
  for (const item of items) groups.find((group) => group.id === scopeOf(item))!.items.push(item);
  return groups.filter((group) => group.items.length > 0);
}

/** The picker's scope chips, and what each asks the server for. */
export type PickerScope = "all" | "personal" | "tree" | "public";
export const PICKER_SCOPES: Array<{ id: PickerScope; label: string }> = [
  { id: "all", label: "All" },
  { id: "personal", label: "Mine" },
  { id: "tree", label: "This space" },
  { id: "public", label: "Server" },
];

// Recent: copies of what was sent, newest first, per account and kind, on this computer.

const recentKey = (userId: string) => `raven.library.recent.${userId}`;

interface Storage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const storage = (): Storage | null => (typeof localStorage === "undefined" ? null : localStorage);

export function recentItems(userId: string, store: Storage | null = storage()): LibraryItem[] {
  try {
    const parsed = JSON.parse(store?.getItem(recentKey(userId)) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is LibraryItem => Boolean(item) && typeof item === "object" && typeof (item as LibraryItem).id === "string" && typeof (item as LibraryItem).assetId === "string") : [];
  } catch {
    return [];
  }
}

export function recordRecent(userId: string, item: LibraryItem, store: Storage | null = storage()) {
  const next = [item, ...recentItems(userId, store).filter((entry) => entry.id !== item.id)];
  // Each kind keeps its own last few.
  const kept = (["gif", "sticker"] as const).flatMap((kind) => next.filter((entry) => entry.kind === kind).slice(0, RECENT_LIMIT));
  kept.sort((a, b) => next.indexOf(a) - next.indexOf(b));
  try {
    store?.setItem(recentKey(userId), JSON.stringify(kept));
  } catch {
    // Storage is full or unavailable: Recent simply doesn't change.
  }
}

/** Drops an item from Recent, after it was removed or turned out to be gone. */
export function forgetRecent(userId: string, itemId: string, store: Storage | null = storage()) {
  const kept = recentItems(userId, store).filter((entry) => entry.id !== itemId);
  try {
    store?.setItem(recentKey(userId), JSON.stringify(kept));
  } catch {
    // As above.
  }
}

const TAB_KEY = "raven.library.pickerTab";

export function lastTab(): LibraryKind {
  try {
    return storage()?.getItem(TAB_KEY) === "sticker" ? "sticker" : "gif";
  } catch {
    return "gif";
  }
}

export function rememberTab(kind: LibraryKind) {
  try {
    storage()?.setItem(TAB_KEY, kind);
  } catch {
    // Not remembered this time.
  }
}
