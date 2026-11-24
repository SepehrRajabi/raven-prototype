import { useMemo, useState } from "react";
import { MoreHorizontal, Plus, Tag } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { api, type TreeDetails } from "@/lib/api";
import type { ChatStore } from "@/lib/chat/store";
import type { TreeLabel } from "@/lib/chat/types";
import {
  labelDeleteCopy,
  labelNameProblem,
  labelRoomCount,
  labelRuleCount,
  MAX_LABEL_NAME,
  MAX_LABELS,
  newlyHidden,
  roomKey,
  withRoomLabels,
  type RoomKind,
} from "@/lib/roomAccess";
import { EmptyState, NestGlyph } from "../atoms";
import { SettingsPage, SettingsRows, SettingsSection } from "../SettingsScaffold";
import type { RavenShellData } from "../state";
import { useHideGuard, useTreeAccess, useTreeRooms } from "../useTreeAccess";
import { PickList } from "./PickList";
import { HideRoomsConfirm } from "./RoomAccessDialog";

/** Settings › Labels: the labels of a tree and which rooms have them. For the owner. */
export function RoomLabelSettings({ details, data, chat }: { details: TreeDetails; data: RavenShellData; chat?: ChatStore | null }) {
  const treeId = details.tree.id;
  const tree = useTreeAccess(treeId);
  const { access } = tree;
  const rooms = useTreeRooms(details, data, chat, access);
  const { names } = rooms;
  const { one, many } = names.nouns;
  const guard = useHideGuard();
  const [editing, setEditing] = useState<TreeLabel | "new" | null>(null);
  const [deleting, setDeleting] = useState<TreeLabel | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const labels = access?.labels ?? [];

  // The lobby and the sidebar read labels from the layout.
  const refreshLayout = () => void chat?.loadLayout(treeId).catch(() => undefined);
  const save = async (request: () => Promise<unknown>) => {
    const problem = await tree.changeThenReload(request);
    if (!problem) refreshLayout();
    return problem;
  };

  const chosen = rooms.rooms.filter((room) => selected.has(roomKey(room)));
  const labelsOf = useMemo(() => new Map((access?.roomLabels ?? []).map((room) => [roomKey(room), room.labelIds])), [access]);
  const has = (key: string, labelId: string) => labelsOf.get(key)?.includes(labelId) ?? false;
  const addable = labels.filter((label) => chosen.some((room) => !has(roomKey(room), label.id)));
  const removable = labels.filter((label) => chosen.some((room) => has(roomKey(room), label.id)));

  const assign = async (add: string[], remove: string[]) => {
    if (!access) return;
    const change = { rooms: chosen, add, remove };
    const hidden = newlyHidden(access, { ...access, roomLabels: withRoomLabels(access.roomLabels, change) }, rooms.rooms, Date.now());
    if (!(await guard.guard(hidden))) return;
    const problem = await tree.change(() => api.changeRoomLabels(treeId, change));
    if (problem) toast({ title: "Couldn’t save that.", description: problem, tone: "error" });
    else refreshLayout();
  };
  /** For a change made from a row, which has nowhere of its own to say that it failed. */
  const saveRow = async (request: () => Promise<unknown>) => {
    const problem = await save(request);
    if (problem) toast({ title: "Couldn’t save that.", description: problem, tone: "error" });
  };
  const selectKind = (kind: RoomKind) => setSelected((current) => new Set([...current, ...rooms.rooms.filter((room) => room.kind === kind).map(roomKey)]));

  return (
    <SettingsPage title="Labels" description={`Group ${many} so one rule can be about all of them. A label changes nothing until a rule is about it.`}>
      <SettingsSection title={`In this ${data.labels.treeSingular.toLowerCase()}`}>
        {!access ? (
          tree.loadError ? (
            <div role="alert" className="flex items-center justify-between gap-4 rounded-card bg-destructive/10 px-3.5 py-3 text-small">
              <span>Couldn’t load the labels. {tree.loadError}</span>
              <Button size="sm" variant="secondary" onClick={() => void tree.reload()}>Try again</Button>
            </div>
          ) : (
            <p className="text-small text-muted-foreground">Loading…</p>
          )
        ) : (
          <>
            {labels.length ? (
              <SettingsRows>
                {labels.map((label) => {
                  const roomCount = labelRoomCount(label.id, access.roomLabels);
                  const ruleCount = labelRuleCount(label.id, access.rules);
                  return (
                    <div key={label.id} className="flex min-h-12 items-center gap-3 py-2 pl-4 pr-2">
                      <Tag className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-body"><bdi>{label.name}</bdi></span>
                        <span className="block truncate text-caption text-muted-foreground">
                          {roomCount ? `${roomCount} ${roomCount === 1 ? one : many}` : `On no ${one}`}
                          {ruleCount ? ` · ${ruleCount} ${ruleCount === 1 ? "rule" : "rules"}` : null}
                        </span>
                      </span>
                      <label className="flex shrink-0 items-center gap-2 text-caption text-muted-foreground">
                        Shown to members
                        <Switch
                          checked={label.visible}
                          disabled={tree.busy}
                          aria-label={`${label.name}: shown to members`}
                          onCheckedChange={(visible) => void saveRow(() => api.editTreeLabel(treeId, label.id, { visible }))}
                        />
                      </label>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="icon-xs" variant="ghost" disabled={tree.busy} aria-label={`More for ${label.name}`}>
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => setEditing(label)}>Rename…</DropdownMenuItem>
                          <DropdownMenuItem destructive onSelect={() => setDeleting(label)}>Delete…</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  );
                })}
              </SettingsRows>
            ) : (
              <EmptyState className="rounded-card bg-secondary/50" title="No labels yet" text={`Make one, put it on some ${many}, then add a rule about it.`}>
                <Button size="sm" variant="secondary" onClick={() => setEditing("new")}>
                  <Plus className="h-4 w-4" /> New label
                </Button>
              </EmptyState>
            )}
            {labels.length >= MAX_LABELS ? (
              <p className="text-small text-muted-foreground">That is as many labels as fit.</p>
            ) : labels.length ? (
              <Button size="sm" variant="secondary" onClick={() => setEditing("new")}>
                <Plus className="h-4 w-4" /> New label
              </Button>
            ) : null}
            <p className="max-w-xl text-caption text-muted-foreground">
              Members see a label only when it is shown to them and on a {one} they can see. A label you keep to yourself still can’t hide its effect: people always see their own access.
            </p>
          </>
        )}
      </SettingsSection>

      {access && labels.length && rooms.rooms.length ? (
        <SettingsSection title={`On which ${many}`} description={`Choose ${many}, then add or take off labels.`}>
          <div className="flex flex-wrap items-center gap-1">
            <Button size="xs" variant="ghost" onClick={() => selectKind("text")}>All text</Button>
            <Button size="xs" variant="ghost" onClick={() => selectKind("voice")}>All voice</Button>
            <Button size="xs" variant="ghost" disabled={selected.size === 0} onClick={() => setSelected(new Set())}>None</Button>
            <span className="ml-auto mr-1 text-caption text-muted-foreground" aria-live="polite">{chosen.length ? `${chosen.length} chosen` : ""}</span>
            <LabelMenu title="Add label" labels={addable} disabled={tree.busy || addable.length === 0} onPick={(id) => void assign([id], [])} />
            <LabelMenu title="Take off label" labels={removable} disabled={tree.busy || removable.length === 0} onPick={(id) => void assign([], [id])} />
          </div>
          <PickList
            label={data.labels.nestPlural}
            selected={selected}
            searchLabel={`Find a ${one}`}
            emptyText={`There are no ${many} yet.`}
            className="max-h-[26rem]"
            onToggle={(id) =>
              setSelected((current) => {
                const next = new Set(current);
                if (!next.delete(id)) next.add(id);
                return next;
              })
            }
            sections={rooms.sections.map((section) => ({
              key: section.category?.id ?? "top",
              title: section.category?.name,
              items: section.items.map((room) => {
                const key = roomKey(room);
                return {
                  id: key,
                  name: names.room(room) ?? "",
                  leading: <NestGlyph kind={room.kind} className="text-muted-foreground" />,
                  trailing: <LabelChips labels={labels.filter((label) => has(key, label.id))} />,
                };
              }),
            }))}
          />
        </SettingsSection>
      ) : null}

      {editing ? (
        <LabelDialog
          key={editing === "new" ? "new" : editing.id}
          label={editing === "new" ? null : editing}
          labels={labels}
          onClose={() => setEditing(null)}
          onSave={(name, visible) => save(() => (editing === "new" ? api.createTreeLabel(treeId, { name, visible }) : api.editTreeLabel(treeId, editing.id, { name })))}
        />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => { if (!open) setDeleting(null); }}
        title={`Delete the label ${deleting?.name ?? ""}?`}
        description={deleting && access ? labelDeleteCopy(deleting.id, access, rooms.rooms, names, tree.now) : ""}
        confirmLabel="Delete"
        destructive
        busy={tree.busy}
        onConfirm={async () => {
          if (!deleting) return;
          await saveRow(() => api.deleteTreeLabel(treeId, deleting.id));
          setDeleting(null);
        }}
      />
      <HideRoomsConfirm hidden={guard.hidden} names={names} onAnswer={guard.answer} />
    </SettingsPage>
  );
}

function LabelChips({ labels }: { labels: TreeLabel[] }) {
  if (labels.length === 0) return null;
  const shown = labels.slice(0, 3);
  return (
    <span className="flex min-w-0 shrink-0 items-center gap-1" title={labels.map((label) => label.name).join(", ")}>
      {shown.map((label) => (
        <Badge key={label.id} variant="outline" className="max-w-28">
          <bdi className="truncate">{label.name}</bdi>
        </Badge>
      ))}
      {labels.length > shown.length ? <span className="text-caption text-muted-foreground">+{labels.length - shown.length}</span> : null}
    </span>
  );
}

function LabelMenu({ title, labels, disabled, onPick }: { title: string; labels: TreeLabel[]; disabled: boolean; onPick: (id: string) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="xs" variant="secondary" disabled={disabled}>{title}</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
        {labels.map((label) => (
          <DropdownMenuItem key={label.id} onSelect={() => onPick(label.id)}><bdi>{label.name}</bdi></DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LabelDialog({ label, labels, onClose, onSave }: { label: TreeLabel | null; labels: TreeLabel[]; onClose: () => void; onSave: (name: string, visible: boolean) => Promise<string> }) {
  const [name, setName] = useState(label?.name ?? "");
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    if (saving) return;
    const problem = labelNameProblem(name, labels, label?.id);
    if (problem) return setError(problem);
    setSaving(true);
    setError("");
    const failure = await onSave(name.trim(), visible);
    setSaving(false);
    if (failure) setError(failure);
    else onClose();
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }} title={label ? "Rename label" : "New label"} widthClassName="max-w-sm">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="block space-y-1.5 text-small text-muted-foreground">
          Name
          <Input value={name} maxLength={MAX_LABEL_NAME} disabled={saving} placeholder="Staff" dir="auto" onChange={(event) => { setName(event.currentTarget.value); setError(""); }} />
        </label>
        {label ? null : (
          <label className="flex items-center justify-between gap-4 text-small">
            Shown to members
            <Switch checked={visible} disabled={saving} onCheckedChange={setVisible} />
          </label>
        )}
        {error ? <p role="alert" className="text-small text-destructive">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={saving} onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving || !name.trim()}>{saving ? "Saving…" : label ? "Save" : "Create label"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
