import * as React from "react";
import { cn } from "@/lib/utils";

export function Tabs({
  value,
  onValueChange,
  tabs,
}: {
  value: string;
  onValueChange: (value: string) => void;
  tabs: Array<{ value: string; label: React.ReactNode; content: React.ReactNode }>;
}) {
  const current = tabs.find((tab) => tab.value === value) ?? tabs[0];
  return (
    <div>
      {/* Segmented control: the track sits below the panel surface and the active
          segment lifts above it, which is the way round that reads on dark. */}
      <div className="inline-flex h-9 items-center gap-0.5 rounded-control bg-background/60 p-0.5" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={tab.value === current.value}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-chip px-3 text-small font-medium text-muted-foreground transition-colors hover:text-foreground",
              tab.value === current.value && "bg-accent text-foreground",
            )}
            onClick={() => onValueChange(tab.value)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {current.content != null ? <div className="mt-4">{current.content}</div> : null}
    </div>
  );
}
