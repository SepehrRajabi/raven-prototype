import { describe, expect, test } from "bun:test";
import { neighbour } from "@/lib/gridNavigation";
import { filterItems, rangeSelect } from "./manager";
import { browseSections, groupResults, recentItems, recordRecent } from "./picker";
import type { LibraryItem } from "./types";

function item(id: string, over: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id,
    assetId: `a-${id}`,
    kind: "sticker",
    format: "webp",
    status: "ready",
    title: "",
    keywords: [],
    collectionId: null,
    favourite: false,
    public: false,
    variants: ["play"],
    owner: { scope: "personal" },
    canEdit: true,
    createdAt: "2026-11-10T00:00:00Z",
    ...over,
  };
}

const space = (id: string, over: Partial<LibraryItem> = {}) => item(id, { owner: { scope: "tree", treeId: "t" }, canEdit: false, ...over });
const publicItem = (id: string) => item(id, { canEdit: false, public: true });
const ids = (list: LibraryItem[]) => list.map((entry) => entry.id);

describe("picker sections", () => {
  test("before typing: For this reply, Favourites, Recent; then Not in a collection and This space", () => {
    const items = [item("fav", { favourite: true }), item("loose"), item("kept", { collectionId: "c" }), space("s"), item("gif", { kind: "gif" }), item("busy", { status: "processing" })];
    const { top, bottom } = browseSections({ kind: "sticker", suggested: [item("sug")], recent: [item("loose"), item("gif", { kind: "gif" })], items });
    expect(top.map((section) => [section.title, ids(section.items)])).toEqual([
      ["For this reply", ["sug"]],
      ["Favourites", ["fav"]],
      ["Recent", ["loose"]],
    ]);
    expect(bottom.map((section) => [section.title, ids(section.items)])).toEqual([
      ["Not in a collection", ["loose"]],
      ["This space", ["s"]],
    ]);
  });

  test("a scope chip keeps only that scope's items", () => {
    const items = [item("fav", { favourite: true }), item("loose"), space("s")];
    const mine = browseSections({ kind: "sticker", scope: "personal", suggested: [space("s")], recent: [item("loose"), space("s")], items });
    expect(mine.top.map((section) => [section.title, ids(section.items)])).toEqual([
      ["Favourites", ["fav"]],
      ["Recent", ["loose"]],
    ]);
    expect(mine.bottom.map((section) => section.title)).toEqual(["Not in a collection"]);
    const tree = browseSections({ kind: "sticker", scope: "tree", suggested: [], recent: [item("loose"), space("s")], items });
    expect(tree.top.map((section) => [section.title, ids(section.items)])).toEqual([["Recent", ["s"]]]);
    expect(tree.bottom.map((section) => [section.title, ids(section.items)])).toEqual([["This space", ["s"]]]);
  });

  test("empty sections are left out", () => {
    const { top, bottom } = browseSections({ kind: "gif", suggested: [], recent: [], items: [] });
    expect(top).toEqual([]);
    expect(bottom).toEqual([]);
  });

  test("search results are grouped Yours, This space, Server, keeping the server's order", () => {
    const groups = groupResults([publicItem("p1"), item("m1"), space("s1"), item("m2"), publicItem("p2")]);
    expect(groups.map((group) => [group.title, ids(group.items)])).toEqual([
      ["Yours", ["m1", "m2"]],
      ["This space", ["s1"]],
      ["Server", ["p1", "p2"]],
    ]);
  });

  test("Recent keeps the newest first, without repeats, per account", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
    recordRecent("u", item("a"), storage);
    recordRecent("u", item("b"), storage);
    recordRecent("u", item("a"), storage);
    expect(ids(recentItems("u", storage))).toEqual(["a", "b"]);
    expect(recentItems("other", storage)).toEqual([]);
  });
});

describe("grid keys", () => {
  // Three cells on one row and two below, 50 px apart.
  const cell = (left: number, top: number) => ({ getBoundingClientRect: () => ({ left, top }) }) as unknown as HTMLElement;
  const cells = [cell(0, 0), cell(50, 0), cell(100, 0), cell(0, 50), cell(50, 50)];

  test("arrows move to the nearest cell on screen, and the short last row works", () => {
    expect(neighbour(cells, cells[0], "ArrowRight")).toBe(cells[1]);
    expect(neighbour(cells, cells[1], "ArrowLeft")).toBe(cells[0]);
    expect(neighbour(cells, cells[2], "ArrowDown")).toBe(cells[4]);
    expect(neighbour(cells, cells[3], "ArrowUp")).toBe(cells[0]);
    expect(neighbour(cells, cells[0], "ArrowUp")).toBeUndefined();
  });
});

describe("library page", () => {
  test("Untagged shows only items with no title and no keywords; search reads titles and keywords", () => {
    const items = [item("bare"), item("titled", { title: "Cat waving" }), item("tagged", { keywords: ["hello"] })];
    expect(ids(filterItems(items, { kind: "untagged" }, ""))).toEqual(["bare"]);
    expect(ids(filterItems(items, { kind: "all" }, "cat"))).toEqual(["titled"]);
    expect(ids(filterItems(items, { kind: "all" }, "HELL"))).toEqual(["tagged"]);
  });

  test("Shift-click selects the run between the two clicks", () => {
    expect(rangeSelect(["a", "b", "c", "d"], "c", "a")).toEqual(["a", "b", "c"]);
    expect(rangeSelect(["a"], "gone", "a")).toEqual(["a"]);
  });
});
