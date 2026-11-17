import { cn } from "@/lib/utils";

/** Beside your own name in a call: a quiet "you", read as "(you)" by screen readers. */
export function SelfMark({ className }: { className?: string }) {
  return (
    <span className={cn("shrink-0 text-caption font-normal text-muted-foreground", className)}>
      <span aria-hidden>you</span>
      <span className="sr-only">(you)</span>
    </span>
  );
}
