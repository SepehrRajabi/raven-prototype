import type { Tree } from "@/lib/api";
import type { ChatConversation } from "@/lib/chat/types";

/** Direct messages and groups with something unread, newest first. Text nests and Saved are in their tree. */
export function unreadConversations(conversations: readonly ChatConversation[], limit = 5): ChatConversation[] {
  return conversations
    .filter((conversation) => (conversation.kind === "dm" || conversation.kind === "group" || conversation.kind === "raven") && !conversation.archived && conversation.unreadCount > 0)
    .sort((a, b) => b.lastActivityMs - a.lastActivityMs)
    .slice(0, limit);
}

/** Trees with people in a nest first, then ones with unread text, then the last one opened, then by name. */
export function orderTrees(trees: readonly Tree[], isLive: (treeId: string) => boolean, isUnread: (treeId: string) => boolean, lastTreeId?: string): Tree[] {
  const rank = (tree: Tree) => (isLive(tree.id) ? 0 : isUnread(tree.id) ? 1 : tree.id === lastTreeId ? 2 : 3);
  return [...trees].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
