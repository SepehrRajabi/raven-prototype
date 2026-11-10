import { useState, type KeyboardEvent, type MouseEvent } from "react";
import { AlertCircle, Bookmark, Check, FolderInput, Globe, Loader2, Pencil, Star, StarOff, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { scopeOf, type LibraryCollection, type LibraryItem } from "@/lib/library/types";
import { cn } from "@/lib/utils";
import { LibraryMedia, libraryLabel } from "./LibraryMedia";

/** What a tile's menu can do. A missing action leaves its item out. */
export interface ItemActions {
  collections: LibraryCollection[];
  favourite?: (item: LibraryItem) => void;
  edit?: (item: LibraryItem) => void;
  move?: (item: LibraryItem, collectionId: string) => void;
  remove?: (item: LibraryItem) => void;
  save?: (item: LibraryItem) => void;
}

/**
 * One GIF or sticker in a grid. A click (or Enter) activates it; right-click, the context
 * menu key or Shift+F10 opens its menu: Favourite, Edit, Move to collection and Remove
 * for one's own, Save to my library for the rest.
 */
export function LibraryTile({
  item,
  width,
  height,
  actions,
  selected,
  onActivate,
  onKeyDown,
}: {
  item: LibraryItem;
  width: number;
  height: number;
  actions: ItemActions;
  /** Shown as a tick, in the library page's multi-select. */
  selected?: boolean;
  onActivate: (item: LibraryItem, event: MouseEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const [active, setActive] = useState(false);
  const [focused, setFocused] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const markPublic = selected !== undefined && item.public && item.canEdit;
  const label = markPublic ? `${libraryLabel(item)}, public` : libraryLabel(item);
  const ready = item.status === "ready";
  const own = item.canEdit;
  const scope = scopeOf(item);

  return (
    <div className="relative" style={{ width, height }}>
      <button
        type="button"
        data-library-tile
        aria-label={label}
        aria-pressed={selected === undefined ? undefined : selected}
        title={item.title || undefined}
        onPointerEnter={() => setActive(true)}
        onPointerLeave={() => setActive(false)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onClick={(event) => onActivate(item, event)}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenuOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
            event.preventDefault();
            setMenuOpen(true);
            return;
          }
          onKeyDown?.(event);
        }}
        className={cn(
          "group relative flex h-full w-full items-center justify-center overflow-hidden rounded-control transition-colors hover:bg-secondary focus-visible:-outline-offset-2",
          selected && "bg-primary/15 ring-2 ring-inset ring-primary",
        )}
      >
        {ready || item.variants.length > 0 ? (
          <LibraryMedia media={item} width={width - 8} height={height - 8} active={ready && (active || focused)} className="pointer-events-none" />
        ) : null}
        {item.status === "processing" || item.status === "uploading" ? (
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/55 text-caption text-white">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Getting it ready
          </span>
        ) : item.status === "failed" ? (
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/55 p-1.5 text-center text-caption text-white">
            <AlertCircle className="h-4 w-4" aria-hidden />
            {item.failure || "Couldn’t convert it."}
          </span>
        ) : null}
        {(active || focused) && item.title && ready ? (
          <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-black/55 px-1.5 py-0.5 text-caption text-white backdrop-blur-md">{item.title}</span>
        ) : null}
        {markPublic ? (
          // In the manager, mark your own items anyone on the server can find.
          <span title="Public" className="absolute left-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-md">
            <Globe className="h-3 w-3" aria-hidden />
          </span>
        ) : null}
        {selected ? (
          <span className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Check className="h-3 w-3" aria-hidden />
          </span>
        ) : null}
      </button>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        {/* Anchors the menu to the tile; the tile itself opens it. */}
        <DropdownMenuTrigger asChild>
          <span aria-hidden tabIndex={-1} className="pointer-events-none absolute bottom-0 left-1/2 h-0 w-0" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="w-56">
          {own ? (
            <>
              {actions.favourite && scope === "personal" && ready ? (
                <DropdownMenuItem onSelect={() => actions.favourite!(item)}>
                  {item.favourite ? <StarOff className="text-muted-foreground" /> : <Star className="text-muted-foreground" />}
                  {item.favourite ? "Remove from favourites" : "Add to favourites"}
                </DropdownMenuItem>
              ) : null}
              {actions.edit ? (
                <DropdownMenuItem onSelect={() => actions.edit!(item)}>
                  <Pencil className="text-muted-foreground" />
                  Edit…
                </DropdownMenuItem>
              ) : null}
              {actions.move ? (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <FolderInput className="text-muted-foreground" />
                    Move to collection
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-52">
                    <DropdownMenuItem disabled={!item.collectionId} onSelect={() => actions.move!(item, "")}>
                      No collection
                    </DropdownMenuItem>
                    {actions.collections
                      .filter((collection) => collection.owner.scope === item.owner.scope)
                      .map((collection) => (
                        <DropdownMenuItem key={collection.id} disabled={collection.id === item.collectionId} onSelect={() => actions.move!(item, collection.id)}>
                          <span className="truncate">{collection.name}</span>
                        </DropdownMenuItem>
                      ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              ) : null}
              {actions.remove ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => actions.remove!(item)} className="text-destructive">
                    <Trash2 />
                    Remove…
                  </DropdownMenuItem>
                </>
              ) : null}
            </>
          ) : null}
          {(!own || scope === "tree") && actions.save && ready ? (
            <DropdownMenuItem onSelect={() => actions.save!(item)}>
              <Bookmark className="text-muted-foreground" />
              Save to my library
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** The tile size for a kind in a grid: stickers square, GIFs wider. */
export function tileSize(kind: LibraryItem["kind"], large = false) {
  if (kind === "sticker") return large ? { width: 112, height: 112 } : { width: 80, height: 80 };
  return large ? { width: 200, height: 140 } : { width: 160, height: 112 };
}
