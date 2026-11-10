import type { ChatStore } from "@/lib/chat/store";
import { useEffect, useMemo, useState } from "react";
import { ClipboardList, Info, MoreHorizontal, Shield, Sticker, Trash2, Users } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input, Textarea } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SquareImageUpload } from "@/components/SquareImageUpload";
import { api, type TreeDetails, type TreeJoinPolicy, type TreeMember, type TreeRole, type TreeVisibility } from "@/lib/api";
import { treeCan, treeOutranks } from "@/lib/permissions";
import { PersonAvatar } from "../atoms";
import {
  SettingsChoice,
  SettingsField,
  SettingsHint,
  SettingsNav,
  SettingsPage,
  SettingsRows,
  SettingsSection,
  SettingsToggleRow,
  type SettingsCategoryGroup,
} from "../SettingsScaffold";
import { displayNameFor, type RavenShellData, type RavenView } from "../state";
import { BoardSettings } from "./BoardSettings";
import { LibraryManager } from "@/components/library/LibraryManager";
import { libraryCapabilities } from "@/lib/library/types";
import { failureText } from "@/lib/chat/errors";
import { toast } from "@/components/ui/toast";
import { SpaceNameDialog, TREE_ROLE_LABEL } from "./dialogs";

export type TreeSettingsSection = "general" | "access" | "members" | "board" | "library" | "delete";

// Everyone in a tree can open its settings to see who is in it and to leave. What else
// they find there is what their role allows.
export function resolveTreeSettingsSection(section: string | undefined, details: TreeDetails, _data: RavenShellData): TreeSettingsSection {
  const canEdit = treeCan(details, "settings.edit");
  if (section === "members") return section;
  if (section === "board" && treeCan(details, "board.manage")) return section;
  if (section === "library" && showsLibrary(details, _data)) return section;
  if ((section === "access" || section === "general") && canEdit) return section;
  if (section === "delete" && treeCan(details, "space.delete")) return section;
  return canEdit ? "general" : "members";
}

/** GIFs and stickers: for whoever manages the set or the space's settings, on a server that has them. */
function showsLibrary(details: TreeDetails, data: RavenShellData): boolean {
  if (!libraryCapabilities(data.serverProperties.properties)) return false;
  return treeCan(details, "stickers.manage") || (treeCan(details, "settings.edit") && Boolean(details.library));
}

export function TreeSettingsNav({
  details,
  data,
  section,
  onSelect,
  onBack,
}: {
  details: TreeDetails;
  data: RavenShellData;
  section: TreeSettingsSection;
  onSelect: (section: TreeSettingsSection) => void;
  onBack: () => void;
}) {
  const treeLabel = data.labels.treeSingular.toLowerCase();
  const groups: SettingsCategoryGroup[] = [
    {
      categories: [
        ...(treeCan(details, "settings.edit")
          ? [
              { id: "general", label: "General", icon: <Info /> },
              { id: "access", label: "Who can join", icon: <Shield /> },
            ]
          : []),
        { id: "members", label: "Members", icon: <Users /> },
        ...(treeCan(details, "board.manage") ? [{ id: "board", label: "Board", icon: <ClipboardList /> }] : []),
        ...(showsLibrary(details, data) ? [{ id: "library", label: "GIFs and stickers", icon: <Sticker /> }] : []),
      ],
    },
    ...(treeCan(details, "space.delete")
      ? [{ categories: [{ id: "delete", label: `Delete ${treeLabel}`, icon: <Trash2 /> }] }]
      : []),
  ];
  return (
    <SettingsNav
      title={details.tree.name}
      backLabel={`Back to ${treeLabel}`}
      onBack={onBack}
      groups={groups}
      activeId={section}
      onSelect={(id) => onSelect(id as TreeSettingsSection)}
    />
  );
}

export function TreeSettingsView({
  details,
  section,
  data,
  chat,
  onNavigate,
}: {
  details: TreeDetails;
  section: TreeSettingsSection;
  data: RavenShellData;
  chat?: ChatStore | null;
  onNavigate: (view: RavenView) => void;
}) {
  if (section === "access") return <AccessSettings details={details} data={data} />;
  if (section === "board") return <BoardSettings details={details} data={data} chat={chat} />;
  if (section === "library") return <SpaceLibrarySettings details={details} data={data} />;
  if (section === "members") return <MemberSettings details={details} data={data} onNavigate={onNavigate} />;
  if (section === "delete") return <DeleteSettings details={details} data={data} onNavigate={onNavigate} />;
  return <GeneralSettings details={details} data={data} />;
}

function GeneralSettings({ details, data }: { details: TreeDetails; data: RavenShellData }) {
  const tree = details.tree;
  const treeLabel = data.labels.treeSingular.toLowerCase();
  const [name, setName] = useState(tree.name);
  const [description, setDescription] = useState(tree.description);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setName(tree.name);
    setDescription(tree.description);
  }, [tree.id, tree.name, tree.description]);

  const dirty = name.trim() !== tree.name || description.trim() !== tree.description;

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await data.updateTreeSettings(tree.id, { name: name.trim(), description: description.trim(), joinPolicy: tree.joinPolicy, visibility: tree.visibility });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Your changes could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const uploadAvatar = async (file: File) => {
    setUploading(true);
    setError("");
    try {
      await api.uploadTreeAvatar(tree.id, file);
      await data.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The picture could not be uploaded.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <SettingsPage title="General" description={`What people see for this ${treeLabel}.`}>
      <SettingsSection title="Picture, name and description">
        <div className="flex items-center gap-4">
          <Avatar name={tree.name} src={api.treeAvatarUrl(tree.id, tree.updatedAt)} className="h-16 w-16 rounded-card text-title" />
          <SquareImageUpload disabled={uploading} label={uploading ? "Uploading…" : "Choose a picture"} onUpload={uploadAvatar} onError={setError} />
        </div>
        <SettingsField label="Name">
          <Input value={name} maxLength={80} onChange={(event) => { setName(event.currentTarget.value); setSaved(false); }} />
        </SettingsField>
        <SettingsField label="Description" hint="One or two lines people read before they join.">
          <Textarea value={description} rows={3} maxLength={240} onChange={(event) => { setDescription(event.currentTarget.value); setSaved(false); }} />
        </SettingsField>
        {error ? <p role="alert" className="text-small text-destructive">{error}</p> : null}
        <div className="flex items-center gap-3">
          <Button disabled={!dirty || !name.trim() || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save changes"}</Button>
          {saved && !dirty ? <span className="text-small text-muted-foreground">Saved.</span> : null}
        </div>
      </SettingsSection>
    </SettingsPage>
  );
}

function AccessSettings({ details, data }: { details: TreeDetails; data: RavenShellData }) {
  const tree = details.tree;
  const treeLabel = data.labels.treeSingular.toLowerCase();
  const [visibility, setVisibility] = useState<TreeVisibility>(tree.visibility);
  const [joinPolicy, setJoinPolicy] = useState<TreeJoinPolicy>(tree.joinPolicy);
  const [error, setError] = useState("");

  useEffect(() => {
    setVisibility(tree.visibility);
    setJoinPolicy(tree.joinPolicy);
  }, [tree.id, tree.visibility, tree.joinPolicy]);

  const apply = (next: { visibility?: TreeVisibility; joinPolicy?: TreeJoinPolicy }) => {
    const nextVisibility = next.visibility ?? visibility;
    const nextPolicy = next.joinPolicy ?? joinPolicy;
    setVisibility(nextVisibility);
    setJoinPolicy(nextPolicy);
    setError("");
    void data
      .updateTreeSettings(tree.id, { name: tree.name, description: tree.description, visibility: nextVisibility, joinPolicy: nextPolicy })
      .catch((err) => {
        setVisibility(tree.visibility);
        setJoinPolicy(tree.joinPolicy);
        setError(err instanceof Error ? err.message : "That change could not be saved.");
      });
  };

  return (
    <SettingsPage title="Who can join" description="Changes apply straight away.">
      <SettingsSection title="Finding it">
        <SettingsRows>
          <SettingsChoice
            title="Private"
            copy="Hidden from search. People get in only when the owner or a moderator adds them."
            selected={visibility === "private"}
            onSelect={() => apply({ visibility: "private" })}
          />
          <SettingsChoice
            title="Public"
            copy={`Anyone on this server can find this ${treeLabel} in search and see its name and description.`}
            selected={visibility === "public"}
            onSelect={() => apply({ visibility: "public" })}
          />
        </SettingsRows>
      </SettingsSection>
      <SettingsSection title="Joining" description={`For people who find this ${treeLabel} in search.`}>
        <SettingsRows>
          <SettingsChoice
            title="Ask first"
            copy="People send a request. The owner or a moderator lets them in."
            selected={joinPolicy === "request"}
            onSelect={() => apply({ joinPolicy: "request" })}
          />
          <SettingsChoice
            title="Anyone can join"
            copy="People who find it join immediately, with no approval."
            selected={joinPolicy === "free"}
            onSelect={() => apply({ joinPolicy: "free" })}
          />
        </SettingsRows>
        {error ? <p role="alert" className="text-small text-destructive">{error}</p> : null}
      </SettingsSection>
    </SettingsPage>
  );
}

function MemberSettings({ details, data, onNavigate }: { details: TreeDetails; data: RavenShellData; onNavigate: (view: RavenView) => void }) {
  const tree = details.tree;
  const treeLabel = data.labels.treeSingular.toLowerCase();
  const nestsLabel = data.labels.nestPlural.toLowerCase();
  const canAssignRoles = treeCan(details, "roles.assign");
  const canTransfer = treeCan(details, "ownership.transfer");
  const canLeave = treeCan(details, "leave");
  const isOwner = details.viewer?.role === "owner";
  const [removing, setRemoving] = useState<TreeMember | null>(null);
  const [renaming, setRenaming] = useState<TreeMember | null>(null);
  const [transferring, setTransferring] = useState<TreeMember | null>(null);
  const [leaving, setLeaving] = useState(false);
  const members = [...details.members].sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || displayNameFor(a).localeCompare(displayNameFor(b)));
  const run = (action: Promise<unknown>) => void action.catch(() => undefined);

  return (
    <SettingsPage title="Members" description={`${members.length} ${members.length === 1 ? "person" : "people"} in this ${treeLabel}.`}>
      <SettingsSection title="People">
        <SettingsRows>
          {members.map((member) => {
            const isSelf = member.userId === data.user?.id;
            const name = displayNameFor(member);
            const canChangeRole = canAssignRoles && member.role !== "owner";
            const canRemove = !isSelf && treeCan(details, "members.remove") && treeOutranks(details, member.role);
            const canMakeOwner = canTransfer && !isSelf;
            const canRename = isSelf || (treeCan(details, "members.rename") && treeOutranks(details, member.role));
            return (
              <div key={member.userId} className="flex items-center gap-3 px-4 py-2.5">
                <button type="button" onClick={() => onNavigate({ kind: "user", id: member.userId })} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                  <PersonAvatar id={member.userId} name={name} className="h-8 w-8" />
                  <span className="min-w-0">
                    <span className="block truncate text-body">{name}{isSelf ? " (you)" : ""}</span>
                    <span className="block truncate text-caption text-muted-foreground">@{member.username}</span>
                  </span>
                </button>
                {canChangeRole ? (
                  <Select value={member.role} onValueChange={(value) => run(data.updateTreeMemberRole(tree.id, member.userId, value as TreeRole))}>
                    <SelectTrigger size="sm" className="w-[132px]" aria-label={`Role for ${name}`}>
                      <SelectValue>{TREE_ROLE_LABEL[member.role]}</SelectValue>
                    </SelectTrigger>
                    <SelectContent align="end">
                      <SelectGroup>
                        <SelectItem value="member">Member</SelectItem>
                        <SelectItem value="moderator">Moderator</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                ) : (
                  <span className="shrink-0 text-small text-muted-foreground">{TREE_ROLE_LABEL[member.role]}</span>
                )}
                {canRename || canRemove || canMakeOwner ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="icon-sm" variant="ghost" aria-label={`More for ${name}`}>
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {canRename ? <DropdownMenuItem onSelect={() => setRenaming(member)}>{isSelf ? "Set your name here…" : "Set name here…"}</DropdownMenuItem> : null}
                      {canMakeOwner ? <DropdownMenuItem onSelect={() => setTransferring(member)}>Make owner…</DropdownMenuItem> : null}
                      {canRemove ? <DropdownMenuItem onSelect={() => setRemoving(member)}>Remove from {treeLabel}…</DropdownMenuItem> : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </div>
            );
          })}
        </SettingsRows>
        <SettingsHint>
          A {treeLabel} has one owner, who changes its settings and roles. Moderators add and remove members and look after its {nestsLabel}.
        </SettingsHint>
      </SettingsSection>

      <SettingsSection
        title={`Leave ${treeLabel}`}
        description={
          isOwner
            ? `You own this ${treeLabel}. Make someone else its owner before you leave, or delete it.`
            : `You lose this ${treeLabel} and its ${nestsLabel} until someone adds you again.`
        }
      >
        <div>
          <Button variant="secondary" disabled={!canLeave} onClick={() => setLeaving(true)}>Leave {tree.name}</Button>
        </div>
      </SettingsSection>

      <SpaceNameDialog
        member={renaming}
        isSelf={renaming?.userId === data.user?.id}
        treeName={tree.name}
        onClose={() => setRenaming(null)}
        onSave={async (name) => {
          if (!renaming) return;
          await data.updateTreeMemberName(tree.id, renaming.userId, name);
          setRenaming(null);
        }}
      />
      <ConfirmDialog
        open={removing != null}
        onOpenChange={(open) => { if (!open) setRemoving(null); }}
        title={`Remove ${removing ? displayNameFor(removing) : ""} from ${tree.name}?`}
        description={`They lose this ${treeLabel} and its ${nestsLabel} straight away, including a call they are in, until someone adds them again.`}
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          if (!removing) return;
          await data.removeTreeMember(tree.id, removing.userId).catch(() => undefined);
          setRemoving(null);
        }}
      />
      <ConfirmDialog
        open={transferring != null}
        onOpenChange={(open) => { if (!open) setTransferring(null); }}
        title={`Make ${transferring ? displayNameFor(transferring) : ""} the owner of ${tree.name}?`}
        description="They will decide its settings and roles and can delete it. You stay as a moderator. Only they can give it back."
        confirmLabel="Make owner"
        onConfirm={async () => {
          if (!transferring) return;
          await data.transferTreeOwnership(tree.id, transferring.userId).catch(() => undefined);
          setTransferring(null);
        }}
      />
      <ConfirmDialog
        open={leaving}
        onOpenChange={setLeaving}
        title={`Leave ${tree.name}?`}
        description={`You lose this ${treeLabel} and its ${nestsLabel} until someone adds you again.`}
        confirmLabel="Leave"
        destructive
        onConfirm={async () => {
          try {
            await data.leaveTree(tree.id);
            setLeaving(false);
            onNavigate({ kind: "home" });
          } catch {
            // The shell has already said why; stay here.
            setLeaving(false);
          }
        }}
      />
    </SettingsPage>
  );
}

const ROLE_ORDER: Record<TreeRole, number> = { owner: 0, moderator: 1, member: 2 };

function DeleteSettings({ details, data, onNavigate }: { details: TreeDetails; data: RavenShellData; onNavigate: (view: RavenView) => void }) {
  const tree = details.tree;
  const treeLabel = data.labels.treeSingular.toLowerCase();
  const [confirmation, setConfirmation] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  const remove = async () => {
    setDeleting(true);
    setError("");
    try {
      await data.deleteTree(tree.id, confirmation.trim());
      onNavigate({ kind: "home" });
    } catch (err) {
      setError(err instanceof Error ? err.message : `The ${treeLabel} could not be deleted.`);
      setDeleting(false);
    }
  };

  return (
    <SettingsPage title={`Delete ${treeLabel}`}>
      <SettingsSection
        title="This cannot be undone"
        description={`Deleting ${tree.name} removes it for all ${details.members.length} ${details.members.length === 1 ? "member" : "members"}, along with every ${data.labels.nestSingular.toLowerCase()} in it.`}
      >
        <SettingsField label={`Type ${tree.name} to confirm`}>
          <Input value={confirmation} onChange={(event) => setConfirmation(event.currentTarget.value)} placeholder={tree.name} />
        </SettingsField>
        {error ? <p role="alert" className="text-small text-destructive">{error}</p> : null}
        <Button variant="destructive" disabled={deleting || confirmation.trim() !== tree.name} onClick={() => void remove()}>
          <Trash2 className="h-4 w-4" />
          {deleting ? "Deleting…" : `Delete ${treeLabel}`}
        </Button>
      </SettingsSection>
    </SettingsPage>
  );
}

function SpaceLibrarySettings({ details, data }: { details: TreeDetails; data: RavenShellData }) {
  const tree = details.tree;
  const capabilities = useMemo(() => libraryCapabilities(data.serverProperties.properties), [data.serverProperties.properties]);
  const owner = useMemo(() => ({ scope: "tree" as const, treeId: tree.id }), [tree.id]);
  const stored = details.library?.savedStickersPublishable ?? false;
  const [publishable, setPublishable] = useState(stored);
  const [saving, setSaving] = useState(false);
  useEffect(() => setPublishable(stored), [stored]);

  const change = (next: boolean) => {
    setPublishable(next);
    setSaving(true);
    data
      .updateTreeSettings(tree.id, { name: tree.name, description: tree.description, joinPolicy: tree.joinPolicy, visibility: tree.visibility, savedStickersPublishable: next })
      .catch((failure: unknown) => {
        setPublishable(stored);
        toast({ title: failureText(failure, "Couldn’t save that setting."), tone: "error" });
      })
      .finally(() => setSaving(false));
  };

  return (
    <SettingsPage title="GIFs and stickers" description={`This ${data.labels.treeSingular.toLowerCase()}’s own set, which everyone in it can send.`}>
      {treeCan(details, "settings.edit") && details.library ? (
        <SettingsToggleRow
          label="Saved copies can be made public"
          description="When on, someone who saves one of these to their library may share it with the whole server."
          checked={publishable}
          disabled={saving}
          onChange={change}
        />
      ) : null}
      {treeCan(details, "stickers.manage") && capabilities ? <LibraryManager owner={owner} capabilities={capabilities} /> : null}
    </SettingsPage>
  );
}
