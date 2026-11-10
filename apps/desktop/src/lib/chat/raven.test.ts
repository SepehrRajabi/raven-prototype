import { describe, expect, test } from "bun:test";
import { applyEvent, applyList, DEFAULT_SETTINGS, emptyChatState } from "./reducer";
import { previewLine, ravenLine, UNKNOWN_RAVEN_MESSAGE } from "./text";
import type { ChatConversation } from "./types";

const ME = "me";
const raven: ChatConversation = {
  id: "r", kind: "raven", name: "Raven", topic: "", role: "owner", canSend: false, canManage: false, memberCount: 1,
  lastSeq: 0, lastActivityMs: 0, unreadCount: 0, readSeq: 0, hideRev: 0, visibleFromSeq: 0, archived: false, createdAt: "2026-11-10T10:00:00Z",
};
// Raven writes in the person's own name: the server records the recipient as sender.
const adminMessage = (seq: number, text: string) => ({
  type: "message.created", conversationId: "r", seq,
  message: { id: `m${seq}`, conversationId: "r", seq, changedSeq: seq, senderId: ME, senderName: "Me", clientMessageId: `c${seq}`, kind: "system" as const, body: "", system: { type: "admin", text }, createdAt: "2026-11-10T10:00:00Z" },
});

describe("the Raven contact", () => {
  test("a new message counts as unread even though the server records the person as sender", () => {
    const listed = applyList(emptyChatState(ME), [raven], { ...DEFAULT_SETTINGS, shareReadStatus: true, readDm: true }).state;
    const first = applyEvent(listed, adminMessage(1, "Maintenance tonight"), 1).state;
    expect(first.conversations.r.summary.unreadCount).toBe(1);
    expect(applyEvent(first, adminMessage(2, "Done"), 2).state.conversations.r.summary.unreadCount).toBe(2);
  });

  test("the list shows the admin's words as written, and old clients' unknown types are named", () => {
    expect(ravenLine({ type: "admin", text: "<@u:1> **hi**" })).toBe("<@u:1> **hi**");
    expect(ravenLine({ type: "poll" })).toBe(UNKNOWN_RAVEN_MESSAGE);
    const last = { id: "m", seq: 1, senderId: ME, senderName: "Me", kind: "system" as const, excerpt: "", system: { type: "admin", text: "Hello" }, createdAt: "" };
    expect(previewLine({ ...raven, lastMessage: last }, ME)).toBe("Hello");
  });
});
