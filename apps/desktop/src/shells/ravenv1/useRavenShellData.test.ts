import { beforeAll, describe, expect, test } from "bun:test";
import type { HomeState, Knock, TreeDetails } from "@/lib/api";
import type { UILabelCopy } from "./state";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});

let derivePeople: typeof import("./useRavenShellData").derivePeople;
let applyEntryUpdate: typeof import("./useRavenShellData").applyEntryUpdate;
let derivePending: typeof import("./useRavenShellData").derivePending;

beforeAll(async () => {
  ({ derivePeople, applyEntryUpdate, derivePending } = await import("./useRavenShellData"));
});

describe("incoming knock inbox", () => {
  test("hides sent knocks from older APIs and keeps direct and Nest knocks from others", () => {
    const knock = (id: string, fromUserId: string, toUserId: string | null, nestId: string | null = null): Knock => ({
      id, fromUserId, fromUsername: fromUserId, fromDisplayName: fromUserId,
      toUserId, nestId, status: "pending", createdAt: "", expiresAt: "",
    });
    const home = {
      user: { id: "self" },
      pendingKnocks: [
        knock("sent", "self", "dariush"),
        knock("sent-nest", "self", null, "nest"),
        knock("incoming", "dariush", "self"),
        knock("incoming-nest", "mina", null, "nest"),
      ],
      pendingInvites: [], pendingRequests: [], incomingFriendRequests: [],
    } as unknown as HomeState;
    expect(derivePending(home, {}, {} as UILabelCopy).map((item) => [item.id, item.from])).toEqual([
      ["incoming", "dariush"], ["incoming-nest", "mina"],
    ]);
  });
});

describe("entry notices", () => {
  const entering = { type: "nest.entering", nestId: "nest-1", actorId: "bob", actorName: "Bob" };

  test("shows one notice per person entering a Nest", () => {
    const first = applyEntryUpdate([], entering, 100);
    expect(first).toEqual([{ nestId: "nest-1", actorId: "bob", actorName: "Bob", receivedAt: 100 }]);

    // Announcing again refreshes the notice instead of stacking a second one.
    const again = applyEntryUpdate(first, entering, 250);
    expect(again).toEqual([{ nestId: "nest-1", actorId: "bob", actorName: "Bob", receivedAt: 250 }]);

    const second = applyEntryUpdate(again, { ...entering, actorId: "carol", actorName: "Carol" }, 300);
    expect(second.map((notice) => notice.actorId)).toEqual(["bob", "carol"]);
  });

  test("a cancellation removes only that person's notice", () => {
    const notices = [
      { nestId: "nest-1", actorId: "bob", actorName: "Bob", receivedAt: 100 },
      { nestId: "nest-1", actorId: "carol", actorName: "Carol", receivedAt: 120 },
    ];
    const cancelled = applyEntryUpdate(notices, { type: "nest.entering.cancelled", nestId: "nest-1", actorId: "bob" }, 200);
    expect(cancelled.map((notice) => notice.actorId)).toEqual(["carol"]);
    // Cancelling something that is not shown leaves the list untouched (no re-render).
    expect(applyEntryUpdate(cancelled, { type: "nest.entering.cancelled", nestId: "nest-1", actorId: "bob" }, 210)).toBe(cancelled);
  });

  test("ignores updates that do not say who or where", () => {
    expect(applyEntryUpdate([], { type: "nest.entering", nestId: "nest-1" }, 1)).toEqual([]);
    expect(applyEntryUpdate([], { type: "nest.entering", actorId: "bob" }, 1)).toEqual([]);
    expect(applyEntryUpdate([], { type: "nest.entering", nestId: "nest-1", actorId: "bob" }, 1)[0]?.actorName).toBe("Someone");
  });
});

describe("derivePeople", () => {
  test("uses direct friend presence and places available friends before offline ones", () => {
    const home = {
      user: { id: "self" },
      friends: [
        { userId: "offline-friend", username: "offline", displayName: "Offline friend", presenceState: "offline", reachability: "unavailable" },
        { userId: "dnd-friend", username: "dnd", displayName: "DND friend", presenceState: "dnd", reachability: "unavailable" },
      ],
      activeNests: [],
      pendingKnocks: [],
      incomingFriendRequests: [],
      outgoingFriendRequests: [],
    } as HomeState;
    const treeDetails = {
      team: {
        tree: { id: "team" },
        members: [
          { userId: "dnd-friend", username: "dnd", displayName: "DND friend", presenceState: "available", reachability: "open" },
          { userId: "context-person", username: "context", displayName: "Context person", presenceState: "available", reachability: "focused" },
        ],
      },
    } as Record<string, TreeDetails>;

    const people = derivePeople(home, treeDetails);

    expect(people.map((person) => [person.id, person.presence])).toEqual([
      ["dnd-friend", "dnd"],
      ["offline-friend", "offline"],
      ["context-person", "focused"],
    ]);
  });
});

describe("server properties after a failed fetch", () => {
  const answer = { name: "Home", description: "", avatar: "", rtcServerUrl: "wss://rtc.example", properties: { chat: { enabled: true } } };

  test("a failure after an answer keeps the answer", async () => {
    const { resolveServerProperties } = await import("./useRavenShellData");
    const first = resolveServerProperties("https://a.example", answer, null);
    const blip = resolveServerProperties("https://a.example", null, first.lastGood);
    expect(blip.properties).toBe(first.properties);
    expect(blip.properties.properties.chat).toEqual({ enabled: true });
  });

  test("before any answer, or for another server, the defaults stand in, with no call address", async () => {
    const { resolveServerProperties } = await import("./useRavenShellData");
    expect(resolveServerProperties("https://a.example", null, null).properties.rtcServerUrl).toBe("");
    const first = resolveServerProperties("https://a.example", answer, null);
    const other = resolveServerProperties("https://b.example", null, first.lastGood);
    expect(other.properties.properties).toEqual({});
    expect(other.properties.rtcServerUrl).toBe("");
  });
});
