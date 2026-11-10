import { useState } from "react";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react";
import { MentionField } from "@/components/chat/MentionField";
import { MessageText } from "@/components/chat/MessageText";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, type TreeDetails, type TreeNote } from "@/lib/api";
import { fromTokens, toTokens, type PickedMention } from "@/lib/chat/mentions";
import type { ChatStore } from "@/lib/chat/store";
import { pinnedEvents } from "@/lib/events";
import { activeNotes, boardTime, fromLocalInput, toLocalInput } from "@/lib/notes";
import { SettingsRows, SettingsSection } from "../SettingsScaffold";
import type { RavenShellData } from "../state";
import { SegmentedChoice } from "../UserSettings";
import { useSpaceMentions } from "../useSpaceMentions";

export const MAX_NOTES = 5;
const MAX_TITLE = 80;
const MAX_DESCRIPTION = 280;

const ENDS = [
  { id: "never", label: "Never" },
  { id: "at", label: "At a time" },
] as const;

/** Settings › Board: the pinned notes at the top of the lobby. */
export function BoardNotes({ details, data, chat }: { details: TreeDetails; data: RavenShellData; chat?: ChatStore | null }) {
  const treeId = details.tree.id;
  const treeLabel = data.labels.treeSingular.toLowerCase();
  const { resolver, context, candidates, members } = useSpaceMentions(details, data, chat);
  const notes = activeNotes(details.notes);
  // Pinned events share the lobby's pins.
  const pinsUsed = notes.length + pinnedEvents(details.events).length;
  const [editing, setEditing] = useState<TreeNote | "new" | null>(null);
  const [removing, setRemoving] = useState<TreeNote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      await data.refresh();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "That change could not be saved.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const move = (index: number, direction: -1 | 1) => {
    const ids = notes.map((note) => note.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(index + direction, 0, moved);
    void run(() => api.orderTreeNotes(treeId, ids));
  };

  return (
    <SettingsSection title="Pinned notes" description={`Up to ${MAX_NOTES} with pinned events, at the top of the ${treeLabel}’s lobby. Each can end at a time you pick.`}>
      {notes.length ? (
        <SettingsRows>
          {notes.map((note, index) => (
            <div key={note.id} className="flex items-center gap-1 px-3 py-2">
              <div className="min-w-0 flex-1">
                <MessageText body={note.title} mentions={context} className="truncate text-body" />
                {note.endsAt ? <p className="text-caption text-subtle">Until {boardTime(note.endsAt)}</p> : null}
              </div>
              <Button size="icon-xs" variant="ghost" disabled={busy || index === 0} aria-label="Move up" onClick={() => move(index, -1)}>
                <ArrowUp className="h-4 w-4" />
              </Button>
              <Button size="icon-xs" variant="ghost" disabled={busy || index === notes.length - 1} aria-label="Move down" onClick={() => move(index, 1)}>
                <ArrowDown className="h-4 w-4" />
              </Button>
              <Button size="icon-xs" variant="ghost" disabled={busy} aria-label="Edit note" onClick={() => setEditing(note)}>
                <Pencil className="h-4 w-4" />
              </Button>
              <Button size="icon-xs" variant="ghost" disabled={busy} aria-label="Delete note" onClick={() => setRemoving(note)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </SettingsRows>
      ) : null}
      {pinsUsed < MAX_NOTES ? (
        <Button size="sm" variant="secondary" onClick={() => setEditing("new")}>
          <Plus className="h-4 w-4" /> Pin a note
        </Button>
      ) : (
        <p className="text-small text-muted-foreground">That is as many notes and pinned events as fit.</p>
      )}
      {error ? <p role="alert" className="text-small text-destructive">{error}</p> : null}
      {editing ? (
        <NoteDialog
          key={editing === "new" ? "new" : editing.id}
          note={editing === "new" ? null : editing}
          candidates={candidates}
          members={members}
          fromStored={(text) => fromTokens(text, resolver)}
          onClose={() => setEditing(null)}
          onSave={(input) => run(() => (editing === "new" ? api.createTreeNote(treeId, input) : api.editTreeNote(treeId, editing.id, input)))}
        />
      ) : null}
      <ConfirmDialog
        open={removing != null}
        onOpenChange={(open) => { if (!open) setRemoving(null); }}
        title="Delete this note?"
        description="It disappears from the lobby for everyone."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (!removing) return;
          await run(() => api.deleteTreeNote(treeId, removing.id));
          setRemoving(null);
        }}
      />
    </SettingsSection>
  );
}

function NoteDialog({
  note,
  candidates,
  members,
  fromStored,
  onClose,
  onSave,
}: {
  note: TreeNote | null;
  candidates: ReturnType<typeof useSpaceMentions>["candidates"];
  members: ReturnType<typeof useSpaceMentions>["members"];
  fromStored: (text: string) => { text: string; picked: PickedMention[] };
  onClose: () => void;
  onSave: (input: { title: string; description: string; endsAt: string | null }) => Promise<boolean>;
}) {
  const [title, setTitle] = useState(() => fromStored(note?.title ?? ""));
  const [description, setDescription] = useState(() => fromStored(note?.description ?? ""));
  const [ends, setEnds] = useState<"never" | "at">(note?.endsAt ? "at" : "never");
  const [endValue, setEndValue] = useState(() => (note?.endsAt ? toLocalInput(note.endsAt) : ""));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const endsAt = ends === "at" ? fromLocalInput(endValue) : null;
    if (ends === "at" && !endsAt) return setError("Pick when this note should end.");
    if (endsAt && Date.parse(endsAt) <= Date.now()) return setError("Pick an end time that hasn’t passed yet.");
    setError("");
    setSaving(true);
    try {
      const saved = await onSave({
        title: toTokens(title.text, title.picked, members),
        description: toTokens(description.text, description.picked, members),
        endsAt,
      });
      if (saved) onClose();
      else setError("That note could not be saved. Check the mentions and the end time.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }} title={note ? "Edit note" : "Pin a note"}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="block space-y-1.5">
          <span className="text-small font-medium">Title</span>
          <MentionField
            label="Title"
            value={title.text}
            picked={title.picked}
            candidates={candidates}
            disabled={saving}
            placeholder="Movie night on Friday"
            onChange={(text, picked) => setTitle({ text: text.slice(0, MAX_TITLE), picked })}
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-small font-medium">Description <span className="font-normal text-muted-foreground">(optional)</span></span>
          <MentionField
            multiline
            label="Description"
            value={description.text}
            picked={description.picked}
            candidates={candidates}
            disabled={saving}
            placeholder="Type @ to mention a person or a room"
            onChange={(text, picked) => setDescription({ text: text.slice(0, MAX_DESCRIPTION), picked })}
          />
        </label>
        <div className="space-y-1.5">
          <span className="text-small font-medium">Ends</span>
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedChoice
              label="Ends"
              options={ENDS}
              selected={ends}
              disabled={saving}
              onSelect={(next) => {
                setEnds(next);
                if (next === "at" && !endValue) setEndValue(toLocalInput(new Date(Math.ceil((Date.now() + 3_600_000) / 3_600_000) * 3_600_000).toISOString()));
              }}
            />
            {ends === "at" ? (
              <Input type="datetime-local" aria-label="End time" value={endValue} disabled={saving} className="w-auto" onChange={(event) => setEndValue(event.target.value)} />
            ) : null}
          </div>
        </div>
        {error ? <p role="alert" className="text-small text-destructive">{error}</p> : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" disabled={saving} onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving || !title.text.trim()}>{note ? "Save" : "Pin"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
