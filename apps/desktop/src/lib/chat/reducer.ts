// The rules that keep what the client holds in step with the server, as pure functions.
//
// The server numbers every change to a conversation with a gapless `seq`. From that the
// client can tell, on its own, when it has missed something:
//
//   - `summary.lastSeq` is how far the conversation is known to have got. It guards the
//     list entry (unread count, preview): an event at or below it has already been
//     counted, and one more than a step ahead means an event was missed, so the entry is
//     fetched again instead of patched.
//   - `syncedSeq` is how far the loaded window of messages is complete. An event exactly
//     one step ahead advances it. One further ahead is a gap, and the window asks the
//     server for the changes in between.
//
// Messages are merged by id and the copy with the higher `changedSeq` wins, so the same
// message arriving twice, or an old copy arriving late, does no harm. Nothing here
// performs a request; functions return the state and the work that follows from it.

import { mentionsUser } from "./mentions";
import {
  UNREAD_CAP,
  type ChatAttachmentSummary,
  type ChatChanges,
  type ChatConversation,
  type ChatEffect,
  type ChatEvent,
  type ChatMember,
  type ChatMessage,
  type ChatMessagePreview,
  type ChatPage,
  type ChatReaction,
  type ChatSeen,
  type ChatSettings,
  type ChatState,
  type ConversationState,
  type PendingMessage,
  type Reduced,
  type TreeLayout,
} from "./types";

/** The most messages kept loaded for one conversation, and what it is trimmed back to. */
export const WINDOW_MAX = 600;
export const WINDOW_TRIM_TO = 400;
/** How long "is typing" stays up after the last signal. The sender repeats it every 4 s. */
export const TYPING_TTL_MS = 6000;

export const DEFAULT_SETTINGS: ChatSettings = { shareReadStatus: true, readDm: true, readGroup: true, readPrivateSpace: true, readPublicSpace: false };

export function emptyChatState(me: string): ChatState {
  return { me, connection: "connecting", listLoaded: false, conversations: {}, settings: DEFAULT_SETTINGS, layouts: {} };
}

export function newConversation(summary: ChatConversation, members: ChatMember[] = []): ConversationState {
  return {
    summary,
    members,
    loaded: false,
    messages: [],
    syncedSeq: 0,
    hasMoreBefore: false,
    hasMoreAfter: false,
    loading: "idle",
    pending: [],
    typing: {},
  };
}

function put(state: ChatState, conversation: ConversationState): ChatState {
  // Nothing changed means the same object back, so nothing that reads it re-renders.
  if (state.conversations[conversation.summary.id] === conversation) return state;
  return { ...state, conversations: { ...state.conversations, [conversation.summary.id]: conversation } };
}

function drop(state: ChatState, conversationId: string): ChatState {
  if (!state.conversations[conversationId]) return state;
  const conversations = { ...state.conversations };
  delete conversations[conversationId];
  return { ...state, conversations };
}

const unchanged = (state: ChatState): Reduced => ({ state, effects: [] });

/** The single-line form of a message used in lists, matching the server's. */
export function excerptOf(body: string): string {
  const flat = body.split(/\s+/).filter(Boolean).join(" ");
  const characters = Array.from(flat);
  return characters.length <= 140 ? flat : `${characters.slice(0, 140).join("")}…`;
}

/** Only what a list or a quote needs to say what a message holds. */
export function summarize(attachments: ChatAttachmentSummary[] | undefined): ChatAttachmentSummary[] | undefined {
  return attachments?.length ? attachments.map((attachment) => ({ kind: attachment.kind })) : undefined;
}

function previewOf(message: ChatMessage): ChatMessagePreview {
  return {
    id: message.id,
    seq: message.seq,
    senderId: message.senderId,
    senderName: message.senderName,
    kind: message.kind,
    excerpt: message.deletedAt ? "" : excerptOf(message.body),
    ...(message.attachments?.length && !message.deletedAt ? { attachments: summarize(message.attachments) } : {}),
    system: message.system,
    deleted: Boolean(message.deletedAt),
    createdAt: message.createdAt,
  };
}

/** Puts a message into a window, or replaces the copy already there unless that one is newer. */
export function upsertMessage(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const index = messages.findIndex((candidate) => candidate.id === message.id);
  if (index >= 0) {
    // Equal revisions can still correct an optimistic reaction; identical copies do nothing.
    if (message.changedSeq < messages[index].changedSeq || (message.changedSeq === messages[index].changedSeq && JSON.stringify(message.reactions ?? []) === JSON.stringify(messages[index].reactions ?? []))) return messages;
    const next = messages.slice();
    next[index] = message;
    return next;
  }
  let at = messages.length;
  while (at > 0 && messages[at - 1].seq > message.seq) at -= 1;
  const next = messages.slice();
  next.splice(at, 0, message);
  return next;
}

function withoutPending(pending: PendingMessage[], clientMessageIds: Iterable<string>): PendingMessage[] {
  const done = new Set(clientMessageIds);
  if (done.size === 0 || !pending.some((item) => done.has(item.clientMessageId))) return pending;
  return pending.filter((item) => !done.has(item.clientMessageId));
}

/**
 * Whether a message that is not in the window belongs in it. The window is a run of the
 * conversation; a message past either end belongs only if the window reaches that end
 * of the conversation, otherwise it is left for when the person pages there.
 */
function belongsInWindow(conversation: ConversationState, message: ChatMessage): boolean {
  const { messages } = conversation;
  if (messages.length === 0) return !conversation.hasMoreAfter;
  if (message.seq > messages[messages.length - 1].seq) return !conversation.hasMoreAfter;
  if (message.seq < messages[0].seq) return !conversation.hasMoreBefore;
  return true;
}

function mergeIntoWindow(conversation: ConversationState, incoming: ChatMessage[]): ChatMessage[] {
  let messages = conversation.messages;
  for (const message of incoming) {
    const present = messages.some((candidate) => candidate.id === message.id);
    if (present || belongsInWindow({ ...conversation, messages }, message)) messages = upsertMessage(messages, message);
  }
  return messages;
}

/**
 * Keeps a window within WINDOW_MAX by letting go of the end the person is not at.
 * Whatever is let go is simply loaded again when they scroll back to it.
 */
function trimWindow(conversation: ConversationState, keep: "newest" | "oldest"): ConversationState {
  if (conversation.messages.length <= WINDOW_MAX) return conversation;
  if (keep === "newest") {
    return { ...conversation, messages: conversation.messages.slice(-WINDOW_TRIM_TO), hasMoreBefore: true };
  }
  return { ...conversation, messages: conversation.messages.slice(0, WINDOW_TRIM_TO), hasMoreAfter: true };
}

function followUp(conversation: ConversationState): ChatEffect[] {
  return conversation.loaded && conversation.summary.lastSeq > conversation.syncedSeq
    ? [{ type: "fetchChanges", conversationId: conversation.summary.id, after: conversation.syncedSeq }]
    : [];
}

// ---- the list ----------------------------------------------------------------------

/**
 * Takes a fresh conversation list. `stale` names conversations that received an event
 * while the list was being fetched: for those the list may be the older of the two, so
 * what the event established is kept and the entry is fetched again.
 *
 * A conversation whose `lastSeq` went backwards without that excuse has been rewound
 * (the server was restored from a backup): its window is thrown away and loaded afresh.
 */
export function applyList(state: ChatState, list: ChatConversation[], settings: ChatSettings, stale: ReadonlySet<string> = new Set()): Reduced {
  const effects: ChatEffect[] = [];
  const conversations: Record<string, ConversationState> = {};
  for (const fresh of list) {
    const existing = state.conversations[fresh.id];
    if (!existing) {
      conversations[fresh.id] = newConversation(fresh);
      continue;
    }
    if (stale.has(fresh.id) && fresh.lastSeq < existing.summary.lastSeq) {
      conversations[fresh.id] = existing;
      effects.push({ type: "fetchSummary", conversationId: fresh.id });
      continue;
    }
    const next: ConversationState = { ...existing, summary: fresh };
    if (existing.loaded) {
      const rewound = fresh.lastSeq < existing.syncedSeq;
      const viewChanged = fresh.hideRev !== existing.summary.hideRev || fresh.visibleFromSeq !== existing.summary.visibleFromSeq;
      if (rewound || viewChanged) effects.push({ type: "reload", conversationId: fresh.id });
      else effects.push(...followUp(next));
    }
    conversations[fresh.id] = next;
  }
  return { state: { ...state, conversations, settings, listLoaded: true }, effects };
}

/** Takes one conversation's entry, fetched on its own. */
export function applySummary(state: ChatState, fresh: ChatConversation, members?: ChatMember[]): Reduced {
  const existing = state.conversations[fresh.id];
  if (!existing) return unchanged(put(state, newConversation(fresh, members)));
  // A reply that is older than what an event has already established is ignored for
  // everything the event set; only the slow-changing details are taken from it.
  const summary: ChatConversation = fresh.lastSeq < existing.summary.lastSeq
    ? { ...fresh, lastSeq: existing.summary.lastSeq, lastMessage: existing.summary.lastMessage, unreadCount: existing.summary.unreadCount, mentionCount: existing.summary.mentionCount, readSeq: Math.max(fresh.readSeq, existing.summary.readSeq), lastActivityMs: existing.summary.lastActivityMs, archived: existing.summary.archived }
    : fresh;
  const next: ConversationState = { ...existing, summary, members: members ?? existing.members };
  const viewChanged = existing.loaded && (fresh.hideRev !== existing.summary.hideRev || fresh.visibleFromSeq !== existing.summary.visibleFromSeq);
  return {
    state: put(state, next),
    effects: viewChanged ? [{ type: "reload", conversationId: fresh.id }] : followUp(next),
  };
}

export function removeConversation(state: ChatState, conversationId: string): ChatState {
  return drop(state, conversationId);
}

// ---- events ------------------------------------------------------------------------

function advanceWindow(conversation: ConversationState, seq: number): { conversation: ConversationState; effects: ChatEffect[] } {
  if (!conversation.loaded || seq <= conversation.syncedSeq) return { conversation, effects: [] };
  if (seq === conversation.syncedSeq + 1) return { conversation: { ...conversation, syncedSeq: seq }, effects: [] };
  return { conversation, effects: [{ type: "fetchChanges", conversationId: conversation.summary.id, after: conversation.syncedSeq }] };
}

/** Folds one new or changed message into a conversation's list entry. */
function noteInSummary(conversation: ConversationState, message: ChatMessage, seq: number, created: boolean, me: string): { conversation: ConversationState; effects: ChatEffect[] } {
  const summary = conversation.summary;
  const id = summary.id;
  if (seq <= summary.lastSeq) {
    // Already counted. Still let a changed message correct the preview it appears in.
    if (!created && summary.lastMessage?.id === message.id) {
      return { conversation: { ...conversation, summary: { ...summary, lastMessage: previewOf(message) } }, effects: [] };
    }
    return { conversation, effects: [] };
  }
  if (seq > summary.lastSeq + 1) {
    // An event in between never arrived, so the count cannot be patched.
    return { conversation: { ...conversation, summary: { ...summary, lastSeq: seq } }, effects: [{ type: "fetchSummary", conversationId: id }] };
  }

  const next: ChatConversation = { ...summary, lastSeq: seq };
  const effects: ChatEffect[] = [];
  if (created) {
    next.lastMessage = previewOf(message);
    next.lastActivityMs = Date.parse(message.createdAt) || summary.lastActivityMs;
    next.archived = false;
    if (summary.kind === "raven") {
      // Raven writes in the person's own name: every new line is unread.
      next.unreadCount = Math.min(summary.unreadCount + 1, UNREAD_CAP);
    } else if (message.senderId === me) {
      // Sending means having read what came before.
      next.readSeq = seq;
      next.unreadCount = 0;
      next.mentionCount = 0;
    } else if (message.kind === "text" && summary.kind !== "saved") {
      next.unreadCount = Math.min(summary.unreadCount + 1, UNREAD_CAP);
      if (mentionsUser(message.body, me)) next.mentionCount = Math.min((summary.mentionCount ?? 0) + 1, UNREAD_CAP);
      // A message from the other person in a direct message shows they have read up to it.
      if (summary.kind === "dm" && summary.peerReadSeq !== undefined) next.peerReadSeq = Math.max(summary.peerReadSeq, seq);
    }
    // A system line means the people or the name changed.
    if (message.kind === "system") effects.push({ type: "fetchSummary", conversationId: id });
  } else {
    if (summary.lastMessage?.id === message.id) next.lastMessage = previewOf(message);
    const wasUnread = message.deletedAt && message.kind === "text" && message.senderId !== me && message.seq > summary.readSeq;
    if (wasUnread) {
      if (summary.unreadCount >= UNREAD_CAP) effects.push({ type: "fetchSummary", conversationId: id });
      else next.unreadCount = Math.max(summary.unreadCount - 1, 0);
    }
  }
  return { conversation: { ...conversation, summary: next }, effects };
}

/**
 * Applies one event from the stream. `atBottom` says whether the person is looking at
 * the newest messages of this conversation, which decides which end a full window gives up.
 */
export function applyEvent(state: ChatState, event: ChatEvent, now: number, atBottom = true): Reduced {
  if (event.type === "settings.changed") return { state, effects: [{ type: "fetchList" }] };
  const id = event.conversationId;
  const existing = state.conversations[id];

  if (event.type === "conversation.removed") return unchanged(drop(state, id));
  if (!existing) {
    // Something we were not listing: a new direct message, or a group we were added to.
    const worthFetching = event.type === "message.created" || event.type === "message.updated" || event.type === "conversation.changed";
    return { state, effects: worthFetching ? [{ type: "fetchSummary", conversationId: id }] : [] };
  }

  switch (event.type) {
    case "message.created":
    case "message.updated": {
      const message = event.message;
      const seq = event.seq ?? 0;
      if (!message || seq <= 0) return unchanged(state);
      const created = event.type === "message.created";
      const noted = noteInSummary(existing, message, seq, created, state.me);
      const advanced = advanceWindow(noted.conversation, seq);
      let conversation = advanced.conversation;
      if (conversation.loaded) {
        const present = conversation.messages.some((candidate) => candidate.id === message.id);
        if (present) {
          const messages = upsertMessage(conversation.messages, message);
          if (messages !== conversation.messages) conversation = { ...conversation, messages };
        } else if (belongsInWindow(conversation, message)) {
          if (created && !atBottom && conversation.messages.length >= WINDOW_MAX) {
            // They are reading further up and the window is full: stop following the
            // newest end instead of pushing what they are reading out of the other.
            conversation = { ...conversation, hasMoreAfter: true };
          } else {
            conversation = trimWindow({ ...conversation, messages: upsertMessage(conversation.messages, message) }, "newest");
          }
        }
      }
      if (created && seq > (conversation.seen?.seq ?? 0)) {
        conversation = { ...conversation, seen: { seq, readers: [], readSeq: conversation.seen?.readSeq } };
      }
      if (created) {
        const pending = message.senderId === state.me ? withoutPending(conversation.pending, [message.clientMessageId]) : conversation.pending;
        if (pending !== conversation.pending) conversation = { ...conversation, pending };
        if (conversation.typing[message.senderId]) {
          const typing = { ...conversation.typing };
          delete typing[message.senderId];
          conversation = { ...conversation, typing };
        }
      }
      return { state: put(state, conversation), effects: [...noted.effects, ...advanced.effects] };
    }

    case "conversation.bump": {
      const seq = event.seq ?? 0;
      if (seq <= 0) return unchanged(state);
      const summary = seq > existing.summary.lastSeq ? { ...existing.summary, lastSeq: seq } : existing.summary;
      const advanced = advanceWindow({ ...existing, summary }, seq);
      return { state: put(state, advanced.conversation), effects: advanced.effects };
    }

    case "message.hidden": {
      // Removed for myself on another device.
      const summary: ChatConversation = {
        ...existing.summary,
        hideRev: event.hideRev ?? existing.summary.hideRev,
        unreadCount: event.unreadCount ?? existing.summary.unreadCount,
      };
      const messages = existing.messages.some((message) => message.id === event.messageId)
        ? existing.messages.filter((message) => message.id !== event.messageId)
        : existing.messages;
      const previewGone = existing.summary.lastMessage?.id === event.messageId;
      return {
        state: put(state, { ...existing, summary, messages }),
        effects: previewGone ? [{ type: "fetchSummary", conversationId: id }] : [],
      };
    }

    case "conversation.read": {
      const readSeq = event.readSeq ?? 0;
      if (event.userId === state.me) {
        if (readSeq < existing.summary.readSeq) return unchanged(state);
        const summary = { ...existing.summary, readSeq, unreadCount: event.unreadCount ?? existing.summary.unreadCount };
        // Reading to the end clears the mention mark.
        if (readSeq >= existing.summary.lastSeq) summary.mentionCount = 0;
        return unchanged(put(state, { ...existing, summary }));
      }
      let conversation = existing;
      const effects: ChatEffect[] = [];
      if (existing.summary.kind === "dm" && readSeq > (existing.summary.peerReadSeq ?? 0)) {
        conversation = { ...conversation, summary: { ...existing.summary, peerReadSeq: readSeq, peerReadAt: event.readAt ?? existing.summary.peerReadAt } };
      }
      let seen = existing.seen;
      if (seen && event.userId && readSeq > (seen.readSeq ?? 0)) {
        seen = { ...seen, readSeq: Math.min(readSeq, seen.seq) };
        conversation = { ...conversation, seen };
      }
      if (seen && event.userId && readSeq >= seen.seq) {
        const known = seen.readers.find((reader) => reader.userId === event.userId);
        const member = existing.members.find((candidate) => candidate.id === event.userId);
        const at = event.readAt ?? new Date(now).toISOString();
        if (known) {
          if (known.at !== at) conversation = { ...conversation, seen: { ...seen, readers: seen.readers.map((reader) => (reader === known ? { ...reader, at } : reader)) } };
        } else if (member) {
          conversation = { ...conversation, seen: { ...seen, readers: [...seen.readers, { userId: member.id, username: member.username, displayName: member.displayName, at }] } };
        } else {
          effects.push({ type: "fetchSeen", conversationId: id });
        }
      }
      return { state: put(state, conversation), effects };
    }

    case "conversation.seen":
      // A read-receipt switch changed for someone here: who is shown must be asked for again.
      return { state, effects: [{ type: "fetchSeen", conversationId: id }] };

    case "conversation.changed":
      return { state, effects: [{ type: "fetchSummary", conversationId: id }] };

    case "typing": {
      if (!event.userId || event.userId === state.me) return unchanged(state);
      const typing = { ...existing.typing, [event.userId]: { name: event.userName || "Someone", until: now + TYPING_TTL_MS } };
      return unchanged(put(state, { ...existing, typing }));
    }

    default:
      return unchanged(state);
  }
}

/** Drops "is typing" entries that have run out. Returns the same state when none have. */
export function expireTyping(state: ChatState, now: number): ChatState {
  let next = state;
  for (const conversation of Object.values(state.conversations)) {
    const entries = Object.entries(conversation.typing);
    if (entries.length === 0 || entries.every(([, person]) => person.until > now)) continue;
    const typing = Object.fromEntries(entries.filter(([, person]) => person.until > now));
    next = put(next, { ...conversation, typing });
  }
  return next;
}

/** The soonest moment any "is typing" entry runs out, or null when nobody is typing. */
export function nextTypingExpiry(state: ChatState): number | null {
  let soonest: number | null = null;
  for (const conversation of Object.values(state.conversations)) {
    for (const person of Object.values(conversation.typing)) {
      if (soonest === null || person.until < soonest) soonest = person.until;
    }
  }
  return soonest;
}

// ---- history pages and catching up ---------------------------------------------------

function takeViewerState(conversation: ConversationState, me: { readSeq: number; hideRev: number; visibleFromSeq: number }, asOfSeq: number): ConversationState {
  const summary = conversation.summary;
  return {
    ...conversation,
    summary: {
      ...summary,
      readSeq: Math.max(summary.readSeq, me.readSeq),
      hideRev: me.hideRev,
      visibleFromSeq: me.visibleFromSeq,
      lastSeq: Math.max(summary.lastSeq, asOfSeq),
    },
  };
}

function acknowledged(messages: ChatMessage[], me: string): string[] {
  return messages.filter((message) => message.senderId === me).map((message) => message.clientMessageId);
}

export type PageMode = "replace" | "older" | "newer";

/**
 * Merges a page of history.
 *
 * "replace" starts the window over (opening a conversation, jumping to a message,
 * reloading). "older" and "newer" extend it at one end.
 *
 * The page says how current it is (`asOfSeq`). If the window had already moved past
 * that, changes to the page's messages may have gone by before they were in the window
 * to receive them, so the window's own mark is pulled back and the changes are asked for.
 */
export function applyPage(state: ChatState, conversationId: string, page: ChatPage, mode: PageMode): Reduced {
  const existing = state.conversations[conversationId];
  if (!existing) return unchanged(state);
  const hiddenElsewhere = existing.loaded && mode !== "replace" && page.me.hideRev !== existing.summary.hideRev;
  let conversation = takeViewerState(existing, page.me, page.asOfSeq);
  conversation = { ...conversation, loading: "idle", pending: withoutPending(conversation.pending, acknowledged(page.messages, state.me)) };

  if (mode === "replace" || !existing.loaded) {
    conversation = {
      ...conversation,
      loaded: true,
      messages: page.messages,
      syncedSeq: page.asOfSeq,
      hasMoreBefore: page.hasMoreBefore,
      hasMoreAfter: page.hasMoreAfter,
    };
    return { state: put(state, conversation), effects: followUp(conversation) };
  }

  let messages = conversation.messages;
  for (const message of page.messages) messages = upsertMessage(messages, message);
  conversation = { ...conversation, messages, syncedSeq: Math.min(conversation.syncedSeq, page.asOfSeq) };
  conversation = mode === "older"
    ? trimWindow({ ...conversation, hasMoreBefore: page.hasMoreBefore }, "oldest")
    : trimWindow({ ...conversation, hasMoreAfter: page.hasMoreAfter }, "newest");
  return {
    state: put(state, conversation),
    effects: hiddenElsewhere ? [{ type: "reload", conversationId }] : followUp(conversation),
  };
}

/** Merges the answer to "what changed after seq N". */
export function applyChanges(state: ChatState, conversationId: string, changes: ChatChanges): Reduced {
  const existing = state.conversations[conversationId];
  if (!existing || !existing.loaded) return unchanged(state);
  if (changes.reset || changes.me.hideRev !== existing.summary.hideRev || changes.me.visibleFromSeq !== existing.summary.visibleFromSeq) {
    return { state: put(state, takeViewerState(existing, changes.me, 0)), effects: [{ type: "reload", conversationId }] };
  }
  let conversation = takeViewerState(existing, changes.me, changes.asOfSeq);
  conversation = {
    ...conversation,
    messages: mergeIntoWindow(conversation, changes.messages),
    syncedSeq: Math.max(conversation.syncedSeq, changes.asOfSeq),
    pending: withoutPending(conversation.pending, acknowledged(changes.messages, state.me)),
  };
  conversation = trimWindow(conversation, "newest");
  return { state: put(state, conversation), effects: followUp(conversation) };
}

/** Forgets a conversation's messages, keeping its list entry. Used before a reload and to free memory. */
export function unloadConversation(state: ChatState, conversationId: string): ChatState {
  const existing = state.conversations[conversationId];
  if (!existing || (!existing.loaded && existing.loading === "idle")) return state;
  return put(state, { ...existing, loaded: false, messages: [], syncedSeq: 0, hasMoreBefore: false, hasMoreAfter: false, loading: "idle" });
}

export function setLoading(state: ChatState, conversationId: string, loading: ConversationState["loading"]): ChatState {
  const existing = state.conversations[conversationId];
  if (!existing || existing.loading === loading) return state;
  return put(state, { ...existing, loading });
}

// ---- the person's own actions --------------------------------------------------------

export function addPending(state: ChatState, pending: PendingMessage): ChatState {
  const existing = state.conversations[pending.conversationId];
  if (!existing || existing.pending.some((item) => item.clientMessageId === pending.clientMessageId)) return state;
  return put(state, { ...existing, pending: [...existing.pending, pending] });
}

export function updatePending(state: ChatState, conversationId: string, clientMessageId: string, patch: Partial<PendingMessage>): ChatState {
  const existing = state.conversations[conversationId];
  if (!existing || !existing.pending.some((item) => item.clientMessageId === clientMessageId)) return state;
  return put(state, { ...existing, pending: existing.pending.map((item) => (item.clientMessageId === clientMessageId ? { ...item, ...patch } : item)) });
}

export function removePending(state: ChatState, conversationId: string, clientMessageId: string): ChatState {
  const existing = state.conversations[conversationId];
  if (!existing) return state;
  const pending = withoutPending(existing.pending, [clientMessageId]);
  return pending === existing.pending ? state : put(state, { ...existing, pending });
}

/**
 * Takes the server's answer to a send, an edit or a delete. The message goes into the
 * window, but the window's mark only moves if this was the very next change: someone
 * else's message with a lower seq may still be on its way, and skipping ahead would
 * make it look already seen.
 */
export function applyOwnMessage(state: ChatState, message: ChatMessage, atBottom = true): Reduced {
  const existing = state.conversations[message.conversationId];
  if (!existing) return unchanged(state);
  const seq = message.changedSeq;
  const created = message.changedSeq === message.seq;
  // For the list entry this is the newest thing there is, whatever is still in flight:
  // having just acted here, the person has seen what came before.
  const primed = seq > existing.summary.lastSeq + 1 ? put(state, { ...existing, summary: { ...existing.summary, lastSeq: seq - 1 } }) : state;
  const reduced = applyEvent(primed, { type: created ? "message.created" : "message.updated", conversationId: message.conversationId, seq, message }, Date.now(), atBottom);
  // An answer that is ahead of the stream is not a gap. If something really was missed,
  // the next event on the stream shows it.
  return { state: reduced.state, effects: reduced.effects.filter((effect) => effect.type !== "fetchChanges") };
}

/** Moves my read position forward at once, ahead of the server confirming it. */
export function markReadLocally(state: ChatState, conversationId: string, seq: number): ChatState {
  const existing = state.conversations[conversationId];
  if (!existing || seq <= existing.summary.readSeq) return state;
  const readSeq = Math.min(seq, existing.summary.lastSeq);
  // Exact when the window holds everything after the new position; otherwise the
  // server's answer corrects it a moment later.
  const stillUnread = existing.messages.filter((message) => message.seq > readSeq && message.senderId !== state.me && message.kind === "text" && !message.deletedAt).length;
  const unreadCount = readSeq >= existing.summary.lastSeq ? 0 : existing.loaded && !existing.hasMoreAfter ? stillUnread : existing.summary.unreadCount;
  return put(state, { ...existing, summary: { ...existing.summary, readSeq, unreadCount, mentionCount: readSeq >= existing.summary.lastSeq ? 0 : existing.summary.mentionCount } });
}

/** Reactions change immediately without pretending the server advanced its revision. */
export function setReactionsLocally(state: ChatState, conversationId: string, messageId: string, reactions: ChatReaction[]): ChatState {
  const conversation = state.conversations[conversationId];
  if (!conversation?.messages.some((message) => message.id === messageId)) return state;
  const messages = conversation.messages.map((message) => {
    if (message.id !== messageId) return message;
    return { ...message, reactions };
  });
  return put(state, { ...conversation, messages });
}

export function removeMessageLocally(state: ChatState, conversationId: string, messageId: string, hideRev: number, unreadCount: number): Reduced {
  return applyEvent(state, { type: "message.hidden", conversationId, messageId, hideRev, unreadCount }, Date.now());
}

export function setLayout(state: ChatState, layout: TreeLayout): ChatState {
  return { ...state, layouts: { ...state.layouts, [layout.treeId]: layout } };
}

/** Takes the answer to "who has seen the last message", unless a newer message has arrived since. */
export function applySeen(state: ChatState, conversationId: string, seen: ChatSeen): ChatState {
  const existing = state.conversations[conversationId];
  if (!existing) return state;
  if (seen.seq < existing.summary.lastSeq || seen.seq < (existing.seen?.seq ?? 0)) return state;
  return put(state, { ...existing, seen });
}

export function setSettings(state: ChatState, settings: ChatSettings): ChatState {
  return { ...state, settings };
}

// ---- reading the state ---------------------------------------------------------------

/**
 * A direct message nobody has written in yet. Opening a friend's row creates one on the
 * server, so it is left out of lists until there is something in it.
 */
export function isEmptyDM(summary: ChatConversation): boolean {
  return summary.kind === "dm" && summary.lastSeq === 0 && !summary.lastMessage;
}

/** Conversations for the Messages list: direct messages and groups, newest activity first. */
export function listedConversations(state: ChatState, archived = false): ConversationState[] {
  return Object.values(state.conversations)
    .filter((conversation) => conversation.summary.kind !== "nest" && conversation.summary.archived === archived && !isEmptyDM(conversation.summary))
    .sort((a, b) => b.summary.lastActivityMs - a.summary.lastActivityMs || a.summary.id.localeCompare(b.summary.id));
}

export function textNestsOfTree(state: ChatState, treeId: string): ConversationState[] {
  return Object.values(state.conversations).filter((conversation) => conversation.summary.kind === "nest" && conversation.summary.treeId === treeId);
}

/** Whether anything is unread anywhere, for the dot on the taskbar icon. */
export function hasUnread(state: ChatState): boolean {
  return Object.values(state.conversations).some((conversation) => conversation.summary.unreadCount > 0 && !conversation.summary.archived);
}

export function treeHasUnread(state: ChatState, treeId: string): boolean {
  return textNestsOfTree(state, treeId).some((conversation) => conversation.summary.unreadCount > 0);
}

/** "3", "99+", or nothing. */
export function unreadLabel(count: number): string {
  if (count <= 0) return "";
  return count >= UNREAD_CAP ? `${UNREAD_CAP - 1}+` : String(count);
}
