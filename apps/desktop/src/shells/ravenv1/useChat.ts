import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "@/components/ui/toast";
import { failureText } from "@/lib/chat/errors";
import { capabilitiesOf } from "@/lib/permissions";
import { discard, readVariant, sweep } from "@/lib/chat/attachmentPrep";
import { attachmentLimits, reactionLimits, canSendImages, type AttachmentLimits } from "@/lib/chat/attachments";
import { chatApi } from "@/lib/chat/chatApi";
import { chatTray, setAttachmentsReady } from "@/lib/chat/composerTray";
import { seedAttachment } from "@/lib/chat/media";
import { hasUnread } from "@/lib/chat/reducer";
import { accountScope } from "@/lib/chat/outbox";
import { ChatStore } from "@/lib/chat/store";
import type { ChatConversation, ChatEvent, ChatState, ConversationState } from "@/lib/chat/types";
import { eventStream } from "@/lib/eventStream";
import { setTaskbarUnread } from "@/lib/taskbarBadge";
import { trayCommands } from "@/lib/tray";
import { friendsAndGroups, type FriendsAndGroups } from "./friendsAndGroups";
import { strangerNamed } from "./people";
import type { RavenShellData, RavenView } from "./state";

/**
 * Text chat for the signed-in person, or null when there is none: signed out, or
 * connected to a server that does not have it. Views treat null as "no chat here".
 */
export function useChat(data: RavenShellData): ChatStore | null {
  const userId = data.user?.id ?? "";
  const username = data.user?.username ?? "";
  const displayName = data.preferences.displayName || username;
  // An account the administrator has turned messages off for has no chat, exactly as if
  // the server had none.
  const available = Boolean(data.serverProperties.properties?.chat) && capabilitiesOf(data.user).readMessages;
  const { sessionExpired, apiServerUrl } = data;
  const [store, setStore] = useState<ChatStore | null>(null);

  useEffect(() => {
    if (!userId || !available) {
      setStore(null);
      return;
    }
    const next = new ChatStore({
      api: chatApi,
      me: { id: userId, username, displayName },
      storage: localStorage,
      outboxScope: accountScope(apiServerUrl, userId),
      onSignedOut: sessionExpired,
      attachments: { readVariant, discard, sweep, seed: seedAttachment },
    });
    setAttachmentsReady(next.attachmentsReady);
    setStore(next);
    const unsubscribe = eventStream.subscribe({
      onOpen: () => next.streamOpened(),
      onClose: () => next.streamClosed(),
      onChatEvent: (event) => next.handleEvent(event as ChatEvent),
      onNestUpdate: (update) => {
        // Who is a friend and who is in a tree decide what can be read and sent.
        if (update.type.startsWith("friend") || update.type.startsWith("tree.")) next.accessMayHaveChanged();
        if (update.type === "tree.layout_updated" || update.type === "stream.reconnected") {
          for (const treeId of Object.keys(next.getState().layouts)) void next.loadLayout(treeId).catch(() => undefined);
        }
      },
    });
    return () => {
      unsubscribe();
      next.dispose();
      chatTray.clearAll();
      setStore(null);
    };
    // The display name is only used for messages shown before the server answers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, apiServerUrl, available, sessionExpired]);

  useEffect(() => {
    store?.setReactionLimits(reactionLimits(data.serverProperties.properties));
  }, [store, data.serverProperties.properties]);

  // The dot on the taskbar icon and on the tray icon.
  useEffect(() => {
    const show = (unread: boolean) => {
      void setTaskbarUnread(unread);
      void trayCommands.setUnread(unread);
    };
    if (!store) {
      show(false);
      return;
    }
    const sync = () => show(hasUnread(store.getState()));
    sync();
    return store.subscribe(sync);
  }, [store]);

  return store;
}

/**
 * What this server lets a message carry, or null when images can't be sent to it. Null
 * means no attach button, no drop and no paste of images anywhere.
 */
export function useImageLimits(data: RavenShellData): AttachmentLimits | null {
  const properties = data.serverProperties.properties;
  return useMemo(() => {
    const limits = attachmentLimits(properties);
    return canSendImages(limits) ? limits : null;
  }, [properties]);
}

const noSubscription = () => () => undefined;

/** The whole chat state. Re-renders on any change; use it for lists, not for one conversation. */
export function useChatState(store: ChatStore | null): ChatState | null {
  return useSyncExternalStore(store ? store.subscribe : noSubscription, () => (store ? store.getState() : null));
}

/** One conversation. Re-renders only when that conversation changes. */
export function useConversation(store: ChatStore | null, conversationId: string): ConversationState | undefined {
  return useSyncExternalStore(store ? store.subscribe : noSubscription, () => store?.getState().conversations[conversationId]);
}

/**
 * A value worked out from the chat state. The component re-renders only when that value
 * changes, not on every chat event, so a busy conversation does not redraw the sidebar.
 *
 * `select` should return something `Object.is` can compare: a string, number or boolean,
 * or an object already in the state. `key` is for selectors that depend on a prop; pass
 * the prop so a change of prop is noticed without a change of state.
 */
export function useChatSelector<T>(store: ChatStore | null, select: (state: ChatState) => T, fallback: T, key = ""): T {
  const cache = useRef<{ state: ChatState | null; key: string; value: T } | null>(null);
  const getSnapshot = () => {
    const state = store ? store.getState() : null;
    const cached = cache.current;
    if (cached && cached.state === state && cached.key === key) return cached.value;
    const value = state ? select(state) : fallback;
    cache.current = { state, key, value };
    return value;
  };
  return useSyncExternalStore(store ? store.subscribe : noSubscription, getSnapshot);
}

export interface TreeChatSummary {
  /** How many text nests the tree has. */
  count: number;
  unread: boolean;
}

/** For each tree: how many text nests it has and whether any has something unread. */
export function useTreeChatSummaries(store: ChatStore | null): Map<string, TreeChatSummary> {
  // Reduced to a string so that it only changes when one of these facts does.
  const signature = useChatSelector(store, (state) => {
    const byTree = new Map<string, TreeChatSummary>();
    for (const conversation of Object.values(state.conversations)) {
      const { kind, treeId, unreadCount } = conversation.summary;
      if (kind !== "nest" || !treeId) continue;
      const entry = byTree.get(treeId) ?? { count: 0, unread: false };
      entry.count += 1;
      entry.unread ||= unreadCount > 0;
      byTree.set(treeId, entry);
    }
    return [...byTree].map(([treeId, entry]) => `${treeId}:${entry.count}:${entry.unread ? 1 : 0}`).sort().join("|");
  }, "");
  return useMemo(() => {
    const out = new Map<string, TreeChatSummary>();
    for (const part of signature ? signature.split("|") : []) {
      const [treeId, count, unread] = part.split(":");
      out.set(treeId, { count: Number(count), unread: unread === "1" });
    }
    return out;
  }, [signature]);
}

/** Whether any direct message or group that is not archived has something unread. */
export function useMessagesUnread(store: ChatStore | null): boolean {
  return useChatSelector(store, (state) => Object.values(state.conversations).some(({ summary }) => summary.kind !== "nest" && summary.kind !== "saved" && !summary.archived && summary.unreadCount > 0), false);
}

/**
 * The "Friends and groups" list for the sidebar and the rail, plus which person or group
 * the open view belongs to (a friend's row is current on their profile and in their
 * direct message).
 */
export function useFriendsAndGroups(
  store: ChatStore | null,
  data: RavenShellData,
  view: RavenView,
): FriendsAndGroups & { activePersonId: string; activeConversationId: string } {
  const state = useChatState(store);
  const activeConversationId = view.kind === "chat" ? view.id : "";
  const lists = useMemo(() => {
    const friends = data.people.filter((person) => person.relationship === "friend");
    // Empty direct messages are included: a friend's row is there either way.
    const conversations = state
      ? Object.values(state.conversations).map(({ summary }) => summary).filter((summary) => summary.kind !== "nest" && !summary.archived)
      : [];
    return friendsAndGroups({
      friends,
      conversations,
      personFor: (id, name) => strangerNamed(id, data.getPerson(id)?.name ?? name),
      activeConversationId,
      now: Date.now(),
    });
  }, [state, data, activeConversationId]);
  const activePeer = activeConversationId ? state?.conversations[activeConversationId]?.summary.peer?.id : undefined;
  const activePersonId = view.kind === "user" ? view.id : activePeer ?? "";
  return { ...lists, activePersonId, activeConversationId };
}

/**
 * Opens the conversation with a friend from their row: the direct message if there is one,
 * otherwise it asks the server for it (which creates it). Without chat, their profile.
 * `openingId` is the person being opened, so their row can wait instead of asking twice.
 */
export function useOpenPerson(store: ChatStore | null, onNavigate: (view: RavenView) => void) {
  const [openingId, setOpeningId] = useState("");
  const opening = useRef("");
  const open = useCallback(
    (personId: string) => {
      if (!store) {
        onNavigate({ kind: "user", id: personId });
        return;
      }
      const known = Object.values(store.getState().conversations).find(({ summary }) => summary.kind === "dm" && summary.peer?.id === personId);
      if (known) {
        onNavigate({ kind: "chat", id: known.summary.id });
        return;
      }
      if (opening.current) return;
      opening.current = personId;
      setOpeningId(personId);
      void store
        .openDM(personId)
        .then((conversation) => onNavigate({ kind: "chat", id: conversation.id }))
        .catch((failure) => toast({ title: failureText(failure, "Couldn’t open that conversation."), tone: "error" }))
        .finally(() => {
          opening.current = "";
          setOpeningId("");
        });
    },
    [store, onNavigate],
  );
  return { open, openingId };
}

/** Raven's own conversation (notes from Raven and the server), unless it is archived. */
export function useRavenConversation(store: ChatStore | null): ChatConversation | null {
  return useChatSelector(store, (state) => Object.values(state.conversations).find(({ summary }) => summary.kind === "raven" && !summary.archived)?.summary ?? null, null);
}

/**
 * Opens Saved messages, asking the server for it (which creates it) the first time. `savedId`
 * is empty until then, so the row that opens it is there before the conversation is.
 */
export function useOpenSaved(store: ChatStore | null, onNavigate: (view: RavenView) => void) {
  const savedId = useChatSelector(store, (state) => Object.values(state.conversations).find(({ summary }) => summary.kind === "saved")?.summary.id ?? "", "");
  const [opening, setOpening] = useState(false);
  const busy = useRef(false);
  const open = useCallback(() => {
    if (!store) return;
    if (savedId) {
      onNavigate({ kind: "chat", id: savedId });
      return;
    }
    if (busy.current) return;
    busy.current = true;
    setOpening(true);
    void store
      .openSaved()
      .then((conversation) => onNavigate({ kind: "chat", id: conversation.id }))
      .catch((failure) => toast({ title: failureText(failure, "Couldn’t open Saved messages."), tone: "error" }))
      .finally(() => {
        busy.current = false;
        setOpening(false);
      });
  }, [store, savedId, onNavigate]);
  return { open, opening, savedId };
}

/**
 * Whether the person can actually see the window: it is focused and not hidden. Messages
 * are only marked as read while this is true.
 */
export function useWindowActive(): boolean {
  const read = () => document.visibilityState === "visible" && document.hasFocus();
  const [active, setActive] = useState(read);
  useEffect(() => {
    const update = () => setActive(read());
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return active;
}
