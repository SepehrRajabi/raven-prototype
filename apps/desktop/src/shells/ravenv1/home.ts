import type { ChatConversation } from "@/lib/chat/types";

/** Direct messages and groups with something unread, newest first. Text nests and Saved are in their tree. */
export function unreadConversations(conversations: readonly ChatConversation[], limit = 5): ChatConversation[] {
  return conversations
    .filter((conversation) => (conversation.kind === "dm" || conversation.kind === "group" || conversation.kind === "raven") && !conversation.archived && conversation.unreadCount > 0)
    .sort((a, b) => b.lastActivityMs - a.lastActivityMs)
    .slice(0, limit);
}
