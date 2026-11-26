import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown } from "lucide-react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { isLibraryMessage, type ReactionLimits } from "@/lib/chat/attachments";
import type { ChatStore } from "@/lib/chat/store";
import { typingLine } from "@/lib/chat/text";
import { useGlideToEnd } from "./useGlideToEnd";
import { unreadLabel } from "@/lib/chat/reducer";
import { buildRows, type ChatRow as Row } from "@/lib/chat/rows";
import { canSelect, type MessageSelection } from "@/lib/chat/selection";
import { lastVisibleIndex, renderedRowBoxes } from "@/lib/chat/visibility";
import type { ChatAttachment, ChatMessage, ConversationState, PendingMessage, ChatPollPrivacy } from "@/lib/chat/types";
import { MessageRow, PendingRow, type DeliveryStatus } from "./MessageRow";
import type { MentionContext } from "./MessageText";
import { SeenBy } from "./SeenBy";

interface RowHandlers {
  onReact: (emoji: string) => Promise<void>;
  onRemoveLinkPreview?: () => Promise<void>;
  onVote: (options: number[]) => Promise<void>;
  onClosePoll?: () => Promise<void>;
  onPollPrivacy?: (privacy: ChatPollPrivacy) => Promise<void>;
  onPin?: (pinned: boolean) => Promise<void>;
}

/** Virtuoso counts rows from here, leaving room to add older ones in front. */
const FIRST_INDEX = 1_000_000;
/** How many rows from the edge of the loaded window the next page is asked for. */
const FETCH_AHEAD_ROWS = 25;
/**
 * The height of an ordinary one-line message, for rows that have not been drawn yet.
 * Without it the list takes the first row it happens to measure as typical.
 */
const USUAL_ROW_HEIGHT = 52;
/** Messages can be edited for this long; the server has the final say. */
const EDIT_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * Keeps the list still while its window of messages moves.
 *
 * When older rows are added in front, or rows are dropped from the front, the index of
 * the first row moves by the same amount, so what the person is reading stays where it
 * is. When the window is replaced by a different part of the conversation altogether,
 * `epoch` changes and the list starts over.
 */
function useWindowAnchor(keys: string[]) {
  const anchor = useRef({ keys: [] as string[], first: FIRST_INDEX, epoch: 0 });
  return useMemo(() => {
    const previous = anchor.current;
    if (previous.keys.length > 0 && keys.length > 0 && previous.keys[0] !== keys[0]) {
      const added = keys.indexOf(previous.keys[0]);
      const dropped = previous.keys.indexOf(keys[0]);
      if (added > 0) previous.first -= added;
      else if (dropped > 0) previous.first += dropped;
      else {
        previous.epoch += 1;
        previous.first = FIRST_INDEX;
      }
    }
    previous.keys = keys;
    return { firstItemIndex: previous.first, epoch: previous.epoch };
  }, [keys]);
}

/** What the parts above and below the rows need. Passed through the list so they keep their identity. */
interface ListContext {
  loadingOlder: boolean;
  atStart: boolean;
  intro?: ReactNode;
  typing: string;
}

function ListHeader({ context }: { context?: ListContext }) {
  return (
    <div className="mx-auto w-full max-w-3xl px-6 pt-4">
      {context?.atStart ? (
        context.intro ? <div className="pb-2 pt-6 text-center text-small text-muted-foreground">{context.intro}</div> : null
      ) : (
        // The line keeps its place whether or not it has anything to say. If it came and
        // went, everything below would shift each time an earlier page was fetched.
        <p className="h-8 py-2 text-center text-caption text-subtle" role="status">
          {context?.loadingOlder ? "Loading earlier messages…" : null}
        </p>
      )}
    </div>
  );
}

function ListFooter({ context }: { context?: ListContext }) {
  return (
    <div className="mx-auto h-7 w-full max-w-3xl px-6 pt-1.5 text-caption text-muted-foreground" aria-live="polite">
      {context?.typing ? <bdi>{context.typing}</bdi> : null}
    </div>
  );
}

const LIST_PARTS = { Header: ListHeader, Footer: ListFooter };

/** Keys that move a scrolled list towards its start. */
const KEYS_UP = new Set(["ArrowUp", "PageUp", "Home"]);

export interface MessageListHandle {
  scrollToLatest: () => void;
  /** Brings a message into view and marks it for a moment, loading that part if needed. */
  goTo: (seq: number) => void;
}

export interface MessageListProps {
  store: ChatStore;
  reactionLimits?: ReactionLimits | null;
  conversation: ConversationState;
  me: string;
  /** The person can see the window, so what is on screen counts as read. */
  windowActive: boolean;
  /** Shown above the first message once the whole history is loaded. */
  intro?: ReactNode;
  onReply: (message: ChatMessage) => void;
  onEdit: (message: ChatMessage) => void;
  onRemoveForMe: (message: ChatMessage) => void;
  onDeleteForEveryone: (message: ChatMessage) => void;
  onOpenImage: (message: ChatMessage, attachment: ChatAttachment) => void;
  onOpenPerson: (userId: string) => void;
  /** Opens a space's lobby, from an event invitation. */
  onOpenSpace?: (treeId: string) => void;
  /** Adds a message to Saved messages. Absent inside Saved messages. */
  onSave?: (message: ChatMessage) => void;
  /** Opens the chat a copied message came from, at the original. */
  onOpenSource?: (conversationId: string, seq: number) => void;
  onForward?: (message: ChatMessage) => void;
  onStartSelecting?: (message: ChatMessage) => void;
  /** The messages being chosen; null when not choosing. */
  selection?: MessageSelection | null;
  /** A click on a message while choosing. `order` is what can be chosen, in order. */
  onToggleSelected?: (message: ChatMessage, shift: boolean, order: string[]) => void;
  mentions?: MentionContext;
  /** Messages here can be pinned: a text room, on a server that has pins. */
  pins?: boolean;
}

/**
 * The messages of one conversation. Only the rows near the viewport exist in the page,
 * and only a window of the conversation is held in memory, so a conversation of any
 * length scrolls the same.
 */
export const MessageList = forwardRef<MessageListHandle, MessageListProps>(function MessageList(
  { store, conversation, me, windowActive, intro, reactionLimits, onReply, onEdit, onRemoveForMe, onDeleteForEveryone, onOpenImage, onOpenPerson, onOpenSpace, onSave, onOpenSource, onForward, onStartSelecting, selection, onToggleSelected, mentions, pins = false },
  ref,
) {
  const { summary, messages, pending } = conversation;
  const id = summary.id;
  const virtuoso = useRef<VirtuosoHandle>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  // The list's scrolling element: what is on screen is read from it, not from the range
  // Virtuoso renders, which reaches 600 px beyond the viewport.
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const scrollerRef = useCallback((element: HTMLElement | Window | null) => {
    setScroller(element instanceof HTMLElement ? element : null);
  }, []);
  // Where "New messages" goes is decided once, when the conversation is opened: before
  // what was unread then. Messages that arrive while reading do not get a divider.
  const [dividerAfterSeq] = useState<number | null>(() => (summary.unreadCount > 0 ? summary.readSeq : null));
  // A message to open the window on, after jumping to it.
  const [focusSeq, setFocusSeq] = useState<number | null>(null);

  const inSaved = summary.kind === "saved";
  const rows = useMemo(
    // Saved messages keep no trace of what was deleted: a copy goes with its original.
    () => buildRows({ messages: inSaved ? messages.filter((message) => !message.deletedAt) : messages, pending, me, dividerAfterSeq, hasMoreBefore: conversation.hasMoreBefore, hasMoreAfter: conversation.hasMoreAfter }),
    [inSaved, messages, pending, me, dividerAfterSeq, conversation.hasMoreBefore, conversation.hasMoreAfter],
  );

  const keys = useMemo(() => rows.map((row) => row.key), [rows]);
  const { firstItemIndex, epoch } = useWindowAnchor(keys);
  const nameOf = useMemo(() => {
    const names = new Map<string, string>();
    for (const message of messages) if (message.senderName && !names.has(message.senderId)) names.set(message.senderId, message.senderName);
    for (const member of conversation.members) names.set(member.id, member.displayName || member.username);
    return (id: string) => names.get(id) || "Someone";
  }, [messages, conversation.members]);
  const byId = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages]);
  const selectable = useMemo(() => rows.flatMap((row) => (row.kind === "message" && canSelect(row.message) ? [row.message.id] : [])), [rows]);

  const initialIndex = useMemo(() => {
    if (focusSeq !== null) {
      const at = rows.findIndex((row) => row.kind === "message" && row.message.seq === focusSeq);
      if (at >= 0) return { index: at, align: "center" as const };
    }
    const divider = rows.findIndex((row) => row.kind === "message" && row.newDivider);
    if (divider >= 0) return { index: divider, align: "start" as const };
    return { index: "LAST" as const, align: "end" as const };
    // Only read when the list (re)starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epoch, conversation.loaded]);

  useEffect(() => {
    store.setAtBottom(id, atBottom && !conversation.hasMoreAfter);
  }, [store, id, atBottom, conversation.hasMoreAfter]);

  // Whether the view keeps up with the end of the conversation. It is set on reaching the
  // bottom and cleared only by the person scrolling up or jumping elsewhere, not by the list
  // growing: while the view glides down to one message, the next may already have arrived,
  // and that one has to be followed too.
  const following = useRef(false);
  // The view follows on a spring of its own rather than the browser's smooth scroll, which
  // starts abruptly, lasts about 100 ms and restarts with every message in a burst.
  const { glide, stop: stopGlide } = useGlideToEnd(scroller);
  const onAtBottomChange = useCallback((value: boolean) => {
    setAtBottom(value);
    if (value) following.current = true;
  }, []);
  useEffect(() => {
    if (!scroller) return;
    const stop = () => {
      following.current = false;
      stopGlide();
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) stop();
    };
    const onKey = (event: KeyboardEvent) => {
      if (KEYS_UP.has(event.key)) stop();
    };
    // A press on the scroller itself, not on a message in it, is a press on its scrollbar.
    const onPointer = (event: PointerEvent) => {
      if (event.target === scroller) stop();
    };
    scroller.addEventListener("wheel", onWheel, { passive: true });
    scroller.addEventListener("keydown", onKey);
    scroller.addEventListener("pointerdown", onPointer);
    return () => {
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("keydown", onKey);
      scroller.removeEventListener("pointerdown", onPointer);
    };
  }, [scroller, stopGlide]);

  // What is on screen has been seen, provided the person can see the window.
  const markVisibleRead = useCallback(() => {
    if (!windowActive || !scroller) return;
    const viewport = scroller.getBoundingClientRect();
    const lastSeen = lastVisibleIndex(renderedRowBoxes(scroller), viewport.top, viewport.bottom);
    for (let index = Math.min(lastSeen, rows.length - 1); index >= 0; index -= 1) {
      const row = rows[index];
      if (row?.kind !== "message") continue;
      if (row.message.seq > summary.readSeq) store.markRead(id, row.message.seq);
      return;
    }
  }, [windowActive, scroller, rows, summary.readSeq, store, id]);

  useEffect(markVisibleRead, [markVisibleRead]);

  // Scrolling within the rows already rendered changes what is seen without changing the
  // rendered range, so look again once per frame while scrolling.
  const markVisibleReadRef = useRef(markVisibleRead);
  markVisibleReadRef.current = markVisibleRead;
  useEffect(() => {
    if (!scroller) return;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        markVisibleReadRef.current();
      });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scroller]);

  const scrollToLatest = useCallback(() => {
    if (conversation.hasMoreAfter) {
      setFocusSeq(null);
      void store.jumpToLatest(id);
      return;
    }
    virtuoso.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
  }, [conversation.hasMoreAfter, store, id]);

  const openReply = useCallback(
    (seq: number) => {
      // The person went to read something further back; new messages must not pull them away.
      following.current = false;
      stopGlide();
      const at = rows.findIndex((row) => row.kind === "message" && row.message.seq === seq);
      const flash = (messageId: string) => {
        setHighlighted(messageId);
        window.setTimeout(() => setHighlighted((current) => (current === messageId ? null : current)), 1600);
      };
      if (at >= 0) {
        virtuoso.current?.scrollToIndex({ index: at, align: "center", behavior: "smooth" });
        const row = rows[at];
        if (row.kind === "message") flash(row.message.id);
        return;
      }
      // It is outside the loaded window: load the part of the conversation around it.
      setFocusSeq(seq);
      void store.jumpTo(id, seq).then(() => {
        const found = store.getState().conversations[id]?.messages.find((message) => message.seq === seq);
        if (found) flash(found.id);
      });
    },
    [rows, store, id],
  );

  useImperativeHandle(ref, () => ({ scrollToLatest, goTo: openReply }), [scrollToLatest, openReply]);

  // One set of handlers per message, kept while the conversation and what may be done in
  // it stay the same, so MessageRow's memo holds when other rows change.
  const canSend = summary.canSend;
  const rowHandlers = useMemo(() => {
    const cache = new Map<string, RowHandlers>();
    return (messageId: string, mine: boolean): RowHandlers => {
      const key = `${mine ? "1" : "0"}${messageId}`;
      let handlers = cache.get(key);
      if (!handlers) {
        handlers = {
          onReact: (emoji) => store.react(id, messageId, emoji),
          onRemoveLinkPreview: mine && canSend ? () => store.removeLinkPreview(id, messageId) : undefined,
          onVote: (options) => store.votePoll(id, messageId, options),
          onClosePoll: mine && canSend ? () => store.closePoll(id, messageId) : undefined,
          onPollPrivacy: mine && canSend ? (privacy) => store.setPollPrivacy(id, messageId, privacy) : undefined,
          // Who may pin or unpin which message is decided per message, by pinActions.
          onPin: pins ? (pinned) => store.setPinned(id, messageId, pinned) : undefined,
        };
        cache.set(key, handlers);
      }
      return handlers;
    };
  }, [store, id, canSend, pins]);
  const toggleSelected = useCallback(
    (toggled: ChatMessage, shift: boolean) => onToggleSelected?.(toggled, shift, selectable),
    [onToggleSelected, selectable],
  );

  const retry = useCallback((item: PendingMessage) => store.retry(id, item.clientMessageId), [store, id]);
  const discard = useCallback((item: PendingMessage) => store.discard(id, item.clientMessageId), [store, id]);

  const typing = typingLine(conversation.typing);
  const withAvatars = summary.kind !== "dm";
  const loadingOlder = conversation.loading === "older";
  const atStart = !conversation.hasMoreBefore;
  const context = useMemo<ListContext>(() => ({ loadingOlder, atStart, intro, typing }), [loadingOlder, atStart, intro, typing]);

  // When someone starts typing and the view is following, glide down so the whole line is
  // in view. Its space is always kept, so this moves at most the last few pixels.
  const someoneTyping = typing !== "";
  const atEnd = !conversation.hasMoreAfter;
  useEffect(() => {
    if (!someoneTyping || !atEnd || !scroller || !following.current) return;
    const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (gap > 1) glide();
  }, [someoneTyping, atEnd, scroller, glide]);

  if (!conversation.loaded) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-small text-muted-foreground" role="status">
        Loading messages…
      </div>
    );
  }

  return (
    <div className="relative min-h-0 flex-1">
      <Virtuoso<Row, ListContext>
        key={epoch}
        ref={virtuoso}
        scrollerRef={scrollerRef}
        className="h-full"
        data={rows}
        context={context}
        components={LIST_PARTS}
        firstItemIndex={firstItemIndex}
        initialTopMostItemIndex={initialIndex}
        computeItemKey={(_, row) => row.key}
        alignToBottom
        // New messages pull the view down only at the real end of the conversation. At
        // the end of a window further back, the next page would otherwise drag the view
        // to its own end, which fetches the page after that, and so on to the newest.
        followOutput={(isAtBottom) => {
          // The new row is laid out in the next frame; the glide starts there and reads the
          // end afresh on every frame.
          if ((isAtBottom || following.current) && !conversation.hasMoreAfter) requestAnimationFrame(glide);
          return false;
        }}
        atBottomThreshold={48}
        atBottomStateChange={onAtBottomChange}
        increaseViewportBy={{ top: 600, bottom: 600 }}
        defaultItemHeight={USUAL_ROW_HEIGHT}
        // Row heights are applied in the frame they are measured. A frame later, a row
        // taller than expected would show for an instant in the wrong place while
        // scrolling up.
        skipAnimationFrameInResizeObserver
        startReached={() => void store.loadOlder(id)}
        endReached={() => {
          if (conversation.hasMoreAfter) void store.loadNewer(id);
        }}
        rangeChanged={({ startIndex, endIndex }) => {
          markVisibleRead();
          // Ask for the next page while there is still some way to go, so that scrolling
          // steadily does not run into the edge of what is loaded and have to wait there.
          if (conversation.hasMoreBefore && startIndex - firstItemIndex < FETCH_AHEAD_ROWS) void store.loadOlder(id);
          if (conversation.hasMoreAfter && rows.length - 1 - (endIndex - firstItemIndex) < FETCH_AHEAD_ROWS) void store.loadNewer(id);
        }}
        itemContent={(_, row) => {
          if (row.kind === "pending") {
            return (
              <div className="mx-auto w-full max-w-3xl px-6">
                <PendingRow pending={row.pending} mentions={mentions} onRetry={retry} onDiscard={discard} />
              </div>
            );
          }
          const { message } = row;
          const mine = message.senderId === me;
          const status: DeliveryStatus | undefined = mine && !inSaved
            ? message.seq <= (summary.kind === "dm" ? (summary.peerReadSeq ?? 0) : (conversation.seen?.readSeq ?? 0)) ? "read" : "sent"
            : undefined;
          // A copy stays as it was saved; your own notes in Saved messages have no time limit.
          const handlers = rowHandlers(message.id, mine);
          const editable = mine && summary.canSend && !message.origin && !message.poll && !isLibraryMessage(message) && (inSaved || Date.now() - Date.parse(message.createdAt) < EDIT_WINDOW_MS);
          return (
            <div className="mx-auto w-full max-w-3xl px-6">
              <MessageRow
                message={message}
                mine={mine}
                me={me}
                withAvatars={withAvatars}
                showSender={withAvatars && !mine && !row.continuation}
                continuation={row.continuation}
                status={status}
                parent={message.replyTo ? byId.get(message.replyTo.id) : undefined}
                reactionLimits={reactionLimits}
                nameOf={nameOf}
                onReact={handlers.onReact}
                onRemoveLinkPreview={handlers.onRemoveLinkPreview}
                onVote={handlers.onVote}
                onClosePoll={handlers.onClosePoll}
                onPollPrivacy={handlers.onPollPrivacy}
                onPin={handlers.onPin}
                canPin={pins && Boolean(summary.canPin)}
                canManagePins={pins && summary.canManage}
                canReply={summary.canSend}
                canEdit={editable}
                canDeleteForEveryone={mine || summary.canManage}
                dayHeading={row.dayHeading}
                newDivider={row.newDivider}
                highlighted={highlighted === message.id}
                onReply={onReply}
                onEdit={onEdit}
                onRemoveForMe={onRemoveForMe}
                onDeleteForEveryone={onDeleteForEveryone}
                onOpenReply={openReply}
                onOpenImage={onOpenImage}
                onOpenPerson={onOpenPerson}
                onOpenSpace={onOpenSpace}
                onSave={onSave}
                onOpenSource={onOpenSource}
                onForward={onForward}
                onSelect={onStartSelecting}
                selecting={Boolean(selection)}
                selected={selection?.ids.has(message.id)}
                onToggleSelected={toggleSelected}
                inSaved={inSaved}
                mentions={mentions}
              />
              {message.seq === summary.lastSeq && !message.deletedAt && !inSaved && (mine || summary.kind !== "dm") ? (
                <SeenBy
                  onOpenPerson={onOpenPerson}
                  direct={summary.kind === "dm"}
                  readers={conversation.seen?.seq === message.seq ? conversation.seen.readers : []}
                  fallbackAt={summary.peerReadSeq !== undefined && summary.peerReadSeq >= message.seq ? summary.peerReadAt : undefined}
                />
              ) : null}
            </div>
          );
        }}
      />
      {!atBottom || conversation.hasMoreAfter ? (
        <button
          type="button"
          onClick={scrollToLatest}
          aria-label="Go to the latest messages"
          className="absolute bottom-9 right-6 flex h-9 animate-fade-in items-center gap-1.5 rounded-full bg-popover px-3 text-caption font-medium text-popover-foreground shadow-raised transition-colors hover:bg-accent"
        >
          <ArrowDown className="h-4 w-4" />
          {summary.unreadCount > 0 ? <span className="tabular-nums">{unreadLabel(summary.unreadCount)}</span> : null}
        </button>
      ) : null}
    </div>
  );
});
