import { viewNote } from "@/lib/roomAccessView";
import type { RoomAccess, RoomKind } from "@/lib/roomAccess";
import { cn } from "@/lib/utils";

/** What you can do in a room you don't have in full, who that was set for and until when. */
export function RoomAccessNote({ access, kind, now, className }: { access: RoomAccess | undefined; kind: RoomKind; now: number; className?: string }) {
  const note = viewNote(access, kind, now);
  if (!note) return null;
  return (
    <p role="status" className={cn("text-small text-muted-foreground", className)}>
      {note.line}
      {note.reason ? <span className="text-subtle"> {note.reason}</span> : null}
    </p>
  );
}
