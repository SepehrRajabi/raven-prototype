import { Tooltip } from "@/components/ui/tooltip";
import { labelNote, ownLimit } from "@/lib/roomAccessView";
import type { RoomAccess, RoomKind } from "@/lib/roomAccess";
import type { TreeLabel } from "@/lib/chat/types";
import { cn } from "@/lib/utils";

/**
 * What to know about a room, as a few quiet words beside its name: what you can't do there,
 * then its first label and how many more. The tooltip has all of them. Inside a row's button
 * nothing here takes focus of its own, so set `focusable` only where it stands alone.
 */
export function RoomMeta({ access, kind, labels, focusable, className }: { access?: RoomAccess; kind: RoomKind; labels: readonly TreeLabel[]; focusable?: boolean; className?: string }) {
  const limit = ownLimit(access, kind);
  const [first, ...rest] = labels;
  if (!limit && !first) return null;
  const words = (
    <span tabIndex={focusable && first ? 0 : undefined} className={cn("flex min-w-0 items-baseline gap-1 rounded-chip text-caption text-subtle", className)}>
      {limit ? <span className="shrink-0 text-muted-foreground">{limit}</span> : null}
      {limit && first ? <span aria-hidden>·</span> : null}
      {first ? (
        <>
          <span className="sr-only">{rest.length ? "Labels" : "Label"}: {labels.map(labelNote).join(", ")}</span>
          <bdi aria-hidden className="min-w-0 truncate">{first.name}</bdi>
          {rest.length ? <span aria-hidden className="shrink-0 tabular-nums">+{rest.length}</span> : null}
        </>
      ) : null}
    </span>
  );
  if (!first) return words;
  return <Tooltip label={<span className="block">{labels.map((label) => <bdi key={label.id} className="block">{labelNote(label)}</bdi>)}</span>}>{words}</Tooltip>;
}
