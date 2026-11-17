import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { searchSettings, type SettingsSearchEntry } from "./settingsSearch";

const isMac = typeof navigator !== "undefined" && /Macintosh|Mac OS X/i.test(navigator.userAgent);

/**
 * The search field at the top of Settings and the results that take the categories'
 * place while it has text. Choosing a result opens its page and shows the setting; the
 * results stay, so the next one is a click away. Escape or the clear button brings the
 * categories back. Command F (Control F elsewhere) jumps to the field.
 */
export function useSettingsSearch({
  index,
  icons,
  onOpen,
}: {
  index: SettingsSearchEntry[];
  icons: Partial<Record<string, ReactNode>>;
  onOpen: (entry: SettingsSearchEntry) => void;
}): { field: ReactNode; results: ReactNode | undefined } {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [openedKey, setOpenedKey] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const results = useMemo(() => searchSettings(index, query), [index, query]);
  const searching = query.trim().length > 0;

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (!modifier || event.altKey || event.shiftKey || event.key.toLowerCase() !== "f") return;
      if (document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const open = (entry: SettingsSearchEntry) => {
    setOpenedKey(entry.key);
    onOpen(entry);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (query) setQuery("");
      else event.currentTarget.blur();
      return;
    }
    if (!results.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => (current - 1 + results.length) % results.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const entry = results[Math.min(activeIndex, results.length - 1)];
      if (entry) open(entry);
    }
  };

  const activeId = searching && results.length ? `${listId}-${Math.min(activeIndex, results.length - 1)}` : undefined;

  const field = (
    <div className="flex h-8 items-center gap-2 rounded-control bg-card px-2.5 text-muted-foreground transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-offset-0 focus-within:outline-ring/50 hover:bg-secondary/60">
      <Search className="h-3.5 w-3.5 shrink-0" />
      <input
        ref={inputRef}
        value={query}
        role="combobox"
        aria-label="Search settings"
        aria-expanded={searching}
        aria-controls={listId}
        aria-activedescendant={activeId}
        aria-autocomplete="list"
        placeholder="Search settings"
        spellCheck={false}
        onChange={(event) => setQuery(event.currentTarget.value)}
        onKeyDown={onKeyDown}
        className="h-full min-w-0 flex-1 bg-transparent text-small text-foreground outline-none placeholder:text-subtle focus-visible:outline-none"
      />
      {query ? (
        <button
          type="button"
          aria-label="Clear search"
          className="text-subtle hover:text-foreground"
          onClick={() => {
            setQuery("");
            inputRef.current?.focus();
          }}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : (
        <kbd className="rounded-chip bg-background/60 px-1.5 text-caption text-subtle">{isMac ? "⌘F" : "Ctrl F"}</kbd>
      )}
    </div>
  );

  const list = searching ? (
    <div id={listId} role="listbox" aria-label="Settings that match" className="space-y-px">
      {results.length ? (
        results.map((entry, position) => (
          <button
            key={entry.key}
            id={`${listId}-${position}`}
            type="button"
            role="option"
            tabIndex={-1}
            aria-selected={position === activeIndex}
            aria-current={entry.key === openedKey ? "page" : undefined}
            onMouseEnter={() => setActiveIndex(position)}
            onClick={() => open(entry)}
            className={cn(
              "flex w-full items-start gap-2.5 rounded-control px-2 py-1.5 text-left transition-colors",
              entry.key === openedKey ? "bg-secondary text-foreground" : position === activeIndex ? "bg-secondary/60 text-foreground" : "text-muted-foreground",
            )}
          >
            <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center [&>svg]:h-4 [&>svg]:w-4">{icons[entry.page]}</span>
            <span className="min-w-0">
              <span className="block truncate text-small">{entry.title}</span>
              {entry.context ? <span className="block truncate text-caption text-subtle">{entry.context}</span> : null}
            </span>
          </button>
        ))
      ) : (
        <p className="px-2 py-2 text-small text-muted-foreground">No settings match “{query.trim()}”.</p>
      )}
    </div>
  ) : undefined;

  return { field, results: list };
}
