import { Lock } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { lockNote, labelNote } from "@/lib/roomAccessView";
import type { RoomAccess, RoomKind } from "@/lib/roomAccess";
import type { TreeLabel } from "@/lib/chat/types";
import { cn } from "@/lib/utils";

const CHIP = "inline-flex h-5 min-w-0 items-center rounded-chip border border-input px-1.5 text-caption text-muted-foreground";

/**
 * A room's labels as small neutral chips. A long name is cut short and the rest are counted;
 * the tooltip has the words in full. Inside a row's button nothing here takes focus of its
 * own, so set `focusable` only where it stands alone.
 */
export function RoomLabels({ labels, max = 2, focusable, className }: { labels: readonly TreeLabel[]; max?: number; focusable?: boolean; className?: string }) {
  if (labels.length === 0) return null;
  const shown = labels.slice(0, max);
  const rest = labels.slice(max);
  const tabIndex = focusable ? 0 : undefined;
  return (
    <span className={cn("flex min-w-0 items-center gap-1", className)}>
      {shown.map((label) => (
        <Tooltip key={label.id} label={<bdi>{labelNote(label)}</bdi>}>
          <span tabIndex={tabIndex} className={CHIP}>
            <span className="sr-only">Label: </span>
            <bdi className="max-w-28 truncate">{label.name}</bdi>
            {label.visible ? null : <span className="sr-only">. Only you can see this label.</span>}
          </span>
        </Tooltip>
      ))}
      {rest.length ? (
        <Tooltip label={<span className="block">{rest.map((label) => <bdi key={label.id} className="block">{labelNote(label)}</bdi>)}</span>}>
          <span tabIndex={tabIndex} className={cn(CHIP, "shrink-0 tabular-nums")}>
            <span aria-hidden>+{rest.length}</span>
            <span className="sr-only">Labels: {rest.map(labelNote).join(", ")}</span>
          </span>
        </Tooltip>
      ) : null}
    </span>
  );
}

/** The room is not open to every member in full, or not to you. */
export function RoomLock({ access, kind, focusable, className }: { access: RoomAccess | undefined; kind: RoomKind; focusable?: boolean; className?: string }) {
  const note = lockNote(access, kind);
  if (!note) return null;
  return (
    <Tooltip label={note}>
      <span role="img" aria-label={note} tabIndex={focusable ? 0 : undefined} className={cn("flex shrink-0 items-center rounded-chip text-subtle", className)}>
        <Lock className="h-3.5 w-3.5" aria-hidden />
      </span>
    </Tooltip>
  );
}
