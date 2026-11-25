import { Ear, HeadphoneOff, Headphones, Mic, MicOff, MoreHorizontal } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { stripSidecarIdentity } from "@/lib/mediaIdentity";
import { returnFocusToKeyboardOnly } from "@/lib/focusHandoff";
import { cn } from "@/lib/utils";
import type { NativeMediaTile } from "./useNativeMediaTiles";

/** Server mute and server deafen, as the stage offers them. Absent when you can't use them. */
export type VoiceModeration = {
  canModerate: (userId: string) => boolean;
  setLimit: (userId: string, patch: { muted?: boolean; deafened?: boolean }) => void;
};

/** The person is limited by someone else, so it reads apart from their own mute: a filled chip. */
export function ServerVoiceMark({ person, className }: { person: Pick<NativeMediaTile, "serverMuted" | "serverDeafened">; className?: string }) {
  if (!person.serverMuted && !person.serverDeafened) return null;
  const label = person.serverDeafened ? "Deafened by a moderator" : "Muted by a moderator";
  return (
    <span className={cn("flex items-center justify-center rounded-full bg-destructive-fill text-destructive-foreground", className)} title={label} aria-label={label} role="img">
      {person.serverDeafened ? <HeadphoneOff className="h-3 w-3" /> : <MicOff className="h-3 w-3" />}
    </span>
  );
}

/** Who is here to listen, where others show that they are muted. Quiet: it is how they came in, not a fault. */
export function ListeningMark({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center justify-center text-muted-foreground", className)} title="Listening" aria-label="Listening" role="img">
      <Ear className="h-3.5 w-3.5" />
    </span>
  );
}

export function VoiceModerationItems({ person, moderation }: { person: NativeMediaTile; moderation: VoiceModeration }) {
  const userId = stripSidecarIdentity(person.participantId);
  return (
    <>
      <DropdownMenuItem onSelect={() => moderation.setLimit(userId, { muted: !person.serverMuted })}>
        {person.serverMuted ? <Mic /> : <MicOff />}
        {person.serverMuted ? "Unmute for everyone" : "Mute for everyone"}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => moderation.setLimit(userId, { deafened: !person.serverDeafened })}>
        {person.serverDeafened ? <Headphones /> : <HeadphoneOff />}
        {person.serverDeafened ? "Undeafen for everyone" : "Deafen for everyone"}
      </DropdownMenuItem>
    </>
  );
}

/** The "…" beside someone who is only talking. Nothing is drawn if you can't act on them. */
export function VoiceModerationMenu({ person, moderation, onVoteToRemove, className }: { person: NativeMediaTile; moderation?: VoiceModeration; onVoteToRemove?: () => void; className?: string }) {
  const canModerate = Boolean(moderation) && !person.isLocal && moderation!.canModerate(stripSidecarIdentity(person.participantId));
  if (!canModerate && !onVoteToRemove) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`More for ${person.displayName}`}
          className={cn(
            "flex items-center justify-center rounded-full text-muted-foreground opacity-0 transition-colors hover:text-foreground focus-visible:opacity-100 group-hover/person:opacity-100 data-[state=open]:opacity-100",
            className,
          )}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56" onCloseAutoFocus={returnFocusToKeyboardOnly}>
        {canModerate ? <VoiceModerationItems person={person} moderation={moderation!} /> : null}
        {canModerate && onVoteToRemove ? <DropdownMenuSeparator /> : null}
        {onVoteToRemove ? <DropdownMenuItem onSelect={onVoteToRemove}>Vote to remove from call…</DropdownMenuItem> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
