import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatMessage } from "@/lib/chat/types";
if (typeof globalThis.localStorage === "undefined") {
  Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => undefined } });
}
const { MessageRow } = await import("./MessageRow");
const noop = () => undefined;

const message: ChatMessage = {
  id: "m1", conversationId: "room", seq: 1, changedSeq: 2, senderId: "sara", senderName: "Sara", clientMessageId: "c1", kind: "text", body: "Agenda for Friday", createdAt: "2026-11-01T10:00:00Z",
  pin: { byId: "ava", byName: "Ava", at: "2026-11-02T10:00:00Z" },
};
const row = (patch: Partial<ChatMessage> = {}, me = "me") => renderToStaticMarkup(
  <MessageRow message={{ ...message, ...patch }} mine={false} me={me} withAvatars={false} showSender={false} continuation={false} canReply canEdit={false} canDeleteForEveryone={false} onReply={noop} onEdit={noop} onRemoveForMe={noop} onDeleteForEveryone={noop} onOpenReply={noop} onOpenImage={noop} onPin={async () => {}} canManagePins />,
);

describe("a pinned message in its room", () => {
  test("carries a quiet mark beside its time that says who pinned it", () => {
    const html = row();
    expect(html).toMatch(/role="img" aria-label="Pinned by Ava · [^"]+"/);
    expect(html.indexOf("Pinned by Ava")).toBeLessThan(html.indexOf("<time"));
    expect(row({}, "ava")).toContain('aria-label="Pinned by you · ');
  });
  test("an unpinned or deleted message has no mark", () => {
    expect(row({ pin: undefined })).not.toContain("Pinned by");
    expect(row({ deletedAt: "2026-11-03T10:00:00Z", body: "" })).not.toContain("Pinned by");
  });
});
