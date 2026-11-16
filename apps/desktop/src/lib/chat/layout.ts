// How a tree's nests are arranged: categories, and voice and text nests in an order its
// owners choose. These are the pure parts: reading a layout for display, and working out
// a new one while it is being rearranged.

import type { ConversationState, TreeCategory, TreeLayout } from "./types";

export type NestKind = "voice" | "text";

export interface NestRef {
  kind: NestKind;
  id: string;
}

/** A category and what is in it. `category` is null for nests above all categories. */
export interface LayoutSection {
  category: TreeCategory | null;
  items: NestRef[];
}

const refKey = (ref: NestRef) => `${ref.kind}:${ref.id}`;

/**
 * Groups a tree's nests for display. Uncategorised nests come first, then each category
 * in order. A nest the layout does not mention yet (it was just created) goes at the end
 * of the uncategorised ones; a layout entry for a nest that no longer exists is skipped.
 */
export function layoutSections(layout: TreeLayout | undefined, existing: NestRef[]): LayoutSection[] {
  const known = new Map(existing.map((ref) => [refKey(ref), ref]));
  const top: LayoutSection = { category: null, items: [] };
  const categories = [...(layout?.categories ?? [])].sort((a, b) => a.position - b.position);
  const byCategory = new Map(categories.map((category) => [category.id, { category, items: [] as NestRef[] }]));
  const placed = new Set<string>();

  for (const item of [...(layout?.items ?? [])].sort((a, b) => a.position - b.position)) {
    const ref = known.get(refKey(item));
    if (!ref || placed.has(refKey(ref))) continue;
    placed.add(refKey(ref));
    (item.categoryId ? byCategory.get(item.categoryId) ?? top : top).items.push(ref);
  }
  for (const ref of existing) {
    if (!placed.has(refKey(ref))) top.items.push(ref);
  }
  return [top, ...categories.map((category) => byCategory.get(category.id)!)];
}

/** Every nest a tree has, before ordering: text nests oldest first, then voice nests. */
export function existingNestRefs(textNests: ConversationState[], voiceNests: Array<{ id: string }>): NestRef[] {
  const oldestFirst = [...textNests].sort((a, b) => a.summary.createdAt.localeCompare(b.summary.createdAt) || a.summary.id.localeCompare(b.summary.id));
  return [...oldestFirst.map((nest) => ({ kind: "text" as const, id: nest.summary.id })), ...voiceNests.map((nest) => ({ kind: "voice" as const, id: nest.id }))];
}

/** A tree's nests, voice and text, in the order its lobby lists them. Categories are flattened. */
export function orderedNestRefs(layout: TreeLayout | undefined, existing: NestRef[]): NestRef[] {
  return layoutSections(layout, existing).flatMap((section) => section.items);
}

// ---- rearranging -----------------------------------------------------------------------

/**
 * The arrangement as one flat list, which is what gets dragged around: a category is a
 * heading row, and a nest belongs to the nearest heading above it (or to none).
 */
export type ArrangeEntry =
  | { type: "category"; id: string; name: string }
  | { type: "item"; kind: NestKind; id: string; name: string };

export const entryKey = (entry: ArrangeEntry) => (entry.type === "category" ? `category:${entry.id}` : `${entry.kind}:${entry.id}`);

export function toEntries(sections: LayoutSection[], nameOf: (ref: NestRef) => string): ArrangeEntry[] {
  const out: ArrangeEntry[] = [];
  for (const section of sections) {
    if (section.category) out.push({ type: "category", id: section.category.id, name: section.category.name });
    for (const item of section.items) out.push({ type: "item", kind: item.kind, id: item.id, name: nameOf(item) });
  }
  return out;
}

/** Moves one nest to another place in the list. Headings are not moved this way. */
export function moveEntry(entries: ArrangeEntry[], from: number, to: number): ArrangeEntry[] {
  if (from === to || from < 0 || to < 0 || from >= entries.length || to >= entries.length) return entries;
  if (entries[from].type !== "item") return entries;
  const next = entries.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** Moves a category, with everything in it, one place up (-1) or down (+1) among the categories. */
export function moveCategory(entries: ArrangeEntry[], categoryId: string, direction: -1 | 1): ArrangeEntry[] {
  const starts = entries.flatMap((entry, index) => (entry.type === "category" ? [index] : []));
  const which = starts.findIndex((index) => (entries[index] as { id: string }).id === categoryId);
  const other = which + direction;
  if (which < 0 || other < 0 || other >= starts.length) return entries;
  const blockOf = (position: number) => entries.slice(starts[position], position + 1 < starts.length ? starts[position + 1] : entries.length);
  const first = Math.min(which, other);
  const head = entries.slice(0, starts[first]);
  const tail = first + 2 < starts.length ? entries.slice(starts[first + 2]) : [];
  return [...head, ...blockOf(first + 1), ...blockOf(first), ...tail];
}

/** Whether a category can move in a direction, for enabling its buttons. */
export function canMoveCategory(entries: ArrangeEntry[], categoryId: string, direction: -1 | 1): boolean {
  return moveCategory(entries, categoryId, direction) !== entries;
}

/** The arrangement in the form the server takes. */
export function toLayoutRequest(entries: ArrangeEntry[]): { categories: string[]; items: Array<{ kind: NestKind; id: string; categoryId?: string }> } {
  const categories: string[] = [];
  const items: Array<{ kind: NestKind; id: string; categoryId?: string }> = [];
  let current: string | undefined;
  for (const entry of entries) {
    if (entry.type === "category") {
      current = entry.id;
      categories.push(entry.id);
    } else {
      items.push({ kind: entry.kind, id: entry.id, categoryId: current });
    }
  }
  return { categories, items };
}
