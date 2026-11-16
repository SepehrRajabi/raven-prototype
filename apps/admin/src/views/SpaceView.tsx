import { useState } from "react";
import type { FormEvent } from "react";
import { ArrowLeft, Hash, Plus, Volume2 } from "lucide-react";
import type { AdminApi } from "../api";
import type { Room, SpaceDetail, SpaceMember } from "../types";
import { Badge, Button, ConfirmDialog, Dialog, Field, Input, List, Loading, Notice, PageHeader, Row, Section, Select } from "../components/ui";
import { formatDate, plural } from "../lib/format";
import { navigate, routeHref } from "../lib/route";
import { errorMessage, useLoad } from "../lib/useLoad";

type Pending =
  | { kind: "settings" }
  | { kind: "delete" }
  | { kind: "add-member" }
  | { kind: "add-room" }
  | { kind: "rename-member"; member: SpaceMember }
  | { kind: "transfer"; member: SpaceMember }
  | { kind: "remove-member"; member: SpaceMember }
  | { kind: "rename-room"; room: Room }
  | { kind: "remove-room"; room: Room }
  | null;

export function SpaceView({ api, spaceId }: { api: AdminApi; spaceId: string }) {
  const detail = useLoad(() => api.space(spaceId), spaceId);
  const [pending, setPending] = useState<Pending>(null);
  // Members whose role change is on its way. Their menu waits for the answer, so two quick
  // changes cannot come back in the wrong order.
  const [savingRole, setSavingRole] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState("");

  if (detail.error && !detail.data) {
    return (
      <>
        <Back />
        <Notice>{detail.error}</Notice>
      </>
    );
  }
  if (!detail.data) return <Loading />;
  const { space, members, rooms } = detail.data;
  const apply = (next: SpaceDetail) => {
    detail.set(next);
    setError("");
  };
  const close = () => setPending(null);

  return (
    <>
      <Back />
      <PageHeader
        title={space.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {space.description || "No description"}
            <Badge>{space.visibility === "public" ? "Public" : "Private"}</Badge>
            <Badge>{space.joinPolicy === "free" ? "Anyone can join" : "Join by request"}</Badge>
          </span>
        }
        actions={
          <Button size="sm" onClick={() => setPending({ kind: "settings" })}>
            Edit settings
          </Button>
        }
      />
      {error ? <div className="mb-4"><Notice>{error}</Notice></div> : null}
      {detail.error ? (
        <div className="mb-4">
          <Notice>Couldn’t refresh this page, so it may be out of date. {detail.error}</Notice>
        </div>
      ) : null}
      {!space.ownerId ? (
        <div className="mb-6">
          <Notice tone="warning">Nobody owns this space, so nobody in it can change its settings or roles. Make a member its owner below.</Notice>
        </div>
      ) : null}
      {space.ownerStatus === "suspended" ? (
        <div className="mb-6">
          <Notice tone="warning">The owner, @{space.ownerUsername}, is suspended. Make someone else owner if the space should be run by someone who can sign in.</Notice>
        </div>
      ) : null}

      <Section
        title="Members"
        description={`${plural(members.length, "member")}. A space has one owner; moderators manage rooms and members.`}
        actions={
          <Button size="sm" onClick={() => setPending({ kind: "add-member" })}>
            <Plus size={14} aria-hidden />
            Add member
          </Button>
        }
      >
        <List empty="Nobody is in this space.">
          {members.map((member) => (
            <Row key={member.userId}>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 truncate font-medium">
                  <a href={routeHref({ page: "user", id: member.userId })} className="truncate hover:underline">
                    {member.displayName}
                  </a>
                  {member.status === "suspended" ? <Badge tone="destructive">Suspended</Badge> : null}
                </p>
                <p className="truncate text-small text-muted-foreground">
                  @{member.username}{member.nickname ? " · nickname" : ""} · joined {formatDate(member.joinedAt)}
                </p>
              </div>
              <Button size="sm" variant="ghost" aria-label={`Set name of ${member.username} in this space`} onClick={() => setPending({ kind: "rename-member", member })}>
                Set name
              </Button>
              {member.role === "owner" ? (
                <Badge>Owner</Badge>
              ) : (
                <>
                  <Select
                    aria-label={`Role of ${member.username}`}
                    value={member.role}
                    disabled={savingRole.has(member.userId)}
                    onChange={(event) => {
                      const userId = member.userId;
                      setSavingRole((current) => new Set(current).add(userId));
                      api
                        .setMemberRole(space.id, userId, event.target.value as "member" | "moderator")
                        .then(apply)
                        .catch((cause: unknown) => setError(errorMessage(cause)))
                        .finally(() =>
                          setSavingRole((current) => {
                            const next = new Set(current);
                            next.delete(userId);
                            return next;
                          }),
                        );
                    }}
                  >
                    <option value="member">Member</option>
                    <option value="moderator">Moderator</option>
                  </Select>
                  <Button size="sm" variant="ghost" aria-label={`Make ${member.username} owner`} disabled={member.status === "suspended"} onClick={() => setPending({ kind: "transfer", member })}>
                    Make owner
                  </Button>
                  <Button size="sm" variant="ghost" aria-label={`Remove ${member.username}`} onClick={() => setPending({ kind: "remove-member", member })}>
                    Remove
                  </Button>
                </>
              )}
            </Row>
          ))}
        </List>
      </Section>

      <Section
        title="Rooms"
        description="Voice rooms are for calls, text rooms for messages. You can’t see inside either from here."
        actions={
          <Button size="sm" onClick={() => setPending({ kind: "add-room" })}>
            <Plus size={14} aria-hidden />
            Add room
          </Button>
        }
      >
        <List empty="This space has no rooms.">
          {rooms.map((room) => (
            <Row key={room.id}>
              {room.kind === "voice" ? <Volume2 size={16} className="shrink-0 text-muted-foreground" aria-label="Voice room" /> : <Hash size={16} className="shrink-0 text-muted-foreground" aria-label="Text room" />}
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{room.name}</p>
                <p className="text-small text-subtle">
                  {room.kind === "voice" ? "Voice" : "Text"} · created {formatDate(room.createdAt)}
                </p>
              </div>
              {room.peopleInCall > 0 ? <Badge tone="live">{plural(room.peopleInCall, "person", "people")} in call</Badge> : null}
              <Button size="sm" variant="ghost" aria-label={`Rename ${room.name}`} onClick={() => setPending({ kind: "rename-room", room })}>
                Rename
              </Button>
              <Button size="sm" variant="ghost" aria-label={`${room.kind === "voice" ? "End" : "Delete"} ${room.name}`} onClick={() => setPending({ kind: "remove-room", room })}>
                {room.kind === "voice" ? "End" : "Delete"}
              </Button>
            </Row>
          ))}
        </List>
      </Section>

      <Section title="Delete space">
        <List>
          <Row>
            <p className="min-w-0 flex-1 text-small text-muted-foreground">Removes the space, its rooms and every message written in them, for everyone. This cannot be undone.</p>
            <Button size="sm" variant="destructive" onClick={() => setPending({ kind: "delete" })}>
              Delete space
            </Button>
          </Row>
        </List>
      </Section>

      {pending?.kind === "settings" ? <SettingsDialog api={api} detail={detail.data} onClose={close} onDone={apply} /> : null}
      {pending?.kind === "add-member" ? <AddMemberDialog api={api} spaceId={space.id} onClose={close} onDone={apply} /> : null}
      {pending?.kind === "add-room" ? <RoomDialog title="Add room" confirmLabel="Add room" withKind onClose={close} onSubmit={async (name, kind) => apply(await api.createRoom(space.id, name, kind))} /> : null}
      {pending?.kind === "rename-room" ? (
        <RoomDialog title="Rename room" confirmLabel="Rename" initialName={pending.room.name} onClose={close} onSubmit={async (name) => apply(await api.renameRoom(space.id, pending.room.id, name))} />
      ) : null}
      {pending?.kind === "rename-member" ? (
        <RoomDialog
          title={`Name of ${pending.member.username} in ${space.name}`}
          confirmLabel="Save"
          initialName={pending.member.nickname}
          allowBlank
          onClose={close}
          onSubmit={async (name) => apply(await api.setMemberName(space.id, pending.member.userId, name))}
        />
      ) : null}
      {pending?.kind === "transfer" ? (
        <ConfirmDialog
          title={`Make ${pending.member.username} the owner?`}
          body={space.ownerUsername ? `@${space.ownerUsername} stays in the space as a moderator. Only the owner can change settings and roles or delete the space.` : "They will be able to change settings and roles and delete the space."}
          confirmLabel="Make owner"
          typeToConfirm={pending.member.username}
          onClose={close}
          onConfirm={async () => apply(await api.transferSpace(space.id, { userId: pending.member.userId }))}
        />
      ) : null}
      {pending?.kind === "remove-member" ? (
        <ConfirmDialog
          title={`Remove ${pending.member.username}?`}
          body="They lose the space and its rooms at once, including any call they are in. They can be added back later, as a member."
          confirmLabel="Remove"
          destructive
          onClose={close}
          onConfirm={async () => apply(await api.removeMember(space.id, pending.member.userId))}
        />
      ) : null}
      {pending?.kind === "remove-room" ? (
        <ConfirmDialog
          title={pending.room.kind === "voice" ? `End ${pending.room.name}?` : `Delete ${pending.room.name}?`}
          body={pending.room.kind === "voice" ? "The room closes and anyone in its call is disconnected. It cannot be reopened." : "The room and every message in it are deleted for everyone. This cannot be undone."}
          confirmLabel={pending.room.kind === "voice" ? "End room" : "Delete room"}
          destructive
          onClose={close}
          onConfirm={async () => apply(await api.removeRoom(space.id, pending.room.id))}
        />
      ) : null}
      {pending?.kind === "delete" ? (
        <ConfirmDialog
          title={`Delete ${space.name}?`}
          body={`${plural(members.length, "member")} lose the space, its ${plural(rooms.length, "room")} and every message in them. This cannot be undone.`}
          confirmLabel="Delete space"
          typeToConfirm={space.name}
          destructive
          onClose={close}
          onConfirm={async () => {
            await api.deleteSpace(space.id, space.name);
            navigate({ page: "spaces" });
          }}
        />
      ) : null}
    </>
  );
}

function Back() {
  return (
    <a href={routeHref({ page: "spaces" })} className="mb-4 inline-flex items-center gap-1.5 text-small text-muted-foreground hover:text-foreground">
      <ArrowLeft size={14} aria-hidden />
      Spaces
    </a>
  );
}

function SettingsDialog({ api, detail, onClose, onDone }: { api: AdminApi; detail: SpaceDetail; onClose: () => void; onDone: (detail: SpaceDetail) => void }) {
  const [name, setName] = useState(detail.space.name);
  const [description, setDescription] = useState(detail.space.description);
  const [visibility, setVisibility] = useState(detail.space.visibility);
  const [joinPolicy, setJoinPolicy] = useState(detail.space.joinPolicy);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onDone(await api.updateSpace(detail.space.id, { name: name.trim(), description: description.trim(), visibility, joinPolicy }));
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  };
  return (
    <Dialog title="Space settings" onClose={onClose}>
      <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
        <Field label="Name">
          {(id) => <Input id={id} value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required />}
        </Field>
        <Field label="Description">
          {(id) => <Input id={id} value={description} onChange={(event) => setDescription(event.target.value)} maxLength={240} />}
        </Field>
        <Field label="Who can find it" hint="A public space shows up when people search for spaces.">
          {(id) => (
            <Select id={id} value={visibility} onChange={(event) => setVisibility(event.target.value as "public" | "private")}>
              <option value="private">Private: only its members</option>
              <option value="public">Public: anyone on this server</option>
            </Select>
          )}
        </Field>
        <Field label="How people join" hint="Applies to people who find a public space.">
          {(id) => (
            <Select id={id} value={joinPolicy} onChange={(event) => setJoinPolicy(event.target.value as "free" | "request")}>
              <option value="request">They ask, and an owner or moderator lets them in</option>
              <option value="free">They join straight away</option>
            </Select>
          )}
        </Field>
        {error ? <Notice>{error}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function AddMemberDialog({ api, spaceId, onClose, onDone }: { api: AdminApi; spaceId: string; onClose: () => void; onDone: (detail: SpaceDetail) => void }) {
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<"member" | "moderator">("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onDone(await api.addMember(spaceId, username.trim(), role));
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  };
  return (
    <Dialog title="Add member" onClose={onClose}>
      <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
        <Field label="Username">
          {(id) => <Input id={id} value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} required />}
        </Field>
        <Field label="Role">
          {(id) => (
            <Select id={id} value={role} onChange={(event) => setRole(event.target.value as "member" | "moderator")}>
              <option value="member">Member</option>
              <option value="moderator">Moderator</option>
            </Select>
          )}
        </Field>
        {error ? <Notice>{error}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !username.trim()}>
            {busy ? "Adding…" : "Add member"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

interface RoomDialogProps {
  title: string;
  confirmLabel: string;
  initialName?: string;
  withKind?: boolean;
  allowBlank?: boolean;
  onClose: () => void;
  onSubmit: (name: string, kind: "voice" | "text") => Promise<void>;
}

function RoomDialog({ title, confirmLabel, initialName = "", withKind, allowBlank, onClose, onSubmit }: RoomDialogProps) {
  const [name, setName] = useState(initialName);
  const [kind, setKind] = useState<"voice" | "text">("voice");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSubmit(name.trim(), kind);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  };
  return (
    <Dialog title={title} onClose={onClose}>
      <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
        {withKind ? (
          <Field label="Kind">
            {(id) => (
              <Select id={id} value={kind} onChange={(event) => setKind(event.target.value as "voice" | "text")}>
                <option value="voice">Voice room</option>
                <option value="text">Text room</option>
              </Select>
            )}
          </Field>
        ) : null}
        <Field label="Name">
          {(id) => <Input id={id} value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required={!allowBlank} placeholder={allowBlank ? "Blank uses their usual name" : undefined} />}
        </Field>
        {error ? <Notice>{error}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || (!allowBlank && !name.trim())}>
            {busy ? "Saving…" : confirmLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
