// What the server sends for text chat, and what the client keeps about it.
// The wire shapes mirror services/api/internal/http/chat.go.

export type ChatKind = "dm" | "group" | "nest" | "saved" | "raven";

export interface ChatUser {
  id: string;
  username: string;
  displayName: string;
}

export interface ChatMember extends ChatUser {
  role: "owner" | "member";
  joinedAt: string;
}

/**
 * Something a message carries besides its text. `kind` says how it is shown (an image
 * now; a gif, sticker, video or file later) and `source` where its bytes come from
 * (`stored` on the server now; `peer` later). Both are open: a newer Raven may send
 * kinds and sources this one does not know.
 */
export interface ChatAttachment {
  id: string;
  kind: string;
  source: string;
  /** Of the `full` variant. */
  contentType: string;
  /** Bytes of the `full` variant. */
  size: number;
  name?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  /** A ThumbHash, base64: a blurred stand-in shown before the image loads. */
  placeholder?: string;
  /** What can be fetched, for example ["full", "preview"]. */
  variants: string[];
  meta?: Record<string, unknown>;
  /** A GIF or sticker (`source: "library"`): the library asset and what `play` is. */
  assetId?: string;
  format?: "webm" | "webp" | "tgs";
}

/** All a list or a quote needs to say what a message holds ("Photo"). */
export interface ChatAttachmentSummary {
  kind: string;
}

/** The quoted line above a reply. */
export interface ChatReplyRef {
  id: string;
  seq?: number;
  senderId?: string;
  senderName?: string;
  excerpt?: string;
  deleted?: boolean;
  attachments?: ChatAttachmentSummary[];
  /** This reader may not see the original (it predates them, or they removed it). */
  unavailable?: boolean;
}

/** What a system line says happened. */
export interface ChatSystemPayload {
  /** Raven's own messages (a conversation of kind `raven`) say what they are here instead. */
  type?: "admin" | "event" | string;
  /** The words of an `admin` message. Plain text: never parse it. */
  text?: string;
  event?: "group_created" | "members_added" | "member_left" | "member_removed" | "renamed" | "topic_changed" | string;
  name?: string;
  user?: ChatUser;
  users?: ChatUser[];
  /** An `event` message: an invitation from a space, with the names as they were when sent. */
  eventId?: string;
  treeId?: string;
  space?: string;
  title?: string;
  host?: string;
  hostUserId?: string;
  startsAt?: string;
  endsAt?: string;
  rrule?: string;
  target?: { kind?: "voice" | "text" | string; id?: string; name?: string };
  /** Re-sent after the event was edited. */
  updated?: boolean;
  cancelled?: boolean;
}

export interface ChatReaction {
  emoji: string;
  count: number;
  userIds: string[];
}

/** Where a copied message came from. The server decides per viewer what is shown. */
export interface ChatOrigin {
  senderId?: string;
  senderName?: string;
  createdAt: string;
  /** The chat it came from, only while the viewer can read it or it is public. */
  source?: {
    conversationId: string;
    kind: ChatKind;
    name: string;
    treeId?: string;
    /** The other person, when the source is a direct message. */
    peerId?: string;
    seq: number;
  };
}

/**
 * The card the server adds under a message with a web address: what the page says about
 * itself. It arrives after the message, as a change to it. The text is plain text.
 */
export interface ChatLinkPreview {
  /** The address in the message the card is for. */
  url: string;
  title?: string;
  description?: string;
  siteName?: string;
  /** The page's picture, fetched from the message's link-preview/image route. */
  /** `version` changes whenever the picture does; older servers leave it out. */
  image?: { version?: string; contentType: string; width: number; height: number };
}

/** One answer of a poll. */
export interface ChatPollOption {
  text: string;
  votes: number;
  /** Who chose it, in the order they did. Never sent for an anonymous poll. */
  voterIds?: string[];
  /** Set on every answer of a quiz once this viewer may know: never before. */
  correct?: boolean;
  /**
   * What the asker wrote for whoever picks this answer. Sent only to people who picked
   * it, to the asker, and to everyone once the poll ended.
   */
  feedback?: string;
}

/**
 * A poll. Its question is the message's body. The server shapes it for each viewer:
 * `myVotes` are their own choices, and a quiz's answers show only once they answered,
 * asked it themselves, or it ended.
 */
export interface ChatPoll {
  multiple: boolean;
  anonymous: boolean;
  /** Some answers are correct. Which ones is in `options`, once `revealed`. */
  quiz: boolean;
  revealed: boolean;
  closedAt?: string;
  options: ChatPollOption[];
  /** How many people voted. */
  voters: number;
  /** The viewer's choices, by position. */
  myVotes: number[];
}

/** A poll as it is written, before it is sent. */
export interface ChatPollDraft {
  question: string;
  options: Array<{ text: string; correct: boolean; feedback?: string }>;
  multiple: boolean;
  anonymous: boolean;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  /** When it was created within the conversation. The order and paging key. */
  seq: number;
  /** The conversation seq of its last change (an edit or a delete). */
  changedSeq: number;
  senderId: string;
  senderName: string;
  clientMessageId: string;
  kind: "text" | "system";
  /** The text, or the caption when there are attachments. May be empty then. */
  body: string;
  attachments?: ChatAttachment[];
  linkPreview?: ChatLinkPreview;
  /** Set on a poll; `body` is its question. */
  poll?: ChatPoll;
  reactions?: ChatReaction[];
  replyTo?: ChatReplyRef;
  system?: ChatSystemPayload;
  /** Set on a copy: a message saved or forwarded from elsewhere. */
  origin?: ChatOrigin;
  createdAt: string;
  editedAt?: string;
  deletedAt?: string;
}

export interface ChatMessagePreview {
  id: string;
  seq: number;
  senderId: string;
  senderName: string;
  kind: "text" | "system";
  excerpt: string;
  attachments?: ChatAttachmentSummary[];
  system?: ChatSystemPayload;
  deleted?: boolean;
  createdAt: string;
}

/** A conversation as the signed-in person sees it. */
export interface ChatConversation {
  id: string;
  kind: ChatKind;
  name: string;
  topic: string;
  treeId?: string;
  peer?: ChatUser;
  role: string;
  canSend: boolean;
  /** The other person in a direct message deleted their account. */
  peerDeleted?: boolean;
  canManage: boolean;
  memberCount: number;
  lastSeq: number;
  lastActivityMs: number;
  lastMessage?: ChatMessagePreview;
  /** Counted up to UNREAD_CAP; at the cap it means "that many or more". */
  unreadCount: number;
  /** Unread messages that mention you, counted up to UNREAD_CAP. Absent from older servers. */
  mentionCount?: number;
  readSeq: number;
  /** How far the other person in a direct message has read. Absent unless both share it. */
  peerReadSeq?: number;
  /** When that position last moved (ISO). Absent with `peerReadSeq`. */
  peerReadAt?: string;
  hideRev: number;
  visibleFromSeq: number;
  archived: boolean;
  notify?: import("./notify").NotifyMode;
  createdAt: string;
}

export interface ChatViewerState {
  readSeq: number;
  hideRev: number;
  visibleFromSeq: number;
}

/** Where you take part in read receipts. Each switch works both ways. */
export interface ChatSettings {
  /** The old name of `readDm`, kept in step by the server for older clients. */
  shareReadStatus: boolean;
  readDm: boolean;
  readGroup: boolean;
  readPrivateSpace: boolean;
  readPublicSpace: boolean;
}

export interface ChatSeenReader {
  userId: string;
  username: string;
  displayName: string;
  /** When their read position reached the last message (ISO). */
  at: string;
}

/** Who has seen the conversation's last message (`seq`), not counting you or its sender. */
export interface ChatSeen {
  seq: number;
  readers: ChatSeenReader[];
  /** How far the furthest other reader has read: every message up to it is seen by someone. */
  readSeq?: number;
}

export interface ChatPage {
  messages: ChatMessage[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  /** Everything in the conversation up to this seq is reflected in `messages`. */
  asOfSeq: number;
  me: ChatViewerState;
}

export interface ChatChanges {
  messages: ChatMessage[];
  /** Too much changed to list: reload the newest page instead. */
  reset: boolean;
  asOfSeq: number;
  me: ChatViewerState;
}

export type ChatEventType =
  | "message.created"
  | "message.updated"
  | "conversation.bump"
  | "message.hidden"
  | "conversation.read"
  | "conversation.seen"
  | "conversation.changed"
  | "conversation.removed"
  | "typing"
  | "settings.changed";

export interface ChatEvent {
  type: ChatEventType | string;
  conversationId: string;
  seq?: number;
  message?: ChatMessage;
  messageId?: string;
  userId?: string;
  userName?: string;
  readSeq?: number;
  readAt?: string;
  unreadCount?: number;
  hideRev?: number;
  at?: string;
}

export interface TreeCategory {
  id: string;
  name: string;
  position: number;
}

export interface TreeLayoutItem {
  kind: "voice" | "text";
  id: string;
  categoryId?: string;
  position: number;
}

export interface TreeLayout {
  treeId: string;
  categories: TreeCategory[];
  items: TreeLayoutItem[];
}

// ---- client-side state ---------------------------------------------------------

/** The server stops counting unread messages here; show "99+". */
export const UNREAD_CAP = 100;

/** What plan 02's native preparation returned for one picked, pasted or dropped file. */
export interface PreparedVariant {
  variant: string;
  contentType: string;
  size: number;
}

export interface PreparedAttachment {
  /** The folder on this computer that holds its variants until it is sent. */
  handle: string;
  kind: string;
  contentType: string;
  size: number;
  name: string;
  width: number;
  height: number;
  placeholder: string;
  /** For the tray only (a still preview of a moving image). Not sent. */
  animated: boolean;
  variants: PreparedVariant[];
}

/**
 * One attachment of an unsent message, and how far sending it got. Each step is
 * recorded, so a retry or a restart carries on where it stopped.
 */
export interface PendingAttachment {
  handle: string;
  /** Lets the server recognise a repeated create. One per attachment, never reused. */
  clientUploadId: string;
  kind: string;
  description: PreparedAttachment;
  /** Set once the server has created it. */
  attachmentId?: string;
  /** Variants the server has. */
  uploaded: string[];
}

/**
 * A message the person has sent that the server has not acknowledged yet.
 *   queued   waiting its turn (messages to one conversation go one at a time)
 *   sending  the request is out, or it failed in a way worth retrying and will go again
 *   failed   it will not be retried without the person asking
 */
/** What a pending GIF or sticker needs to be sent and drawn before the server answers. */
export interface PendingLibraryItem {
  itemId: string;
  kind: "gif" | "sticker";
  format: "webm" | "webp" | "tgs";
  assetId: string;
  variants: string[];
  width?: number;
  height?: number;
  title?: string;
}

export interface PendingMessage {
  clientMessageId: string;
  conversationId: string;
  body: string;
  attachments?: PendingAttachment[];
  /** A GIF or sticker from a library: sent alone, with no text or attachments. */
  library?: PendingLibraryItem;
  replyTo?: ChatReplyRef;
  createdAt: string;
  state: "queued" | "sending" | "failed";
  /** Why it failed, in words the person can act on. */
  error?: string;
  attempts: number;
  /** Its uploads were started over once because the server had let them go. */
  reuploaded?: boolean;
}

export interface TypingPerson {
  name: string;
  /** When to stop showing it if nothing more is heard, in epoch milliseconds. */
  until: number;
}

export type WindowLoad = "idle" | "initial" | "older" | "newer";

/** One conversation: its list entry and, when open, a window of its messages. */
export interface ConversationState {
  summary: ChatConversation;
  members: ChatMember[];
  /** True once a page of messages has been loaded into `messages`. */
  loaded: boolean;
  /** Ascending by seq. A contiguous run of what the person may see, not the whole history. */
  messages: ChatMessage[];
  /**
   * The window reflects every change up to this seq. It is used only to notice a gap:
   * an event further ahead than the next seq means something was missed.
   */
  syncedSeq: number;
  hasMoreBefore: boolean;
  /** False when the window reaches the newest message. */
  hasMoreAfter: boolean;
  loading: WindowLoad;
  pending: PendingMessage[];
  typing: Record<string, TypingPerson>;
  /** Who has seen the last message. Absent until fetched. */
  seen?: ChatSeen;
}

export type ChatConnection = "connecting" | "live" | "offline";

export interface ChatState {
  me: string;
  connection: ChatConnection;
  /** True once the conversation list has been fetched at least once. */
  listLoaded: boolean;
  conversations: Record<string, ConversationState>;
  settings: ChatSettings;
  layouts: Record<string, TreeLayout>;
}

/** Work the store must do as a consequence of a state change. */
export type ChatEffect =
  | { type: "fetchChanges"; conversationId: string; after: number }
  | { type: "fetchSummary"; conversationId: string }
  | { type: "reload"; conversationId: string }
  | { type: "fetchList" }
  | { type: "fetchSeen"; conversationId: string };

export interface Reduced {
  state: ChatState;
  effects: ChatEffect[];
}
