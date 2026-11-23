import { describe, expect, test } from "bun:test";
import type { Knock } from "./api";
import type { ChatConversation, ChatState } from "./chat/types";
import type { VoiceOverlayHeadsUp } from "./voiceOverlay";
import {
  HEADS_UP_LEAVE_MS,
  HOLD_GRACE_MS,
  KNOCK_SHOW_MS,
  MESSAGE_SHOW_MS,
  MESSAGE_TEXT_MAX,
  NEW_TRACKER,
  NOTHING_SHOWN,
  advanceHeadsUp,
  closeHeadsUp,
  cutText,
  headsUpFirst,
  knockCandidates,
  knockIdOfLine,
  knockLineId,
  messageCandidates,
  nextHeadsUpWake,
  nextTrackerExpiry,
  showingLines,
  trackHeadsUp,
  type HeadsUpCandidate,
} from "./voiceOverlayHeadsUp";

const avatarUrl = (id: string) => `avatar/${id}`;

function candidate(id: string, eligible = true, kind: "knock" | "message" = "message"): HeadsUpCandidate {
  return { eligible, line: { id, kind, actorName: "Mina", avatarUrl: null, text: "hi" } };
}

function line(id: string, kind: "knock" | "message" = "message"): VoiceOverlayHeadsUp {
  return { id, kind, actorName: "Mina", avatarUrl: null, text: "hi", at: "2026-10-29T10:00:00.000Z" };
}

function knock(id: string, from = "Arash"): Knock {
  return {
    id,
    fromUserId: `u_${from}`,
    fromUsername: from.toLowerCase(),
    fromDisplayName: from,
    status: "pending",
    createdAt: "2026-10-29T10:00:00Z",
    expiresAt: "2026-10-29T10:05:00Z",
  } as Knock;
}

function conversation(patch: Partial<ChatConversation> & { id: string }, lastId: string, body = "hello"): ChatConversation {
  return {
    kind: "nest",
    name: "design",
    topic: "",
    treeId: "tree_a",
    role: "member",
    canSend: true,
    canManage: false,
    memberCount: 3,
    lastSeq: 5,
    lastActivityMs: 0,
    unreadCount: 1,
    readSeq: 0,
    hideRev: 0,
    visibleFromSeq: 0,
    archived: false,
    createdAt: "",
    lastMessage: { id: lastId, seq: 5, senderId: "u_mina", senderName: "Mina", kind: "text", excerpt: body, createdAt: "" },
    ...patch,
  };
}

function chatState(...conversations: ChatConversation[]): ChatState {
  return {
    conversations: Object.fromEntries(conversations.map((summary) => [summary.id, { summary }])),
  } as unknown as ChatState;
}

const baseMessages = { messages: "tree" as const, treeId: "tree_a", meId: "u_me", openConversationId: "", avatarUrl };

describe("tracking what is new", () => {
  test("what is already there on the first look is old news", () => {
    const first = trackHeadsUp(NEW_TRACKER, { candidates: [candidate("a")], ready: true, now: 1000, listedMs: 20_000 });
    expect(first.ready).toBe(true);
    expect(first.live).toEqual([]);
    const again = trackHeadsUp(first, { candidates: [candidate("a")], ready: true, now: 2000, listedMs: 20_000 });
    expect(again.live).toEqual([]);
  });

  test("nothing is consumed until the data is ready", () => {
    const waiting = trackHeadsUp(NEW_TRACKER, { candidates: [], ready: false, now: 1000, listedMs: 20_000 });
    expect(waiting).toBe(NEW_TRACKER);
    const first = trackHeadsUp(waiting, { candidates: [candidate("a")], ready: true, now: 2000, listedMs: 20_000 });
    expect(first.live).toEqual([]);
  });

  test("a new eligible candidate is listed with the time it was seen", () => {
    const first = trackHeadsUp(NEW_TRACKER, { candidates: [], ready: true, now: 0, listedMs: 20_000 });
    const next = trackHeadsUp(first, { candidates: [candidate("a")], ready: true, now: 5000, listedMs: 20_000 });
    expect(next.live.map((entry) => entry.line.id)).toEqual(["a"]);
    expect(next.live[0].seenAt).toBe(5000);
    expect(next.live[0].line.at).toBe(new Date(5000).toISOString());
  });

  test("a candidate that may not show is used up, so switching on later does not replay it", () => {
    const first = trackHeadsUp(NEW_TRACKER, { candidates: [], ready: true, now: 0, listedMs: 20_000 });
    const hidden = trackHeadsUp(first, { candidates: [candidate("a", false)], ready: true, now: 1000, listedMs: 20_000 });
    expect(hidden.live).toEqual([]);
    const later = trackHeadsUp(hidden, { candidates: [candidate("a", true)], ready: true, now: 2000, listedMs: 20_000 });
    expect(later.live).toEqual([]);
  });

  test("a line leaves when its candidate goes or can no longer show", () => {
    let tracker = trackHeadsUp(NEW_TRACKER, { candidates: [], ready: true, now: 0, listedMs: 60_000 });
    tracker = trackHeadsUp(tracker, { candidates: [candidate("k", true, "knock")], ready: true, now: 1000, listedMs: 60_000 });
    expect(tracker.live).toHaveLength(1);
    expect(trackHeadsUp(tracker, { candidates: [], ready: true, now: 2000, listedMs: 60_000 }).live).toEqual([]);
    expect(trackHeadsUp(tracker, { candidates: [candidate("k", false, "knock")], ready: true, now: 2000, listedMs: 60_000 }).live).toEqual([]);
  });

  test("a line is listed for a limited time, and the expiry says when", () => {
    let tracker = trackHeadsUp(NEW_TRACKER, { candidates: [], ready: true, now: 0, listedMs: 20_000 });
    tracker = trackHeadsUp(tracker, { candidates: [candidate("a")], ready: true, now: 1000, listedMs: 20_000 });
    expect(nextTrackerExpiry(tracker, 20_000)).toBe(21_000);
    const expired = trackHeadsUp(tracker, { candidates: [candidate("a")], ready: true, now: 21_000, listedMs: 20_000 });
    expect(expired.live).toEqual([]);
    expect(nextTrackerExpiry(expired, 20_000)).toBeNull();
    // Still the same message: it does not come back.
    const after = trackHeadsUp(expired, { candidates: [candidate("a")], ready: true, now: 22_000, listedMs: 20_000 });
    expect(after.live).toEqual([]);
  });

  test("an unchanged look returns the same tracker", () => {
    const first = trackHeadsUp(NEW_TRACKER, { candidates: [candidate("a")], ready: true, now: 0, listedMs: 20_000 });
    const again = trackHeadsUp(first, { candidates: [candidate("a")], ready: true, now: 100, listedMs: 20_000 });
    expect(again).toBe(first);
  });
});

describe("knocks", () => {
  test("a knock reads as the person's name and what they did", () => {
    const [entry] = knockCandidates({ knocks: [knock("k1")], enabled: true, avatarUrl, now: Date.parse("2026-10-29T10:06:00Z") });
    expect(entry.eligible).toBe(true);
    expect(entry.line).toMatchObject({ id: "knock:k1", kind: "knock", actorName: "Arash", text: "knocked 6 min ago", avatarUrl: "avatar/u_Arash" });
    expect(knockIdOfLine(entry.line.id)).toBe("k1");
    expect(knockIdOfLine("message:x")).toBeNull();
    expect(knockLineId("k1")).toBe("knock:k1");
  });

  test("the switch decides whether a knock may show", () => {
    expect(knockCandidates({ knocks: [knock("k1")], enabled: false, avatarUrl, now: 0 })[0].eligible).toBe(false);
  });

  test("falls back to the username", () => {
    const named = { ...knock("k2"), fromDisplayName: "" };
    expect(knockCandidates({ knocks: [named], enabled: true, avatarUrl, now: 0 })[0].line.actorName).toBe("arash");
  });
});

describe("messages", () => {
  const state = chatState(conversation({ id: "c1" }, "m1", "can someone check the build"));

  test("a text room of the call's tree shows the message with its room", () => {
    const [entry] = messageCandidates({ ...baseMessages, state });
    expect(entry.eligible).toBe(true);
    expect(entry.line).toMatchObject({
      id: "message:m1",
      kind: "message",
      actorName: "Mina",
      text: "in design: can someone check the build",
      avatarUrl: "avatar/u_mina",
    });
  });

  test("a mention shows as a name, before the line is cut", () => {
    const resolve = { nestSingular: "", person: (id: string) => (id === "u_sam" ? { name: "Sam", username: "sam" } : null), nest: () => null };
    const long = `${"a".repeat(70)} <@u:u_sam>`;
    const [entry] = messageCandidates({ ...baseMessages, state: chatState(conversation({ id: "c1" }, "m1", long)), resolve });
    expect(entry.line.text).toBe(`in design: ${"a".repeat(70)} Sam`);
  });

  test("off shows nothing but still counts the message as seen", () => {
    const [entry] = messageCandidates({ ...baseMessages, messages: "off", state });
    expect(entry.eligible).toBe(false);
  });

  test("nothing when the call is not in a tree", () => {
    expect(messageCandidates({ ...baseMessages, treeId: null, state })[0].eligible).toBe(false);
  });

  test("not another tree's room", () => {
    const other = chatState(conversation({ id: "c1", treeId: "tree_b" }, "m1"));
    expect(messageCandidates({ ...baseMessages, state: other })[0].eligible).toBe(false);
  });

  test("not direct messages or groups, which are not candidates at all", () => {
    const rooms = chatState(conversation({ id: "d1", kind: "dm", treeId: undefined }, "m1"), conversation({ id: "g1", kind: "group" }, "m2"));
    expect(messageCandidates({ ...baseMessages, state: rooms })).toEqual([]);
  });

  test("not your own message", () => {
    const own = chatState(
      conversation(
        {
          id: "c1",
          lastMessage: { id: "m1", seq: 5, senderId: "u_me", senderName: "Me", kind: "text", excerpt: "mine", createdAt: "" },
        },
        "m1",
      ),
    );
    expect(messageCandidates({ ...baseMessages, state: own })[0].eligible).toBe(false);
  });

  test("not the room open in a window you are looking at", () => {
    expect(messageCandidates({ ...baseMessages, state, openConversationId: "c1" })[0].eligible).toBe(false);
  });

  test("not a system line or a deleted message", () => {
    const system = chatState(
      conversation(
        { id: "c1", lastMessage: { id: "m1", seq: 5, senderId: "u_mina", senderName: "Mina", kind: "system", excerpt: "", createdAt: "" } },
        "m1",
      ),
    );
    expect(messageCandidates({ ...baseMessages, state: system })[0].eligible).toBe(false);
    const deleted = chatState(
      conversation(
        { id: "c1", lastMessage: { id: "m1", seq: 5, senderId: "u_mina", senderName: "Mina", kind: "text", excerpt: "oops", deleted: true, createdAt: "" } },
        "m1",
      ),
    );
    expect(messageCandidates({ ...baseMessages, state: deleted })[0].eligible).toBe(false);
  });

  test("a long message is cut with an ellipsis", () => {
    const long = chatState(conversation({ id: "c1" }, "m1", "word ".repeat(40)));
    const [entry] = messageCandidates({ ...baseMessages, state: long });
    expect(entry.line.text.startsWith("in design: ")).toBe(true);
    expect(entry.line.text.endsWith("…")).toBe(true);
    expect(entry.line.text.length).toBeLessThanOrEqual("in design: ".length + MESSAGE_TEXT_MAX);
  });

  test("a room without a name shows just the text", () => {
    const unnamed = chatState(conversation({ id: "c1", name: "" }, "m1", "hi there"));
    expect(messageCandidates({ ...baseMessages, state: unnamed })[0].line.text).toBe("hi there");
  });

  test("no chat means no candidates", () => {
    expect(messageCandidates({ ...baseMessages, state: null })).toEqual([]);
  });

  test("cutText keeps short text and counts characters, not code units", () => {
    expect(cutText("hello   world", 20)).toBe("hello world");
    expect(cutText("😀😀😀😀", 3)).toBe("😀😀…");
  });
});

describe("how long a line shows", () => {
  test("a new line shows, then folds away after its time, and does not come back", () => {
    const a = line("message:a");
    let state = advanceHeadsUp(NOTHING_SHOWN, [a], 0);
    expect(showingLines(state).map((entry) => entry.line.id)).toEqual(["message:a"]);
    expect(nextHeadsUpWake(state)).toBe(MESSAGE_SHOW_MS);

    expect(advanceHeadsUp(state, [a], MESSAGE_SHOW_MS - 1)).toBe(state);
    state = advanceHeadsUp(state, [a], MESSAGE_SHOW_MS);
    expect(showingLines(state)).toEqual([]);
    expect(state.shown).toHaveLength(1);
    expect(nextHeadsUpWake(state)).toBe(MESSAGE_SHOW_MS + HEADS_UP_LEAVE_MS);

    state = advanceHeadsUp(state, [a], MESSAGE_SHOW_MS + HEADS_UP_LEAVE_MS);
    expect(state.shown).toEqual([]);
    // The main window still lists it for a while; it must not start over.
    expect(advanceHeadsUp(state, [a], MESSAGE_SHOW_MS + 5000).shown).toEqual([]);
    // Once it is not listed, it is forgotten.
    expect(advanceHeadsUp(state, [], MESSAGE_SHOW_MS + 6000).done.size).toBe(0);
  });

  test("a knock stays for 30 seconds", () => {
    const k = line("knock:k1", "knock");
    const state = advanceHeadsUp(NOTHING_SHOWN, [k], 0);
    expect(showingLines(advanceHeadsUp(state, [k], KNOCK_SHOW_MS - 1))).toHaveLength(1);
    expect(showingLines(advanceHeadsUp(state, [k], KNOCK_SHOW_MS))).toHaveLength(0);
  });

  test("a knock that is dismissed folds away at once", () => {
    const k = line("knock:k1", "knock");
    let state = advanceHeadsUp(NOTHING_SHOWN, [k], 0);
    state = advanceHeadsUp(state, [], 4000);
    expect(showingLines(state)).toEqual([]);
    expect(state.shown[0].leavingAt).toBe(4000);
    expect(advanceHeadsUp(state, [], 4000 + HEADS_UP_LEAVE_MS).shown).toEqual([]);
  });

  test("an answered line folds away now and stays gone while it is still listed", () => {
    const k = line("knock:k1", "knock");
    let state = advanceHeadsUp(NOTHING_SHOWN, [k], 0);
    state = closeHeadsUp(state, "knock:k1", 1000);
    expect(showingLines(state)).toEqual([]);
    expect(closeHeadsUp(state, "knock:k1", 1100)).toBe(state);
    state = advanceHeadsUp(state, [k], 1000 + HEADS_UP_LEAVE_MS);
    expect(state.shown).toEqual([]);
    expect(advanceHeadsUp(state, [k], 5000).shown).toEqual([]);
  });

  test("at most two lines; a newer one pushes out the oldest", () => {
    const [a, b, c] = [line("message:a"), line("message:b"), line("message:c")];
    let state = advanceHeadsUp(NOTHING_SHOWN, [a, b], 0);
    expect(showingLines(state)).toHaveLength(2);
    state = advanceHeadsUp(state, [a, b, c], 1000);
    expect(showingLines(state).map((entry) => entry.line.id)).toEqual(["message:b", "message:c"]);
    // The pushed-out one does not return while it is still listed.
    state = advanceHeadsUp(state, [a, b, c], 1000 + HEADS_UP_LEAVE_MS);
    expect(showingLines(state).map((entry) => entry.line.id)).toEqual(["message:b", "message:c"]);
    expect(state.shown).toHaveLength(2);
  });

  test("a line the pointer rests on stays, then goes shortly after it leaves", () => {
    const a = line("message:a");
    const held = new Set(["message:a"]);
    let state = advanceHeadsUp(NOTHING_SHOWN, [a], 0);
    state = advanceHeadsUp(state, [a], MESSAGE_SHOW_MS + 4000, held);
    expect(showingLines(state)).toHaveLength(1);
    expect(nextHeadsUpWake(state, held)).toBeNull();
    const releasedAt = MESSAGE_SHOW_MS + 4000;
    expect(nextHeadsUpWake(state)).toBe(releasedAt + HOLD_GRACE_MS);
    expect(showingLines(advanceHeadsUp(state, [a], releasedAt + HOLD_GRACE_MS - 1))).toHaveLength(1);
    expect(showingLines(advanceHeadsUp(state, [a], releasedAt + HOLD_GRACE_MS))).toHaveLength(0);
  });
});

describe("where the lines go", () => {
  test("a column puts them at the end away from the edge it grows from", () => {
    expect(headsUpFirst("column", "bottomLeft")).toBe(true);
    expect(headsUpFirst("column", "bottomRight")).toBe(true);
    expect(headsUpFirst("column", "topLeft")).toBe(false);
    expect(headsUpFirst("column", "topRight")).toBe(false);
  });

  test("a row does the same along its length", () => {
    expect(headsUpFirst("row", "topRight")).toBe(true);
    expect(headsUpFirst("row", "bottomRight")).toBe(true);
    expect(headsUpFirst("row", "topLeft")).toBe(false);
    expect(headsUpFirst("row", "bottomLeft")).toBe(false);
  });
});
