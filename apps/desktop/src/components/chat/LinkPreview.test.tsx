import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatLinkPreview, ChatMessage } from "@/lib/chat/types";
if (typeof globalThis.localStorage === "undefined") {
  Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => undefined } });
}
const { MessageRow } = await import("./MessageRow");
const { isWidePicture, linkHost } = await import("./LinkPreview");

const preview: ChatLinkPreview = {
  url: "https://www.example.com/article",
  title: "An article",
  description: "What it is about",
  siteName: "Example News",
  image: { contentType: "image/jpeg", width: 800, height: 420 },
};
const message: ChatMessage = {
  id: "m1", conversationId: "c1", seq: 1, changedSeq: 2, senderId: "sara", senderName: "Sara", clientMessageId: "client1", kind: "text",
  body: "look https://www.example.com/article", linkPreview: preview, createdAt: "2026-11-10T12:00:00Z",
};
const noop = () => undefined;
function render(patch: Partial<ChatMessage> = {}, remove?: () => Promise<void>) {
  return renderToStaticMarkup(
    <MessageRow message={{ ...message, ...patch }} mine={Boolean(remove)} me="me" withAvatars={false} showSender={false} continuation={false} canReply canEdit={false} canDeleteForEveryone={false} onReply={noop} onEdit={noop} onRemoveForMe={noop} onDeleteForEveryone={noop} onOpenReply={noop} onOpenImage={noop} onRemoveLinkPreview={remove} />,
  );
}

describe("link previews", () => {
  test("show the page's words and the real host, and open the address", () => {
    const html = render();
    expect(html).toContain("An article");
    expect(html).toContain("What it is about");
    expect(html).toContain("Example News");
    expect(html).toContain("· example.com");
    expect(html).toContain('href="https://www.example.com/article"');
    expect(html).not.toContain("Remove preview");
  });

  test("only your own messages can lose their card", () => {
    expect(render({}, async () => undefined)).toContain('aria-label="Remove preview"');
  });

  test("a deleted message shows no card", () => {
    expect(render({ deletedAt: message.createdAt, body: "" })).not.toContain("An article");
  });

  test("the page's words are text, never markup", () => {
    const html = render({ linkPreview: { ...preview, title: "<b>bold</b>" } });
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(html).not.toContain("<b>bold</b>");
  });

  test("hosts and picture shapes", () => {
    expect(linkHost("https://www.Example.com/x")).toBe("example.com");
    // A look-alike name stays in the ASCII form that gives it away.
    expect(linkHost("https://ex\u0430mple.com/")).toBe("xn--exmple-4nf.com");
    expect(isWidePicture(preview)).toBe(true);
    expect(isWidePicture({ ...preview, image: { contentType: "image/png", width: 200, height: 200 } })).toBe(false);
    expect(isWidePicture({ url: preview.url, image: { contentType: "image/png", width: 200, height: 200 } })).toBe(true);
    expect(isWidePicture({ url: preview.url, title: "No picture" })).toBe(false);
  });
});
