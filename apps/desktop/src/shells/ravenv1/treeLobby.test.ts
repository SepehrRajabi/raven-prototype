import { describe, expect, test } from "bun:test";
import type { TreeMember } from "@/lib/api";
import type { LauncherNest, Nest } from "@/lib/api";
import { groupMembers, liveTreeNests, lobbyMenus, lobbySummary, peopleAround, treeSubtitleParts, type SummaryNest, type SummaryPerson } from "./treeLobby";

describe("lobbyMenus", () => {
  test("a room manager with chat can create all three and arrange", () => {
    expect(lobbyMenus({ canRooms: true, canMembers: false, hasChat: true })).toEqual({ create: ["voice", "text", "category"], more: ["arrange"] });
  });

  test("without chat only a voice nest can be made and there is nothing to arrange", () => {
    expect(lobbyMenus({ canRooms: true, canMembers: false, hasChat: false })).toEqual({ create: ["voice"], more: [] });
  });

  test("someone who may add people but not rooms still gets Add a person", () => {
    expect(lobbyMenus({ canRooms: false, canMembers: true, hasChat: true })).toEqual({ create: [], more: ["addPerson"] });
  });

  test("someone with neither gets nothing", () => {
    expect(lobbyMenus({ canRooms: false, canMembers: false, hasChat: true })).toEqual({ create: [], more: [] });
  });
});

describe("treeSubtitleParts", () => {
  test("says visibility and the member count, and who is inside only when someone is", () => {
    expect(treeSubtitleParts({ visibility: "private", members: 5, inside: 2, nestSingular: "nest" })).toEqual({ visibility: "Private", members: "5 members", inside: "2 in a nest" });
    expect(treeSubtitleParts({ visibility: "public", members: 1, inside: 0, nestSingular: "nest" })).toEqual({ visibility: "Public", members: "1 member", inside: null });
  });
});

const member = (userId: string, patch: Partial<TreeMember> = {}): TreeMember =>
  ({ treeId: "t", userId, username: userId, displayName: userId, role: "member", state: "joined", presenceState: "available", reachability: "around", ...patch }) as TreeMember;

describe("groupMembers", () => {
  test("splits into here and around, open people first, and leaves the away out", () => {
    const groups = groupMembers([
      member("zed", { presenceState: "offline" }),
      member("bea", { activeNestId: "n1" }),
      member("cal", { reachability: "focused" }),
      member("dan", { reachability: "open" }),
      member("eve", { presenceState: "invisible" }),
    ]);
    expect(groups.here.map((item) => item.userId)).toEqual(["bea"]);
    expect(groups.around.map((item) => item.userId)).toEqual(["dan", "cal"]);
  });

  test("someone who is away is never listed as here", () => {
    const groups = groupMembers([member("ava", { presenceState: "offline", activeNestId: "n1" })]);
    expect(groups.here).toEqual([]);
    expect(groups.around).toEqual([]);
  });
});

describe("liveTreeNests", () => {
  test("prefers the launcher's data for a nest and falls back to the tree's own", () => {
    const own = { id: "a", name: "A" } as Nest;
    const other = { id: "b", name: "B" } as Nest;
    const launcher = { id: "a", name: "A", currentParticipants: [{ userId: "u" }] } as unknown as LauncherNest;
    const merged = liveTreeNests({ activeNests: [own, other] }, [launcher]);
    expect(merged[0]).toBe(launcher);
    expect(merged[1]).toBe(other);
  });
});

const person = (id: string): SummaryPerson => ({ id, name: id[0].toUpperCase() + id.slice(1) });
const nest = (id: string, ...people: string[]): SummaryNest => ({ id, name: id[0].toUpperCase() + id.slice(1), people: people.map(person) });

describe("lobbySummary", () => {
  test("you inside with others and alone", () => {
    expect(lobbySummary({ nests: [nest("lounge", "me", "ava")], selfId: "me", activeNestId: "lounge", around: [] })).toEqual({ kind: "here", nestId: "lounge", text: "You're in Lounge with Ava." });
    expect(lobbySummary({ nests: [nest("lounge", "me")], selfId: "me", activeNestId: "lounge", around: [] }).text).toBe("You're in Lounge.");
  });

  test("being in a room of another tree does not make you inside this one", () => {
    expect(lobbySummary({ nests: [], selfId: "me", activeNestId: "elsewhere", around: [] }).kind).toBe("quiet");
  });

  test("one live room names who is in it", () => {
    expect(lobbySummary({ nests: [nest("lounge", "ava")], selfId: "me", around: [] })).toEqual({ kind: "live", nestId: "lounge", text: "Lounge is live. Ava is in it." });
    expect(lobbySummary({ nests: [nest("lounge", "ava", "sam")], selfId: "me", around: [] }).text).toBe("Lounge is live. Ava and Sam are in it.");
  });

  test("four or more names show two and a count", () => {
    expect(lobbySummary({ nests: [nest("lounge", "ava", "sam", "mina", "kian")], selfId: "me", around: [] }).text).toBe("Lounge is live. Ava, Sam and 2 others are in it.");
    expect(lobbySummary({ nests: [nest("lounge", "ava", "sam", "mina")], selfId: "me", around: [] }).text).toBe("Lounge is live. Ava, Sam and Mina are in it.");
  });

  test("several live rooms, two and three or more", () => {
    expect(lobbySummary({ nests: [nest("a", "ava"), nest("b", "sam", "mina")], selfId: "me", around: [] })).toEqual({ kind: "live", text: "A and B are live. 3 people are in them." });
    expect(lobbySummary({ nests: [nest("a", "ava"), nest("b", "sam"), nest("c"), nest("d")], selfId: "me", around: [] }).text).toBe("A, B and 2 more are live. 2 people are in them.");
  });

  test("quiet, with and without people around", () => {
    expect(lobbySummary({ nests: [], selfId: "me", around: [person("ava")] })).toEqual({ kind: "around", text: "Quiet right now. Ava is around." });
    expect(lobbySummary({ nests: [], selfId: "me", around: [person("ava"), person("sam")] }).text).toBe("Quiet right now. Ava and Sam are around.");
    expect(lobbySummary({ nests: [], selfId: "me", around: [] })).toEqual({ kind: "quiet", text: "Quiet right now." });
  });
});

describe("peopleAround", () => {
  test("leaves out offline, invisible, yourself and anyone in a room", () => {
    const around = peopleAround(
      [member("me"), member("ava"), member("off", { presenceState: "offline" }), member("inv", { presenceState: "invisible" }), member("in", { activeNestId: "n1" }), member("late")],
      "me",
      new Set(["late"]),
    );
    expect(around.map((entry) => entry.id)).toEqual(["ava"]);
  });
});
