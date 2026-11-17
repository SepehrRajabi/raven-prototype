import { describe, expect, test } from "bun:test";
import { canMoveCategory, entryKey, existingNestRefs, layoutSections, orderedNestRefs, moveCategory, moveEntry, toEntries, toLayoutRequest, type ArrangeEntry, type NestRef } from "./layout";
import { previewLine, systemLine, typingLine, continuesRun, namesSentence } from "./text";
import type { ChatConversation, ChatMessage, ConversationState, TreeLayout } from "./types";

const voice = (id: string): NestRef => ({ kind: "voice", id });
const text = (id: string): NestRef => ({ kind: "text", id });

const layout: TreeLayout = {
  treeId: "tree",
  categories: [
    { id: "social", name: "Social", position: 1 },
    { id: "work", name: "Work", position: 0 },
  ],
  items: [
    { kind: "text", id: "general", categoryId: "work", position: 0 },
    { kind: "voice", id: "standup", categoryId: "work", position: 1 },
    { kind: "voice", id: "lounge", categoryId: "social", position: 0 },
    { kind: "text", id: "welcome", position: 0 },
    { kind: "text", id: "gone", categoryId: "work", position: 2 },
  ],
};

const describeSections = (sections: ReturnType<typeof layoutSections>) =>
  sections.map((section) => `${section.category?.name ?? "-"}: ${section.items.map((item) => item.id).join(",")}`);

describe("reading a layout", () => {
  const existing = [voice("standup"), voice("lounge"), text("general"), text("welcome"), text("brand-new")];

  test("uncategorised nests come first, then categories in their order", () => {
    expect(describeSections(layoutSections(layout, existing))).toEqual(["-: welcome,brand-new", "Work: general,standup", "Social: lounge"]);
  });

  test("a nest the layout does not know yet is kept, and one that no longer exists is dropped", () => {
    const ids = layoutSections(layout, existing).flatMap((section) => section.items.map((item) => item.id));
    expect(ids).toContain("brand-new");
    expect(ids).not.toContain("gone");
  });

  test("with no layout at all, everything is simply listed", () => {
    expect(describeSections(layoutSections(undefined, existing))).toEqual(["-: standup,lounge,general,welcome,brand-new"]);
  });
});

describe("a tree's nests in one list", () => {
  const textNest = (id: string, createdAt: string) => ({ summary: { id, createdAt } }) as unknown as ConversationState;

  test("lists text nests oldest first, then voice nests", () => {
    const refs = existingNestRefs([textNest("b", "2026-02-01"), textNest("a", "2026-01-01")], [{ id: "v" }]);
    expect(refs).toEqual([text("a"), text("b"), voice("v")]);
  });

  test("follows the layout across kinds, with categories flattened", () => {
    const refs = [text("general"), text("welcome"), voice("standup"), voice("lounge"), voice("new")];
    expect(orderedNestRefs(layout, refs).map((ref) => ref.id)).toEqual(["welcome", "new", "general", "standup", "lounge"]);
    expect(orderedNestRefs(undefined, refs).map((ref) => ref.id)).toEqual(["general", "welcome", "standup", "lounge", "new"]);
  });
});

describe("rearranging", () => {
  const entries = (): ArrangeEntry[] => toEntries(layoutSections(layout, [voice("standup"), voice("lounge"), text("general"), text("welcome")]), (ref) => ref.id.toUpperCase());
  const keys = (list: ArrangeEntry[]) => list.map(entryKey);

  test("the arrangement is a flat list with headings", () => {
    expect(keys(entries())).toEqual(["text:welcome", "category:work", "text:general", "voice:standup", "category:social", "voice:lounge"]);
    expect(entries()[2]).toEqual({ type: "item", kind: "text", id: "general", name: "GENERAL" });
  });

  test("a nest takes the category of the heading above where it lands", () => {
    // Move "standup" to the end, under Social.
    const moved = moveEntry(entries(), 3, 5);
    expect(keys(moved)).toEqual(["text:welcome", "category:work", "text:general", "category:social", "voice:lounge", "voice:standup"]);
    expect(toLayoutRequest(moved)).toEqual({
      categories: ["work", "social"],
      items: [
        { kind: "text", id: "welcome", categoryId: undefined },
        { kind: "text", id: "general", categoryId: "work" },
        { kind: "voice", id: "lounge", categoryId: "social" },
        { kind: "voice", id: "standup", categoryId: "social" },
      ],
    });
    // Move "general" to the very top: no category.
    expect(toLayoutRequest(moveEntry(entries(), 2, 0)).items[0]).toEqual({ kind: "text", id: "general", categoryId: undefined });
  });

  test("headings are not dragged, and nonsense moves change nothing", () => {
    const start = entries();
    expect(moveEntry(start, 1, 4)).toBe(start);
    expect(moveEntry(start, 2, 2)).toBe(start);
    expect(moveEntry(start, 2, 99)).toBe(start);
  });

  test("a category moves with everything in it", () => {
    const down = moveCategory(entries(), "work", 1);
    expect(keys(down)).toEqual(["text:welcome", "category:social", "voice:lounge", "category:work", "text:general", "voice:standup"]);
    expect(keys(moveCategory(down, "work", -1))).toEqual(keys(entries()));
    expect(toLayoutRequest(down).categories).toEqual(["social", "work"]);
  });

  test("the first category cannot go up and the last cannot go down", () => {
    const start = entries();
    expect(canMoveCategory(start, "work", -1)).toBe(false);
    expect(canMoveCategory(start, "work", 1)).toBe(true);
    expect(canMoveCategory(start, "social", 1)).toBe(false);
    expect(canMoveCategory(start, "no-such", 1)).toBe(false);
  });
});

describe("the sentences written about conversations", () => {
  const me = "me";
  const ava = { id: "ava", username: "ava", displayName: "Ava" };
  const sam = { id: "sam", username: "sam", displayName: "Sam" };

  test("names", () => {
    expect(namesSentence([])).toBe("");
    expect(namesSentence(["Ava"])).toBe("Ava");
    expect(namesSentence(["Ava", "Sam"])).toBe("Ava and Sam");
    expect(namesSentence(["Ava", "Sam", "Mina", "Kian"])).toBe("Ava, Sam and 2 others");
  });

  test("what happened to a group, from the reader's side", () => {
    expect(systemLine({ event: "group_created" }, me, "Me", me)).toBe("You created the group");
    expect(systemLine({ event: "group_created" }, "ava", "Ava", me)).toBe("Ava created the group");
    expect(systemLine({ event: "members_added", users: [sam, { id: me, username: "me", displayName: "Me" }] }, "ava", "Ava", me)).toBe("Ava added Sam and you");
    expect(systemLine({ event: "member_left", user: sam }, "sam", "Sam", me)).toBe("Sam left");
    expect(systemLine({ event: "member_removed", user: sam }, me, "Me", me)).toBe("You removed Sam");
    expect(systemLine({ event: "renamed", name: "Weekend" }, "ava", "Ava", me)).toBe("Ava changed the name to “Weekend”");
    expect(systemLine({ event: "something-new" }, "ava", "Ava", me)).toBe("");
  });

  test("who is typing", () => {
    expect(typingLine({})).toBe("");
    expect(typingLine({ ava: { name: "Ava", until: 1 } })).toBe("Ava is typing…");
    expect(typingLine({ ava: { name: "Ava", until: 1 }, sam: { name: "Sam", until: 1 } })).toBe("Ava and Sam are typing…");
  });

  test("the line under a conversation's name", () => {
    const base = { kind: "dm", name: "Ava" } as ChatConversation;
    const last = { id: "m1", seq: 1, senderId: "ava", senderName: "Ava", kind: "text" as const, excerpt: "see you at nine", createdAt: "" };
    expect(previewLine({ ...base }, me)).toBe("");
    expect(previewLine({ ...base, lastMessage: last }, me)).toBe("see you at nine");
    expect(previewLine({ ...base, lastMessage: { ...last, senderId: me } }, me)).toBe("You: see you at nine");
    expect(previewLine({ ...base, kind: "group", lastMessage: last }, me)).toBe("Ava: see you at nine");
    expect(previewLine({ ...base, lastMessage: { ...last, deleted: true, excerpt: "" } }, me)).toBe("Message deleted");
    expect(previewLine({ ...base, kind: "group", lastMessage: { ...last, kind: "system", excerpt: "", system: { event: "member_left", user: ava } } }, me)).toBe("Ava left");
  });

  test("messages close together from one person read as one run", () => {
    const at = (minute: number, senderId = "ava", kind: ChatMessage["kind"] = "text") =>
      ({ senderId, kind, createdAt: new Date(2026, 9, 11, 10, minute).toISOString() }) as ChatMessage;
    expect(continuesRun(at(0), at(3))).toBe(true);
    expect(continuesRun(at(0), at(6))).toBe(false);
    expect(continuesRun(at(0), at(1, "sam"))).toBe(false);
    expect(continuesRun(at(0, "ava", "system"), at(1))).toBe(false);
    expect(continuesRun(undefined, at(1))).toBe(false);
  });
});
