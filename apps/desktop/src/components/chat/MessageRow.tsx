import { memo, useState, type ReactNode } from "react";
import { AlertCircle, Bookmark, CalendarClock, Check, CheckCheck, CheckCircle2, CircleStop, Clock, ChevronDown, Copy, CornerUpLeft, Download, EyeOff, Forward, MoreHorizontal, Pencil, SmilePlus, Trash2, Users } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { canShow, messageExcerpt, onlyPictures, summaryOf } from "@/lib/chat/attachments";
import type { ReactionLimits } from "@/lib/chat/attachments";
import { QUICK_REACTIONS } from "@/lib/chat/reactions";
import { failureText } from "@/lib/chat/errors";
import { libraryApi } from "@/lib/library/libraryApi";
import { saveAttachment } from "@/lib/chat/imageActions";
import { excerptOf } from "@/lib/chat/reducer";
import { emojiOnlyCount } from "@/lib/chat/format";
import { eventCancelledLine, eventInviteLine, systemLine, UNKNOWN_RAVEN_MESSAGE } from "@/lib/chat/text";
import { repeatText } from "@/lib/events";
import { boardTime } from "@/lib/notes";
import { Button } from "@/components/ui/button";
import { clockTime, fullTime, listTime } from "@/lib/chat/time";
import type { ChatAttachment, ChatMessage, ChatOrigin, ChatReplyRef, ChatSystemPayload, PendingMessage } from "@/lib/chat/types";
import { NestGlyph } from "@/shells/ravenv1/atoms";
import { cn } from "@/lib/utils";
import { MessageAttachments, PendingAttachments } from "./Attachments";
import { LibraryMedia } from "@/components/library/LibraryMedia";
import { libraryBox } from "@/lib/library/types";
import { RavenAvatar, SystemBadge } from "./ConversationRow";
import { LinkPreviewCard } from "./LinkPreview";
import { PollCard } from "./Poll";
import { EmojiPicker } from "./EmojiPicker";
import { Reactions } from "./Reactions";
import { MessageText, type MentionContext } from "./MessageText";
import { mentionsUser } from "@/lib/chat/mentions";
import { useSwipeToReply } from "./useSwipeToReply";

/** What stands above a message without being part of it. */
function Decorations({ dayHeading, newDivider }: { dayHeading?: string; newDivider?: boolean }) {
  return (
    <>
      {dayHeading ? (
        <div className="flex justify-center pb-2 pt-4">
          <span className="rounded-full bg-secondary px-2.5 py-0.5 text-caption text-muted-foreground">{dayHeading}</span>
        </div>
      ) : null}
      {newDivider ? (
        <div className="flex items-center gap-3 pb-2 pt-3" role="separator" aria-label="New messages">
          <span className="h-px flex-1 bg-border" />
          <span className="text-caption font-medium text-muted-foreground">New messages</span>
          <span className="h-px flex-1 bg-border" />
        </div>
      ) : null}
    </>
  );
}

/** The quoted line above a reply. Clicking it goes to the original when there is one to go to. */
function ReplyQuote({ reply, onOpen }: { reply: ChatReplyRef; onOpen?: () => void }) {
  const text = reply.unavailable ? "Original message isn’t available" : reply.deleted ? "Message deleted" : messageExcerpt(reply.excerpt, reply.attachments);
  const content = (
    <>
      {reply.senderName && !reply.unavailable ? <span className="block truncate text-caption font-medium"><bdi>{reply.senderName}</bdi></span> : null}
      <span dir="auto" className={cn("block truncate text-caption", reply.unavailable || reply.deleted ? "italic text-subtle" : "text-muted-foreground")}>{text}</span>
    </>
  );
  const className = "mb-1 block w-full min-w-0 border-s-2 border-subtle ps-2 text-start";
  if (!onOpen || reply.unavailable || !reply.seq) return <div className={className}>{content}</div>;
  return (
    <button type="button" onClick={onOpen} aria-label="Go to the original message" className={cn(className, "rounded-e-chip transition-colors hover:bg-foreground/5")}>
      {content}
    </button>
  );
}

/**
 * The caption above a copied message: who wrote it, the chat it came from when this viewer
 * may know that, and when. The sender opens their profile; the chat opens at the original.
 */
export function ForwardedFrom({ origin, onOpenPerson, onOpenSource }: { origin: ChatOrigin; onOpenPerson?: (userId: string) => void; onOpenSource?: (conversationId: string, seq: number) => void }) {
  const { senderId, senderName, source } = origin;
  const person = senderName ? (
    <>
      <Avatar name={senderName} src={senderId ? api.userAvatarUrl(senderId) : undefined} className="h-3.5 w-3.5 text-[8px]" />
      <bdi className="min-w-0 truncate">{senderName}</bdi>
    </>
  ) : null;
  const doorway = "inline-flex min-w-0 max-w-full items-center gap-1 rounded-chip border border-subtle/50 px-1.5 leading-5";
  const place = source ? (
    <>
      {source.kind === "dm" && source.peerId ? (
        <Avatar name={source.name} src={api.userAvatarUrl(source.peerId)} className="h-3.5 w-3.5 text-[8px]" />
      ) : source.kind === "group" ? (
        <Users className="h-3.5 w-3.5 shrink-0 text-subtle" aria-hidden />
      ) : (
        <NestGlyph kind="text" className="h-3.5 w-3.5 text-subtle" />
      )}
      <bdi className="min-w-0 truncate">{source.name}</bdi>
    </>
  ) : null;
  return (
    <div className="mb-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-caption text-muted-foreground">
      <Forward className="h-3.5 w-3.5 shrink-0 text-subtle" aria-hidden />
      {person ? <span className="sr-only">Forwarded from</span> : <span>Forwarded</span>}
      {person && senderId && onOpenPerson ? (
        <button type="button" onClick={() => onOpenPerson(senderId)} aria-label={`Open ${senderName}’s profile`} className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-chip hover:underline">{person}</button>
      ) : person ? (
        <span className="inline-flex min-w-0 max-w-full items-center gap-1">{person}</span>
      ) : null}
      {source && onOpenSource ? (
        <button type="button" onClick={() => onOpenSource(source.conversationId, source.seq)} aria-label={`Open ${source.name} at this message`} className={cn(doorway, "transition-colors hover:border-subtle hover:bg-secondary/60")}>{place}</button>
      ) : place ? (
        <span className={doorway}>{place}</span>
      ) : null}
      <time dateTime={origin.createdAt} title={fullTime(origin.createdAt)} className="tabular-nums text-subtle">{listTime(Date.parse(origin.createdAt))}</time>
    </div>
  );
}

export type DeliveryStatus = "sent" | "read";

export interface MessageRowProps {
  message: ChatMessage;
  mine: boolean;
  me: string;
  /** Leave room for avatars: true where more than two people talk. */
  withAvatars: boolean;
  /** Show who wrote it: on the first message of a run, where there are avatars. */
  showSender: boolean;
  continuation: boolean;
  status?: DeliveryStatus;
  /** The current copy of the message this replies to, when it is loaded. */
  parent?: ChatMessage;
  canReply: boolean;
  reactionLimits?: ReactionLimits | null;
  nameOf?: (id: string) => string;
  onReact?: (emoji: string) => Promise<void>;
  canEdit: boolean;
  canDeleteForEveryone: boolean;
  dayHeading?: string;
  newDivider?: boolean;
  highlighted?: boolean;
  onReply: (message: ChatMessage) => void;
  onEdit: (message: ChatMessage) => void;
  /** Takes the link preview off this message for everyone. Set on your own messages. */
  onRemoveLinkPreview?: () => Promise<void>;
  /** Sets my choices in this message's poll. */
  onVote?: (options: number[]) => Promise<void>;
  /** Ends this message's poll. Set on your own polls. */
  onClosePoll?: () => Promise<void>;
  onRemoveForMe: (message: ChatMessage) => void;
  onDeleteForEveryone: (message: ChatMessage) => void;
  onOpenReply: (seq: number) => void;
  /** Opens the viewer on one of the message's images. */
  onOpenImage: (message: ChatMessage, attachment: ChatAttachment) => void;
  /** Opens the sender's profile page. Without it the avatar and name are plain. */
  onOpenPerson?: (userId: string) => void;
  /** Opens a space's lobby, from an event invitation. Without it the card has no button. */
  onOpenSpace?: (treeId: string) => void;
  /** Adds the message to Saved messages. Without it the menu does not offer that. */
  onSave?: (message: ChatMessage) => void;
  /** Opens the chat a copy came from, at the original. */
  onOpenSource?: (conversationId: string, seq: number) => void;
  /** Opens the forward picker for this message. Without it the menu does not offer that. */
  onForward?: (message: ChatMessage) => void;
  /** Starts choosing messages, with this one chosen. */
  onSelect?: (message: ChatMessage) => void;
  /** Selection mode: clicking the row chooses it, and nothing in it acts. */
  selecting?: boolean;
  selected?: boolean;
  onToggleSelected?: (message: ChatMessage, shift: boolean) => void;
  /** Saved messages has one reader, so there is one way to delete. */
  inSaved?: boolean;
  /** Draws mentions; without it they show as unknown. */
  mentions?: MentionContext;
}

/** A sender's face or name; opens their profile when the conversation can. */
function PersonLink({ message, onOpenPerson, className, children }: { message: ChatMessage; onOpenPerson?: (userId: string) => void; className?: string; children: ReactNode }) {
  if (!onOpenPerson) return <>{children}</>;
  return (
    <button type="button" onClick={() => onOpenPerson(message.senderId)} aria-label={`Open ${message.senderName}’s profile`} className={cn("max-w-full rounded-control text-start", className)}>
      {children}
    </button>
  );
}

/** The time, and for my own messages whether it has been read. */
function MessageMeta({ message, mine, deleted, status, overImage, alignStart, className }: { message: ChatMessage; mine: boolean; deleted: boolean; status?: DeliveryStatus; overImage?: boolean; alignStart?: boolean; className?: string }) {
  return (
    <div
      className={cn(
        "flex items-center justify-end gap-1 text-caption",
        alignStart && "justify-start",
        // Over a picture the colours behind are anyone's guess, so it gets a scrim.
        overImage ? "pointer-events-none absolute bottom-1.5 right-1.5 rounded-chip bg-black/55 px-1.5 py-0.5 text-white backdrop-blur-md" : "mt-0.5 text-subtle",
        className,
      )}
    >
      {message.editedAt && !deleted ? <span title={`Edited ${fullTime(message.editedAt)}`}>edited</span> : null}
      <time dateTime={message.createdAt} title={fullTime(message.createdAt)} className="tabular-nums">{clockTime(message.createdAt)}</time>
      {mine && !deleted ? (
        status === "read" ? (
          <CheckCheck className={cn("h-3.5 w-3.5", !overImage && "text-muted-foreground")} aria-label="Read" />
        ) : (
          <Check className="h-3.5 w-3.5" aria-label="Sent" />
        )
      ) : null}
    </div>
  );
}

/**
 * A message from Raven or the server admin, in the Raven contact. It comes from Raven, not
 * from the person it is addressed to, whatever sender the server records. The admin's words
 * are plain text: they are shown as written, never parsed for mentions or formatting.
 */
function RavenMessageRow({ message, dayHeading, newDivider, onOpenSpace }: { message: ChatMessage; dayHeading?: string; newDivider?: boolean; onOpenSpace?: (treeId: string) => void }) {
  const system = message.system;
  const admin = system?.type === "admin";
  return (
    <div>
      <Decorations dayHeading={dayHeading} newDivider={newDivider} />
      <div className="flex items-start gap-2 pt-2.5">
        <RavenAvatar className="h-7 w-7" />
        <div className="min-w-0 max-w-[min(100%,34rem)] rounded-card bg-secondary px-3 py-1.5">
          <div className="flex items-center gap-1.5 text-caption">
            <span className="font-medium text-muted-foreground">Raven</span>
            <SystemBadge />
            {system?.type === "event" && system.updated && !system.cancelled ? <span className="shrink-0 rounded-full bg-accent px-1.5 text-caption text-foreground">Updated</span> : null}
          </div>
          {system?.type === "event" ? (
            <EventInvitation system={system} onOpenSpace={onOpenSpace} />
          ) : admin ? (
            <>
              <p className="pt-0.5 text-caption text-subtle">From the server admin</p>
              <p dir="auto" className="whitespace-pre-wrap break-words text-body text-foreground">{message.system?.text ?? ""}</p>
            </>
          ) : (
            <p className="text-body text-muted-foreground">{UNKNOWN_RAVEN_MESSAGE}</p>
          )}
          <time className="mt-0.5 block text-caption tabular-nums text-subtle" dateTime={message.createdAt} title={fullTime(message.createdAt)}>{clockTime(message.createdAt)}</time>
        </div>
      </div>
    </div>
  );
}

/** Raven's message about an event: who invited you to what, when and where. Times are the viewer's own. */
function EventInvitation({ system, onOpenSpace }: { system: ChatSystemPayload; onOpenSpace?: (treeId: string) => void }) {
  if (system.cancelled) return <p dir="auto" className="pt-0.5 text-body text-foreground">{eventCancelledLine(system)}</p>;
  const repeats = repeatText(system.rrule ?? null);
  const when = [system.startsAt ? boardTime(system.startsAt) : "", repeats].filter(Boolean).join(" · ");
  return (
    <div className="pt-0.5">
      <p dir="auto" className="text-body text-foreground">{eventInviteLine(system)}</p>
      {when ? <p className="mt-1 flex items-center gap-1.5 text-small text-muted-foreground"><CalendarClock className="h-3.5 w-3.5 shrink-0 text-subtle" aria-hidden />{when}</p> : null}
      {system.target?.name ? (
        <p className="mt-0.5 flex items-center gap-1.5 text-small text-muted-foreground">
          <NestGlyph kind={system.target.kind === "text" ? "text" : "voice"} className="h-3.5 w-3.5 shrink-0 text-subtle" />
          <bdi className="min-w-0 truncate">{system.target.name}</bdi>
        </p>
      ) : null}
      {onOpenSpace && system.treeId ? (
        <Button size="sm" variant="outline" className="mt-2" onClick={() => onOpenSpace(system.treeId!)}>
          Open <bdi className="ms-1 min-w-0 truncate">{system.space}</bdi>
        </Button>
      ) : null}
    </div>
  );
}

/** One message in a conversation. */
export const MessageRow = memo(function MessageRow(props: MessageRowProps) {
  const { message, mine, showSender, continuation, status, parent } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const [reactionOpen, setReactionOpen] = useState(false);
  const [fullPicker, setFullPicker] = useState(false);
  // Swipe left to reply, wherever the Reply button would show.
  const swipe = useSwipeToReply({
    disabled: !props.canReply || message.kind === "system" || Boolean(message.deletedAt) || Boolean(props.selecting),
    onReply: () => props.onReply(message),
  });

  if (message.kind === "system" && message.system?.type) {
    return <RavenMessageRow message={message} dayHeading={props.dayHeading} newDivider={props.newDivider} onOpenSpace={props.onOpenSpace} />;
  }
  if (message.kind === "system") {
    return (
      <div>
        <Decorations dayHeading={props.dayHeading} newDivider={props.newDivider} />
        <p className="py-1.5 text-center text-caption text-muted-foreground"><bdi>{systemLine(message.system, message.senderId, message.senderName, props.me)}</bdi></p>
      </div>
    );
  }

  const deleted = Boolean(message.deletedAt);
  // A reply shows the original as it is now when that is on screen, and otherwise as it
  // was when this message was fetched.
  const reply: ChatReplyRef | undefined = message.replyTo && parent
    ? { id: parent.id, seq: parent.seq, senderId: parent.senderId, senderName: parent.senderName, deleted: Boolean(parent.deletedAt), excerpt: parent.deletedAt ? undefined : excerptOf(parent.body), attachments: parent.deletedAt ? undefined : summaryOf(parent) }
    : message.replyTo;
  const attachments = !deleted ? message.attachments ?? [] : [];
  const hasText = message.body.trim() !== "";
  // Pictures with nothing to say about them stand on their own, without a bubble.
  const origin = !deleted ? message.origin : undefined;
  const poll = !deleted ? message.poll : undefined;
  const bareEmoji = !deleted && !poll && !origin && attachments.length === 0 && !reply && emojiOnlyCount(message.body) > 0;
  const bare = bareEmoji || (!origin && attachments.length > 0 && !hasText && !reply && onlyPictures(attachments));
  const shown = attachments.filter(canShow);
  const savable = shown.length === 1 && shown[0].kind === "image" ? shown[0] : null;

  const libraryAttachment = shown.length === 1 && (shown[0].kind === "gif" || shown[0].kind === "sticker") ? shown[0] : null;
  const saveToLibrary = () => {
    if (!libraryAttachment) return;
    const what = libraryAttachment.kind === "gif" ? "GIF" : "sticker";
    void libraryApi.save({ attachmentId: libraryAttachment.id }).then(
      () => toast({ title: `Saved to your ${what}s` }),
      (failure: unknown) => toast({ title: `Couldn’t save the ${what}`, description: failureText(failure, "Try again in a moment."), tone: "error" }),
    );
  };

  const save = () => {
    if (!savable) return;
    void saveAttachment(message.conversationId, savable).then(
      (saved) => {
        if (saved) toast({ title: "Image saved" });
      },
      () => toast({ title: "Couldn’t save the image", description: "Try again in a moment.", tone: "error" }),
    );
  };

  const closePoll = () => {
    void props.onClosePoll?.().catch((failure: unknown) => toast({ title: failureText(failure, "Couldn’t end the poll."), tone: "error" }));
  };

  const removeLinkPreview = () => {
    void props.onRemoveLinkPreview?.().catch((failure: unknown) => toast({ title: failureText(failure, "Couldn’t remove the preview."), tone: "error" }));
  };

  const copy = () => {
    void navigator.clipboard.writeText(message.body).then(
      () => toast({ title: "Copied" }),
      () => toast({ title: "Couldn’t copy", description: "Select the text and copy it instead.", tone: "error" }),
    );
  };

  const canReact = Boolean(props.reactionLimits && props.canReply && !deleted && props.onReact);
  const react = (emoji: string) => {
    setReactionOpen(false);
    setMenuOpen(false);
    void props.onReact?.(emoji).catch((failure: unknown) => toast({ title: failureText(failure, "Couldn’t react to that."), tone: "error" }));
  };
  const yours = (emoji: string) => message.reactions?.some((reaction) => reaction.emoji === emoji && reaction.userIds.includes(props.me));
  const hasChips = Boolean(!deleted && props.reactionLimits && message.reactions?.length);
  const chips = (align: "start" | "end") => hasChips ? <Reactions
    reactions={message.reactions!} me={props.me} align={align} limits={props.reactionLimits!}
    canSend={props.canReply} nameOf={props.nameOf ?? (() => "Someone")} onReact={react}
  /> : null;
  // One look for the quick row, in the popover and at the top of the menu.
  const quickClass = (emoji: string) => cn(
    "group/quick flex h-9 w-9 items-center justify-center rounded-full p-0 text-[22px] leading-none transition-colors hover:bg-secondary focus:bg-secondary",
    yours(emoji) && "bg-foreground/[0.16] ring-1 ring-inset ring-foreground/25",
  );
  const quickEmoji = (emoji: string) => (
    <span className="transition-transform duration-150 group-hover/quick:scale-[1.15] motion-reduce:transition-none">{emoji}</span>
  );

  const actions = (
    <div className={cn("flex shrink-0 items-center self-center", menuOpen || reactionOpen ? "opacity-100" : "pointer-events-none opacity-0 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100")}>
      {canReact ? <Popover open={reactionOpen} onOpenChange={(open) => { setReactionOpen(open); if (open) setFullPicker(false); }}>
        <Tooltip label="React"><PopoverTrigger asChild>
          <button type="button" aria-label="React" className="flex h-7 w-7 items-center justify-center rounded-control text-subtle transition-colors hover:bg-secondary hover:text-foreground"><SmilePlus className="h-4 w-4" /></button>
        </PopoverTrigger></Tooltip>
        <PopoverContent side="top" align={mine ? "end" : "start"} className={fullPicker ? "w-auto p-0" : "w-auto rounded-full p-1"}>
          {fullPicker ? <EmojiPicker autoFocus onPick={react} /> : <div className="flex items-center gap-0.5" onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
            event.preventDefault();
            const buttons = Array.from(event.currentTarget.querySelectorAll("button"));
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const step = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
            buttons[(index + step + buttons.length) % buttons.length]?.focus();
          }}>
            {QUICK_REACTIONS.map((emoji) => <button key={emoji} type="button" aria-label={`React with ${emoji}`} aria-pressed={Boolean(yours(emoji))} onClick={() => react(emoji)} className={quickClass(emoji)}>{quickEmoji(emoji)}</button>)}
            <span className="mx-0.5 h-5 w-px bg-border" aria-hidden />
            <Tooltip label="More emoji">
              <button type="button" aria-label="More emoji" onClick={() => setFullPicker(true)} className="flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"><ChevronDown className="h-4 w-4" /></button>
            </Tooltip>
          </div>}
        </PopoverContent>
      </Popover> : null}
      {props.canReply && !deleted ? (
        <Tooltip label="Reply">
          <button type="button" aria-label="Reply" onClick={() => props.onReply(message)} className="flex h-7 w-7 items-center justify-center rounded-control text-subtle transition-colors hover:bg-secondary hover:text-foreground">
            <CornerUpLeft className="h-4 w-4" />
          </button>
        </Tooltip>
      ) : null}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label="More for this message" className="flex h-7 w-7 items-center justify-center rounded-control text-subtle transition-colors hover:bg-secondary hover:text-foreground">
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={mine ? "end" : "start"}>
          {canReact ? <>
            <div className="flex gap-0.5" onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              event.stopPropagation();
              const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
              const index = items.indexOf(document.activeElement as HTMLElement);
              items[(index + (event.key === "ArrowLeft" ? -1 : 1) + items.length) % items.length]?.focus();
            }}>
              {QUICK_REACTIONS.map((emoji) => <DropdownMenuItem key={emoji} aria-label={`React with ${emoji}`} onSelect={() => react(emoji)} className={quickClass(emoji)}>{quickEmoji(emoji)}</DropdownMenuItem>)}
            </div>
            <DropdownMenuSeparator />
          </> : null}
          {props.canReply && !deleted ? (
            <DropdownMenuItem onSelect={() => props.onReply(message)}>
              <CornerUpLeft className="text-muted-foreground" />
              Reply
            </DropdownMenuItem>
          ) : null}
          {props.onForward && !deleted ? (
            <DropdownMenuItem onSelect={() => props.onForward!(message)}>
              <Forward className="text-muted-foreground" />
              Forward
            </DropdownMenuItem>
          ) : null}
          {props.onSelect && !deleted ? (
            <DropdownMenuItem onSelect={() => props.onSelect!(message)}>
              <CheckCircle2 className="text-muted-foreground" />
              Select
            </DropdownMenuItem>
          ) : null}
          {props.onSave && !deleted ? (
            <DropdownMenuItem onSelect={() => props.onSave!(message)}>
              <Bookmark className="text-muted-foreground" />
              Add to Saved messages
            </DropdownMenuItem>
          ) : null}
          {!deleted && savable ? (
            <DropdownMenuItem onSelect={save}>
              <Download className="text-muted-foreground" />
              Save image…
            </DropdownMenuItem>
          ) : null}
          {!deleted && libraryAttachment ? (
            <DropdownMenuItem onSelect={saveToLibrary}>
              <Bookmark className="text-muted-foreground" />
              Save to my library
            </DropdownMenuItem>
          ) : null}
          {!deleted && hasText ? (
            <DropdownMenuItem onSelect={copy}>
              <Copy className="text-muted-foreground" />
              Copy text
            </DropdownMenuItem>
          ) : null}
          {poll && !poll.closedAt && props.onClosePoll ? (
            <DropdownMenuItem onSelect={closePoll}>
              <CircleStop className="text-muted-foreground" />
              {poll.quiz ? "End quiz" : "End poll"}
            </DropdownMenuItem>
          ) : null}
          {props.canEdit && !deleted ? (
            <DropdownMenuItem onSelect={() => props.onEdit(message)}>
              <Pencil className="text-muted-foreground" />
              Edit
            </DropdownMenuItem>
          ) : null}
          {!deleted ? <DropdownMenuSeparator /> : null}
          {!props.inSaved ? (
            <DropdownMenuItem onSelect={() => props.onRemoveForMe(message)}>
              <EyeOff className="text-muted-foreground" />
              Remove for me
            </DropdownMenuItem>
          ) : null}
          {props.canDeleteForEveryone && !deleted ? (
            <DropdownMenuItem destructive onSelect={() => props.onDeleteForEveryone(message)}>
              <Trash2 />
              {props.inSaved ? "Delete" : "Delete for everyone"}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  return (
    <div>
      <Decorations dayHeading={props.dayHeading} newDivider={props.newDivider} />
      <div
        className={cn("relative", props.selecting && "flex cursor-pointer select-none items-center gap-2 rounded-control transition-colors", props.selected && "bg-secondary/60")}
        // In selection mode the whole row is one control: nothing inside it opens or reacts.
        onClickCapture={props.selecting ? (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!deleted) props.onToggleSelected?.(message, event.shiftKey);
        } : undefined}
      >
      {props.selecting ? (
        deleted ? <span className="h-5 w-5 shrink-0" aria-hidden /> : (
          <button
            type="button"
            role="checkbox"
            aria-checked={Boolean(props.selected)}
            aria-label="Select this message"
            className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors", props.selected ? "border-primary bg-primary text-primary-foreground" : "border-input")}
          >
            {props.selected ? <Check className="h-3.5 w-3.5" aria-hidden /> : null}
          </button>
        )
      ) : null}
      <span ref={swipe.arrowRef} aria-hidden className={cn("pointer-events-none absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full opacity-0", swipe.armed ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground")} style={{ transform: "scale(0.6)" }}>
        <CornerUpLeft className="h-4 w-4" />
      </span>
      <div
        ref={swipe.rowRef}
        className={cn("group flex touch-pan-y items-end gap-2", continuation ? "pt-0.5" : "pt-2.5", mine && "flex-row-reverse", props.selecting && "min-w-0 flex-1")}
        onContextMenu={(event) => {
          if (props.selecting) {
            event.preventDefault();
            return;
          }
          // Right-click opens the same menu as the button, unless text is being selected.
          if (window.getSelection()?.toString()) return;
          event.preventDefault();
          setMenuOpen(true);
        }}
      >
        {!mine && props.withAvatars ? (
          <span className="w-7 shrink-0 self-start">
            {showSender ? <PersonLink message={message} onOpenPerson={props.onOpenPerson} className="block rounded-full"><Avatar name={message.senderName} src={api.userAvatarUrl(message.senderId)} className="h-7 w-7" /></PersonLink> : null}
          </span>
        ) : null}
        {bare ? (
          <div className={cn("min-w-0 max-w-[min(100%,34rem)] rounded-control transition-colors", props.highlighted && "outline outline-2 outline-ring")}>
            {showSender && !mine ? <div className="truncate pb-0.5 text-caption font-medium text-muted-foreground"><PersonLink message={message} onOpenPerson={props.onOpenPerson} className="max-w-full truncate hover:underline"><bdi>{message.senderName}</bdi></PersonLink></div> : null}
            {bareEmoji ? <>
              <MessageText body={message.body} mentions={props.mentions} />
              {hasChips ? <div className="mt-1">{chips(mine ? "end" : "start")}</div> : null}
              <MessageMeta message={message} mine={mine && !props.inSaved} deleted={deleted} status={status} alignStart={!mine} />
            </> : <MessageAttachments
              conversationId={message.conversationId}
              attachments={attachments}
              senderName={mine ? "you" : message.senderName}
              onOpen={(attachment) => props.onOpenImage(message, attachment)}
              footer={<MessageMeta message={message} mine={mine && !props.inSaved} deleted={deleted} status={status} overImage />}
            />}
            {!bareEmoji && hasChips ? <div className="mt-1">{chips(mine ? "end" : "start")}</div> : null}
          </div>
        ) : (
          <div
            className={cn(
              "min-w-0 max-w-[min(100%,34rem)] rounded-card px-3 py-1.5 transition-colors",
              mine ? "bg-accent" : "bg-secondary",
              // A message that mentions you catches a thin edge of light on its side.
              !mine && !deleted && mentionsUser(message.body, props.me) && "shadow-[inset_2px_0_0_0_hsl(var(--live))]",
              props.highlighted && "outline outline-2 outline-ring",
            )}
          >
            {showSender && !mine ? <div className="truncate text-caption font-medium text-muted-foreground"><PersonLink message={message} onOpenPerson={props.onOpenPerson} className="max-w-full truncate hover:underline"><bdi>{message.senderName}</bdi></PersonLink></div> : null}
            {origin ? <ForwardedFrom origin={origin} onOpenPerson={props.onOpenPerson} onOpenSource={props.onOpenSource} /> : null}
            {reply && !deleted ? <ReplyQuote reply={reply} onOpen={reply.seq ? () => props.onOpenReply(reply.seq!) : undefined} /> : null}
            {attachments.length > 0 ? (
              <div className="-mx-1.5 mb-1 mt-0.5">
                <MessageAttachments
                  conversationId={message.conversationId}
                  attachments={attachments}
                  senderName={mine ? "you" : message.senderName}
                  onOpen={(attachment) => props.onOpenImage(message, attachment)}
                />
              </div>
            ) : null}
            {deleted ? (
              <p className="text-body italic text-subtle">Message deleted</p>
            ) : poll ? (
              <PollCard poll={poll} question={message.body} mine={mine} canVote={props.canReply && Boolean(props.onVote) && !props.selecting} nameOf={props.nameOf} onVote={props.onVote ?? (() => Promise.resolve())} />
            ) : hasText ? (
              <MessageText body={message.body} mentions={props.mentions} />
            ) : null}
            {!deleted && message.linkPreview ? (
              <LinkPreviewCard
                conversationId={message.conversationId}
                messageId={message.id}
                preview={message.linkPreview}
                onRemove={props.onRemoveLinkPreview ? removeLinkPreview : undefined}
              />
            ) : null}
            {hasChips ? (
              // Reactions share the last line with the time, as in a printed note's footer.
              <div className="mt-1 flex flex-wrap items-end gap-x-3 gap-y-1">
                {chips("start")}
                <MessageMeta message={message} mine={mine && !props.inSaved} deleted={deleted} status={status} className="ml-auto mt-0 h-7" />
              </div>
            ) : (
              <MessageMeta message={message} mine={mine && !props.inSaved} deleted={deleted} status={status} />
            )}
          </div>
        )}
        {props.selecting ? null : actions}
      </div>
      </div>
    </div>
  );
});

/** A message that has been written but not yet acknowledged by the server. */
export const PendingRow = memo(function PendingRow({
  pending,
  onRetry,
  onDiscard,
}: {
  pending: PendingMessage;
  onRetry: (pending: PendingMessage) => void;
  onDiscard: (pending: PendingMessage) => void;
}) {
  const failed = pending.state === "failed";
  const attachments = pending.attachments ?? [];
  const hasText = pending.body.trim() !== "";
  const bareEmoji = attachments.length === 0 && !pending.replyTo && emojiOnlyCount(pending.body) > 0;
  const library = pending.library;
  const bare = bareEmoji || ((attachments.length > 0 || library) && !hasText && !pending.replyTo);
  const libraryView = (footer?: ReactNode) => {
    if (!library) return null;
    const box = libraryBox(library.kind, library.width, library.height);
    return (
      <div className="relative max-w-full" style={{ width: box.width }}>
        <LibraryMedia media={library} width={box.width} height={box.height} />
        {footer}
      </div>
    );
  };
  const meta = (overImage: boolean) => (
    <div
      className={cn(
        "flex items-center justify-end gap-1 text-caption",
        overImage ? "pointer-events-none absolute bottom-1.5 right-1.5 rounded-chip bg-black/55 px-1.5 py-0.5 text-white backdrop-blur-md" : "mt-0.5 text-subtle",
      )}
    >
      {failed ? (
        <AlertCircle className={cn("h-3.5 w-3.5", !overImage && "text-destructive")} aria-label="Not sent" />
      ) : (
        <>
          <span>Sending…</span>
          <Clock className="h-3.5 w-3.5" aria-hidden />
        </>
      )}
    </div>
  );
  return (
    <div className="flex flex-col items-end pt-2.5">
      {bare ? (
        <div className="min-w-0 max-w-[min(100%,34rem)]">
          {bareEmoji ? <><MessageText body={pending.body} />{meta(false)}</> : library ? libraryView(meta(true)) : <PendingAttachments attachments={attachments} footer={meta(true)} />}
        </div>
      ) : (
        <div className="min-w-0 max-w-[min(100%,34rem)] rounded-card bg-accent px-3 py-1.5">
          {pending.replyTo ? <ReplyQuote reply={pending.replyTo} /> : null}
          {library ? <div className="-mx-1.5 mb-1 mt-0.5">{libraryView()}</div> : null}
          {attachments.length > 0 ? (
            <div className="-mx-1.5 mb-1 mt-0.5">
              <PendingAttachments attachments={attachments} />
            </div>
          ) : null}
          {hasText ? <MessageText body={pending.body} /> : null}
          {meta(false)}
        </div>
      )}
      {failed ? (
        <div className="mt-1 flex max-w-[34rem] flex-wrap items-center justify-end gap-x-2 gap-y-1 text-caption" role="alert">
          <span className="text-destructive">Not sent. {pending.error && pending.error !== "Not sent." ? pending.error : "Nobody has seen this."}</span>
          <button type="button" onClick={() => onRetry(pending)} className="rounded-chip px-1.5 py-0.5 font-medium text-foreground transition-colors hover:bg-secondary">Send again</button>
          <button type="button" onClick={() => onDiscard(pending)} className="rounded-chip px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground">Discard</button>
        </div>
      ) : null}
    </div>
  );
});
