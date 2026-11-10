import { useEffect, useMemo, useState } from "react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, type Friend, type TreeMember, type TreeRole } from "@/lib/api";
import { friendsMatching } from "../people";
import { displayNameFor } from "../state";


/** Ask for one name and create something with it. */
export function NameDialog({
  open,
  onOpenChange,
  title,
  description,
  label,
  placeholder,
  submitLabel,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  label: string;
  placeholder?: string;
  submitLabel: string;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (open) setName("");
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} description={description} widthClassName="max-w-sm">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          const nextName = name.trim();
          if (!nextName || working) return;
          setWorking(true);
          void onSubmit(nextName)
            .catch(() => undefined)
            .finally(() => setWorking(false));
        }}
      >
        <label className="block space-y-1.5 text-small text-muted-foreground">
          {label}
          <Input value={name} onChange={(event) => setName(event.currentTarget.value)} placeholder={placeholder} maxLength={80} autoFocus />
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" disabled={working || !name.trim()}>{working ? "Creating…" : submitLabel}</Button>
        </div>
      </form>
    </Dialog>
  );
}

export const TREE_ROLE_LABEL: Record<TreeRole, string> = {
  member: "Member",
  moderator: "Moderator",
  owner: "Owner",
};

export function AddTreeMemberDialog({
  open,
  onOpenChange,
  title,
  canAssignRoles,
  friends,
  memberIds,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Adding someone as a moderator is giving out a role, which is the owner's to do. */
  canAssignRoles: boolean;
  /** Suggestions come only from your friends, never from everyone on the server. */
  friends: readonly Friend[];
  /** People already in, left out of the suggestions. */
  memberIds: ReadonlySet<string>;
  onAdd: (username: string, role: TreeRole) => Promise<void>;
}) {
  const [username, setUsername] = useState("");
  const matches = useMemo(() => friendsMatching(friends, username, memberIds), [friends, username, memberIds]);
  const picked = matches.length === 1 && matches[0].username.toLocaleLowerCase() === username.trim().replace(/^@/, "").toLocaleLowerCase();
  const [role, setRole] = useState<TreeRole>("member");
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (!open) return;
    setUsername("");
    setRole("member");
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} description="They are added straight away and can see who is here." widthClassName="max-w-sm">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          const nextUsername = username.trim().replace(/^@/, "");
          if (!nextUsername || working) return;
          setWorking(true);
          void onAdd(nextUsername, role)
            .catch(() => undefined)
            .finally(() => setWorking(false));
        }}
      >
        <label className="block space-y-1.5 text-small text-muted-foreground">
          Username
          <Input value={username} onChange={(event) => setUsername(event.currentTarget.value)} placeholder="mina" autoFocus autoComplete="off" />
        </label>
        {username.trim() && !picked ? (
          matches.length > 0 ? (
            <div className="-mt-2 space-y-px" role="listbox" aria-label="Friends">
              {matches.map((friend) => (
                <button
                  key={friend.userId}
                  type="button"
                  role="option"
                  aria-selected={false}
                  onClick={() => setUsername(friend.username)}
                  className="flex h-10 w-full items-center gap-2.5 rounded-control px-2 text-left transition-colors hover:bg-secondary/60"
                >
                  <Avatar name={friend.displayName || friend.username} src={api.userAvatarUrl(friend.userId)} className="h-7 w-7" />
                  <span className="min-w-0 flex-1 truncate text-body"><bdi>{friend.displayName || friend.username}</bdi></span>
                  <span className="shrink-0 truncate text-small text-muted-foreground">@<bdi>{friend.username}</bdi></span>
                </button>
              ))}
            </div>
          ) : (
            <p className="-mt-2 px-2 text-small text-muted-foreground">No friend with that username.</p>
          )
        ) : null}
        {canAssignRoles ? (
          <div className="space-y-1.5 text-small text-muted-foreground">
            Role
            <Select value={role} onValueChange={(value) => setRole(value as TreeRole)}>
              <SelectTrigger>
                <SelectValue>{TREE_ROLE_LABEL[role]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="member">Member</SelectItem>
                  <SelectItem value="moderator">Moderator</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" disabled={working || !username.trim()}>{working ? "Adding…" : "Add person"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** A name that applies inside one space only. Blank goes back to the usual name. */
export function SpaceNameDialog({
  member,
  isSelf,
  treeName,
  onClose,
  onSave,
}: {
  member: TreeMember | null;
  isSelf: boolean;
  treeName: string;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [working, setWorking] = useState(false);
  useEffect(() => {
    if (member) setName(member.nickname ?? "");
  }, [member]);
  const save = (next: string) => {
    if (working) return;
    setWorking(true);
    void onSave(next)
      .catch(() => undefined)
      .finally(() => setWorking(false));
  };
  const who = member ? (isSelf ? "your" : `${member.username}’s`) : "";
  return (
    <Dialog
      open={member != null}
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={isSelf ? `Your name in ${treeName}` : `${member ? displayNameFor(member) : ""}’s name in ${treeName}`}
      description={`Everyone in ${treeName} sees this instead of ${who} usual name. Nowhere else changes.`}
      widthClassName="max-w-sm"
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          save(name.trim());
        }}
      >
        <label className="block space-y-1.5 text-small text-muted-foreground">
          Name
          <Input value={name} onChange={(event) => setName(event.currentTarget.value)} placeholder={member?.nickname ? member.username : member ? displayNameFor(member) : ""} maxLength={80} autoFocus />
        </label>
        <div className="flex justify-between gap-2">
          <Button variant="ghost" disabled={working || !member?.nickname} onClick={() => save("")}>Use usual name</Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={working}>{working ? "Saving…" : "Save"}</Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
