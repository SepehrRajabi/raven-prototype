import { Hand } from "lucide-react";
import { handLabel } from "@/lib/raisedHand";
import { cn } from "@/lib/utils";

/**
 * "I'd like to speak" beside a person: a hand, with the place in line once more than one
 * hand is up. Never how long they have waited. On your own hand, when you are first and
 * the room has gone quiet, it fills once to say the gap is yours.
 */
export function HandMark({ order, raisedCount, yourTurn = false, onVideo = false, className }: {
  order: number;
  raisedCount: number;
  yourTurn?: boolean;
  onVideo?: boolean;
  className?: string;
}) {
  if (order <= 0) return null;
  const label = yourTurn ? `${handLabel(order, raisedCount)}. The room is quiet: your turn.` : handLabel(order, raisedCount);
  return (
    <span
      key={yourTurn ? "turn" : "waiting"}
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "flex shrink-0 items-center justify-center gap-0.5 rounded-full text-caption font-medium tabular-nums transition-colors duration-150",
        yourTurn ? "animate-pop-in bg-primary text-primary-foreground" : onVideo ? "text-white" : "bg-card text-foreground",
        className,
      )}
    >
      <Hand className="h-3.5 w-3.5" />
      {raisedCount > 1 ? <span aria-hidden>{order}</span> : null}
    </span>
  );
}
