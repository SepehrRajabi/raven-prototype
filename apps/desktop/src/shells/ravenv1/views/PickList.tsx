import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface PickItem {
  id: string;
  name: string;
  caption?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
}

export interface PickSection {
  key: string;
  title?: string;
  items: PickItem[];
}

/** A list to choose several things from. The arrow keys move, Space or Enter chooses. */
export function PickList({
  label,
  sections,
  selected,
  onToggle,
  searchLabel,
  emptyText,
  disabled = false,
  autoFocus = false,
  className,
}: {
  label: string;
  sections: readonly PickSection[];
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  /** Shows a search field over a long list. */
  searchLabel?: string;
  emptyText: string;
  disabled?: boolean;
  /** Where a dialog that holds this list starts. */
  autoFocus?: boolean;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const total = sections.reduce((count, section) => count + section.items.length, 0);
  const searchable = searchLabel !== undefined && total > 6;

  const shown = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return sections.filter((section) => section.items.length > 0);
    return sections
      .map((section) => ({ ...section, items: section.items.filter((item) => item.name.toLocaleLowerCase().includes(needle)) }))
      .filter((section) => section.items.length > 0);
  }, [query, sections]);
  const ids = shown.flatMap((section) => section.items.map((item) => item.id));
  // One stop in the tab order: the last row that was on, or the first.
  const stop = ids.includes(active) ? active : ids[0];

  // What is already chosen when the list opens is in view.
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, []);

  const onKeyDown = (event: KeyboardEvent) => {
    const at = ids.indexOf(stop ?? "");
    const next = event.key === "ArrowDown" ? Math.min(at + 1, ids.length - 1) : event.key === "ArrowUp" ? Math.max(at - 1, 0) : event.key === "Home" ? 0 : event.key === "End" ? ids.length - 1 : -1;
    if (next < 0 || ids.length === 0) return;
    event.preventDefault();
    setActive(ids[next]);
    list.current?.querySelectorAll<HTMLElement>('[role="option"]')[next]?.focus();
  };

  return (
    <div className="space-y-1.5">
      {searchable ? (
        <Input
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.preventDefault();
            if (event.key !== "ArrowDown" || ids.length === 0) return;
            event.preventDefault();
            list.current?.querySelector<HTMLElement>('[role="option"]')?.focus();
          }}
          placeholder={searchLabel}
          aria-label={searchLabel}
          data-autofocus={autoFocus || undefined}
          className="h-8 text-small"
        />
      ) : null}
      {ids.length ? (
        <div ref={list} role="listbox" aria-label={label} aria-multiselectable onKeyDown={onKeyDown} className={cn("space-y-2 overflow-y-auto", className)}>
          {shown.map((section) => (
            <div key={section.key} role="group" aria-label={section.title} className="space-y-px">
              {section.title ? <p aria-hidden className="truncate px-2 pb-0.5 pt-1 text-caption text-subtle"><bdi>{section.title}</bdi></p> : null}
              {section.items.map((item) => {
                const on = selected.has(item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={on}
                    tabIndex={item.id === stop ? 0 : -1}
                    disabled={disabled}
                    data-autofocus={(autoFocus && !searchable && item.id === ids[0]) || undefined}
                    onFocus={() => setActive(item.id)}
                    onClick={() => onToggle(item.id)}
                    className={cn(
                      "flex min-h-8 w-full items-center gap-2.5 rounded-control px-2 py-1 text-left transition-colors focus-visible:-outline-offset-2 disabled:opacity-55",
                      on ? "bg-secondary" : "hover:bg-secondary/60",
                    )}
                  >
                    <span aria-hidden className={cn("flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border", on ? "border-foreground bg-foreground text-background" : "border-input")}>
                      {on ? <Check className="h-3 w-3" strokeWidth={3} /> : null}
                    </span>
                    {item.leading}
                    <span className="min-w-0 flex-1 truncate text-small"><bdi>{item.name}</bdi></span>
                    {item.trailing}
                    {item.caption ? <span className="shrink-0 text-caption text-muted-foreground">{item.caption}</span> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      ) : (
        <p className="px-2 py-2 text-small text-muted-foreground">{query.trim() ? "Nothing by that name." : emptyText}</p>
      )}
    </div>
  );
}
