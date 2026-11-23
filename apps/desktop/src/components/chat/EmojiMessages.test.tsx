import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatMessage, PendingMessage } from "@/lib/chat/types";
if (typeof globalThis.localStorage === "undefined") {
  Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => undefined } });
}
const { MessageRow, PendingRow } = await import("./MessageRow");
const { MessageText } = await import("./MessageText");
const message: ChatMessage = {
  id: "m1", conversationId: "c1", seq: 1, changedSeq: 1, senderId: "sara", senderName: "Sara", clientMessageId: "client1", kind: "text", body: "😄", createdAt: "2026-10-30T12:00:00Z",
};
const noop = () => undefined;
function render(patch: Partial<ChatMessage> = {}, mine = false) {
  return renderToStaticMarkup(<MessageRow message={{ ...message, ...patch }} mine={mine} me="me" withAvatars showSender continuation={false} canReply canEdit canDeleteForEveryone onReply={noop} onEdit={noop} onRemoveForMe={noop} onDeleteForEveryone={noop} onOpenReply={noop} onOpenImage={noop} highlighted />);
}
describe("large emoji messages", () => {
  test("uses one of three dedicated sizes and preserves selectable text", () => {
    for (const [body, size] of [["😄", 1], ["🇮🇷 ❤️", 2], ["👍🏽 😄 ❤️", 3]] as const) {
      const html = renderToStaticMarkup(<MessageText body={body} />);
      expect(html).toContain(`text-emoji-${size}`); expect(html).toContain(body);
      expect(html).not.toContain("select-none");
    }
    expect(renderToStaticMarkup(<MessageText body="😄 hello" />)).toContain("text-body");
    expect(renderToStaticMarkup(<MessageText body="😄😄😄😄" />)).toContain("text-body");
  });
  test("stands bare with sender, plain aligned metadata and jump highlighting", () => {
    const html = render({ editedAt: message.createdAt });
    expect(html).toContain("Sara"); expect(html).toContain("edited");
    expect(html).toContain("justify-start"); expect(html).toContain("outline-ring");
    expect(html).not.toContain("rounded-card px-3 py-1.5");
    expect(html).not.toContain("backdrop-blur-md");
    expect(render({}, true)).toContain('aria-label="Sent"');
  });
  test("replies, attachments and deleted messages retain their bubble", () => {
    const replyTo = { id: "m0", seq: 1, senderId: "sara", senderName: "Sara", excerpt: "Hello" };
    expect(render({ replyTo })).toContain("rounded-card px-3 py-1.5");
    expect(render({ replyTo })).toContain("text-emoji-1");
    expect(render({ deletedAt: message.createdAt })).not.toContain("text-emoji-1");
    expect(render({ deletedAt: message.createdAt })).toContain("Message deleted");
    expect(render({ attachments: [{ id: "a1", kind: "sticker", source: "pack", contentType: "image/png", size: 20, variants: [] }] })).toContain("rounded-card px-3 py-1.5");
  });
  test("pending emoji has plain Sending metadata; pending replies retain a bubble", () => {
    const pending: PendingMessage = { clientMessageId: "c1", conversationId: "c1", body: "😄", createdAt: message.createdAt, state: "sending", attempts: 1 };
    const html = renderToStaticMarkup(<PendingRow pending={pending} onRetry={noop} onDiscard={noop} />);
    expect(html).toContain("text-emoji-1"); expect(html).toContain("Sending…");
    expect(html).not.toContain("bg-bubble-mine"); expect(html).not.toContain("backdrop-blur-md");
    const reply = renderToStaticMarkup(<PendingRow pending={{ ...pending, replyTo: { id: "m0", excerpt: "Hi" } }} onRetry={noop} onDiscard={noop} />);
    expect(reply).toContain("bg-bubble-mine"); expect(reply).toContain("text-emoji-1");
  });
});
