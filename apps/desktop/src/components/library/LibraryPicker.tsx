import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Folder, ImagePlay, Plus, Search, Sticker } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { SCOPE_ICONS, SECTION_ICONS } from "./icons";
import { Input } from "@/components/ui/input";
import { Tabs } from "@/components/ui/tabs";
import { neighbour } from "@/lib/gridNavigation";
import { libraryApi, type LibraryApi } from "@/lib/library/libraryApi";
import { PICKER_CAP } from "@/lib/library/playback";
import { browseSections, groupResults, lastTab, PICKER_SCOPES, recentItems, rememberTab, type PickerScope, type PickerSection } from "@/lib/library/picker";
import type { LibraryCollection, LibraryItem, LibraryKind } from "@/lib/library/types";
import { cn } from "@/lib/utils";
import { PlaybackScopeProvider } from "./LibraryMedia";
import { LibraryTile, tileSize, type ItemActions } from "./LibraryTile";

export interface LibraryPickerProps {
  conversationId: string;
  userId: string;
  /** The space this conversation is in, for the This space chip and section. */
  inSpace: boolean;
  /** When replying: the message to suggest for. */
  replyToMessageId?: string;
  onPick: (item: LibraryItem) => void;
  onAdd: (kind: LibraryKind) => void;
  onEdit: (item: LibraryItem) => void;
  onRemove: (item: LibraryItem) => void;
  onSave: (item: LibraryItem) => void;
  onClose: () => void;
  /** Bumped by the caller after an edit, so the lists load again. */
  version?: number;
  api?: LibraryApi;
}

interface Results {
  items: LibraryItem[];
  nextCursor: string;
  loading: boolean;
  error: boolean;
}

const EMPTY: Results = { items: [], nextCursor: "", loading: true, error: false };

/** The GIFs and stickers panel next to the emoji button. Its caller owns the popover. */
export function LibraryPicker(props: LibraryPickerProps) {
  return (
    <PlaybackScopeProvider cap={PICKER_CAP} mode="hover">
      <PickerBody {...props} />
    </PlaybackScopeProvider>
  );
}

function PickerBody({ conversationId, userId, inSpace, replyToMessageId, onPick, onAdd, onEdit, onRemove, onSave, onClose, version = 0, api = libraryApi }: LibraryPickerProps) {
  const [kind, setKind] = useState<LibraryKind>(lastTab);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [scope, setScope] = useState<PickerScope>("all");
  const [browse, setBrowse] = useState<Results>(EMPTY);
  const [results, setResults] = useState<Results>(EMPTY);
  const [suggested, setSuggested] = useState<LibraryItem[]>([]);
  const [collections, setCollections] = useState<LibraryCollection[]>([]);
  // Collections start open; this holds the ones the person folded.
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [collectionItems, setCollectionItems] = useState<Record<string, LibraryItem[] | "loading" | "error">>({});
  const [changed, setChanged] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const [recent] = useState(() => recentItems(userId));
  const reload = version + changed;

  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 150);
    return () => clearTimeout(timer);
  }, [query]);

  // Before typing: the person's own items and the space set, in the server's order.
  useEffect(() => {
    let live = true;
    setBrowse(EMPTY);
    api.search({ conversationId, kind }).then(
      (page) => live && setBrowse({ ...page, loading: false, error: false }),
      () => live && setBrowse({ ...EMPTY, loading: false, error: true }),
    );
    return () => {
      live = false;
    };
  }, [api, conversationId, kind, reload]);

  useEffect(() => {
    let live = true;
    setSuggested([]);
    if (replyToMessageId) api.suggest(conversationId, replyToMessageId).then((value) => live && setSuggested(value.items), () => undefined);
    return () => {
      live = false;
    };
  }, [api, conversationId, replyToMessageId]);

  useEffect(() => {
    let live = true;
    api.collections({ scope: "personal" }).then((value) => live && setCollections(value.collections), () => undefined);
    setCollectionItems({});
    return () => {
      live = false;
    };
  }, [api, reload]);

  const searching = debounced !== "";
  useEffect(() => {
    if (!searching) return;
    let live = true;
    setResults(EMPTY);
    api.search({ conversationId, kind, q: debounced, scope: scope === "all" ? undefined : scope }).then(
      (page) => live && setResults({ ...page, loading: false, error: false }),
      () => live && setResults({ ...EMPTY, loading: false, error: true }),
    );
    return () => {
      live = false;
    };
  }, [api, conversationId, kind, debounced, scope, searching, reload]);

  // Each collection's first page loads with the picker (tiles fetch only posters, and only
  // near the view), so a collection with nothing of this kind can be left out.
  const loadCollection = (id: string) => {
    if (collectionItems[id] && collectionItems[id] !== "error") return;
    setCollectionItems((current) => ({ ...current, [id]: "loading" }));
    api.listItems({ scope: "personal" }, { kind, collectionId: id }).then(
      (page) => setCollectionItems((current) => ({ ...current, [id]: page.items.filter((item) => item.status === "ready") })),
      () => setCollectionItems((current) => ({ ...current, [id]: "error" })),
    );
  };
  useEffect(() => setCollectionItems({}), [kind]);
  useEffect(() => {
    for (const collection of collections) if (collectionItems[collection.id] === undefined) loadCollection(collection.id);
  });
  const toggle = (id: string, force?: boolean) => {
    const next = new Set(folded);
    const opening = force ?? next.has(id);
    if (opening) next.delete(id);
    else next.add(id);
    setFolded(next);
  };
  // Collections are personal, so This space hides them.
  const shownCollections = scope === "tree" ? [] : collections.filter((collection) => {
    const items = collectionItems[collection.id];
    return !Array.isArray(items) || items.length > 0;
  });

  const more = (current: Results, set: (value: Results) => void, q?: string) => {
    if (!current.nextCursor) return;
    set({ ...current, loading: true });
    api.search({ conversationId, kind, q, scope: q && scope !== "all" ? scope : undefined, cursor: current.nextCursor }).then(
      (page) => set({ items: [...current.items, ...page.items], nextCursor: page.nextCursor, loading: false, error: false }),
      () => set({ ...current, loading: false, error: true }),
    );
  };

  const edited = () => setChanged((value) => value + 1);
  const actions: ItemActions = {
    collections,
    favourite: (item) => void api.updateItem(item.id, { favourite: !item.favourite }).then(edited, () => undefined),
    edit: onEdit,
    move: (item, collectionId) => void api.updateItem(item.id, { collectionId }).then(edited, () => undefined),
    remove: onRemove,
    save: onSave,
  };

  const cells = () => Array.from(grid.current?.querySelectorAll<HTMLButtonElement>("button[data-library-tile]") ?? []);
  const gridKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!event.key.startsWith("Arrow")) return;
    event.preventDefault();
    const next = neighbour(cells(), event.currentTarget, event.key);
    if (next) {
      next.focus();
      next.scrollIntoView({ block: "nearest" });
    } else if (event.key === "ArrowUp") input.current?.focus();
  };
  const size = tileSize(kind);
  const tiles = (items: LibraryItem[]) => (
    <div className="flex flex-wrap gap-1">
      {items.map((item) => (
        <LibraryTile key={item.id} item={item} width={size.width} height={size.height} actions={actions} onActivate={onPick} onKeyDown={gridKey} />
      ))}
    </div>
  );
  const section = (entry: PickerSection) => (
    <section key={entry.id} aria-label={entry.title}>
      <h3 className="flex items-center gap-1.5 px-0.5 pb-1 pt-2 text-caption font-medium text-subtle">
        {(() => {
          const Icon = SECTION_ICONS[entry.id];
          return Icon ? <Icon className="h-3.5 w-3.5" aria-hidden /> : null;
        })()}
        {entry.title}
      </h3>
      {tiles(entry.items)}
    </section>
  );

  const noun = kind === "gif" ? "GIFs" : "stickers";
  let body: ReactNode;
  if (scope === "public" && !searching) {
    body = <Hint>Type to search what people have made public on this server.</Hint>;
  } else if (searching) {
    const groups = groupResults(results.items);
    body = results.error ? (
      <Hint>Couldn’t search. Try again in a moment.</Hint>
    ) : results.loading && results.items.length === 0 ? (
      <Hint>Searching…</Hint>
    ) : groups.length === 0 ? (
      <Hint>No {noun} match “{debounced}”.</Hint>
    ) : (
      <>
        {groups.map(section)}
        <ShowMore results={results} onMore={() => more(results, setResults, debounced)} />
      </>
    );
  } else {
    const { top, bottom } = browseSections({ kind, scope, suggested, recent, items: browse.items });
    const visibleBottom = inSpace ? bottom : bottom.filter((entry) => entry.id !== "space");
    const empty = top.length === 0 && visibleBottom.length === 0 && shownCollections.length === 0;
    body = browse.error ? (
      <Hint>Couldn’t load your {noun}. Try again in a moment.</Hint>
    ) : browse.loading ? (
      <Hint>Loading…</Hint>
    ) : (
      <>
        {empty ? <Hint>{scope === "tree" ? `This space has no ${noun} yet.` : `No ${noun} yet. Add one, or save one someone sent you.`}</Hint> : null}
        {top.map(section)}
        {shownCollections.length > 0 ? (
          <>
            <div className="flex flex-wrap gap-1 pt-2" role="group" aria-label="Jump to a collection">
              {shownCollections.map((collection) => (
                <button
                  key={collection.id}
                  type="button"
                  onClick={() => {
                    toggle(collection.id, true);
                    requestAnimationFrame(() => grid.current?.querySelector<HTMLElement>(`[data-collection="${collection.id}"]`)?.scrollIntoView({ block: "start" }));
                  }}
                  className="h-7 max-w-[10rem] truncate rounded-chip bg-secondary px-2.5 text-caption font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  {collection.name}
                </button>
              ))}
            </div>
            {shownCollections.map((collection) => {
              const expanded = !folded.has(collection.id);
              const items = collectionItems[collection.id];
              return (
                <section key={collection.id} data-collection={collection.id} aria-label={collection.name}>
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => toggle(collection.id)}
                    className="flex h-8 w-full items-center gap-1 rounded-control px-0.5 text-caption font-medium text-subtle transition-colors hover:text-foreground"
                  >
                    {expanded ? <ChevronDown className="h-3.5 w-3.5" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
                    <Folder className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{collection.name}</span>
                  </button>
                  {!expanded ? null : items === "loading" || items === undefined ? (
                    <Hint>Loading…</Hint>
                  ) : items === "error" ? (
                    <Hint>Couldn’t load this collection.</Hint>
                  ) : items.length === 0 ? (
                    <Hint>No {noun} in this collection.</Hint>
                  ) : (
                    tiles(items)
                  )}
                </section>
              );
            })}
          </>
        ) : null}
        {visibleBottom.map(section)}
        <ShowMore results={browse} onMore={() => more(browse, setBrowse)} />
      </>
    );
  }

  return (
    <div
      className="flex h-[440px] w-[356px] flex-col"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="flex flex-col gap-2 px-3 pt-3">
        <Tabs
          value={kind}
          onValueChange={(value) => {
            const next = value === "sticker" ? "sticker" : "gif";
            setKind(next);
            rememberTab(next);
          }}
          tabs={[
            { value: "gif", label: <><ImagePlay className="h-4 w-4" aria-hidden />GIFs</>, content: null },
            { value: "sticker", label: <><Sticker className="h-4 w-4" aria-hidden />Stickers</>, content: null },
          ]}
        />
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
          <Input
            ref={input}
            placeholder={kind === "gif" ? "Search GIFs" : "Search stickers"}
            aria-label={kind === "gif" ? "Search GIFs" : "Search stickers"}
            value={query}
            className="pl-8"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                cells()[0]?.focus();
              }
              if (event.key === "Enter") {
                const first = cells()[0];
                if (first && searching) {
                  event.preventDefault();
                  first.click();
                }
              }
            }}
          />
        </div>
        <div className="flex gap-1" role="group" aria-label="Where to look">
          {PICKER_SCOPES.filter((entry) => inSpace || entry.id !== "tree").map((entry) => {
            const Icon = SCOPE_ICONS[entry.id];
            return (
              <Tooltip key={entry.id} label={entry.label}>
                <button
                  type="button"
                  aria-label={entry.label}
                  aria-pressed={scope === entry.id}
                  onClick={() => setScope(entry.id)}
                  className={cn(
                    "flex h-7 w-8 items-center justify-center rounded-chip transition-colors",
                    scope === entry.id ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                  )}
                >
                  <Icon className="h-4 w-4" aria-hidden />
                </button>
              </Tooltip>
            );
          })}
        </div>
      </div>
      <div ref={grid} className="mt-1 min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {body}
        <div className="pt-2">
          <button
            type="button"
            data-library-tile
            onClick={() => onAdd(kind)}
            onKeyDown={gridKey}
            className="flex h-9 w-full items-center justify-center gap-1.5 rounded-control border border-dashed text-small text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <Plus className="h-4 w-4" aria-hidden />
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="px-0.5 py-3 text-small text-muted-foreground">{children}</p>;
}

function ShowMore({ results, onMore }: { results: Results; onMore: () => void }) {
  if (!results.nextCursor) return null;
  return (
    <button type="button" disabled={results.loading} onClick={onMore} className="mt-2 h-8 w-full rounded-control text-small text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-60">
      {results.loading ? "Loading…" : "Show more"}
    </button>
  );
}
