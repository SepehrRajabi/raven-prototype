import { useEffect, useMemo, useState, type ReactNode } from "react";
import { roomEventCaptions } from "@/lib/events";
import { useNow } from "../useNow";
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDown, ArrowUp, GripVertical, MoreHorizontal, Pencil, Settings, Trash2 } from "lucide-react";
import { RenameDialog } from "@/components/chat/ChatDialogs";
import { MentionDot, UnreadCount } from "@/components/chat/ConversationRow";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import type { LauncherNest, Nest, TreeDetails } from "@/lib/api";
import { failureText } from "@/lib/chat/errors";
import { canMoveCategory, entryKey, layoutSections, moveCategory, moveEntry, toEntries, toLayoutRequest, type ArrangeEntry, type NestRef } from "@/lib/chat/layout";
import { textNestsOfTree } from "@/lib/chat/reducer";
import type { ChatStore } from "@/lib/chat/store";
import type { TreeCategory } from "@/lib/chat/types";
import { cn } from "@/lib/utils";
import { AvatarStack, GroupedList, NestGlyph, SectionLabel } from "../atoms";
import { lifecycleLabel, type RavenShellData, type RavenView } from "../state";
import type { RavenMediaAdapterState } from "../useRavenMediaAdapter";
import { useChatState } from "../useChat";
import { liveTreeNests } from "../treeLobby";
import { DoorMark, RoomDialog } from "./RoomDoor";
import { namesSentence, nestPeople, nestView } from "./shared";

/**
 * A tree's nests as its owners arranged them: categories, with text and voice nests in
 * order inside each. Owners and moderators can switch to arranging, where rows are
 * dragged (or moved with the keyboard) and categories are moved as a block. They can
 * also rename or delete a nest from its row.
 */
export function TreeNestsSection({
  details,
  data,
  media,
  chat,
  canManage,
  canJoin,
  arranging,
  onArrangingChange,
  onNavigate,
}: {
  details: TreeDetails;
  data: RavenShellData;
  media: RavenMediaAdapterState;
  chat: ChatStore;
  canManage: boolean;
  /** Nothing is being entered or left, so a Join can start. */
  canJoin: boolean;
  arranging: boolean;
  onArrangingChange: (arranging: boolean) => void;
  onNavigate: (view: RavenView) => void;
}) {
  const treeId = details.tree.id;
  const state = useChatState(chat);
  const layout = state?.layouts[treeId];
  const nestPlural = data.labels.nestPlural;
  const [renaming, setRenaming] = useState<TreeCategory | null>(null);
  const [deleting, setDeleting] = useState<TreeCategory | null>(null);
  const [working, setWorking] = useState(false);
  const [renamingNest, setRenamingNest] = useState<NestRef | null>(null);
  const [deletingNest, setDeletingNest] = useState<NestRef | null>(null);
  const nestSingular = data.labels.nestSingular.toLowerCase();
  const captions = roomEventCaptions(details.events, useNow());

  useEffect(() => {
    void chat.loadLayout(treeId).catch(() => undefined);
  }, [chat, treeId]);

  const voiceNests = useMemo(() => [...liveTreeNests(details, data.activeNests), ...details.inactiveNests], [details, data.activeNests]);
  const voiceById = useMemo(() => new Map(voiceNests.map((nest) => [nest.id, nest])), [voiceNests]);
  const textNests = useMemo(() => (state ? textNestsOfTree(state, treeId) : []), [state, treeId]);
  const textById = useMemo(() => new Map(textNests.map((nest) => [nest.summary.id, nest.summary])), [textNests]);

  const sections = useMemo(() => {
    const oldestFirst = [...textNests].sort((a, b) => a.summary.createdAt.localeCompare(b.summary.createdAt));
    const existing: NestRef[] = [
      ...oldestFirst.map((nest) => ({ kind: "text" as const, id: nest.summary.id })),
      ...voiceNests.map((nest) => ({ kind: "voice" as const, id: nest.id })),
    ];
    return layoutSections(layout, existing);
  }, [layout, textNests, voiceNests]);

  const nameOf = (ref: NestRef) => (ref.kind === "text" ? textById.get(ref.id)?.name : voiceById.get(ref.id)?.name) ?? "";

  if (arranging) {
    return (
      <ArrangeNests
        initial={toEntries(sections, nameOf)}
        nestPlural={nestPlural}
        onCancel={() => onArrangingChange(false)}
        onSave={async (entries) => {
          await chat.saveLayout(treeId, toLayoutRequest(entries));
          onArrangingChange(false);
        }}
      />
    );
  }

  const hasCategories = sections.length > 1;
  return (
    <>
      {sections.map((section) => {
        const items = section.items;
        if (items.length === 0 && (!section.category || !canManage)) return null;
        return (
          <section key={section.category?.id ?? "top"}>
            <SectionLabel
              className="mb-1"
              action={
                section.category && canManage ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button type="button" aria-label={`More for ${section.category.name}`} className="flex h-6 w-6 items-center justify-center rounded-chip text-subtle transition-colors hover:bg-secondary hover:text-foreground">
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => setRenaming(section.category)}>
                        <Pencil className="text-muted-foreground" />
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem destructive onSelect={() => setDeleting(section.category)}>
                        <Trash2 />
                        Delete category
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : undefined
              }
            >
              {section.category ? <bdi>{section.category.name}</bdi> : hasCategories ? "No category" : nestPlural}
            </SectionLabel>
            {items.length ? (
              <GroupedList>
                {items.map((ref) =>
                  ref.kind === "text" ? (
                    <TextNestRow
                      key={`text:${ref.id}`}
                      name={nameOf(ref)}
                      unread={textById.get(ref.id)?.unreadCount ?? 0}
                      mentions={textById.get(ref.id)?.mentionCount ?? 0}
                      caption={captions.get(ref.id)}
                      onOpen={() => onNavigate({ kind: "chat", id: ref.id })}
                      menu={canManage ? <NestRowMenu name={nameOf(ref)} onRename={() => setRenamingNest(ref)} onDelete={() => setDeletingNest(ref)} /> : undefined}
                    />
                  ) : (
                    <VoiceNestRow
                      key={`voice:${ref.id}`}
                      nest={voiceById.get(ref.id)!}
                      data={data}
                      here={media.activeNestId === ref.id}
                      caption={captions.get(ref.id)}
                      canJoin={canJoin}
                      onOpen={(nest) => onNavigate(nestView(nest))}
                      menu={canManage ? <NestRowMenu name={nameOf(ref)} renameLabel="Settings" onRename={() => setRenamingNest(ref)} onDelete={() => setDeletingNest(ref)} /> : undefined}
                    />
                  ),
                )}
              </GroupedList>
            ) : (
              <p className="px-1 text-small text-muted-foreground">Nothing here yet. Use Arrange to move something in.</p>
            )}
          </section>
        );
      })}

      <RenameDialog
        open={renaming !== null}
        onOpenChange={(open) => {
          if (!open) setRenaming(null);
        }}
        title="Rename category"
        current={renaming?.name ?? ""}
        onRename={async (name) => {
          if (renaming) await chat.renameCategory(treeId, renaming.id, name);
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={`Delete the category “${deleting?.name ?? ""}”?`}
        description={`The ${nestPlural.toLowerCase()} in it are kept, without a category.`}
        confirmLabel="Delete category"
        destructive
        busy={working}
        onConfirm={async () => {
          if (!deleting) return;
          setWorking(true);
          try {
            await chat.deleteCategory(treeId, deleting.id);
            setDeleting(null);
          } catch {
            // The category is still listed; the person can try again.
          } finally {
            setWorking(false);
          }
        }}
      />

      <RoomDialog
        open={renamingNest?.kind === "voice"}
        onOpenChange={(open) => {
          if (!open) setRenamingNest(null);
        }}
        title={`${nestSingular} settings`}
        initialName={renamingNest ? nameOf(renamingNest) : ""}
        initialDoor={(renamingNest?.kind === "voice" ? voiceById.get(renamingNest.id)?.door : undefined) ?? "open"}
        submitLabel="Save"
        onSubmit={async (name, door) => {
          if (renamingNest) await data.updateNestSettings(renamingNest.id, { name, door });
        }}
      />
      <RenameDialog
        open={renamingNest?.kind === "text"}
        onOpenChange={(open) => {
          if (!open) setRenamingNest(null);
        }}
        title={`Rename ${nestSingular}`}
        current={renamingNest ? nameOf(renamingNest) : ""}
        onRename={async (name) => {
          if (renamingNest) await chat.rename(renamingNest.id, { name });
        }}
      />
      <ConfirmDialog
        open={deletingNest !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingNest(null);
        }}
        title={`Delete “${deletingNest ? nameOf(deletingNest) : ""}”?`}
        description={
          deletingNest?.kind === "voice"
            ? `Anyone inside is put out of the call, and the ${nestSingular} disappears for everyone.`
            : `The ${nestSingular} disappears for everyone and can’t be opened again.`
        }
        confirmLabel={`Delete ${nestSingular}`}
        destructive
        busy={working}
        onConfirm={async () => {
          if (!deletingNest) return;
          setWorking(true);
          try {
            if (deletingNest.kind === "text") {
              await chat.deleteConversation(deletingNest.id);
            } else {
              // Someone deleting the room they are in leaves it first, so their microphone
              // and camera stop and the dock does not show a call that no longer exists.
              if (media.activeNestId === deletingNest.id) await media.leaveMediaSession();
              await data.deleteNest(deletingNest.id);
            }
            setDeletingNest(null);
          } catch (failure) {
            // The shell already says why a voice nest could not be deleted.
            if (deletingNest.kind === "text") toast({ title: failureText(failure, `Couldn’t delete the ${nestSingular}.`), tone: "error" });
          } finally {
            setWorking(false);
          }
        }}
      />
    </>
  );
}

/** The "…" at the end of a nest's row, for people who run the tree. */
function NestRowMenu({ name, renameLabel = "Rename", onRename, onDelete }: { name: string; renameLabel?: string; onRename: () => void; onDelete: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={`More for ${name}`} className="mr-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-subtle transition-colors hover:bg-accent hover:text-foreground">
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onRename}>
          {renameLabel === "Rename" ? <Pencil className="text-muted-foreground" /> : <Settings className="text-muted-foreground" />}
          {renameLabel}
        </DropdownMenuItem>
        <DropdownMenuItem destructive onSelect={onDelete}>
          <Trash2 />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const rowClassName = "group flex h-11 w-full items-center transition-colors hover:bg-secondary";
const rowButtonClassName = "flex h-11 min-w-0 flex-1 items-center gap-3 px-3.5 text-left";

/** A room's name, with what is on in it now underneath when an event is. */
function RowName({ name, caption, strong }: { name: string; caption?: string; strong?: boolean }) {
  if (!caption) return <span className={cn("min-w-0 flex-1 truncate text-body", strong && "font-medium")}><bdi>{name}</bdi></span>;
  return (
    <span className="min-w-0 flex-1">
      <span className={cn("block truncate text-body", strong && "font-medium")}><bdi>{name}</bdi></span>
      <span className="block truncate text-caption text-muted-foreground"><bdi>{caption}</bdi></span>
    </span>
  );
}

function TextNestRow({ name, unread, mentions, caption, onOpen, menu }: { name: string; unread: number; mentions: number; caption?: string; onOpen: () => void; menu?: ReactNode }) {
  return (
    <div className={cn(rowClassName, caption && "h-14")}>
      <button type="button" onClick={onOpen} className={cn(rowButtonClassName, caption && "h-14")}>
        <NestGlyph kind="text" className="text-subtle" />
        <RowName name={name} caption={caption} strong={unread > 0} />
        <MentionDot count={mentions} />
        <UnreadCount count={unread} />
      </button>
      {menu}
    </div>
  );
}

/** A quiet voice nest is one line. A live one keeps its place and shows who is inside, with a way in. */
function VoiceNestRow({
  nest,
  data,
  here,
  canJoin,
  caption,
  onOpen,
  menu,
}: {
  nest: Nest | LauncherNest;
  data: RavenShellData;
  here: boolean;
  canJoin: boolean;
  caption?: string;
  onOpen: (nest: Nest | LauncherNest) => void;
  menu?: ReactNode;
}) {
  const live = nest.lifecycleState === "active";
  const state = lifecycleLabel(nest);
  if (!live) {
    return (
      <div className={cn(rowClassName, caption && "h-14")}>
        <button type="button" onClick={() => onOpen(nest)} className={cn(rowButtonClassName, caption && "h-14")}>
          <NestGlyph kind="voice" className="text-subtle" />
          <RowName name={nest.name} caption={caption} />
          {state !== "Empty" && state !== "Created" ? <span className="shrink-0 text-caption text-muted-foreground">{state}</span> : null}
        </button>
        <DoorMark door={nest.door} />
        {menu}
      </div>
    );
  }
  const people = nestPeople(nest, data);
  const others = people.filter((person) => person.id !== data.user?.id).map((person) => person.name);
  const sentence = here
    ? others.length ? `You and ${namesSentence(others)}` : "Only you so far"
    : others.length ? namesSentence(others) : "Open";
  return (
    <div className="group flex min-h-14 w-full items-center transition-colors hover:bg-secondary">
      <button type="button" onClick={() => onOpen(nest)} className="flex min-h-14 min-w-0 flex-1 items-center gap-3 px-3.5 py-2 text-left">
        <NestGlyph kind="voice" live className="text-live" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body"><bdi>{nest.name}</bdi></span>
          {caption ? <span className="block truncate text-caption text-muted-foreground"><bdi>{caption}</bdi></span> : null}
          <span className="mt-0.5 flex min-w-0 items-center gap-2">
            <AvatarStack people={people} max={4} size="sm" surface="card" />
            <span className="min-w-0 truncate text-caption text-muted-foreground">{sentence}</span>
          </span>
        </span>
      </button>
      <DoorMark door={nest.door} />
      <Button size="xs" variant="secondary" className="mr-2 shrink-0" disabled={!here && !canJoin} onClick={() => onOpen(nest)}>
        {here ? "Return" : "Join…"}
      </Button>
      {menu}
    </div>
  );
}

// ---- arranging -------------------------------------------------------------------------

function ArrangeNests({
  initial,
  nestPlural,
  onCancel,
  onSave,
}: {
  initial: ArrangeEntry[];
  nestPlural: string;
  onCancel: () => void;
  onSave: (entries: ArrangeEntry[]) => Promise<void>;
}) {
  const [entries, setEntries] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const sensors = useSensors(
    // A few pixels of movement before a drag starts, so a click is still a click.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const keys = useMemo(() => entries.map(entryKey), [entries]);

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    setEntries((current) => {
      const order = current.map(entryKey);
      return moveEntry(current, order.indexOf(String(active.id)), order.indexOf(String(over.id)));
    });
  };

  return (
    <section>
      <SectionLabel
        className="mb-1"
        action={
          <span className="flex items-center gap-1.5">
            <Button size="xs" variant="ghost" disabled={saving} onClick={onCancel}>Cancel</Button>
            <Button
              size="xs"
              disabled={saving}
              onClick={() => {
                setSaving(true);
                setError("");
                void onSave(entries)
                  .catch((failure) => setError(failureText(failure, "Couldn’t save the arrangement.")))
                  .finally(() => setSaving(false));
              }}
            >
              {saving ? "Saving…" : "Done"}
            </Button>
          </span>
        }
      >
        Arrange {nestPlural.toLowerCase()}
      </SectionLabel>
      <p className="mb-2 text-small text-muted-foreground">
        Drag a row by its handle, or focus the handle and press Space, then the arrow keys. A row belongs to the category above it.
      </p>
      {error ? <p className="mb-2 rounded-card bg-destructive/10 px-3.5 py-3 text-small" role="alert">{error}</p> : null}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={keys} strategy={verticalListSortingStrategy}>
          <GroupedList>
            {entries.map((entry) =>
              entry.type === "category" ? (
                <ArrangeCategoryRow
                  key={entryKey(entry)}
                  entry={entry}
                  canMoveUp={canMoveCategory(entries, entry.id, -1)}
                  canMoveDown={canMoveCategory(entries, entry.id, 1)}
                  onMove={(direction) => setEntries((current) => moveCategory(current, entry.id, direction))}
                />
              ) : (
                <ArrangeItemRow key={entryKey(entry)} entry={entry} />
              ),
            )}
          </GroupedList>
        </SortableContext>
      </DndContext>
    </section>
  );
}

function ArrangeItemRow({ entry }: { entry: Extract<ArrangeEntry, { type: "item" }> }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: entryKey(entry) });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("flex h-11 items-center gap-2 bg-secondary/50 pl-1.5 pr-3.5", isDragging && "relative z-10 rounded-control bg-accent shadow-raised")}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        aria-label={`Move ${entry.name}`}
        className="flex h-8 w-7 shrink-0 cursor-grab items-center justify-center rounded-control text-subtle transition-colors hover:bg-accent hover:text-foreground"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <NestGlyph kind={entry.kind === "text" ? "text" : "voice"} className="text-subtle" />
      <span className="min-w-0 flex-1 truncate text-body"><bdi>{entry.name}</bdi></span>
    </div>
  );
}

function ArrangeCategoryRow({
  entry,
  canMoveUp,
  canMoveDown,
  onMove,
}: {
  entry: Extract<ArrangeEntry, { type: "category" }>;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (direction: -1 | 1) => void;
}) {
  // Part of the sortable list so that rows can be dropped around it, but not draggable
  // itself: a category moves, with its rows, through the buttons.
  const { setNodeRef, transform, transition } = useSortable({ id: entryKey(entry), disabled: { draggable: true } });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className="flex h-10 items-center gap-1 bg-secondary px-3.5">
      <span className="min-w-0 flex-1 truncate text-caption font-medium text-muted-foreground"><bdi>{entry.name}</bdi></span>
      <Button size="icon-xs" variant="ghost" disabled={!canMoveUp} aria-label={`Move ${entry.name} up`} onClick={() => onMove(-1)}>
        <ArrowUp className="h-4 w-4" />
      </Button>
      <Button size="icon-xs" variant="ghost" disabled={!canMoveDown} aria-label={`Move ${entry.name} down`} onClick={() => onMove(1)}>
        <ArrowDown className="h-4 w-4" />
      </Button>
    </div>
  );
}
