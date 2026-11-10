import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { Ellipsis, FolderInput, Globe, ImagePlay, Inbox, LayoutGrid, Lock, PackageOpen, Plus, Search, Sticker, Tag, Trash2, User, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tabs } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import { failureText, httpStatusOf } from "@/lib/chat/errors";
import { neighbour } from "@/lib/gridNavigation";
import { claimDrops } from "@/lib/library/dropTarget";
import { addKeywords, withBackoff } from "@/lib/library/edit";
import { libraryApi, type LibraryApi } from "@/lib/library/libraryApi";
import { LibraryFileError, pickPack, readPack } from "@/lib/library/native";
import { PICKER_CAP } from "@/lib/library/playback";
import { filterItems, rangeSelect, type ManagerFilter } from "@/lib/library/manager";
import type { LibraryCapabilities, LibraryCollection, LibraryItem, LibraryKind, LibraryOwner, Pack } from "@/lib/library/types";
import { cn } from "@/lib/utils";
import { stageAll } from "./ComposerLibrary";
import { ItemSheet, type SheetSubject } from "./ItemSheet";
import { PlaybackScopeProvider } from "./LibraryMedia";
import { LibraryTile, tileSize, type ItemActions } from "./LibraryTile";
import { PackImport } from "./PackImport";

const POLL_MS = 3000;

/**
 * A library, large: one's own on the Settings page, or a space's set in its settings.
 * Collections are a chip row over the grid (create, rename, reorder, delete); items are
 * picked like files (click, Shift-click, Ctrl-click, Ctrl+A) for a bar of bulk actions.
 */
export function LibraryManager({
  owner,
  capabilities,
  serverSearch,
  api = libraryApi,
}: {
  owner: LibraryOwner;
  capabilities: LibraryCapabilities;
  /** For searching what is public on the server, which the server scopes to a conversation. */
  serverSearch?: boolean;
  api?: LibraryApi;
}) {
  return (
    <PlaybackScopeProvider cap={PICKER_CAP} mode="hover">
      <ManagerBody owner={owner} capabilities={capabilities} serverSearch={serverSearch} api={api} />
    </PlaybackScopeProvider>
  );
}

function ManagerBody({ owner, capabilities, serverSearch, api }: { owner: LibraryOwner; capabilities: LibraryCapabilities; serverSearch?: boolean; api: LibraryApi }) {
  const [kind, setKind] = useState<LibraryKind>("sticker");
  const [collections, setCollections] = useState<LibraryCollection[]>([]);
  const [filter, setFilter] = useState<ManagerFilter>({ kind: "all" });
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [cursor, setCursor] = useState("");
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [server, setServer] = useState(false);
  const [serverItems, setServerItems] = useState<LibraryItem[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const [subject, setSubject] = useState<SheetSubject | null>(null);
  const [removing, setRemoving] = useState<LibraryItem[] | null>(null);
  const [naming, setNaming] = useState<{ collection: LibraryCollection | null; name: string } | null>(null);
  const [deletingCollection, setDeletingCollection] = useState<LibraryCollection | null>(null);
  const [keywordsFor, setKeywordsFor] = useState<string[] | null>(null);
  const [typedKeywords, setTypedKeywords] = useState("");
  const [pack, setPack] = useState<Pack | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const files = useRef<HTMLInputElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const personal = owner.scope === "personal";
  const reload = () => setVersion((value) => value + 1);

  useEffect(() => {
    let live = true;
    api.collections(owner).then((value) => live && setCollections([...value.collections].sort((a, b) => a.position - b.position)), () => undefined);
    return () => {
      live = false;
    };
  }, [api, owner.scope, owner.treeId, version]);

  const collectionId = filter.kind === "collection" ? filter.id : undefined;
  const load = useCallback(
    (after = "") =>
      api.listItems(owner, { kind, collectionId, cursor: after || undefined }).then((page) => {
        setItems((current) => (after ? [...current, ...page.items] : page.items));
        setCursor(page.nextCursor);
        setFailed(false);
      }),
    [api, owner.scope, owner.treeId, kind, collectionId],
  );
  useEffect(() => {
    let live = true;
    setLoading(true);
    setSelected(new Set());
    load().then(
      () => live && setLoading(false),
      () => {
        if (!live) return;
        setLoading(false);
        setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [load, version]);

  // While something is being converted, look again every few seconds.
  const processing = items.some((item) => item.status === "uploading" || item.status === "processing");
  useEffect(() => {
    if (!processing) return;
    const timer = setInterval(() => void load().catch(() => undefined), POLL_MS);
    return () => clearInterval(timer);
  }, [processing, load]);

  useEffect(() => claimDrops((paths) => void addFrom(paths.map((path) => ({ path })))), []);

  // Server search, for saving what others made public.
  useEffect(() => {
    if (!server || !serverSearch || !query.trim()) {
      setServerItems(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      api
        .search({ q: query.trim(), kind, scope: "public" })
        .then((page) => live && setServerItems(page.items), () => live && setServerItems([]));
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [server, query, kind, api, serverSearch]);

  const shown = useMemo(() => (server ? serverItems ?? [] : filterItems(items, filter, query)), [server, serverItems, items, filter, query]);
  const chosen = shown.filter((item) => selected.has(item.id));

  const addFrom = async (sources: Array<{ path: string } | File>) => {
    const staged = await stageAll(sources);
    if (staged.length > 0) setSubject({ mode: "add", files: staged, target: owner });
  };

  const importPack = async () => {
    try {
      const path = await pickPack();
      if (!path) return;
      setPack(await readPack(path));
    } catch (error) {
      toast({ title: "Couldn’t open that pack", description: error instanceof LibraryFileError ? error.message : "Try again.", tone: "error" });
    }
  };

  const act = async (work: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    try {
      await work();
      reload();
      return true;
    } catch (error) {
      toast({ title: failure, description: failureText(error, "Try again in a moment."), tone: "error" });
      return false;
    } finally {
      setBusy(false);
    }
  };
  const ids = (list: LibraryItem[]) => list.map((item) => item.id);
  const move = (list: LibraryItem[], to: string) => void act(() => api.bulkUpdate(ids(list), { collectionId: to }), "Couldn’t move them");
  const publish = (list: LibraryItem[], value: boolean) => {
    if (value && list.some((item) => !item.title.trim())) {
      toast({ title: "Give each one a title first", description: "Only GIFs and stickers with a title can be public.", tone: "error" });
      return;
    }
    void act(() => api.bulkUpdate(ids(list), { public: value }), value ? "Couldn’t make them public" : "Couldn’t make them private");
  };
  const remove = async () => {
    if (!removing) return;
    if (await act(() => (removing.length === 1 ? api.deleteItem(removing[0].id) : api.bulkUpdate(ids(removing), { delete: true })), "Couldn’t remove them")) setRemoving(null);
  };
  // Bulk edit takes no keywords, so each item is its own request, slowed when told to.
  const tag = async () => {
    if (!keywordsFor) return;
    const words = addKeywords([], typedKeywords);
    if (words.length === 0) return;
    const targets = items.filter((item) => keywordsFor.includes(item.id));
    const ok = await act(async () => {
      for (const item of targets) {
        const keywords = addKeywords(item.keywords, words.join(",")).slice(0, capabilities.maxKeywords);
        if (keywords.length === item.keywords.length) continue;
        await withBackoff(() => api.updateItem(item.id, { keywords }), (error) => httpStatusOf(error) === 429);
      }
    }, "Couldn’t add the keywords");
    if (ok) {
      setKeywordsFor(null);
      setTypedKeywords("");
    }
  };

  const saveCollection = async () => {
    if (!naming) return;
    const name = naming.name.trim();
    if (!name) return;
    const ok = await act(() => (naming.collection ? api.updateCollection(naming.collection.id, { name }) : api.createCollection(owner, name)), "Couldn’t save the collection");
    if (ok) setNaming(null);
  };
  const reorder = (collection: LibraryCollection, by: -1 | 1) => {
    const index = collections.indexOf(collection);
    const other = collections[index + by];
    if (!other) return;
    void act(async () => {
      await api.updateCollection(collection.id, { position: other.position });
      await api.updateCollection(other.id, { position: collection.position });
    }, "Couldn’t move the collection");
  };
  const deleteCollection = async () => {
    if (!deletingCollection) return;
    if (await act(() => api.deleteCollection(deletingCollection.id), "Couldn’t delete the collection")) {
      if (filter.kind === "collection" && filter.id === deletingCollection.id) setFilter({ kind: "all" });
      setDeletingCollection(null);
    }
  };

  const activate = (item: LibraryItem, event: MouseEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement>) => {
    if (server) return;
    if ("detail" in event && event.detail === 2 && item.canEdit) {
      setSubject({ mode: "edit", item });
      return;
    }
    if (event.shiftKey && anchor.current) {
      setSelected(new Set(rangeSelect(ids(shown), anchor.current, item.id)));
      return;
    }
    const next = event.ctrlKey || event.metaKey ? new Set(selected) : new Set<string>();
    if (next.has(item.id)) next.delete(item.id);
    else next.add(item.id);
    anchor.current = item.id;
    setSelected(next);
  };
  const gridKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key.startsWith("Arrow")) {
      event.preventDefault();
      const cells = Array.from(grid.current?.querySelectorAll<HTMLButtonElement>("button[data-library-tile]") ?? []);
      const next = neighbour(cells, event.currentTarget, event.key);
      next?.focus();
      next?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      const item = shown.find((entry) => entry.id === selected.values().next().value);
      if (item?.canEdit && selected.size === 1) {
        event.preventDefault();
        setSubject({ mode: "edit", item });
      }
    }
  };

  const actions: ItemActions = {
    collections,
    favourite: (item) => void act(() => api.updateItem(item.id, { favourite: !item.favourite }), "Couldn’t change that"),
    edit: (item) => setSubject({ mode: "edit", item }),
    move: (item, to) => move([item], to),
    remove: (item) => setRemoving([item]),
    save: (item) => void act(() => api.save({ itemId: item.id }), "Couldn’t save it").then((ok) => ok && toast({ title: "Saved to your library" })),
  };

  const size = tileSize(kind, true);
  const noun = kind === "gif" ? "GIFs" : "stickers";
  const chip = (active: boolean) =>
    cn("h-8 max-w-[12rem] truncate rounded-chip px-3 text-small font-medium transition-colors", active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs
          value={kind}
          onValueChange={(value) => setKind(value === "gif" ? "gif" : "sticker")}
          tabs={[
            { value: "sticker", label: <><Sticker className="h-4 w-4" aria-hidden />Stickers</>, content: null },
            { value: "gif", label: <><ImagePlay className="h-4 w-4" aria-hidden />GIFs</>, content: null },
          ]}
        />
        <div className="flex gap-2">
          <Button type="button" variant="secondary" onClick={() => void importPack()}>
            <PackageOpen className="h-4 w-4" />
            Import pack
          </Button>
          <Button type="button" onClick={() => files.current?.click()}>
            <Plus className="h-4 w-4" />
            Add
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
          <Input value={query} placeholder={server ? `Search public ${noun}` : personal ? `Search your ${noun}` : `Search the set’s ${noun}`} aria-label={`Search ${noun}`} className="pl-8" onChange={(event) => setQuery(event.target.value)} />
        </div>
        {personal && serverSearch ? (
          <div className="flex gap-1" role="group" aria-label="Where to look">
            <button type="button" aria-pressed={!server} onClick={() => setServer(false)} className={cn(chip(!server), "flex items-center gap-1.5")}><User className="h-3.5 w-3.5" aria-hidden />Mine</button>
            <button type="button" aria-pressed={server} onClick={() => setServer(true)} className={cn(chip(server), "flex items-center gap-1.5")}><Globe className="h-3.5 w-3.5" aria-hidden />Server</button>
          </div>
        ) : null}
      </div>

      {!server ? (
        <div className="flex flex-wrap gap-1" role="group" aria-label="Collections">
          <button type="button" aria-pressed={filter.kind === "all"} onClick={() => setFilter({ kind: "all" })} className={cn(chip(filter.kind === "all"), "flex items-center gap-1.5")}><LayoutGrid className="h-3.5 w-3.5" aria-hidden />All</button>
          {collections.map((collection, index) => {
            const active = filter.kind === "collection" && filter.id === collection.id;
            return (
              <DropdownMenu key={collection.id}>
                <div className="flex items-center">
                  <button type="button" aria-pressed={active} onClick={() => setFilter({ kind: "collection", id: collection.id })} className={chip(active)}>
                    {collection.name}
                  </button>
                  {active ? (
                    <DropdownMenuTrigger asChild>
                      <button type="button" aria-label={`Manage ${collection.name}`} className="-ml-1 flex h-8 w-6 items-center justify-center rounded-chip text-subtle hover:text-foreground">
                        <Ellipsis className="h-4 w-4" aria-hidden />
                      </button>
                    </DropdownMenuTrigger>
                  ) : null}
                </div>
                <DropdownMenuContent align="start" className="w-48">
                  <DropdownMenuItem onSelect={() => setNaming({ collection, name: collection.name })}>Rename…</DropdownMenuItem>
                  <DropdownMenuItem disabled={index === 0} onSelect={() => reorder(collection, -1)}>Move earlier</DropdownMenuItem>
                  <DropdownMenuItem disabled={index === collections.length - 1} onSelect={() => reorder(collection, 1)}>Move later</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-destructive" onSelect={() => setDeletingCollection(collection)}>Delete…</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            );
          })}
          <button type="button" aria-pressed={filter.kind === "untagged"} onClick={() => setFilter({ kind: "untagged" })} className={cn(chip(filter.kind === "untagged"), "flex items-center gap-1.5")}><Inbox className="h-3.5 w-3.5" aria-hidden />Untagged</button>
          <button type="button" onClick={() => setNaming({ collection: null, name: "" })} className={cn(chip(false), "flex items-center gap-1")}>
            <Plus className="h-3.5 w-3.5" aria-hidden />
            New collection
          </button>
        </div>
      ) : null}

      {chosen.length > 0 ? (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-1 rounded-card bg-popover px-2 py-1.5 shadow-raised" role="toolbar" aria-label="Selected">
          <span className="px-2 text-small font-medium">{chosen.length} selected</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="sm" disabled={busy}><FolderInput className="h-4 w-4" />Move</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-52">
              <DropdownMenuItem onSelect={() => move(chosen, "")}>No collection</DropdownMenuItem>
              {collections.map((collection) => <DropdownMenuItem key={collection.id} onSelect={() => move(chosen, collection.id)}><span className="truncate">{collection.name}</span></DropdownMenuItem>)}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setKeywordsFor(ids(chosen))}><Tag className="h-4 w-4" />Add keywords</Button>
          {personal ? (
            chosen.every((item) => item.public) ? (
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => publish(chosen, false)}><Lock className="h-4 w-4" />Make private</Button>
            ) : (
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => publish(chosen, true)}><Globe className="h-4 w-4" />Make public</Button>
            )
          ) : null}
          <Button type="button" variant="ghost" size="sm" disabled={busy} className="text-destructive" onClick={() => setRemoving(chosen)}><Trash2 className="h-4 w-4" />Remove</Button>
          <span className="flex-1" />
          <Button type="button" variant="ghost" size="sm" onClick={() => setSelected(new Set(ids(shown)))}>Select all</Button>
          <button type="button" aria-label="Clear selection" onClick={() => setSelected(new Set())} className="flex h-8 w-8 items-center justify-center rounded-control text-muted-foreground hover:bg-secondary hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : null}

      <div
        ref={grid}
        className="flex flex-wrap gap-1.5"
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a" && !server) {
            event.preventDefault();
            setSelected(new Set(ids(shown)));
          } else if (event.key === "Escape" && selected.size > 0) setSelected(new Set());
        }}
      >
        {server && !query.trim() ? (
          <p className="text-small text-muted-foreground">Type to search what people have made public on this server.</p>
        ) : loading && !server ? (
          <p className="text-small text-muted-foreground">Loading…</p>
        ) : failed && !server ? (
          <p className="text-small text-muted-foreground">Couldn’t load these. Try again in a moment.</p>
        ) : shown.length === 0 ? (
          <p className="text-small text-muted-foreground">
            {query.trim() ? `No ${noun} match “${query.trim()}”.` : filter.kind === "untagged" ? `Every one of these ${noun} has a title or keywords.` : `No ${noun} here yet. Add some, drop files here, or import a pack.`}
          </p>
        ) : (
          shown.map((item) => (
            <LibraryTile key={item.id} item={item} width={size.width} height={size.height} actions={actions} selected={server ? undefined : selected.has(item.id)} onActivate={activate} onKeyDown={gridKey} />
          ))
        )}
      </div>
      {!server && cursor ? (
        <Button type="button" variant="ghost" className="w-full" onClick={() => void load(cursor).catch(() => setFailed(true))}>Show more</Button>
      ) : null}

      <input
        ref={files}
        type="file"
        accept={[...new Set(Object.values(capabilities.kinds).flatMap((entry) => entry?.contentTypes ?? [])), ".tgs"].join(",")}
        multiple
        hidden
        tabIndex={-1}
        onChange={(event) => {
          const picked = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          void addFrom(picked);
        }}
      />
      <ItemSheet subject={subject} capabilities={capabilities} api={api} onClose={() => setSubject(null)} onSaved={reload} />
      <PackImport pack={pack} owner={owner} capabilities={capabilities} api={api} onClose={() => setPack(null)} onImported={reload} />
      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={removing && removing.length > 1 ? `Remove ${removing.length} ${noun}?` : `Remove this ${kind === "gif" ? "GIF" : "sticker"}?`}
        description="Messages they were sent in still show them."
        confirmLabel="Remove"
        destructive
        busy={busy}
        onConfirm={() => void remove()}
      />
      <ConfirmDialog
        open={Boolean(deletingCollection)}
        onOpenChange={(open) => !open && setDeletingCollection(null)}
        title={`Delete “${deletingCollection?.name ?? ""}”?`}
        description={`The ${noun} in it stay in the library, outside any collection.`}
        confirmLabel="Delete collection"
        destructive
        busy={busy}
        onConfirm={() => void deleteCollection()}
      />
      <Dialog open={Boolean(naming)} onOpenChange={(open) => !open && setNaming(null)} title={naming?.collection ? "Rename collection" : "New collection"}>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void saveCollection();
          }}
        >
          <Input aria-label="Name" value={naming?.name ?? ""} maxLength={64} onChange={(event) => naming && setNaming({ ...naming, name: event.target.value })} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setNaming(null)}>Cancel</Button>
            <Button type="submit" disabled={busy || !naming?.name.trim()}>{naming?.collection ? "Rename" : "Create"}</Button>
          </div>
        </form>
      </Dialog>
      <Dialog open={Boolean(keywordsFor)} onOpenChange={(open) => !open && setKeywordsFor(null)} title="Add keywords" description="Added to every selected one. Separate words with commas.">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void tag();
          }}
        >
          <Input aria-label="Keywords" value={typedKeywords} onChange={(event) => setTypedKeywords(event.target.value)} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setKeywordsFor(null)}>Cancel</Button>
            <Button type="submit" disabled={busy || addKeywords([], typedKeywords).length === 0}>{busy ? "Adding…" : "Add"}</Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
