import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { MentionResolver } from "@/lib/chat/mentions";
import type { ChatMessage } from "@/lib/chat/types";
if (typeof globalThis.localStorage === "undefined") {
  Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => undefined } });
}
const { MessageRow, PendingRow } = await import("./MessageRow");

const message: ChatMessage = {
  id: "m2", conversationId: "c1", seq: 2, changedSeq: 2, senderId: "sara", senderName: "Sara", clientMessageId: "client2", kind: "text", body: "Yes", createdAt: "2026-11-23T12:00:00Z",
};
const resolve: MentionResolver = { nestSingular: "", person: (id) => (id === "u1" ? { name: "Ava", username: "ava" } : null), nest: () => null };
const mentions = { resolve, me: "me" };
const replyTo = { id: "m1", seq: 1, senderId: "sam", senderName: "Sam", excerpt: "Poll in chats <@u:u1>" };
const noop = () => undefined;

describe("a quoted message that mentions someone", () => {
  test("shows the name, from the saved excerpt or the loaded original", () => {
    const row = (parent?: ChatMessage) => renderToStaticMarkup(<MessageRow message={{ ...message, replyTo }} parent={parent} mentions={mentions} mine={false} me="me" withAvatars showSender continuation={false} canReply canEdit={false} canDeleteForEveryone={false} onReply={noop} onEdit={noop} onRemoveForMe={noop} onDeleteForEveryone={noop} onOpenReply={noop} onOpenImage={noop} />);
    for (const html of [row(), row({ ...message, id: "m1", seq: 1, body: "Poll in chats <@u:u1>" })]) {
      expect(html).toContain("Poll in chats Ava");
      expect(html).not.toContain("@u:u1");
    }
  });

  test("shows the name while the reply is being sent", () => {
    const html = renderToStaticMarkup(<PendingRow pending={{ ...message, replyTo, state: "queued", attempts: 0 }} mentions={mentions} onRetry={noop} onDiscard={noop} />);
    expect(html).toContain("Poll in chats Ava");
    expect(html).not.toContain("@u:u1");
  });
});
