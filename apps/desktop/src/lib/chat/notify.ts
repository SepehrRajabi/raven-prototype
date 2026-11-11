import { messageExcerpt, summaryOf } from "./attachments";
import { graphemes, parseMessage, type Inline } from "./format";
import { mentionPlainText, type MentionResolver } from "./mentions";
import type { ChatConversation, ChatKind, ChatMessage } from "./types";

export type NotifyMode = "default" | "on" | "off";

/** Direct messages and groups notify unless muted; text nests only when turned on; Saved messages never. */
export function notifies(kind: ChatKind, mode: NotifyMode | undefined): boolean {
  if (kind === "saved") return false;
  return mode === "on" || (mode !== "off" && kind !== "nest");
}

/** Use the kind's default whenever it matches the choice. */
export function modeFor(kind: ChatKind, on: boolean): NotifyMode {
  return on === (kind !== "nest") ? "default" : on ? "on" : "off";
}

function plain(nodes: Inline[], resolve?: MentionResolver): string {
  return nodes.map((node) => node.type === "mention" ? mentionPlainText(node, resolve) : "children" in node ? plain(node.children, resolve) : node.text).join("");
}

/** Title and body of a Windows notification. Names and message text are plain text. */
export function notificationText(message: ChatMessage, conversation: ChatConversation, withText: boolean, resolve?: MentionResolver): { title: string; body: string } {
  const lines = parseMessage(message.body).flatMap((block) => (block.type === "code" ? block.text : plain(block.children, resolve)).split("\n"));
  const line = lines.map((text) => text.replace(/\s+/g, " ").trim()).find(Boolean) ?? "";
  const characters = graphemes(line);
  const text = messageExcerpt(characters.length > 120 ? characters.slice(0, 120).join("") + "…" : line, summaryOf(message));
  if (conversation.kind === "dm") return { title: message.senderName, body: withText ? text : "Sent you a message" };
  return { title: conversation.name, body: withText ? `${message.senderName}: ${text}` : `${message.senderName} sent a message` };
}
