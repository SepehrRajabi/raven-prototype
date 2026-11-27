import { describe, expect, test } from "bun:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatMessage, PinnedMessages } from "@/lib/chat/types";
import { PinnedMessagesList, type PinnedMessagesListProps } from "./PinnedMessages";

const at = (day: number) => `2026-11-0${day}T10:00:00Z`;
const item = (seq: number, senderId: string, patch: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `m${seq}`, conversationId: "room", seq, changedSeq: seq, senderId, senderName: senderId === "me" ? "Me" : "Sara", clientMessageId: `c${seq}`, kind: "text", body: `message ${seq}`, createdAt: at(1),
  pin: { byId: "ava", byName: "Ava", at: at(seq) }, ...patch,
});
const loaded = (items: ChatMessage[]): PinnedMessages => ({ status: "loaded", items });
const noop = () => undefined;

function list(patch: Partial<PinnedMessagesListProps> = {}) {
  const props: PinnedMessagesListProps = { pins: loaded([item(3, "sara"), item(2, "me")]), me: "me", canPin: false, canManage: false, canWrite: true, nest: "room", now: Date.parse(at(9)), onGo: noop, onUnpin: noop, onRetry: noop, ...patch };
  return PinnedMessagesList(props);
}

type Clickable = ReactElement<{ "aria-label"?: string; onClick: () => void; "data-pinned-entry"?: boolean; children?: ReactNode }>;
/** Every element in a rendered tree that does something when clicked. */
function clickables(node: ReactNode): Clickable[] {
  if (Array.isArray(node)) return node.flatMap(clickables);
  if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) return [];
  const own = node.props.onClick ? [node as Clickable] : [];
  return [...own, ...clickables(node.props.children)];
}
const entries = (node: ReactNode) => clickables(node).filter((element) => element.props["data-pinned-entry"]);
const unpins = (node: ReactNode) => clickables(node).filter((element) => element.props["aria-label"]?.startsWith("Unpin"));

describe("the pinned list", () => {
  test("shows each pin newest first: who wrote it, what it says and who pinned it", () => {
    const html = renderToStaticMarkup(list());
    expect(html.indexOf("message 3")).toBeLessThan(html.indexOf("message 2"));
    expect(html).toContain("Sara");
    expect(html).toContain("You");
    expect(html).toContain("Pinned by Ava · ");
  });

  test("choosing an entry goes to that message", () => {
    const went: number[] = [];
    const tree = list({ onGo: (message) => went.push(message.seq) });
    for (const entry of entries(tree)) entry.props.onClick();
    expect(went).toEqual([3, 2]);
  });

  test("people who manage the room can unpin everything", () => {
    const unpinned: string[] = [];
    const tree = list({ canPin: true, canManage: true, onUnpin: (message) => unpinned.push(message.id) });
    expect(unpins(tree).map((button) => button.props["aria-label"])).toEqual(["Unpin Sara’s message", "Unpin your message"]);
    for (const button of unpins(tree)) button.props.onClick();
    expect(unpinned).toEqual(["m3", "m2"]);
  });

  test("anyone else can unpin only their own messages", () => {
    expect(unpins(list()).map((button) => button.props["aria-label"])).toEqual(["Unpin your message"]);
    expect(unpins(list({ me: "someone-else" }))).toHaveLength(0);
  });

  test("a member who made a pin can take it off", () => {
    expect(unpins(list({ me: "ava", canPin: true })).map((button) => button.props["aria-label"])).toEqual(["Unpin Sara’s message", "Unpin Me’s message"]);
    expect(unpins(list({ me: "ava", canWrite: false }))).toHaveLength(0);
  });

  test("a message holding only a picture is described by what it holds", () => {
    const photo = item(4, "sara", { body: "", attachments: [{ id: "a", kind: "image", source: "stored", contentType: "image/jpeg", size: 1, variants: [] }] });
    expect(renderToStaticMarkup(list({ pins: loaded([photo]) }))).toContain("Photo");
  });

  test("an empty room says so, and tells people who can pin how", () => {
    const quiet = renderToStaticMarkup(list({ pins: loaded([]) }));
    expect(quiet).toContain("Nothing is pinned in this room yet.");
    expect(quiet).not.toContain("choose Pin");
    const managing = renderToStaticMarkup(list({ pins: loaded([]), canPin: true, nest: "nest" }));
    expect(managing).toContain("Nothing is pinned in this nest yet.");
    expect(managing).toContain("To keep a message here, choose Pin in its menu.");
  });

  test("loading and a failure that can be tried again", () => {
    expect(renderToStaticMarkup(list({ pins: { status: "loading", items: [] } }))).toContain("Loading…");
    let retried = 0;
    const failed = list({ pins: { status: "error", items: [], error: "Couldn’t load the pinned messages." }, onRetry: () => { retried += 1; } });
    expect(renderToStaticMarkup(failed)).toContain('role="alert"');
    expect(renderToStaticMarkup(failed)).toContain("Try again");
    for (const button of clickables(failed)) button.props.onClick();
    expect(retried).toBe(1);
  });
});
