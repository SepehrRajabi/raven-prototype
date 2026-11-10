import { memo } from "react";
import { BellOff, Bookmark, UserRound, Users } from "lucide-react";
import { NestGlyph } from "@/shells/ravenv1/atoms";
import { Avatar } from "@/components/ui/avatar";
import { api } from "@/lib/api";
import { unreadLabel } from "@/lib/chat/reducer";
import { previewLine } from "@/lib/chat/text";
import { listTime } from "@/lib/chat/time";
import type { ChatConversation } from "@/lib/chat/types";
import { cn } from "@/lib/utils";

/**
 * How many messages are unread, on the conversation's own row. Neutral on purpose: it
 * states a fact and does not use the colour that means a person is live.
 */
export function UnreadCount({ count, className }: { count: number; className?: string }) {
  const label = unreadLabel(count);
  if (!label) return null;
  return (
    <span aria-label={`${label} unread`} className={cn("shrink-0 rounded-full bg-accent px-1.5 text-caption font-medium tabular-nums text-foreground", className)}>
      {label}
    </span>
  );
}

/**
 * Someone mentioned you here: a small face in the soft aqua that means a person, beside
 * the count. Not an "@" badge.
 */
export function MentionDot({ count, className }: { count?: number; className?: string }) {
  if (!count) return null;
  return (
    <span role="img" aria-label="Mentions you" title="Mentions you" className={cn("flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-live text-live-foreground", className)}>
      <UserRound className="h-2.5 w-2.5" strokeWidth={2.5} aria-hidden />
    </span>
  );
}

/** "Something here is unread", for places that are not the conversation's own row. */
export function UnreadDot({ className, label = "Unread messages" }: { className?: string; label?: string }) {
  return <span role="img" aria-label={label} title={label} className={cn("h-1.5 w-1.5 shrink-0 rounded-full bg-foreground", className)} />;
}

/**
 * Marks a group beside its name, so it reads differently from a direct message. Neutral
 * on purpose: it states what the conversation is, not that anyone is live.
 */
export function GroupIndicator({ className }: { className?: string }) {
  return <Users role="img" aria-label="Group" className={cn("h-3.5 w-3.5 shrink-0 text-subtle", className)} />;
}

/** Explicitly muted people and groups; silence is normal for a text nest. */
export function MutedIndicator({ conversation }: { conversation?: ChatConversation }) {
  return conversation?.kind !== "nest" && conversation?.notify === "off" ? <BellOff role="img" aria-label="Muted" className="h-3 w-3 shrink-0 text-subtle" /> : null;
}

/** Saved messages: your own face with a small bookmark on it. */
export function SavedAvatar({ userId, name, className }: { userId: string; name: string; className?: string }) {
  return (
    <span className="relative shrink-0">
      <Avatar name={name} src={api.userAvatarUrl(userId)} className={className} />
      <span className="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-secondary text-foreground outline outline-2 outline-background">
        <Bookmark className="h-2.5 w-2.5" aria-hidden />
      </span>
    </span>
  );
}

/** Raven's own contact: the app's mark, never a person's picture. */
export function RavenAvatar({ className }: { className?: string }) {
  return <img src="/favicon.png" alt="" aria-hidden className={cn("shrink-0 rounded-full bg-secondary object-contain p-1", className)} />;
}

/** Marks a message source that is not a person. Bordered, quiet, never a colour. */
export function SystemBadge({ className }: { className?: string }) {
  return <span className={cn("shrink-0 rounded-full border border-border px-1.5 text-caption text-muted-foreground", className)}>System</span>;
}

/** The picture for a conversation: the other person, the group's initials, or a text nest's mark. */
export function ConversationAvatar({ conversation, me, className }: { conversation: ChatConversation; /** Whose Saved messages this would be. */ me?: string; className?: string }) {
  if (conversation.kind === "raven") return <RavenAvatar className={className} />;
  if (conversation.kind === "saved" && me) return <SavedAvatar userId={me} name={conversation.name} className={className} />;
  if (conversation.kind === "nest") {
    return (
      <span className={cn("flex shrink-0 items-center justify-center text-subtle", className)} aria-hidden>
        <NestGlyph kind="text" />
      </span>
    );
  }
  if (conversation.kind === "dm" && conversation.peer) {
    return <Avatar name={conversation.name} src={api.userAvatarUrl(conversation.peer.id)} className={className} />;
  }
  return <Avatar name={conversation.name} className={cn("rounded-control", className)} />;
}

/** One conversation in the sidebar: a single line, with a count when something is unread. */
export const ConversationRowCompact = memo(function ConversationRowCompact({
  conversation,
  active,
  nested = false,
  caption,
  onOpen,
}: {
  conversation: ChatConversation;
  active: boolean;
  nested?: boolean;
  /** What is on in a text room now, under its name. */
  caption?: string;
  onOpen: (id: string) => void;
}) {
  const unread = conversation.unreadCount > 0;
  const name = <bdi>{conversation.name}</bdi>;
  return (
    <button
      type="button"
      onClick={() => onOpen(conversation.id)}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-control pr-2 text-left transition-colors",
        caption ? "min-h-9 py-1" : "h-9",
        nested ? "pl-[30px]" : "pl-2",
        active ? "bg-secondary" : "hover:bg-secondary/60",
      )}
    >
      <ConversationAvatar conversation={conversation} className={conversation.kind === "nest" ? "h-5 w-5" : "h-6 w-6 text-[10px]"} />
      {caption ? (
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate text-small", unread || active ? "font-medium text-foreground" : "text-muted-foreground")}>{name}</span>
          <span className="block truncate text-caption text-subtle"><bdi>{caption}</bdi></span>
        </span>
      ) : (
        <span className={cn("min-w-0 flex-1 truncate text-small", unread || active ? "font-medium text-foreground" : "text-muted-foreground")}>{name}</span>
      )}
      {conversation.kind === "raven" ? <SystemBadge /> : null}
      <MutedIndicator conversation={conversation} />
      {conversation.kind === "group" ? <GroupIndicator /> : null}
      <MentionDot count={conversation.mentionCount} />
      <UnreadCount count={conversation.unreadCount} />
    </button>
  );
});

/** One conversation in the full list: who, what was said last, and when. */
export const ConversationRow = memo(function ConversationRow({
  conversation,
  me,
  onOpen,
}: {
  conversation: ChatConversation;
  me: string;
  onOpen: (id: string) => void;
}) {
  const preview = previewLine(conversation, me);
  const unread = conversation.unreadCount > 0;
  return (
    <button type="button" onClick={() => onOpen(conversation.id)} className="flex h-16 w-full items-center gap-3 px-3.5 text-left transition-colors hover:bg-secondary">
      <ConversationAvatar conversation={conversation} me={me} className="h-9 w-9" />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={cn("min-w-0 flex-1 truncate text-body", unread ? "font-semibold" : "font-medium")}><bdi>{conversation.name}</bdi></span>
          {conversation.kind === "raven" ? <SystemBadge className="self-center" /> : null}
          <MutedIndicator conversation={conversation} />
          {conversation.kind === "group" ? <GroupIndicator className="self-center" /> : null}
          <time className="shrink-0 text-caption tabular-nums text-subtle">{listTime(conversation.lastActivityMs)}</time>
        </span>
        <span className="mt-0.5 flex items-center gap-2">
          <span dir="auto" className={cn("min-w-0 flex-1 truncate text-small", unread ? "text-foreground" : "text-muted-foreground")}>
            {preview || "No messages yet"}
          </span>
          <MentionDot count={conversation.mentionCount} />
          <UnreadCount count={conversation.unreadCount} />
        </span>
      </span>
    </button>
  );
});
