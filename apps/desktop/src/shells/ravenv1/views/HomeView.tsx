import { useMemo, useState } from "react";
import { capabilitiesOf } from "@/lib/permissions";
import { AtSign, Hand, Plus, Search } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { ConversationRow, UnreadDot } from "@/components/chat/ConversationRow";
import { api } from "@/lib/api";
import type { ChatStore } from "@/lib/chat/store";
import { useProfileKnock } from "../useProfileKnock";
import { GroupedList, LiveDot, NestGlyph, PersonAvatar, SectionLabel } from "../atoms";
import { PendingList } from "../Inbox";
import { orderTrees, unreadConversations } from "../home";
import { readLastVisited } from "../lastVisited";
import { personStatus, reachRank } from "../people";
import { PRESENCE, type RavenShellData, type RavenView, type ShellPerson } from "../state";
import { focusGlobalSearch } from "../searchFocus";
import { usePendingActions } from "../usePendingActions";
import { useChatState, useTreeChatSummaries } from "../useChat";
import type { RavenMediaAdapterState } from "../useRavenMediaAdapter";
import type { NestEntryController } from "../useNestEntry";
import { NameDialog } from "./dialogs";
import { DoorwayRow, LiveNestCard, namesSentence, nestPeople, nestView, treeNameFor } from "./shared";

/**
 * Home is the person's places: what is waiting for them, what is alive, and a door to each
 * of their trees. Sections appear only when they have something, so it is never a dead end.
 */
export function HomeView({
  data,
  media,
  entry,
  chat = null,
  onNavigate,
}: {
  data: RavenShellData;
  media: RavenMediaAdapterState;
  entry: NestEntryController;
  /** Text chat, or null when the server has none. */
  chat?: ChatStore | null;
  onNavigate: (view: RavenView) => void;
}) {
  const [createTreeOpen, setCreateTreeOpen] = useState(false);
  const actions = usePendingActions();
  const treeSingular = data.labels.treeSingular.toLowerCase();
  const nestSingular = data.labels.nestSingular.toLowerCase();
  const canCreate = capabilitiesOf(data.user).createSpaces;
  const liveNests = data.activeNests.filter((nest) => nest.lifecycleState === "active" || nest.activeParticipantCount > 0);
  // People already in a nest are represented by that nest's card.
  const openPeople = data.people
    .filter((person) => person.presence === "open" && person.activeNestIds.length === 0)
    .sort((a, b) => reachRank(a) - reachRank(b) || a.name.localeCompare(b.name));
  const canJoin = !entry.enteringNestId && media.phase !== "joining" && media.phase !== "leaving";

  const chatState = useChatState(chat);
  const unread = useMemo(() => unreadConversations(chatState ? Object.values(chatState.conversations).map(({ summary }) => summary) : []), [chatState]);
  const treeChat = useTreeChatSummaries(chat);
  const lastVisited = useMemo(() => (data.user ? readLastVisited(data.user.id) : {}), [data.user]);
  const liveByTree = useMemo(() => {
    const people = new Map<string, number>();
    for (const nest of liveNests) {
      if (nest.treeId) people.set(nest.treeId, (people.get(nest.treeId) ?? 0) + nest.activeParticipantCount);
    }
    return people;
  }, [liveNests]);
  // Same rule as the Live now cards, so a tree is never marked live with nothing to show.
  const liveTreeIds = useMemo(() => new Set(liveNests.flatMap((nest) => (nest.treeId ? [nest.treeId] : []))), [liveNests]);
  const trees = useMemo(
    () => orderTrees(data.trees, (id) => liveTreeIds.has(id), (id) => treeChat.get(id)?.unread ?? false, lastVisited.treeId),
    [data.trees, liveTreeIds, treeChat, lastVisited.treeId],
  );

  // The last nest looked at, when it is quiet: a live one is already a card above.
  const pickUp = lastVisited.nestId ? data.getNest(lastVisited.nestId) : undefined;
  const pickUpUsable =
    pickUp != null &&
    pickUp.lifecycleState !== "expired" &&
    pickUp.lifecycleState !== "closed" &&
    pickUp.status !== "ended" &&
    media.activeNestId !== pickUp.id &&
    !liveNests.some((nest) => nest.id === pickUp.id);

  const firstRun = data.trees.length === 0;
  const nothingElse = data.pending.length === 0 && liveNests.length === 0 && unread.length === 0 && openPeople.length === 0 && data.outgoingFriendRequests.length === 0 && !pickUpUsable;

  // Joining always passes the threshold, so the person sees what they will reveal first.
  const open = (nestId: string) => onNavigate({ kind: "nest", id: nestId });

  const username = data.user?.username;
  const copyUsername = () => {
    if (!username) return;
    void navigator.clipboard.writeText(`@${username}`).then(
      () => toast({ title: "Copied" }),
      () => toast({ title: "Couldn’t copy", description: "Select the text and copy it instead.", tone: "error" }),
    );
  };

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-8 px-6 py-8">
          {pickUpUsable && pickUp ? (
            <section>
              <SectionLabel className="mb-1">Pick up</SectionLabel>
              <GroupedList>
                <PickUpRow nest={pickUp} data={data} onOpen={() => open(pickUp.id)} />
              </GroupedList>
            </section>
          ) : null}

          {data.pending.length > 0 ? (
            <section>
              <SectionLabel className="mb-1">Reaching you</SectionLabel>
              <GroupedList className="p-1">
                <PendingList data={data} onNavigate={onNavigate} />
              </GroupedList>
            </section>
          ) : null}

          {liveNests.length > 0 ? (
            <section>
              <SectionLabel className="mb-1">Live now</SectionLabel>
              <div className="grid gap-3 sm:grid-cols-2">
                {liveNests.map((nest) => (
                  <LiveNestCard
                    key={nest.id}
                    nest={nest}
                    data={data}
                    here={media.activeNestId === nest.id}
                    canJoin={canJoin}
                    onOpen={() => onNavigate(nestView(nest))}
                  />
                ))}
              </div>
            </section>
          ) : null}

          {unread.length > 0 && data.user ? (
            <section>
              <SectionLabel className="mb-1">Unread</SectionLabel>
              <GroupedList>
                {unread.map((conversation) => (
                  <ConversationRow key={conversation.id} conversation={conversation} me={data.user!.id} onOpen={(id) => onNavigate({ kind: "chat", id })} />
                ))}
              </GroupedList>
            </section>
          ) : null}

          {firstRun ? (
            <section>
              <SectionLabel className="mb-1">Get started</SectionLabel>
              <GroupedList>
                {canCreate ? (
                  <DoorwayRow
                    icon={<Plus />}
                    label={`Start a ${treeSingular}`}
                    value="A private home for people you trust."
                    control={<Button size="xs" variant="secondary" onClick={() => setCreateTreeOpen(true)}>Start</Button>}
                  />
                ) : null}
                <DoorwayRow
                  icon={<Search />}
                  label={`Find a public ${treeSingular}`}
                  value={`Search by name to see what ${data.labels.treePlural.toLowerCase()} are open.`}
                  control={<Button size="xs" variant="secondary" onClick={() => focusGlobalSearch()}>Search</Button>}
                />
                {username ? (
                  <DoorwayRow
                    icon={<AtSign />}
                    label="Ask a friend to add you"
                    value={`Your username is @${username}`}
                    control={<Button size="xs" variant="secondary" onClick={copyUsername}>Copy</Button>}
                  />
                ) : null}
              </GroupedList>
            </section>
          ) : (
            <section>
              <SectionLabel
                className="mb-1"
                action={
                  canCreate ? (
                    <Button size="icon-sm" variant="ghost" aria-label={`New ${treeSingular}`} onClick={() => setCreateTreeOpen(true)}>
                      <Plus className="h-4 w-4" />
                    </Button>
                  ) : undefined
                }
              >
                {data.labels.treePlural}
              </SectionLabel>
              {nothingElse && liveTreeIds.size === 0 ? <p className="mb-2 px-1 text-small text-muted-foreground">Nobody is in a {nestSingular} right now.</p> : null}
              <GroupedList>
                {trees.map((tree) => (
                  <TreeRow
                    key={tree.id}
                    tree={tree}
                    peopleInside={liveByTree.get(tree.id) ?? 0}
                    live={liveTreeIds.has(tree.id)}
                    unread={treeChat.get(tree.id)?.unread ?? false}
                    nestSingular={nestSingular}
                    onOpen={() => onNavigate({ kind: "tree", id: tree.id })}
                  />
                ))}
              </GroupedList>
            </section>
          )}

          {openPeople.length > 0 ? (
            <section>
              <SectionLabel className="mb-1">Open to talk</SectionLabel>
              <GroupedList>
                {openPeople.map((person) => (
                  <ReachableRow key={person.id} person={person} data={data} onNavigate={onNavigate} />
                ))}
              </GroupedList>
            </section>
          ) : null}

          {data.outgoingFriendRequests.length > 0 ? (
            <section>
              <SectionLabel className="mb-1">Friend requests you sent</SectionLabel>
              <GroupedList>
                {data.outgoingFriendRequests.map((request) => {
                  const name = request.toDisplayName || request.toUsername;
                  return (
                    <div key={request.id} className="flex items-center gap-3 px-3 py-2.5">
                      <button type="button" onClick={() => onNavigate({ kind: "user", id: request.toUserId })} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                        <PersonAvatar id={request.toUserId} name={name} className="h-8 w-8" />
                        <span className="min-w-0">
                          <span className="block truncate text-small font-medium">{name}</span>
                          <span className="block text-caption text-muted-foreground">Waiting for a reply</span>
                        </span>
                      </button>
                      <Button size="sm" variant="ghost" disabled={actions.isPending(request.id)} onClick={() => actions.run(request.id, () => data.cancelFriendRequest(request.id))}>
                        Cancel request
                      </Button>
                    </div>
                  );
                })}
              </GroupedList>
            </section>
          ) : null}
        </div>
      </div>
      <NameDialog
        open={createTreeOpen}
        onOpenChange={setCreateTreeOpen}
        title={`New ${treeSingular}`}
        description={`A ${treeSingular} is a private home for a group. You choose who joins.`}
        label="Name"
        placeholder="Weekend crew"
        submitLabel={`Create ${treeSingular}`}
        onSubmit={async (name) => {
          const tree = await data.createTree(name);
          setCreateTreeOpen(false);
          onNavigate({ kind: "tree", id: tree.id });
        }}
      />
    </>
  );
}

function PickUpRow({ nest, data, onOpen }: { nest: NonNullable<ReturnType<RavenShellData["getNest"]>>; data: RavenShellData; onOpen: () => void }) {
  const others = nestPeople(nest, data).filter((person) => person.id !== data.user?.id).map((person) => person.name);
  return (
    <button type="button" onClick={onOpen} className="flex h-14 w-full items-center gap-3 px-3.5 text-left transition-colors hover:bg-secondary">
      <NestGlyph kind="voice" className="text-subtle" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body font-medium"><bdi>{nest.name}</bdi></span>
        <span className="block truncate text-caption text-muted-foreground">
          <bdi>{treeNameFor(data, nest.treeId)}</bdi>
          {others.length ? ` · ${namesSentence(others, 3)} ${others.length === 1 ? "is" : "are"} here` : ""}
        </span>
      </span>
    </button>
  );
}

function TreeRow({
  tree,
  peopleInside,
  live,
  unread,
  nestSingular,
  onOpen,
}: {
  tree: { id: string; name: string; updatedAt: string };
  peopleInside: number;
  live: boolean;
  unread: boolean;
  nestSingular: string;
  onOpen: () => void;
}) {
  return (
    <button type="button" onClick={onOpen} className="flex h-14 w-full items-center gap-3 px-3.5 text-left transition-colors hover:bg-secondary">
      <Avatar name={tree.name} src={api.treeAvatarUrl(tree.id, tree.updatedAt)} className="h-8 w-8 rounded-control" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body font-medium"><bdi>{tree.name}</bdi></span>
        {peopleInside > 0 ? <span className="block truncate text-caption text-muted-foreground">{peopleInside} in a {nestSingular}</span> : null}
      </span>
      {live ? <LiveDot aria-label="Live" /> : null}
      {unread ? <UnreadDot /> : null}
    </button>
  );
}

export function ReachableRow({ person, data, onNavigate }: { person: ShellPerson; data: RavenShellData; onNavigate: (view: RavenView) => void }) {
  const profileKnock = useProfileKnock(data, person.id);
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <button type="button" onClick={() => onNavigate({ kind: "user", id: person.id })} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <PersonAvatar id={person.id} name={person.name} presence={person.presence} className="h-8 w-8" />
        <span className="min-w-0">
          <span className="block truncate text-small font-medium">{person.name}</span>
          <span className="block truncate text-caption text-muted-foreground">{personStatus(person, data) ?? PRESENCE[person.presence].label}</span>
        </span>
      </button>
      <Button variant="secondary" size="sm" disabled={profileKnock.disabled} onClick={profileKnock.knock} title={profileKnock.description}>
        <Hand className="h-4 w-4" />
        {profileKnock.label}
      </Button>
    </div>
  );
}
