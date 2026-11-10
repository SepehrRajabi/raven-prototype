import type { NotifyMode } from "./notify";
import { api } from "@/lib/api";
import type {
  ChatAttachment,
  ChatChanges,
  ChatConversation,
  ChatMember,
  ChatMessage,
  ChatSeen,
  ChatPage,
  ChatSettings,
  TreeCategory,
  TreeLayout,
} from "./types";

/** What creating an attachment declares: its description, with no bytes. */
export interface AttachmentDescription {
  clientUploadId: string;
  kind: string;
  source: string;
  contentType: string;
  size: number;
  name?: string;
  width?: number;
  height?: number;
  placeholder?: string;
  variants: Array<{ variant: string; contentType: string; size: number }>;
}

/** The server's copy of an attachment, and which of its variants still need their bytes. */
export interface AttachmentUploadState {
  attachment: ChatAttachment;
  missingVariants: string[];
}

/**
 * The chat endpoints. The store depends on this interface rather than on `api`, so its
 * tests can stand in a server that drops, delays and reorders at will.
 */
export interface ForwardInput {
  messageIds: string[];
  to: string;
  note?: string;
  hideSender: boolean;
  hideSource: boolean;
}

export interface ChatApi {
  listConversations(): Promise<{ conversations: ChatConversation[]; settings: ChatSettings }>;
  getConversation(id: string): Promise<{ conversation: ChatConversation; members: ChatMember[] }>;
  openDM(userId: string): Promise<{ conversation: ChatConversation; members: ChatMember[] }>;
  /** The person's Saved messages, created the first time it is asked for. */
  openSaved(): Promise<{ conversation: ChatConversation; members: ChatMember[] }>;
  /** Copies messages into Saved messages. Those already there come back in `alreadySaved`. */
  saveMessages(messageIds: string[]): Promise<{ conversationId: string; saved: ChatMessage[]; alreadySaved: ChatMessage[] }>;
  /** Copies messages from one conversation into another, oldest first, then the note. */
  forward(input: ForwardInput): Promise<{ conversationId: string; messages: ChatMessage[] }>;
  createGroup(name: string, memberIds: string[]): Promise<{ conversation: ChatConversation; members: ChatMember[] }>;
  updateConversation(id: string, patch: { name?: string; topic?: string }): Promise<{ conversation: ChatConversation; members: ChatMember[] }>;
  deleteConversation(id: string): Promise<void>;
  addMembers(id: string, userIds: string[]): Promise<{ conversation: ChatConversation; members: ChatMember[] }>;
  removeMember(id: string, userId: string): Promise<void>;
  setNotify(id: string, mode: NotifyMode): Promise<{ conversation: ChatConversation }>;
  setArchived(id: string, archived: boolean): Promise<{ conversation: ChatConversation }>;
  clearConversation(id: string): Promise<void>;
  messages(id: string, cursor?: { before?: number; after?: number; around?: number; limit?: number }): Promise<ChatPage>;
  changes(id: string, after: number): Promise<ChatChanges>;
  send(id: string, message: { clientMessageId: string; body: string; replyToMessageId?: string; attachmentIds?: string[]; libraryItemId?: string }): Promise<{ message: ChatMessage; duplicate?: boolean }>;
  /** Declares an attachment. The same `clientUploadId` again returns the same one. */
  createAttachment(id: string, description: AttachmentDescription): Promise<AttachmentUploadState>;
  /** Stores the bytes of one variant. Uploading one the server already has is harmless. */
  uploadVariant(id: string, attachmentId: string, variant: string, bytes: ArrayBuffer | Blob, contentType: string): Promise<AttachmentUploadState>;
  fetchVariant(id: string, attachmentId: string, variant: string): Promise<Blob>;
  fetchLinkPreviewImage(id: string, messageId: string): Promise<Blob>;
  /** Takes the link preview off one of your own messages, for everyone. */
  removeLinkPreview(id: string, messageId: string): Promise<{ message: ChatMessage }>;
  react(id: string, messageId: string, emoji: string, add: boolean): Promise<{ message: ChatMessage }>;
  edit(id: string, messageId: string, body: string): Promise<{ message: ChatMessage }>;
  deleteForEveryone(id: string, messageId: string): Promise<{ message: ChatMessage }>;
  deleteForMe(id: string, messageId: string): Promise<{ hideRev: number; unreadCount: number }>;
  markRead(id: string, seq: number): Promise<{ readSeq: number; unreadCount: number }>;
  typing(id: string): Promise<void>;
  updateSettings(settings: Partial<ChatSettings>): Promise<{ settings: ChatSettings }>;
  seen(id: string): Promise<ChatSeen>;
  treeLayout(treeId: string): Promise<{ layout: TreeLayout }>;
  saveTreeLayout(treeId: string, layout: { categories: string[]; items: Array<{ kind: "voice" | "text"; id: string; categoryId?: string }> }): Promise<{ layout: TreeLayout }>;
  createCategory(treeId: string, name: string): Promise<{ category: TreeCategory }>;
  renameCategory(treeId: string, categoryId: string, name: string): Promise<{ category: TreeCategory }>;
  deleteCategory(treeId: string, categoryId: string): Promise<void>;
  createTextNest(treeId: string, name: string, categoryId?: string): Promise<{ conversation: ChatConversation }>;
}

const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
const conversationPath = (id: string) => `/v1/chat/conversations/${encodeURIComponent(id)}`;
const treePath = (id: string) => `/v1/trees/${encodeURIComponent(id)}`;
const variantPath = (id: string, attachmentId: string, variant: string) =>
  `${conversationPath(id)}/attachments/${encodeURIComponent(attachmentId)}/variants/${encodeURIComponent(variant)}`;

export const chatApi: ChatApi = {
  listConversations: () => api.call("/v1/chat/conversations"),
  getConversation: (id) => api.call(conversationPath(id)),
  openDM: (userId) => api.call("/v1/chat/dms", json({ userId })),
  openSaved: () => api.call("/v1/chat/saved", { method: "POST" }),
  saveMessages: (messageIds) => api.call("/v1/chat/saved/messages", json({ messageIds })),
  forward: (input) => api.call("/v1/chat/forward", json(input)),
  createGroup: (name, memberIds) => api.call("/v1/chat/groups", json({ name, memberIds })),
  updateConversation: (id, patch) => api.call(`${conversationPath(id)}/settings`, json(patch)),
  deleteConversation: (id) => api.call(conversationPath(id), { method: "DELETE" }),
  addMembers: (id, userIds) => api.call(`${conversationPath(id)}/members`, json({ userIds })),
  removeMember: (id, userId) => api.call(`${conversationPath(id)}/members/${encodeURIComponent(userId)}`, { method: "DELETE" }),
  setNotify: (id, mode) => api.call(`${conversationPath(id)}/notifications`, json({ mode })),
  setArchived: (id, archived) => api.call(`${conversationPath(id)}/${archived ? "archive" : "unarchive"}`, { method: "POST" }),
  clearConversation: (id) => api.call(`${conversationPath(id)}/clear`, { method: "POST" }),
  messages: (id, cursor = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(cursor)) {
      if (value !== undefined) query.set(key, String(value));
    }
    const suffix = query.size ? `?${query}` : "";
    return api.call(`${conversationPath(id)}/messages${suffix}`);
  },
  changes: (id, after) => api.call(`${conversationPath(id)}/changes?after=${after}`),
  send: (id, message) => api.call(`${conversationPath(id)}/messages`, json(message)),
  createAttachment: (id, description) => api.call(`${conversationPath(id)}/attachments`, json(description)),
  // One function for every upload, so a later resumable upload (for video) replaces only this.
  uploadVariant: (id, attachmentId, variant, bytes, contentType) =>
    api.call(variantPath(id, attachmentId, variant), { method: "PUT", headers: { "Content-Type": contentType }, body: bytes }),
  fetchVariant: (id, attachmentId, variant) => api.callBlob(variantPath(id, attachmentId, variant)),
  fetchLinkPreviewImage: (id, messageId) => api.callBlob(`${conversationPath(id)}/messages/${encodeURIComponent(messageId)}/link-preview/image`),
  removeLinkPreview: (id, messageId) => api.call(`${conversationPath(id)}/messages/${encodeURIComponent(messageId)}/link-preview`, { method: "DELETE" }),
  react: (id, messageId, emoji, add) => api.call(`${conversationPath(id)}/messages/${encodeURIComponent(messageId)}/reactions`, json({ emoji, add })),
  edit: (id, messageId, body) => api.call(`${conversationPath(id)}/messages/${encodeURIComponent(messageId)}/edit`, json({ body })),
  deleteForEveryone: (id, messageId) => api.call(`${conversationPath(id)}/messages/${encodeURIComponent(messageId)}?for=everyone`, { method: "DELETE" }),
  deleteForMe: (id, messageId) => api.call(`${conversationPath(id)}/messages/${encodeURIComponent(messageId)}?for=me`, { method: "DELETE" }),
  markRead: (id, seq) => api.call(`${conversationPath(id)}/read`, json({ seq })),
  typing: (id) => api.call(`${conversationPath(id)}/typing`, { method: "POST" }),
  seen: (id) => api.call(`${conversationPath(id)}/seen`),
  updateSettings: (settings) => api.call("/v1/chat/settings", json(settings)),
  treeLayout: (treeId) => api.call(`${treePath(treeId)}/layout`),
  saveTreeLayout: (treeId, layout) => api.call(`${treePath(treeId)}/layout`, json(layout)),
  createCategory: (treeId, name) => api.call(`${treePath(treeId)}/categories`, json({ name })),
  renameCategory: (treeId, categoryId, name) => api.call(`${treePath(treeId)}/categories/${encodeURIComponent(categoryId)}`, json({ name })),
  deleteCategory: (treeId, categoryId) => api.call(`${treePath(treeId)}/categories/${encodeURIComponent(categoryId)}`, { method: "DELETE" }),
  createTextNest: (treeId, name, categoryId) => api.call(`${treePath(treeId)}/text-nests`, json({ name, categoryId: categoryId ?? "" })),
};
