import { useEffect, useMemo, useState } from "react";
import { Check, UserMinus, UserPlus } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { failureText } from "@/lib/chat/errors";
import type { ChatMember } from "@/lib/chat/types";
import { cn } from "@/lib/utils";

export interface PickablePerson {
  id: string;
  name: string;
}

/** A filterable list of friends to pick from. */
function FriendPicker({
  friends,
  selected,
  onToggle,
  emptyText,
}: {
  friends: PickablePerson[];
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  emptyText: string;
}) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle ? friends.filter((friend) => friend.name.toLocaleLowerCase().includes(needle)) : friends;
  }, [friends, query]);

  if (friends.length === 0) return <p className="py-3 text-small text-muted-foreground">{emptyText}</p>;
  return (
    <div className="space-y-2">
      {friends.length > 6 ? <Input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Find a friend" aria-label="Find a friend" /> : null}
      <div className="max-h-64 space-y-px overflow-y-auto" role="listbox" aria-multiselectable>
        {shown.map((friend) => {
          const picked = selected.has(friend.id);
          return (
            <button
              key={friend.id}
              type="button"
              role="option"
              aria-selected={picked}
              onClick={() => onToggle(friend.id)}
              className={cn("flex h-10 w-full items-center gap-2.5 rounded-control px-2 text-left transition-colors", picked ? "bg-secondary" : "hover:bg-secondary/60")}
            >
              <Avatar name={friend.name} src={api.userAvatarUrl(friend.id)} className="h-7 w-7" />
              <span className="min-w-0 flex-1 truncate text-body"><bdi>{friend.name}</bdi></span>
              {picked ? <Check className="h-4 w-4 shrink-0" aria-hidden /> : null}
            </button>
          );
        })}
        {shown.length === 0 ? <p className="px-2 py-3 text-small text-muted-foreground">Nobody by that name.</p> : null}
      </div>
    </div>
  );
}

function useSelection(open: boolean) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (open) setSelected(new Set());
  }, [open]);
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return [selected, toggle] as const;
}

/** Name a group and choose who is in it. */
export function NewGroupDialog({
  open,
  onOpenChange,
  friends,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  friends: PickablePerson[];
  onCreate: (name: string, memberIds: string[]) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [selected, toggle] = useSelection(open);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setName("");
    setError("");
  }, [open]);

  const ready = name.trim() !== "" && selected.size > 0 && !working;
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New group" description="A group is a conversation between friends. People you add later see messages from then on." widthClassName="max-w-sm">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          setWorking(true);
          setError("");
          void onCreate(name.trim(), [...selected])
            .catch((failure) => setError(failureText(failure, "Couldn’t create the group.")))
            .finally(() => setWorking(false));
        }}
      >
        <label className="block space-y-1.5 text-small text-muted-foreground">
          Name
          <Input value={name} onChange={(event) => setName(event.currentTarget.value)} placeholder="Weekend crew" maxLength={80} autoFocus />
        </label>
        <div className="space-y-1.5 text-small text-muted-foreground">
          People
          <FriendPicker friends={friends} selected={selected} onToggle={toggle} emptyText="Add a friend first. A group needs at least one other person." />
        </div>
        {error ? <p className="text-small text-destructive" role="alert">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" disabled={!ready}>{working ? "Creating…" : "Create group"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Who is in a group, with adding, removing and leaving. */
export function GroupPeopleDialog({
  open,
  onOpenChange,
  groupName,
  members,
  me,
  canManage,
  friends,
  onAdd,
  onRemove,
  onLeave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupName: string;
  members: ChatMember[];
  me: string;
  canManage: boolean;
  friends: PickablePerson[];
  onAdd: (userIds: string[]) => Promise<void>;
  onRemove: (member: ChatMember) => void;
  onLeave: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [selected, toggle] = useSelection(adding);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setAdding(false);
    setError("");
  }, [open]);

  const memberIds = useMemo(() => new Set(members.map((member) => member.id)), [members]);
  const addable = useMemo(() => friends.filter((friend) => !memberIds.has(friend.id)), [friends, memberIds]);

  if (adding) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange} title={`Add people to ${groupName}`} description="They see messages from when they are added, not what came before." widthClassName="max-w-sm">
        <div className="space-y-4">
          <FriendPicker friends={addable} selected={selected} onToggle={toggle} emptyText="All of your friends are already in this group." />
          {error ? <p className="text-small text-destructive" role="alert">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAdding(false)}>Back</Button>
            <Button
              disabled={selected.size === 0 || working}
              onClick={() => {
                setWorking(true);
                setError("");
                void onAdd([...selected])
                  .then(() => setAdding(false))
                  .catch((failure) => setError(failureText(failure, "Couldn’t add them.")))
                  .finally(() => setWorking(false));
              }}
            >
              {working ? "Adding…" : selected.size > 1 ? "Add people" : "Add person"}
            </Button>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={groupName} description={`${members.length} ${members.length === 1 ? "person" : "people"}`} widthClassName="max-w-sm">
      <div className="space-y-4">
        <div className="max-h-72 space-y-px overflow-y-auto">
          {members.map((member) => (
            <div key={member.id} className="flex h-10 items-center gap-2.5 px-1">
              <Avatar name={member.displayName} src={api.userAvatarUrl(member.id)} className="h-7 w-7" />
              <span className="min-w-0 flex-1 truncate text-body"><bdi>{member.displayName}</bdi></span>
              <span className="shrink-0 text-caption text-muted-foreground">
                {[member.id === me ? "You" : null, member.role === "owner" ? "Owner" : null].filter(Boolean).join(" · ")}
              </span>
              {canManage && member.id !== me ? (
                <Button size="icon-xs" variant="ghost" aria-label={`Remove ${member.displayName}`} onClick={() => onRemove(member)}>
                  <UserMinus className="h-4 w-4" />
                </Button>
              ) : null}
            </div>
          ))}
        </div>
        <div className="flex justify-between gap-2">
          <Button variant="ghost" onClick={onLeave}>Leave group</Button>
          <Button variant="secondary" onClick={() => setAdding(true)}>
            <UserPlus className="h-4 w-4" />
            Add people
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Change a name. Unlike creating, it starts with the name as it is. */
export function RenameDialog({
  open,
  onOpenChange,
  title,
  current,
  onRename,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  current: string;
  onRename: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(current);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(current);
    setError("");
  }, [open, current]);

  const ready = name.trim() !== "" && name.trim() !== current && !working;
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} widthClassName="max-w-sm">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          setWorking(true);
          setError("");
          void onRename(name.trim())
            .then(() => onOpenChange(false))
            .catch((failure) => setError(failureText(failure, "Couldn’t save that name.")))
            .finally(() => setWorking(false));
        }}
      >
        <label className="block space-y-1.5 text-small text-muted-foreground">
          Name
          <Input value={name} onChange={(event) => setName(event.currentTarget.value)} maxLength={80} autoFocus />
        </label>
        {error ? <p className="text-small text-destructive" role="alert">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" disabled={!ready}>{working ? "Saving…" : "Save"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
