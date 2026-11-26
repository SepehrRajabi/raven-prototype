import { describe, expect, test } from "bun:test";
import {
  applyChanges,
  applySeen,
  DEFAULT_SETTINGS,
  setReactionsLocally,
  applyEvent,
  applyList,
  applyOwnMessage,
  applyPage,
  applySummary,
  applyPins,
  addPending,
  emptyChatState,
  excerptOf,
  expireTyping,
  hasUnread,
  listedConversations,
  markReadLocally,
  nextTypingExpiry,
  setPinsFailed,
  setPinsLoading,
  syncPinned,
  treeHasUnread,
  TYPING_TTL_MS,
  unreadLabel,
  WINDOW_MAX,
  WINDOW_TRIM_TO,
} from "./reducer";
import { UNREAD_CAP, type ChatConversation, type ChatMessage, type ChatPage, type ChatState, type PendingMessage } from "./types";

const ME = "me";
const AVA = "ava";
const C = "conversation-1";
const NOW = 1_700_000_000_000;

function summary(patch: Partial<ChatConversation> = {}): ChatConversation {
  return {
    id: C,
    kind: "dm",
    name: "Ava",
    topic: "",
    peer: { id: AVA, username: "ava", displayName: "Ava" },
    role: "member",
    canSend: true,
    canManage: false,
    memberCount: 2,
    lastSeq: 0,
    lastActivityMs: 0,
    unreadCount: 0,
    readSeq: 0,
    peerReadSeq: 0,
    hideRev: 0,
    visibleFromSeq: 0,
    archived: false,
    createdAt: "2026-10-11T10:00:00Z",
    ...patch,
  };
}

function message(seq: number, patch: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `m${seq}`,
    conversationId: C,
    seq,
    changedSeq: seq,
    senderId: AVA,
    senderName: "Ava",
    clientMessageId: `client-${seq}`,
    kind: "text",
    body: `message ${seq}`,
    createdAt: "2026-10-11T10:00:00Z",
    ...patch,
  };
}

function page(messages: ChatMessage[], patch: Partial<ChatPage> = {}): ChatPage {
  return {
    messages,
    hasMoreBefore: false,
    hasMoreAfter: false,
    asOfSeq: messages.length ? Math.max(...messages.map((item) => item.changedSeq)) : 0,
    me: { readSeq: 0, hideRev: 0, visibleFromSeq: 0 },
    ...patch,
  };
}

/** A state with the conversation listed and, when messages are given, its window loaded. */
function chat(patch: Partial<ChatConversation> = {}, loaded?: ChatMessage[], pagePatch: Partial<ChatPage> = {}): ChatState {
  const listed = applyList(emptyChatState(ME), [summary(patch)], { ...DEFAULT_SETTINGS, shareReadStatus: true, readDm: true }).state;
  if (!loaded) return listed;
  return applyPage(listed, C, page(loaded, pagePatch), "replace").state;
}

const created = (seq: number, patch: Partial<ChatMessage> = {}) => ({ type: "message.created", conversationId: C, seq, message: message(seq, patch) });
const seqs = (state: ChatState) => state.conversations[C].messages.map((item) => item.seq);
/** The list entry's preview of message `seq`, as the server would send it. */
const preview = (seq: number) => ({ id: `m${seq}`, seq, senderId: AVA, senderName: "Ava", kind: "text" as const, excerpt: `message ${seq}`, createdAt: "2026-10-11T10:00:00Z" });

describe("events in order", () => {
  test("a new message from someone else is appended, counted and previewed", () => {
    const start = chat({ lastSeq: 2 }, [message(1), message(2)]);
    const { state, effects } = applyEvent(start, created(3, { body: "the  third\nmessage" }), NOW);
    const conversation = state.conversations[C];

    expect(effects).toEqual([]);
    expect(seqs(state)).toEqual([1, 2, 3]);
    expect(conversation.syncedSeq).toBe(3);
    expect(conversation.summary.lastSeq).toBe(3);
    expect(conversation.summary.unreadCount).toBe(1);
    expect(conversation.summary.lastMessage?.excerpt).toBe("the third message");
  });

  test("the same event twice changes nothing the second time", () => {
    const start = chat({ lastSeq: 2 }, [message(1), message(2)]);
    const once = applyEvent(start, created(3), NOW).state;
    const twice = applyEvent(once, created(3), NOW);

    expect(twice.effects).toEqual([]);
    expect(seqs(twice.state)).toEqual([1, 2, 3]);
    expect(twice.state.conversations[C].summary.unreadCount).toBe(1);
    expect(twice.state.conversations[C].syncedSeq).toBe(3);
  });

  test("an event the list already covered is not counted again", () => {
    // The list was fetched after message 3 was stored; its event arrives afterwards.
    const start = chat({ lastSeq: 3, unreadCount: 3 });
    const { state } = applyEvent(start, created(3), NOW);
    expect(state.conversations[C].summary.unreadCount).toBe(3);
  });

  test("Saved messages never counts as unread", () => {
    const start = chat({ kind: "saved", unreadCount: 0 }, [message(1), message(2)]);
    const { state } = applyEvent(start, created(3), NOW);
    expect(state.conversations[C].summary.unreadCount).toBe(0);
    expect(seqs(state)).toEqual([1, 2, 3]);
  });

  test("my own message marks the conversation read and is not unread", () => {
    const start = chat({ lastSeq: 2, unreadCount: 2 }, [message(1), message(2)]);
    const { state } = applyEvent(start, created(3, { senderId: ME }), NOW);
    expect(state.conversations[C].summary.unreadCount).toBe(0);
    expect(state.conversations[C].summary.readSeq).toBe(3);
  });

  test("a message from the other person in a direct message shows they read up to it", () => {
    const start = chat({ lastSeq: 2, peerReadSeq: 1 });
    expect(applyEvent(start, created(3), NOW).state.conversations[C].summary.peerReadSeq).toBe(3);
    // When read status is not shared there is nothing to update.
    const hidden = chat({ lastSeq: 2, peerReadSeq: undefined });
    expect(applyEvent(hidden, created(3), NOW).state.conversations[C].summary.peerReadSeq).toBeUndefined();
  });

  test("a new message brings an archived conversation back", () => {
    const start = chat({ lastSeq: 2, archived: true });
    expect(applyEvent(start, created(3), NOW).state.conversations[C].summary.archived).toBe(false);
  });

  test("a system line asks for the conversation's details again and is not unread", () => {
    const start = chat({ kind: "group", lastSeq: 1 });
    const { state, effects } = applyEvent(start, created(2, { kind: "system", body: "", system: { event: "members_added" } }), NOW);
    expect(effects).toEqual([{ type: "fetchSummary", conversationId: C }]);
    expect(state.conversations[C].summary.unreadCount).toBe(0);
  });
});

describe("gaps", () => {
  test("an event further ahead than the next seq fetches what was missed and does not skip ahead", () => {
    const start = chat({ lastSeq: 2 }, [message(1), message(2)]);
    const { state, effects } = applyEvent(start, created(5), NOW);

    expect(effects).toContainEqual({ type: "fetchChanges", conversationId: C, after: 2 });
    expect(effects).toContainEqual({ type: "fetchSummary", conversationId: C });
    expect(state.conversations[C].syncedSeq).toBe(2);
    // The message itself is kept; the fetch fills in what lies between.
    expect(seqs(state)).toEqual([1, 2, 5]);
  });

  test("the fetched changes close the gap", () => {
    const start = chat({ lastSeq: 2 }, [message(1), message(2)]);
    const gapped = applyEvent(start, created(5), NOW).state;
    const { state, effects } = applyChanges(gapped, C, { messages: [message(3), message(4), message(5)], reset: false, asOfSeq: 5, me: { readSeq: 0, hideRev: 0, visibleFromSeq: 0 } });

    expect(effects).toEqual([]);
    expect(seqs(state)).toEqual([1, 2, 3, 4, 5]);
    expect(state.conversations[C].syncedSeq).toBe(5);
  });

  test("a change this person may not see still moves the sequence on", () => {
    const start = chat({ lastSeq: 2 }, [message(1), message(2)]);
    const { state, effects } = applyEvent(start, { type: "conversation.bump", conversationId: C, seq: 3 }, NOW);
    expect(effects).toEqual([]);
    expect(state.conversations[C].syncedSeq).toBe(3);
    expect(state.conversations[C].summary.lastSeq).toBe(3);
    expect(applyEvent(state, created(4), NOW).effects).toEqual([]);
  });

  test("for a conversation that is not open, a gap refetches its list entry instead of guessing the count", () => {
    const start = chat({ lastSeq: 2, unreadCount: 1 });
    const { state, effects } = applyEvent(start, created(5), NOW);
    expect(effects).toEqual([{ type: "fetchSummary", conversationId: C }]);
    expect(state.conversations[C].summary.unreadCount).toBe(1);
    expect(state.conversations[C].messages).toEqual([]);
  });

  test("when too much changed the window is reloaded rather than patched", () => {
    const start = chat({ lastSeq: 2 }, [message(1), message(2)]);
    const { effects } = applyChanges(start, C, { messages: [], reset: true, asOfSeq: 900, me: { readSeq: 0, hideRev: 0, visibleFromSeq: 0 } });
    expect(effects).toEqual([{ type: "reload", conversationId: C }]);
  });
});

describe("edits, deletes and late copies", () => {
  test("an edit replaces the message in place", () => {
    const start = chat({ lastSeq: 2 }, [message(1), message(2)]);
    const edited = message(1, { changedSeq: 3, body: "corrected", editedAt: "2026-10-11T10:05:00Z" });
    const { state } = applyEvent(start, { type: "message.updated", conversationId: C, seq: 3, message: edited }, NOW);
    expect(state.conversations[C].messages[0].body).toBe("corrected");
    expect(state.conversations[C].syncedSeq).toBe(3);
    expect(seqs(state)).toEqual([1, 2]);
  });

  test("an older copy arriving late does not undo a newer one", () => {
    const start = chat({ lastSeq: 3 }, [message(1, { changedSeq: 3, body: "corrected" }), message(2)]);
    // A history page read before the edit is merged after it.
    const { state } = applyPage(start, C, page([message(1, { body: "original" })], { asOfSeq: 2 }), "older");
    expect(state.conversations[C].messages[0].body).toBe("corrected");
  });

  test("a page older than the window pulls the mark back and asks for what it may have missed", () => {
    const start = chat({ lastSeq: 12 }, [message(11), message(12)], { hasMoreBefore: true, asOfSeq: 12 });
    // The page was read when the conversation was at 10; an edit at 12 touched message 9.
    const { state, effects } = applyPage(start, C, page([message(9), message(10)], { asOfSeq: 10, hasMoreBefore: true }), "older");
    expect(seqs(state)).toEqual([9, 10, 11, 12]);
    expect(state.conversations[C].syncedSeq).toBe(10);
    expect(effects).toEqual([{ type: "fetchChanges", conversationId: C, after: 10 }]);
  });

  test("deleting an unread message takes it off the count", () => {
    const start = chat({ lastSeq: 2, unreadCount: 2, readSeq: 0, lastMessage: preview(2) }, [message(1), message(2)]);
    const deleted = message(2, { changedSeq: 3, body: "", deletedAt: "2026-10-11T10:05:00Z" });
    const { state } = applyEvent(start, { type: "message.updated", conversationId: C, seq: 3, message: deleted }, NOW);
    expect(state.conversations[C].summary.unreadCount).toBe(1);
    expect(state.conversations[C].messages[1].deletedAt).toBeTruthy();
    expect(state.conversations[C].summary.lastMessage?.deleted).toBe(true);
  });

  test("at the cap the count is fetched again, because it cannot be worked out", () => {
    const start = chat({ lastSeq: 200, unreadCount: UNREAD_CAP });
    const deleted = message(150, { changedSeq: 201, body: "", deletedAt: "2026-10-11T10:05:00Z" });
    const { state, effects } = applyEvent(start, { type: "message.updated", conversationId: C, seq: 201, message: deleted }, NOW);
    expect(effects).toEqual([{ type: "fetchSummary", conversationId: C }]);
    expect(state.conversations[C].summary.unreadCount).toBe(UNREAD_CAP);
  });

  test("a message I removed for myself on another device disappears here", () => {
    const start = chat({ lastSeq: 2, unreadCount: 2, lastMessage: preview(2) }, [message(1), message(2)]);
    const { state, effects } = applyEvent(start, { type: "message.hidden", conversationId: C, messageId: "m2", hideRev: 1, unreadCount: 1 }, NOW);
    expect(seqs(state)).toEqual([1]);
    expect(state.conversations[C].summary.hideRev).toBe(1);
    expect(state.conversations[C].summary.unreadCount).toBe(1);
    // It was the preview, so the entry is fetched again to find the one before it.
    expect(effects).toEqual([{ type: "fetchSummary", conversationId: C }]);
  });
});

describe("my own sends", () => {
  const pending: PendingMessage = { clientMessageId: "client-3", conversationId: C, body: "message 3", createdAt: "2026-10-11T10:00:00Z", state: "sending", attempts: 1 };

  test("the event arriving before the answer leaves one message and no pending row", () => {
    const start = addPending(chat({ lastSeq: 2 }, [message(1), message(2)]), pending);
    const afterEvent = applyEvent(start, created(3, { senderId: ME }), NOW).state;
    expect(afterEvent.conversations[C].pending).toEqual([]);
    const afterAnswer = applyOwnMessage(afterEvent, message(3, { senderId: ME }));
    expect(seqs(afterAnswer.state)).toEqual([1, 2, 3]);
    expect(afterAnswer.effects).toEqual([]);
  });

  test("the answer arriving before the event leaves one message too", () => {
    const start = addPending(chat({ lastSeq: 2 }, [message(1), message(2)]), pending);
    const afterAnswer = applyOwnMessage(start, message(3, { senderId: ME })).state;
    expect(afterAnswer.conversations[C].pending).toEqual([]);
    const afterEvent = applyEvent(afterAnswer, created(3, { senderId: ME }), NOW);
    expect(seqs(afterEvent.state)).toEqual([1, 2, 3]);
    expect(afterEvent.state.conversations[C].syncedSeq).toBe(3);
  });

  test("an answer that is ahead of the stream is not treated as a gap", () => {
    // Ava's message 3 and my message 4 were stored; my answer comes back first.
    const start = addPending(chat({ lastSeq: 2 }, [message(1), message(2)]), { ...pending, clientMessageId: "client-4" });
    const answered = applyOwnMessage(start, message(4, { senderId: ME }));
    expect(answered.effects).toEqual([]);
    expect(answered.state.conversations[C].syncedSeq).toBe(2);
    expect(seqs(answered.state)).toEqual([1, 2, 4]);

    // The stream then delivers both in order and the mark catches up without a fetch.
    const three = applyEvent(answered.state, created(3), NOW);
    const four = applyEvent(three.state, created(4, { senderId: ME }), NOW);
    expect(three.effects).toEqual([]);
    expect(four.effects).toEqual([]);
    expect(seqs(four.state)).toEqual([1, 2, 3, 4]);
    expect(four.state.conversations[C].syncedSeq).toBe(4);
    // I had just written here, so nothing before it counts as unread.
    expect(four.state.conversations[C].summary.unreadCount).toBe(0);
  });

  test("my own edit and delete answers are merged like any change", () => {
    const start = chat({ lastSeq: 2 }, [message(1, { senderId: ME }), message(2)]);
    const edited = applyOwnMessage(start, message(1, { senderId: ME, changedSeq: 3, body: "fixed" }));
    expect(edited.state.conversations[C].messages[0].body).toBe("fixed");
    expect(edited.state.conversations[C].syncedSeq).toBe(3);
  });
});

describe("the conversation list", () => {
  test("conversations that are gone from the list are dropped", () => {
    const start = chat({ lastSeq: 2 });
    const { state } = applyList(start, [], { ...DEFAULT_SETTINGS, shareReadStatus: false, readDm: false });
    expect(state.conversations).toEqual({});
    expect(state.settings.shareReadStatus).toBe(false);
    expect(state.listLoaded).toBe(true);
  });

  test("after a reconnect, an open conversation that moved on asks for its changes", () => {
    const start = chat({ lastSeq: 2 }, [message(1), message(2)]);
    const { effects } = applyList(start, [summary({ lastSeq: 9, unreadCount: 7 })], { ...DEFAULT_SETTINGS, shareReadStatus: true, readDm: true });
    expect(effects).toEqual([{ type: "fetchChanges", conversationId: C, after: 2 }]);
  });

  test("a conversation that did not move asks for nothing", () => {
    const start = chat({ lastSeq: 2 }, [message(1), message(2)]);
    expect(applyList(start, [summary({ lastSeq: 2 })], { ...DEFAULT_SETTINGS, shareReadStatus: true, readDm: true }).effects).toEqual([]);
  });

  test("a sequence that went backwards means the server was rewound: start the window over", () => {
    const start = chat({ lastSeq: 40 }, [message(39), message(40)]);
    const { effects, state } = applyList(start, [summary({ lastSeq: 12 })], { ...DEFAULT_SETTINGS, shareReadStatus: true, readDm: true });
    expect(effects).toEqual([{ type: "reload", conversationId: C }]);
    expect(state.conversations[C].summary.lastSeq).toBe(12);
  });

  test("removing or clearing messages on another device reloads the window", () => {
    const start = chat({ lastSeq: 2 }, [message(1), message(2)]);
    expect(applyList(start, [summary({ lastSeq: 2, hideRev: 1 })], { ...DEFAULT_SETTINGS, shareReadStatus: true, readDm: true }).effects).toEqual([{ type: "reload", conversationId: C }]);
    expect(applyList(start, [summary({ lastSeq: 2, visibleFromSeq: 3 })], { ...DEFAULT_SETTINGS, shareReadStatus: true, readDm: true }).effects).toEqual([{ type: "reload", conversationId: C }]);
  });

  test("a list that is older than an event which arrived meanwhile does not undo the event", () => {
    const start = chat({ lastSeq: 2, unreadCount: 0 });
    const afterEvent = applyEvent(start, created(3), NOW).state;
    // The list request was already on its way and still says 2.
    const { state, effects } = applyList(afterEvent, [summary({ lastSeq: 2, unreadCount: 0 })], { ...DEFAULT_SETTINGS, shareReadStatus: true, readDm: true }, new Set([C]));
    expect(state.conversations[C].summary.lastSeq).toBe(3);
    expect(state.conversations[C].summary.unreadCount).toBe(1);
    expect(effects).toEqual([{ type: "fetchSummary", conversationId: C }]);
  });

  test("an event for a conversation that is not listed fetches it; one that was removed is dropped", () => {
    const empty = emptyChatState(ME);
    expect(applyEvent(empty, created(1), NOW).effects).toEqual([{ type: "fetchSummary", conversationId: C }]);
    expect(applyEvent(empty, { type: "typing", conversationId: C, userId: AVA }, NOW).effects).toEqual([]);

    const start = chat({ lastSeq: 2 }, [message(1), message(2)]);
    expect(applyEvent(start, { type: "conversation.removed", conversationId: C }, NOW).state.conversations).toEqual({});
    expect(applyEvent(start, { type: "conversation.changed", conversationId: C }, NOW).effects).toEqual([{ type: "fetchSummary", conversationId: C }]);
    expect(applyEvent(start, { type: "settings.changed", conversationId: "" }, NOW).effects).toEqual([{ type: "fetchList" }]);
  });

  test("an entry fetched on its own does not undo a newer event either", () => {
    const start = chat({ lastSeq: 2 });
    const afterEvent = applyEvent(start, created(3), NOW).state;
    const { state } = applySummary(afterEvent, summary({ lastSeq: 2, name: "Ava Renamed" }));
    expect(state.conversations[C].summary.lastSeq).toBe(3);
    expect(state.conversations[C].summary.unreadCount).toBe(1);
    expect(state.conversations[C].summary.name).toBe("Ava Renamed");
  });

  test("lists are split by kind and ordered by latest activity", () => {
    const listed = applyList(emptyChatState(ME), [
      summary({ id: "old", lastActivityMs: 10, lastSeq: 1 }),
      summary({ id: "new", lastActivityMs: 30, lastSeq: 2, unreadCount: 2 }),
      summary({ id: "archived", lastActivityMs: 50, lastSeq: 4, archived: true, unreadCount: 4 }),
      summary({ id: "nest", kind: "nest", treeId: "tree-1", lastActivityMs: 40, unreadCount: 1 }),
    ], { ...DEFAULT_SETTINGS, shareReadStatus: true, readDm: true }).state;

    expect(listedConversations(listed).map((item) => item.summary.id)).toEqual(["new", "old"]);
    expect(listedConversations(listed, true).map((item) => item.summary.id)).toEqual(["archived"]);
    expect(treeHasUnread(listed, "tree-1")).toBe(true);
    expect(treeHasUnread(listed, "tree-2")).toBe(false);
    expect(hasUnread(listed)).toBe(true);
    expect(hasUnread(applyList(emptyChatState(ME), [summary({ archived: true, unreadCount: 3 })], { ...DEFAULT_SETTINGS, shareReadStatus: true, readDm: true }).state)).toBe(false);
  });

  test("a direct message nobody has written in is not listed until it has a message", () => {
    const empty = applyList(emptyChatState(ME), [
      summary({ id: "empty", lastActivityMs: 90 }),
      summary({ id: "group", kind: "group", peer: undefined, name: "Crew", lastActivityMs: 20 }),
    ], { ...DEFAULT_SETTINGS, shareReadStatus: true, readDm: true }).state;
    expect(listedConversations(empty).map((item) => item.summary.id)).toEqual(["group"]);

    const written = applyEvent(applyList(emptyChatState(ME), [summary({ id: C })], { ...DEFAULT_SETTINGS, shareReadStatus: true, readDm: true }).state, created(1), NOW).state;
    expect(listedConversations(written).map((item) => item.summary.id)).toEqual([C]);
  });
});

describe("who has seen the last message", () => {
  const BEA = "bea";
  const group = (patch: Partial<ChatState["conversations"][string]> = {}): ChatState => {
    const start = chat({ kind: "group", peer: undefined, lastSeq: 3, memberCount: 3 }, [message(1), message(2), message(3, { senderId: ME })]);
    const members = [AVA, BEA].map((id) => ({ id, username: id, displayName: id.toUpperCase(), role: "member" as const, joinedAt: "2026-10-11T10:00:00Z" }));
    return { ...start, conversations: { ...start.conversations, [C]: { ...start.conversations[C], members, seen: { seq: 3, readers: [] }, ...patch } } };
  };
  const read = (userId: string, readSeq: number, readAt?: string) => ({ type: "conversation.read", conversationId: C, userId, readSeq, readAt });

  test("a group read adds a reader, and a second read of the same person only moves their time", () => {
    const first = applyEvent(group(), read(AVA, 3, "2026-10-11T10:05:00Z"), NOW);
    expect(first.effects).toEqual([]);
    expect(first.state.conversations[C].seen?.readers).toEqual([{ userId: AVA, username: AVA, displayName: "AVA", at: "2026-10-11T10:05:00Z" }]);
    const again = applyEvent(first.state, read(AVA, 3, "2026-10-11T10:06:00Z"), NOW).state;
    expect(again.conversations[C].seen?.readers.map((reader) => reader.at)).toEqual(["2026-10-11T10:06:00Z"]);
  });

  test("a read short of the last message adds nobody, and my own read is not a reader", () => {
    const state = applyEvent(group(), read(AVA, 2), NOW).state;
    expect(state.conversations[C].seen?.readers).toEqual([]);
    expect(applyEvent(group(), read(ME, 3), NOW).state.conversations[C].seen?.readers).toEqual([]);
  });

  test("a group read short of the last message still moves how far someone has read, and a new message keeps it", () => {
    const state = applyEvent(group(), read(AVA, 2), NOW).state;
    expect(state.conversations[C].seen?.readSeq).toBe(2);
    expect(applyEvent(state, read(BEA, 1), NOW).state.conversations[C].seen?.readSeq).toBe(2);
    expect(applyEvent(group(), read(ME, 3), NOW).state.conversations[C].seen?.readSeq).toBeUndefined();
    const after = applyEvent(state, created(4, { senderId: ME }), NOW).state;
    expect(after.conversations[C].seen).toMatchObject({ seq: 4, readers: [], readSeq: 2 });
  });

  test("a reader who is not a known member is fetched instead of guessed", () => {
    const { effects } = applyEvent(group(), read("zed", 3), NOW);
    expect(effects).toEqual([{ type: "fetchSeen", conversationId: C }]);
  });

  test("a new message clears the readers but keeps how far they read", () => {
    const seen = applyEvent(group(), read(AVA, 3, "2026-10-11T10:05:00Z"), NOW).state;
    const next = applyEvent(seen, created(4, { senderId: ME }), NOW).state;
    expect(next.conversations[C].seen).toEqual({ seq: 4, readers: [], readSeq: 3 });
  });

  test("a new message from someone else clears the readers too, and their reads fill in again", () => {
    const seen = applyEvent(group(), read(AVA, 3, "2026-10-11T10:05:00Z"), NOW).state;
    const next = applyEvent(seen, created(4, { senderId: BEA }), NOW).state;
    expect(next.conversations[C].seen).toEqual({ seq: 4, readers: [], readSeq: 3 });
    const later = applyEvent(next, read(AVA, 4, "2026-10-11T10:06:00Z"), NOW).state;
    expect(later.conversations[C].seen?.readers).toEqual([{ userId: AVA, username: AVA, displayName: "AVA", at: "2026-10-11T10:06:00Z" }]);
  });

  test("conversation.seen asks for the list again", () => {
    expect(applyEvent(group(), { type: "conversation.seen", conversationId: C }, NOW).effects).toEqual([{ type: "fetchSeen", conversationId: C }]);
  });

  test("an answer older than the last message is dropped", () => {
    const state = group();
    expect(applySeen(state, C, { seq: 2, readers: [] })).toBe(state);
    const fresh = applySeen(state, C, { seq: 3, readers: [{ userId: BEA, username: BEA, displayName: "BEA", at: "x" }] });
    expect(fresh.conversations[C].seen?.readers).toHaveLength(1);
  });

  test("peerReadAt follows the other person's read in a direct message", () => {
    const start = chat({ lastSeq: 5, peerReadSeq: 1, peerReadAt: "2026-10-11T10:00:00Z" });
    const state = applyEvent(start, read(AVA, 4, "2026-10-11T10:09:00Z"), NOW).state;
    expect(state.conversations[C].summary.peerReadSeq).toBe(4);
    expect(state.conversations[C].summary.peerReadAt).toBe("2026-10-11T10:09:00Z");
  });
});

describe("read position and typing", () => {
  test("my read position from another device updates the count; the other person's updates their tick", () => {
    const start = chat({ lastSeq: 5, unreadCount: 5, peerReadSeq: 1 });
    const mine = applyEvent(start, { type: "conversation.read", conversationId: C, userId: ME, readSeq: 4, unreadCount: 1 }, NOW).state;
    expect(mine.conversations[C].summary.readSeq).toBe(4);
    expect(mine.conversations[C].summary.unreadCount).toBe(1);

    const theirs = applyEvent(mine, { type: "conversation.read", conversationId: C, userId: AVA, readSeq: 3 }, NOW).state;
    expect(theirs.conversations[C].summary.peerReadSeq).toBe(3);
    expect(theirs.conversations[C].summary.readSeq).toBe(4);

    // Neither ever moves back.
    const stale = applyEvent(theirs, { type: "conversation.read", conversationId: C, userId: ME, readSeq: 2, unreadCount: 3 }, NOW).state;
    expect(stale.conversations[C].summary.readSeq).toBe(4);
    expect(applyEvent(stale, { type: "conversation.read", conversationId: C, userId: AVA, readSeq: 1 }, NOW).state.conversations[C].summary.peerReadSeq).toBe(3);
  });

  test("reading updates the count at once", () => {
    const start = chat({ lastSeq: 3, unreadCount: 3 }, [message(1), message(2), message(3)]);
    const partly = markReadLocally(start, C, 2);
    expect(partly.conversations[C].summary.readSeq).toBe(2);
    expect(partly.conversations[C].summary.unreadCount).toBe(1);
    const fully = markReadLocally(partly, C, 99);
    expect(fully.conversations[C].summary.readSeq).toBe(3);
    expect(fully.conversations[C].summary.unreadCount).toBe(0);
    expect(markReadLocally(fully, C, 1)).toBe(fully);
  });

  test("typing shows until it runs out or the person's message arrives", () => {
    const start = chat({ lastSeq: 2 }, [message(1), message(2)]);
    const typing = applyEvent(start, { type: "typing", conversationId: C, userId: AVA, userName: "Ava" }, NOW).state;
    expect(typing.conversations[C].typing[AVA]).toEqual({ name: "Ava", until: NOW + TYPING_TTL_MS });
    expect(nextTypingExpiry(typing)).toBe(NOW + TYPING_TTL_MS);

    expect(expireTyping(typing, NOW + 1000)).toBe(typing);
    expect(expireTyping(typing, NOW + TYPING_TTL_MS + 1).conversations[C].typing).toEqual({});
    expect(applyEvent(typing, created(3), NOW).state.conversations[C].typing).toEqual({});
    // My own typing, echoed from another device, is not shown to me.
    expect(applyEvent(start, { type: "typing", conversationId: C, userId: ME }, NOW).state).toBe(start);
  });
});

describe("long conversations", () => {
  const many = (from: number, count: number) => Array.from({ length: count }, (_, index) => message(from + index));

  test("following the newest messages lets go of the oldest", () => {
    let state = chat({ lastSeq: WINDOW_MAX }, many(1, WINDOW_MAX));
    state = applyEvent(state, created(WINDOW_MAX + 1), NOW, true).state;
    const conversation = state.conversations[C];
    expect(conversation.messages.length).toBe(WINDOW_TRIM_TO);
    expect(conversation.messages[conversation.messages.length - 1].seq).toBe(WINDOW_MAX + 1);
    expect(conversation.hasMoreBefore).toBe(true);
    expect(conversation.hasMoreAfter).toBe(false);
  });

  test("while reading further up, a full window stops following instead of pushing the reader out", () => {
    let state = chat({ lastSeq: WINDOW_MAX }, many(1, WINDOW_MAX));
    state = applyEvent(state, created(WINDOW_MAX + 1), NOW, false).state;
    const conversation = state.conversations[C];
    expect(conversation.messages.length).toBe(WINDOW_MAX);
    expect(conversation.messages[0].seq).toBe(1);
    expect(conversation.hasMoreAfter).toBe(true);
    // The list entry still knows about it.
    expect(conversation.summary.lastSeq).toBe(WINDOW_MAX + 1);
    expect(conversation.summary.unreadCount).toBe(1);
  });

  test("paging back in a full window lets go of the newest end", () => {
    const start = chat({ lastSeq: 1000 }, many(401, WINDOW_MAX), { hasMoreBefore: true, asOfSeq: 1000 });
    const { state } = applyPage(start, C, page(many(351, 50), { hasMoreBefore: true, asOfSeq: 1000 }), "older");
    const conversation = state.conversations[C];
    expect(conversation.messages.length).toBe(WINDOW_TRIM_TO);
    expect(conversation.messages[0].seq).toBe(351);
    expect(conversation.hasMoreAfter).toBe(true);
  });

  test("a window that is not at the newest end ignores new messages but still takes changes to what it shows", () => {
    const start = chat({ lastSeq: 100 }, many(1, 50), { hasMoreAfter: true, asOfSeq: 100 });
    const withNew = applyEvent(start, created(101), NOW).state;
    expect(withNew.conversations[C].messages.length).toBe(50);
    expect(withNew.conversations[C].syncedSeq).toBe(101);

    const edited = message(10, { changedSeq: 102, body: "edited" });
    const withEdit = applyEvent(withNew, { type: "message.updated", conversationId: C, seq: 102, message: edited }, NOW).state;
    expect(withEdit.conversations[C].messages[9].body).toBe("edited");
  });
});

describe("small things", () => {
  test("excerpts are one line and capped by characters, not bytes", () => {
    expect(excerptOf("  two\n\nlines  here ")).toBe("two lines here");
    const persian = "سلام ".repeat(60).trim();
    expect(Array.from(excerptOf(persian)).length).toBe(141);
    expect(excerptOf("👨‍👩‍👧".repeat(10))).toBe("👨‍👩‍👧".repeat(10));
  });

  test("unread labels stop at the cap", () => {
    expect(unreadLabel(0)).toBe("");
    expect(unreadLabel(7)).toBe("7");
    expect(unreadLabel(UNREAD_CAP)).toBe("99+");
    expect(unreadLabel(UNREAD_CAP + 50)).toBe("99+");
  });
});


describe("optimistic reactions", () => {
  const reactions = [{ emoji: "👍", count: 1, userIds: [ME] }];
  test("the local toggle keeps all revisions, activity, read state and preview", () => {
    const start = chat({ lastSeq: 1, lastMessage: preview(1) }, [message(1)]);
    const next = setReactionsLocally(start, C, "m1", reactions);
    expect(next.conversations[C].messages[0].reactions).toEqual(reactions);
    expect(next.conversations[C].messages[0].changedSeq).toBe(1);
    expect(next.conversations[C].syncedSeq).toBe(start.conversations[C].syncedSeq);
    expect(next.conversations[C].summary).toBe(start.conversations[C].summary);
    expect(setReactionsLocally(start, C, "missing", reactions)).toBe(start);
  });
  test("a higher server revision replaces optimism without bumping the conversation", () => {
    const start = chat({ lastSeq: 1, lastMessage: preview(1) }, [message(1)]);
    const optimistic = setReactionsLocally(start, C, "m1", reactions);
    const server = message(1, { changedSeq: 2, reactions: [{ emoji: "❤️", count: 1, userIds: [AVA] }] });
    const next = applyEvent(optimistic, { type: "message.updated", conversationId: C, seq: 2, message: server }, NOW).state;
    expect(next.conversations[C].messages[0]).toEqual(server);
    expect(next.conversations[C].summary.lastActivityMs).toBe(start.conversations[C].summary.lastActivityMs);
    expect(next.conversations[C].summary.unreadCount).toBe(start.conversations[C].summary.unreadCount);
  });
  test("an idempotent server answer at the same revision also corrects optimism", () => {
    const optimistic = setReactionsLocally(chat({ lastSeq: 1 }, [message(1)]), C, "m1", reactions);
    const next = applyOwnMessage(optimistic, message(1)).state;
    expect(next.conversations[C].messages[0].reactions).toBeUndefined();
  });
});

describe("mention count", () => {
  test("a message mentioning me counts; reading to the end or sending clears it", () => {
    const start = chat({ lastSeq: 2, unreadCount: 0, mentionCount: 0 });
    let state = applyEvent(start, created(3, { body: "hi <@u:me>" }), NOW).state;
    state = applyEvent(state, created(4, { body: "hi <@u:ava>" }), NOW).state;
    state = applyEvent(state, created(5, { body: "`<@u:me>` in code" }), NOW).state;
    expect(state.conversations[C].summary.mentionCount).toBe(1);
    expect(state.conversations[C].summary.unreadCount).toBe(3);
    const partly = applyEvent(state, { type: "conversation.read", conversationId: C, userId: ME, readSeq: 4, unreadCount: 1 }, NOW).state;
    expect(partly.conversations[C].summary.mentionCount).toBe(1);
    const all = applyEvent(state, { type: "conversation.read", conversationId: C, userId: ME, readSeq: 5, unreadCount: 0 }, NOW).state;
    expect(all.conversations[C].summary.mentionCount).toBe(0);
    const sent = applyEvent(state, created(6, { senderId: ME, body: "ok" }), NOW).state;
    expect(sent.conversations[C].summary.mentionCount).toBe(0);
  });
});

describe("a conversation that appears while the list is fetched", () => {
  test("is kept and fetched on its own when the older list does not have it", () => {
    const start = chat();
    const { state, effects } = applyList(start, [], { ...DEFAULT_SETTINGS }, new Set([C]));
    expect(state.conversations[C]).toBe(start.conversations[C]);
    expect(effects).toContainEqual({ type: "fetchSummary", conversationId: C });
  });

  test("is dropped as before when nothing happened to it during the fetch", () => {
    const { state } = applyList(chat(), [], { ...DEFAULT_SETTINGS });
    expect(state.conversations[C]).toBeUndefined();
  });
});

describe("pinned messages", () => {
  const pin = (at: string, byName = "Sara") => ({ byId: byName.toLowerCase(), byName, at });
  const room = (loaded?: ChatMessage[]) => chat({ kind: "nest", treeId: "t1", peer: undefined, lastSeq: 5 }, loaded);
  const pinned = (state: ChatState) => state.conversations[C].pins?.items.map((item) => item.id);
  const updated = (seq: number, at: number, patch: Partial<ChatMessage> = {}) => ({ type: "message.updated", conversationId: C, seq: at, message: message(seq, { changedSeq: at, ...patch }) });

  test("the list is newest pin first and holds only pinned messages that are still there", () => {
    const state = applyPins(room(), C, [
      message(1, { pin: pin("2026-11-01T10:00:00Z") }),
      message(2, { pin: pin("2026-11-03T10:00:00Z") }),
      message(3),
      message(4, { pin: pin("2026-11-04T10:00:00Z"), deletedAt: "2026-11-04T11:00:00Z" }),
    ]);
    expect(state.conversations[C].pins?.status).toBe("loaded");
    expect(pinned(state)).toEqual(["m2", "m1"]);
  });

  test("a message pinned by an event goes in at the top, even when its window is not loaded", () => {
    const start = applyPins(room(), C, [message(1, { pin: pin("2026-11-01T10:00:00Z") })]);
    const { state } = applyEvent(start, updated(3, 6, { pin: pin("2026-11-02T10:00:00Z") }), NOW);
    expect(pinned(state)).toEqual(["m3", "m1"]);
  });

  test("an unpin, a delete and a removal for me take it out", () => {
    const start = applyPins(room([message(1), message(2), message(3)]), C, [
      message(1, { pin: pin("2026-11-01T10:00:00Z") }),
      message(2, { pin: pin("2026-11-02T10:00:00Z") }),
      message(3, { pin: pin("2026-11-03T10:00:00Z") }),
    ]);
    const unpinned = applyEvent(start, updated(3, 6), NOW).state;
    expect(pinned(unpinned)).toEqual(["m2", "m1"]);
    const deleted = applyEvent(unpinned, updated(2, 7, { deletedAt: "2026-11-05T10:00:00Z", body: "" }), NOW).state;
    expect(pinned(deleted)).toEqual(["m1"]);
    const hidden = applyEvent(deleted, { type: "message.hidden", conversationId: C, messageId: "m1", hideRev: 1, unreadCount: 0 }, NOW).state;
    expect(pinned(hidden)).toEqual([]);
  });

  test("an older copy does not undo a newer pin, and the same copy twice changes nothing", () => {
    const start = applyPins(room(), C, [message(1, { changedSeq: 8, pin: pin("2026-11-01T10:00:00Z") })]);
    const late = applyEvent(start, updated(1, 6), NOW).state;
    expect(pinned(late)).toEqual(["m1"]);
    const items = late.conversations[C].pins!.items;
    expect(syncPinned(items, [items[0]])).toBe(items);
  });

  test("an edit of a pinned message replaces its copy in the list", () => {
    const start = applyPins(room(), C, [message(1, { pin: pin("2026-11-01T10:00:00Z") })]);
    const { state } = applyEvent(start, updated(1, 6, { body: "edited", pin: pin("2026-11-01T10:00:00Z") }), NOW);
    expect(state.conversations[C].pins?.items[0].body).toBe("edited");
  });

  test("history pages and caught-up changes keep it in step", () => {
    const start = applyPins(room([message(1)]), C, [message(1, { pin: pin("2026-11-01T10:00:00Z") })]);
    const paged = applyPage(start, C, page([message(2, { changedSeq: 6, pin: pin("2026-11-02T10:00:00Z") })], { asOfSeq: 6 }), "newer").state;
    expect(pinned(paged)).toEqual(["m2", "m1"]);
    const changed = applyChanges(paged, C, { messages: [message(1, { changedSeq: 7 })], reset: false, asOfSeq: 7, me: { readSeq: 0, hideRev: 0, visibleFromSeq: 0 } }).state;
    expect(pinned(changed)).toEqual(["m2"]);
  });

  test("my own pin, answered by the server, goes in", () => {
    const start = applyPins(room([message(1)]), C, []);
    const { state } = applyOwnMessage(start, message(1, { changedSeq: 6, pin: pin("2026-11-02T10:00:00Z", "Me") }));
    expect(pinned(state)).toEqual(["m1"]);
    expect(state.conversations[C].messages[0].pin?.byName).toBe("Me");
  });

  test("a pin with the same revision still corrects the window's copy", () => {
    const start = room([message(1)]);
    const { state } = applyEvent(start, { type: "message.updated", conversationId: C, seq: 6, message: message(1, { pin: pin("2026-11-02T10:00:00Z") }) }, NOW);
    expect(state.conversations[C].messages[0].pin).toBeDefined();
  });

  test("nothing is kept before the list is opened, and nothing changes while it loads", () => {
    const start = room([message(1)]);
    const event = updated(1, 6, { pin: pin("2026-11-02T10:00:00Z") });
    expect(applyEvent(start, event, NOW).state.conversations[C].pins).toBeUndefined();
    const loading = setPinsLoading(start, C);
    expect(loading.conversations[C].pins).toEqual({ status: "loading", items: [] });
    expect(applyEvent(loading, event, NOW).state.conversations[C].pins).toEqual({ status: "loading", items: [] });
  });

  test("a failed fetch shows its reason, but never hides a list already shown", () => {
    const failed = setPinsFailed(setPinsLoading(room(), C), C, "Couldn’t load.");
    expect(failed.conversations[C].pins).toEqual({ status: "error", items: [], error: "Couldn’t load." });
    const shown = applyPins(room(), C, [message(1, { pin: pin("2026-11-02T10:00:00Z") })]);
    expect(setPinsFailed(shown, C, "Couldn’t load.")).toBe(shown);
    expect(setPinsLoading(shown, C)).toBe(shown);
  });

  test("clearing the room for me forgets the list, so it is fetched again", () => {
    const shown = applyPins(room(), C, [message(1, { pin: pin("2026-11-02T10:00:00Z") })]);
    const cleared = applySummary(shown, summary({ kind: "nest", treeId: "t1", peer: undefined, lastSeq: 5, visibleFromSeq: 5 })).state;
    expect(cleared.conversations[C].pins).toBeUndefined();
    const relisted = applyList(shown, [summary({ kind: "nest", treeId: "t1", peer: undefined, lastSeq: 5, hideRev: 2 })], DEFAULT_SETTINGS).state;
    expect(relisted.conversations[C].pins).toBeUndefined();
    const unchanged = applySummary(shown, summary({ kind: "nest", treeId: "t1", peer: undefined, lastSeq: 5, name: "Renamed" })).state;
    expect(pinned(unchanged)).toEqual(["m1"]);
  });
});
