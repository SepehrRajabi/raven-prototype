import { useEffect, useMemo, useState } from "react";
import { ArrowUpDown, ChevronDown, FolderPlus, Globe2, Hand, Lock, LogIn, MoreHorizontal, Plus, Settings, UserPlus, UserRound } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { api, type TreeDetails, type TreeMember, type TreeSearchResult } from "@/lib/api";
import type { ChatStore } from "@/lib/chat/store";
import { treeCan } from "@/lib/permissions";
import { RoomDialog } from "./RoomDoor";
import { cn } from "@/lib/utils";
import { AvatarStack, EmptyState, GroupedList, LiveDot, NestGlyph, PersonAvatar, SectionLabel } from "../atoms";
import { displayNameFor, lifecycleLabel, PRESENCE, presenceFromApi, type RavenShellData, type RavenView } from "../state";
import type { RavenMediaAdapterState } from "../useRavenMediaAdapter";
import { useTreeChatSummaries } from "../useChat";
import { groupMembers, liveTreeNests, lobbyMenus, lobbySummary, peopleAround, treeSubtitleParts } from "../treeLobby";
import type { NestEntryController } from "../useNestEntry";
import { AddTreeMemberDialog, NameDialog, SpaceNameDialog, TREE_ROLE_LABEL } from "./dialogs";
import { ProfilePictureViewer } from "./ProfilePictureViewer";
import { DoorwayHeader, DoorwayPage, DoorwayRow, LiveNestCard, nestPeople, nestView, ViewBody, ViewHeader } from "./shared";
import { HouseRules } from "./HouseRules";
import { PinnedNotes, UpcomingEvents } from "./PinnedNotes";
import { useSpaceMentions } from "../useSpaceMentions";
import { activeNotes } from "@/lib/notes";
import { pinnedEvents, upcomingEvents } from "@/lib/events";
import { useNow } from "../useNow";
import { TreeNestsSection } from "./TreeNestsSection";
import { usePendingActions } from "../usePendingActions";

/** A tree's lobby answers: what is alive in this group right now? */
export function TreeLobbyView({
  details,
  data,
  media,
  entry,
  chat = null,
  onNavigate,
}: {
  details: TreeDetails;
  data: RavenShellData;
  media: RavenMediaAdapterState;
  entry: NestEntryController;
  /** Text chat, or null when the server has none. */
  chat?: ChatStore | null;
  onNavigate: (view: RavenView) => void;
}) {
  const [createTextNestOpen, setCreateTextNestOpen] = useState(false);
  const [createCategoryOpen, setCreateCategoryOpen] = useState(false);
  const [arranging, setArranging] = useState(false);
  const [renamingSelf, setRenamingSelf] = useState(false);
  const textNestCount = useTreeChatSummaries(chat).get(details.tree.id)?.count ?? 0;
  const noteMentions = useSpaceMentions(details, data, chat, onNavigate).context;
  const now = useNow();
  const notes = activeNotes(details.notes, now);
  const pinned = pinnedEvents(details.events, now);
  const upcoming = upcomingEvents(details.events, now);
  const tree = details.tree;
  const treeSingular = data.labels.treeSingular.toLowerCase();
  const nestSingular = data.labels.nestSingular.toLowerCase();
  const nestPlural = data.labels.nestPlural.toLowerCase();
  const selfMember = details.members.find((member) => member.userId === data.user?.id);
  const canManage = treeCan(details, "rooms.manage");
  const canManageMembers = treeCan(details, "members.manage");
  const [createNestOpen, setCreateNestOpen] = useState(false);
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  // Whose picture is open: this view stays mounted when moving from one tree to another.
  const [viewingPicture, setViewingPicture] = useState<string | null>(null);
  // One answer per join request at a time, so a double click cannot accept and decline.
  const requestActions = usePendingActions();
  const answering = requestActions.isPending;
  const canJoin = !entry.enteringNestId && media.phase !== "joining" && media.phase !== "leaving";

  const liveNests = liveTreeNests(details, data.activeNests);
  const quietNests = details.inactiveNests;
  const memberIds = useMemo(() => new Set(details.members.filter((member) => member.state === "joined").map((member) => member.userId)), [details.members]);
  const members = details.members;
  const menus = lobbyMenus({ canRooms: canManage, canMembers: canManageMembers, hasChat: Boolean(chat) });
  const peopleInside = data.activeNests.filter((nest) => nest.treeId === tree.id).reduce((sum, nest) => sum + nest.activeParticipantCount, 0);
  const subtitle = treeSubtitleParts({ visibility: tree.visibility, members: members.length, inside: peopleInside, nestSingular });
  const summaryNests = liveNests.map((nest) => ({ id: nest.id, name: nest.name, people: nestPeople(nest, data) }));
  const insideIds = new Set(summaryNests.flatMap((nest) => nest.people.map((person) => person.id)));
  const summary = { nests: summaryNests, ...lobbySummary({ nests: summaryNests, selfId: data.user?.id, activeNestId: media.activeNestId, around: peopleAround(members, data.user?.id, insideIds) }) };
  const summaryNest = summary.nestId ? liveNests.find((nest) => nest.id === summary.nestId) : undefined;
  const summaryPeople = summary.kind === "here" || summary.kind === "live" ? (summary.nestId ? summary.nests.find((nest) => nest.id === summary.nestId)?.people : summary.nests.flatMap((nest) => nest.people)) ?? [] : [];
  const hasNests = liveNests.length > 0 || quietNests.length > 0 || textNestCount > 0;
  const setup = [
    canManage ? "voice" : null,
    canManage && chat ? "text" : null,
    canManageMembers ? "invite" : null,
  ].filter((row): row is "voice" | "text" | "invite" => row !== null);
  const membersList = <MembersList members={members} selfId={data.user?.id} data={data} onNavigate={onNavigate} onRenameSelf={() => setRenamingSelf(true)} />;

  return (
    <>
      {viewingPicture === tree.id ? <ProfilePictureViewer src={api.treeAvatarUrl(tree.id, tree.updatedAt)} alt={`${tree.name}’s picture`} onClose={() => setViewingPicture(null)} /> : null}
      <ViewHeader
        leading={<Avatar name={tree.name} src={api.treeAvatarUrl(tree.id, tree.updatedAt)} className="h-9 w-9 rounded-control" onOpen={() => setViewingPicture(tree.id)} />}
        title={tree.name}
        subtitle={
          <span className="inline-flex items-center gap-1.5">
            {tree.visibility === "public" ? <Globe2 className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
            {subtitle.visibility}
            <span aria-hidden>·</span>
            <span className="hidden min-[1100px]:inline">{subtitle.members}</span>
            {/* The members column needs a wide window; below that the count opens the same list. */}
            <Popover>
              <PopoverTrigger asChild>
                <button type="button" className="rounded-chip underline-offset-4 transition-colors hover:text-foreground hover:underline min-[1100px]:hidden">
                  {subtitle.members}
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="max-h-[60vh] w-72 overflow-y-auto p-2">
                {membersList}
              </PopoverContent>
            </Popover>
            {subtitle.inside ? (
              <>
                <span aria-hidden>·</span>
                {subtitle.inside}
              </>
            ) : null}
          </span>
        }
        actions={
          <>
            {menus.create.length > 1 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="secondary" className="gap-1.5 pl-3 pr-2.5">
                    <Plus className="h-4 w-4" />
                    New
                    <ChevronDown className="h-4 w-4 opacity-70" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setCreateNestOpen(true)}>
                    <NestGlyph kind="voice" className="text-muted-foreground" />
                    Voice {nestSingular}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setCreateTextNestOpen(true)}>
                    <NestGlyph kind="text" className="text-muted-foreground" />
                    Text {nestSingular}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setCreateCategoryOpen(true)}>
                    <FolderPlus className="text-muted-foreground" />
                    Category
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : menus.create.length === 1 ? (
              <Button variant="secondary" onClick={() => setCreateNestOpen(true)}>
                <Plus className="h-4 w-4" />
                New {nestSingular}
              </Button>
            ) : null}
            {menus.more.length || selfMember ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon-sm" variant="ghost" aria-label={`More for ${tree.name}`}>
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {menus.more.includes("arrange") ? (
                    <DropdownMenuItem onSelect={() => setArranging(true)}>
                      <ArrowUpDown className="text-muted-foreground" />
                      Arrange {nestPlural}
                    </DropdownMenuItem>
                  ) : null}
                  {menus.more.includes("addPerson") ? (
                    <DropdownMenuItem onSelect={() => setAddMemberOpen(true)}>
                      <UserPlus className="text-muted-foreground" />
                      Add a person
                    </DropdownMenuItem>
                  ) : null}
                  {selfMember ? (
                    <DropdownMenuItem onSelect={() => setRenamingSelf(true)}>
                      <UserRound className="text-muted-foreground" />
                      Your name in {tree.name}
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => onNavigate({ kind: "tree-settings", id: tree.id })}>
                    <Settings className="text-muted-foreground" />
                    {data.labels.treeSingular} settings
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button size="icon-sm" variant="ghost" aria-label={`${data.labels.treeSingular} settings`} onClick={() => onNavigate({ kind: "tree-settings", id: tree.id })}>
                <Settings className="h-4 w-4" />
              </Button>
            )}
          </>
        }
      />
      <ViewBody>
        <div className="grid max-w-5xl gap-8 min-[1100px]:grid-cols-[minmax(0,1fr)_264px]">
          <div className="min-w-0 space-y-8">
            {notes.length || pinned.length || upcoming.length ? (
              <div className="space-y-2">
                <PinnedNotes notes={notes} events={pinned} mentions={noteMentions} />
                <UpcomingEvents events={upcoming} mentions={noteMentions} />
              </div>
            ) : null}
            <div className="flex items-center gap-3">
              {summary.kind === "live" || summary.kind === "here" ? <LiveDot /> : null}
              {summaryPeople.length ? <AvatarStack people={summaryPeople} max={4} size="md" surface="card" /> : null}
              <p role="status" className="min-w-0 flex-1 text-body">{summary.text}</p>
              {summaryNest && summary.kind === "here" ? (
                <Button size="sm" variant="secondary" onClick={() => onNavigate(nestView(summaryNest))}>Return</Button>
              ) : summaryNest && summary.kind === "live" ? (
                <Button size="sm" disabled={!canJoin} onClick={() => onNavigate(nestView(summaryNest))}>Join {summaryNest.name}…</Button>
              ) : null}
            </div>
            {tree.description ? <p className="max-w-prose text-small text-muted-foreground">{tree.description}</p> : null}
            {/* The right column needs a wide window; below that the rules stay in this column. */}
            <HouseRules rules={details.rules ?? []} className="min-[1100px]:hidden" />
            {canManageMembers && details.joinRequests.length ? (
              <section>
                <SectionLabel className="mb-1">Asking to join</SectionLabel>
                <GroupedList>
                  {details.joinRequests.map((request) => {
                    const name = request.displayName || request.username;
                    return (
                      <div key={request.id} className="flex items-center gap-3 px-3 py-2.5">
                        <button type="button" onClick={() => onNavigate({ kind: "user", id: request.userId })} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                          <PersonAvatar id={request.userId} name={name} className="h-8 w-8" />
                          <span className="min-w-0 truncate text-small font-medium">{name}</span>
                        </button>
                        <Button size="sm" variant="secondary" disabled={answering(request.id)} onClick={() => requestActions.run(request.id, () => data.acceptTreeJoinRequest(tree.id, request.id))}>Accept</Button>
                        <Button size="sm" variant="ghost" disabled={answering(request.id)} onClick={() => requestActions.run(request.id, () => data.rejectTreeJoinRequest(tree.id, request.id))}>Decline</Button>
                      </div>
                    );
                  })}
                </GroupedList>
              </section>
            ) : null}

            {/* With text chat the nests list below shows live rooms in place; without it this is the only place. */}
            {liveNests.length && !chat ? (
              <section>
                <SectionLabel className="mb-1">Live now</SectionLabel>
                <div className="grid gap-3 sm:grid-cols-2">
                  {liveNests.map((nest) => (
                    <LiveNestCard
                      key={nest.id}
                      nest={nest}
                      data={data}
                      showTree={false}
                      here={media.activeNestId === nest.id}
                      canJoin={canJoin}
                      joinVariant="secondary"
                      onOpen={() => onNavigate(nestView(nest))}
                    />
                  ))}
                </div>
              </section>
            ) : null}

            {chat ? (
              <TreeNestsSection
                details={details}
                data={data}
                media={media}
                chat={chat}
                canManage={canManage}
                canJoin={canJoin}
                arranging={arranging}
                onArrangingChange={setArranging}
                onNavigate={onNavigate}
              />
            ) : quietNests.length ? (
              <section>
                <SectionLabel className="mb-1">{data.labels.nestPlural}</SectionLabel>
                <GroupedList>
                  {quietNests.map((nest) => {
                    const state = lifecycleLabel(nest);
                    return (
                      <button
                        key={nest.id}
                        type="button"
                        onClick={() => onNavigate(nestView(nest))}
                        className="group flex h-11 w-full items-center gap-3 px-3.5 text-left transition-colors hover:bg-secondary"
                      >
                        <NestGlyph kind="voice" className="text-subtle" />
                        <span className="min-w-0 flex-1 truncate text-body">{nest.name}</span>
                        {state !== "Empty" && state !== "Created" ? <span className="shrink-0 text-caption text-muted-foreground">{state}</span> : null}
                      </button>
                    );
                  })}
                </GroupedList>
              </section>
            ) : null}

            {!hasNests && setup.length ? (
              <section>
                <SectionLabel className="mb-1">Get {tree.name} going</SectionLabel>
                <GroupedList>
                  {setup.includes("invite") ? (
                    <DoorwayRow
                      icon={<UserPlus />}
                      label="Invite people"
                      value={members.length > 1 ? `${members.length} people are here.` : `You are the only one here.`}
                      control={<Button size="xs" variant="secondary" onClick={() => setAddMemberOpen(true)}>Add a person</Button>}
                    />
                  ) : null}
                  {setup.includes("voice") ? (
                    <DoorwayRow
                      icon={<NestGlyph kind="voice" />}
                      label={`Add a voice ${nestSingular}`}
                      value={`A room people in this ${treeSingular} can drop into.`}
                      control={<Button size="xs" variant="secondary" onClick={() => setCreateNestOpen(true)}>Add</Button>}
                    />
                  ) : null}
                  {setup.includes("text") ? (
                    <DoorwayRow
                      icon={<NestGlyph kind="text" />}
                      label={`Add a text ${nestSingular}`}
                      value="A place to write, for everyone here."
                      control={<Button size="xs" variant="secondary" onClick={() => setCreateTextNestOpen(true)}>Add</Button>}
                    />
                  ) : null}
                </GroupedList>
              </section>
            ) : null}

            {!hasNests && !setup.length ? (
              <EmptyState title={`No ${nestPlural} yet`} text={`An owner or moderator can add the first ${nestSingular}.`} />
            ) : null}
          </div>

          <aside className="hidden min-w-0 space-y-6 min-[1100px]:block">
            {membersList}
            <HouseRules rules={details.rules ?? []} />
          </aside>
        </div>
      </ViewBody>

      <RoomDialog
        open={createNestOpen}
        onOpenChange={setCreateNestOpen}
        title={`New ${nestSingular}`}
        description={`Everyone in ${tree.name} will be able to see it and join.`}
        placeholder="Lounge"
        submitLabel={`Create ${nestSingular}`}
        onSubmit={async (name, door) => {
          const nest = await data.createTreeNest(tree.id, name, door);
          setCreateNestOpen(false);
          onNavigate({ kind: "nest", id: nest.id });
        }}
      />
      {chat ? (
        <>
          <NameDialog
            open={createTextNestOpen}
            onOpenChange={setCreateTextNestOpen}
            title={`New text ${nestSingular}`}
            description={`A place to write. Everyone in ${tree.name} can read it and write in it.`}
            label="Name"
            placeholder="general"
            submitLabel={`Create text ${nestSingular}`}
            onSubmit={async (name) => {
              const conversation = await chat.createTextNest(tree.id, name);
              setCreateTextNestOpen(false);
              onNavigate({ kind: "chat", id: conversation.id });
            }}
          />
          <NameDialog
            open={createCategoryOpen}
            onOpenChange={setCreateCategoryOpen}
            title="New category"
            description={`A heading to group ${nestPlural} under. Use Arrange to move them into it.`}
            label="Name"
            placeholder="Projects"
            submitLabel="Create category"
            onSubmit={async (name) => {
              await chat.createCategory(tree.id, name);
              setCreateCategoryOpen(false);
            }}
          />
        </>
      ) : null}
      <SpaceNameDialog
        member={renamingSelf ? selfMember ?? null : null}
        isSelf
        treeName={tree.name}
        onClose={() => setRenamingSelf(false)}
        onSave={async (name) => {
          if (!data.user) return;
          await data.updateTreeMemberName(tree.id, data.user.id, name);
          setRenamingSelf(false);
        }}
      />
      <AddTreeMemberDialog
        open={addMemberOpen}
        onOpenChange={setAddMemberOpen}
        title={`Add a person to ${tree.name}`}
        canAssignRoles={treeCan(details, "roles.assign")}
        friends={data.friends}
        memberIds={memberIds}
        onAdd={async (username, role) => {
          await data.addTreeMember(tree.id, username, role);
          setAddMemberOpen(false);
        }}
      />
    </>
  );
}

/** Members as the lobby shows them: who is in a nest and who is around. */
function MembersList({ members, selfId, data, onNavigate, onRenameSelf }: { members: TreeMember[]; selfId?: string; data: RavenShellData; onNavigate: (view: RavenView) => void; onRenameSelf: () => void }) {
  // The member list can say you are offline while you are looking at it; your own status is what the dock shows.
  const groups = useMemo(
    () => groupMembers(members.map((member) => (member.userId === selfId && data.presence ? { ...member, presenceState: data.presence.state, reachability: data.presence.reachability } : member))),
    [members, selfId, data.presence],
  );
  const row = (member: TreeMember) => (
    <MemberRow
      key={member.userId}
      member={member}
      isSelf={member.userId === selfId}
      nestName={member.activeNestId ? data.getNest(member.activeNestId)?.name : undefined}
      onOpen={member.userId === selfId ? onRenameSelf : () => onNavigate({ kind: "user", id: member.userId })}
    />
  );
  return (
    <div className="space-y-4">
      {groups.here.length ? (
        <section>
          <SectionLabel className="mb-1 px-2">Here now · {groups.here.length}</SectionLabel>
          <div className="space-y-px">{groups.here.map(row)}</div>
        </section>
      ) : null}
      {groups.around.length ? (
        <section>
          <SectionLabel className="mb-1 px-2">Around · {groups.around.length}</SectionLabel>
          <div className="space-y-px">{groups.around.map(row)}</div>
        </section>
      ) : null}
    </div>
  );
}

function MemberRow({
  member,
  isSelf,
  nestName,
  onOpen,
}: {
  member: TreeMember;
  isSelf: boolean;
  nestName?: string;
  onOpen: () => void;
}) {
  const presence = presenceFromApi({ state: member.presenceState, reachability: member.reachability });
  const away = presence === "offline" || presence === "invisible";
  const status = away ? null : nestName ? `In ${nestName}` : presence === "around" ? null : PRESENCE[presence].label;
  const tags = isSelf
    ? `You · ${member.nickname ? TREE_ROLE_LABEL[member.role] : "Set your name here"}`
    : member.role !== "member" ? TREE_ROLE_LABEL[member.role] : "";
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex min-h-10 w-full items-center gap-2.5 rounded-control px-2 py-1 text-left transition-colors hover:bg-secondary"
    >
      <PersonAvatar id={member.userId} name={displayNameFor(member)} presence={presence} className={cn("h-7 w-7", away && "opacity-60")} />
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-small", away ? "text-muted-foreground" : "text-foreground")}>{displayNameFor(member)}</span>
        {status || tags ? <span className="block truncate text-caption text-muted-foreground">{[status, tags].filter(Boolean).join(" · ")}</span> : null}
      </span>
    </button>
  );
}

/** A public tree you have found but not joined yet. */
export function PublicTreePreviewView({
  initialResult,
  data,
  onNavigate,
}: {
  initialResult: TreeSearchResult;
  data: RavenShellData;
  onNavigate: (view: RavenView) => void;
}) {
  const [result, setResult] = useState(initialResult);
  const [working, setWorking] = useState(false);
  const treeLabel = data.labels.treeSingular.toLowerCase();
  const joined = result.accessState === "joined";
  const pending = result.accessState === "pending";
  const free = result.tree.joinPolicy === "free";

  useEffect(() => {
    setResult(initialResult);
  }, [initialResult]);

  const act = async () => {
    setWorking(true);
    try {
      if (joined) {
        await data.refresh();
        onNavigate({ kind: "tree", id: result.tree.id });
        return;
      }
      const status = await data.joinTree(result.tree.id);
      if (status === "joined") onNavigate({ kind: "tree", id: result.tree.id });
      else setResult((current) => ({ ...current, accessState: "pending" }));
    } catch {
      // Reported by the shell.
    } finally {
      setWorking(false);
    }
  };

  return (
    <DoorwayPage>
      <DoorwayHeader
        leading={<Avatar name={result.tree.name} src={api.treeAvatarUrl(result.tree.id, result.tree.updatedAt)} className="h-16 w-16 shrink-0 rounded-card text-title" />}
        context={`Public ${treeLabel}`}
        title={result.tree.name}
      />
      {result.tree.description ? <p className="mt-4 text-body text-muted-foreground">{result.tree.description}</p> : null}
      {pending ? null : (
        <div className="mt-6 flex">
          <Button size="lg" className="flex-1" disabled={working} onClick={() => void act()}>
            {joined || free ? <LogIn className="h-4 w-4" /> : <Hand className="h-4 w-4" />}
            {joined ? `Open ${treeLabel}` : free ? `Join ${treeLabel}` : "Ask to join"}
          </Button>
        </div>
      )}
      <p role="status" className={cn(pending ? "mt-6 text-small text-muted-foreground" : "mt-3 text-caption text-subtle")}>
        {pending
          ? "Your request was sent. An owner or moderator will let you in."
          : free
            ? "Anyone on this server can join. Members will see that you joined."
            : "Joining needs approval from an owner or moderator."}
      </p>
    </DoorwayPage>
  );
}
