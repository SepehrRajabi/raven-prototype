import { useEffect, useState, type KeyboardEvent } from "react";
import { Pin, PinOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { failureText } from "@/lib/chat/errors";
import { mentionsAsText, type MentionResolver } from "@/lib/chat/mentions";
import { pinActions, pinExcerpt, pinLine } from "@/lib/chat/pins";
import type { ChatMessage, PinnedMessages } from "@/lib/chat/types";
import { returnFocusToKeyboardOnly } from "@/lib/focusHandoff";

export interface PinnedMessagesListProps {
  pins?: PinnedMessages;
  me: string;
  /** The viewer may pin here: they manage the room, or the room lets members pin. */
  canPin: boolean;
  /** The viewer manages the room: they can unpin anything. */
  canManage: boolean;
  /** The viewer can write here: needed to take off a pin they made. */
  canWrite: boolean;
  /** The user's word for a room, in lower case ("room", "nest"). */
  nest: string;
  /** The message whose unpin is on its way, if any. */
  unpinning?: string | null;
  resolve?: MentionResolver;
  now?: number;
  onGo: (message: ChatMessage) => void;
  onUnpin: (message: ChatMessage) => void;
  onRetry: () => void;
}

/** Up and Down move between the entries, as Tab does; Home and End go to either end. */
function moveBetweenEntries(event: KeyboardEvent<HTMLUListElement>) {
  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  const entries = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-pinned-entry]"));
  if (entries.length === 0) return;
  event.preventDefault();
  const index = entries.indexOf(document.activeElement as HTMLElement);
  const next = event.key === "Home" ? 0
    : event.key === "End" ? entries.length - 1
    : index < 0 ? 0
    : (index + (event.key === "ArrowUp" ? -1 : 1) + entries.length) % entries.length;
  entries[next]?.focus();
}

/** What the pinned list shows: the entries, or why there are none. */
export function PinnedMessagesList({ pins, me, canPin, canManage, canWrite, nest, unpinning, resolve, now, onGo, onUnpin, onRetry }: PinnedMessagesListProps) {
  if (!pins || pins.status === "loading") {
    return <p className="px-2 pb-2 text-small text-muted-foreground" role="status">Loading…</p>;
  }
  if (pins.status === "error") {
    return (
      <div className="flex flex-col items-start gap-2 px-2 pb-2" role="alert">
        <p className="text-small text-muted-foreground">{pins.error}</p>
        <Button size="xs" variant="secondary" onClick={onRetry}>Try again</Button>
      </div>
    );
  }
  if (pins.items.length === 0) {
    return (
      <div className="space-y-1 px-2 pb-2">
        <p className="text-small text-muted-foreground">Nothing is pinned in this {nest} yet.</p>
        {canPin ? (
          <p className="text-caption text-subtle">To keep a message here, choose Pin in its menu. Everyone who can read this {nest} sees it, and who pinned it.</p>
        ) : null}
      </div>
    );
  }
  return (
    <ul className="max-h-[min(60vh,28rem)] space-y-0.5 overflow-y-auto" aria-label="Pinned messages" onKeyDown={moveBetweenEntries}>
      {pins.items.map((message) => {
        const mine = message.senderId === me;
        const author = mine ? "You" : message.senderName || "Someone";
        const canUnpin = pinActions(message, { canPin, canManage, canWrite, me }).unpin;
        return (
          <li key={message.id} className="flex items-start rounded-control transition-colors focus-within:bg-secondary hover:bg-secondary">
            <button
              type="button"
              data-pinned-entry
              onClick={() => onGo(message)}
              className="min-w-0 flex-1 rounded-control px-2 py-1.5 text-start"
            >
              <span className="block truncate text-small font-medium"><bdi>{author}</bdi></span>
              <span dir="auto" className="line-clamp-2 break-words text-small text-muted-foreground [text-align:match-parent]">
                {mentionsAsText(pinExcerpt(message), resolve)}
              </span>
              {message.pin ? <span className="mt-0.5 block truncate text-caption text-subtle">{pinLine(message.pin, me, now)}</span> : null}
            </button>
            {canUnpin ? (
              <Tooltip label="Unpin">
                <button
                  type="button"
                  aria-label={mine ? "Unpin your message" : message.senderName ? `Unpin ${message.senderName}’s message` : "Unpin this message"}
                  disabled={unpinning === message.id}
                  onClick={() => onUnpin(message)}
                  className="m-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-subtle transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none"
                >
                  <PinOff className="h-4 w-4" />
                </button>
              </Tooltip>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The room's own choice, for the people who run it: whether members may pin as well.
 * The switch moves at once and goes back if the server refuses.
 */
function MembersCanPinSwitch({ on, nest, onChange }: { on: boolean; nest: string; onChange: (on: boolean) => Promise<unknown> }) {
  const [shown, setShown] = useState(on);
  const [saving, setSaving] = useState(false);
  useEffect(() => setShown(on), [on]);
  const change = (next: boolean) => {
    setShown(next);
    setSaving(true);
    void onChange(next)
      .catch((failure: unknown) => {
        setShown(on);
        toast({ title: failureText(failure, "Couldn’t change who can pin."), tone: "error" });
      })
      .finally(() => setSaving(false));
  };
  return (
    <div className="mt-1.5 flex items-start gap-3 border-t border-border px-2 pb-1 pt-2.5">
      <label htmlFor="members-can-pin" className="min-w-0 flex-1">
        <span className="block text-small font-medium">Members can pin</span>
        <span className="block text-caption text-subtle">
          Members who can write in this {nest} can pin messages and take off the pins they made. A line in the {nest} says when this changes.
        </span>
      </label>
      <Switch id="members-can-pin" checked={shown} disabled={saving} onCheckedChange={change} className="mt-0.5" />
    </div>
  );
}

/**
 * The header button of a text room that opens its pinned messages. Each opening fetches
 * the list; choosing an entry closes it and goes to the message.
 */
export function PinnedMessagesButton({
  onLoad,
  onUnpin,
  membersCanPin,
  onMembersCanPin,
  ...list
}: Omit<PinnedMessagesListProps, "unpinning" | "onRetry" | "onUnpin"> & {
  onLoad: () => void;
  onUnpin: (message: ChatMessage) => Promise<void>;
  /** The room's setting that lets members pin too. */
  membersCanPin: boolean;
  /** Changes that setting. Given only to people who run the room. */
  onMembersCanPin?: (on: boolean) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [unpinning, setUnpinning] = useState<string | null>(null);
  const unpin = (message: ChatMessage) => {
    setUnpinning(message.id);
    void onUnpin(message)
      .catch((failure: unknown) => toast({ title: failureText(failure, "Couldn’t unpin that message."), tone: "error" }))
      .finally(() => setUnpinning((current) => (current === message.id ? null : current)));
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) onLoad();
      }}
    >
      <Tooltip label="Pinned messages" side="bottom">
        <PopoverTrigger asChild>
          <Button size="icon-sm" variant="ghost" aria-label="Pinned messages" title="" className={open ? "bg-secondary text-foreground" : undefined}>
            <Pin className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="end" className="w-[360px] p-2" onCloseAutoFocus={returnFocusToKeyboardOnly}>
        <div className="px-2 pb-1.5 pt-1 text-small font-medium">Pinned messages</div>
        <PinnedMessagesList
          {...list}
          unpinning={unpinning}
          onRetry={onLoad}
          onUnpin={unpin}
          onGo={(message) => {
            setOpen(false);
            list.onGo(message);
          }}
        />
        {onMembersCanPin ? <MembersCanPinSwitch on={membersCanPin} nest={list.nest} onChange={onMembersCanPin} /> : null}
      </PopoverContent>
    </Popover>
  );
}
