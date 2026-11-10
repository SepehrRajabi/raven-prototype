import { useCallback, useMemo, useState, type ReactNode } from "react";
import { roomEventCaptions } from "@/lib/events";
import { useNow } from "./useNow";
import { capabilitiesOf } from "@/lib/permissions";
import { Avatar } from "@/components/ui/avatar";
import { Tooltip } from "@/components/ui/tooltip";
import { api, type LauncherNest } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight, MessageSquare, PanelLeftClose, PanelLeftOpen, Plus } from "lucide-react";
import { ConversationAvatar, SavedAvatar, UnreadDot } from "@/components/chat/ConversationRow";
import type { ChatStore } from "@/lib/chat/store";
import { AvatarStack, LiveDot, NestGlyph, PersonAvatar, SectionLabel } from "./atoms";
import { PendingList } from "./Inbox";
import { OFFLINE_RANK, personStatus, reachRank } from "./people";
import { rowUnread } from "./friendsAndGroups";
import { SidebarFriendsAndGroups, TreeTextNests } from "./SidebarChat";
import { displayNameFor, PRESENCE, type RavenShellData, type RavenView, type ShellPerson } from "./state";
import { useChatSelector, useFriendsAndGroups, useMessagesUnread, useOpenPerson, useOpenSaved, useTreeChatSummaries } from "./useChat";
import type { RavenMediaAdapterState } from "./useRavenMediaAdapter";
import type { NestEntryController } from "./useNestEntry";
import { NameDialog } from "./views/dialogs";

const COLLAPSED_TREES_KEY = "raven.sidebar.collapsedTrees";
const SHOW_OFFLINE_KEY = "raven.sidebar.showOffline";
const SHOW_TREE_PEOPLE_KEY = "raven.sidebar.showTreePeople";

/**
 * The live social map: who is reaching you, which nests are alive in each tree,
 * and which friends are around. It shows what matters now, not every structure.
 */
export function Sidebar({
  view,
  data,
  media,
  entry,
  chat,
  collapsed,
  onToggle,
  onNavigate,
}: {
  view: RavenView;
  data: RavenShellData;
  media: RavenMediaAdapterState;
  entry: NestEntryController;
  /** Text chat, or null when the server has none. */
  chat: ChatStore | null;
  collapsed: boolean;
  onToggle: () => void;
  onNavigate: (view: RavenView) => void;
}) {
  const treeChat = useTreeChatSummaries(chat);
  const messagesUnread = useMessagesUnread(chat);
  const people = useFriendsAndGroups(chat, data, view);
  const saved = useOpenSaved(chat, onNavigate);
  const { open: openPerson, openingId } = useOpenPerson(chat, onNavigate);
  // The tree whose text nest is open: that nest stays listed under it.
  const activeChatId = view.kind === "chat" ? view.id : "";
  const openTextNestTree = useChatSelector(
    chat,
    (state) => {
      const summary = activeChatId ? state.conversations[activeChatId]?.summary : undefined;
      return summary?.kind === "nest" ? summary.treeId ?? "" : "";
    },
    "",
    activeChatId,
  );
  const [collapsedTrees, setCollapsedTrees] = useState<Set<string>>(() => readIdSet(COLLAPSED_TREES_KEY));
  const [showOffline, setShowOffline] = useStoredFlag(SHOW_OFFLINE_KEY, false);
  const [showTreePeople, setShowTreePeople] = useStoredFlag(SHOW_TREE_PEOPLE_KEY, false);
  const [createTreeOpen, setCreateTreeOpen] = useState(false);

  const serverName = data.serverProperties.name || "Raven";
  const serverAvatar = data.serverProperties.avatar ? api.assetUrl(data.serverProperties.avatar) : undefined;
  const treeSingular = data.labels.treeSingular;

  const liveByTree = useMemo(() => {
    const groups = new Map<string, LauncherNest[]>();
    for (const nest of data.activeNests) {
      if (!nest.treeId) continue;
      const list = groups.get(nest.treeId) ?? [];
      list.push(nest);
      groups.set(nest.treeId, list);
    }
    return groups;
  }, [data.activeNests]);

  const looseNests = useMemo(() => {
    const seen = new Set<string>();
    const result: LauncherNest[] = [];
    for (const nest of [...data.activeNests.filter((candidate) => !candidate.treeId), ...data.temporaryNests]) {
      if (seen.has(nest.id)) continue;
      seen.add(nest.id);
      result.push(nest);
    }
    return result;
  }, [data.activeNests, data.temporaryNests]);

  // On the rail: friends who are reachable, and anyone or any group with unread messages.
  const railPeople = people.shown.filter((row) => rowUnread(row) > 0 || (row.kind === "person" && !row.former && reachRank(row.person) < OFFLINE_RANK));
  const treePeople = useMemo(
    () => data.people.filter((person) => person.relationship !== "friend").sort((a, b) => reachRank(a) - reachRank(b) || a.name.localeCompare(b.name)),
    [data.people],
  );

  const toggleTree = useCallback((treeId: string) => {
    setCollapsedTrees((current) => {
      const next = new Set(current);
      if (next.has(treeId)) next.delete(treeId);
      else next.add(treeId);
      localStorage.setItem(COLLAPSED_TREES_KEY, JSON.stringify([...next]));
      return next;
    });
  }, []);

  const openNest = (nest: LauncherNest) =>
    onNavigate(nest.type === "temporary" && nest.lifecycleState !== "active" ? { kind: "waiting", id: nest.id } : { kind: "nest", id: nest.id });

  // Joining always passes the threshold, so the person sees what they will reveal first.
  const joinNest = (nest: LauncherNest) => onNavigate({ kind: "nest", id: nest.id });

  const now = useNow();
  const captionsOf = (treeId: string) => roomEventCaptions(data.treeDetails[treeId]?.events, now);
  const nestRow = (nest: LauncherNest, nested: boolean, caption?: string) => (
    <NestRow
      key={nest.id}
      nest={nest}
      caption={caption}
      nested={nested}
      active={(view.kind === "nest" || view.kind === "waiting") && view.id === nest.id}
      here={media.activeNestId === nest.id}
      joinable={!media.activeNestId && !entry.pending && media.phase !== "joining" && nest.lifecycleState === "active"}
      joinLabel={`Join ${nest.name}…`}
      onOpen={() => openNest(nest)}
      onJoin={() => joinNest(nest)}
    />
  );

  if (collapsed) {
    return (
      <nav aria-label="Raven" className="flex min-h-0 flex-col items-center gap-1 pb-2 pt-1">
        <RailButton label="Expand sidebar" onClick={onToggle}>
          <PanelLeftOpen className="h-4 w-4" />
        </RailButton>
        <RailButton label="Home" active={view.kind === "home"} onClick={() => onNavigate({ kind: "home" })}>
          <Avatar name={serverName} src={serverAvatar} className="h-7 w-7 rounded-control bg-foreground text-background" />
        </RailButton>
        {chat ? (
          <RailButton label={messagesUnread ? "All conversations · unread" : "All conversations"} active={view.kind === "messages"} onClick={() => onNavigate({ kind: "messages" })}>
            <span className="relative">
              <MessageSquare className="h-4 w-4" />
              {messagesUnread ? <UnreadDot className="absolute -right-1.5 -top-1.5 h-2 w-2 outline outline-2 outline-background" /> : null}
            </span>
          </RailButton>
        ) : null}
        <div className="my-1 h-px w-6 bg-border" />
        <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto">
          {data.trees.map((tree) => {
            const live = liveByTree.get(tree.id)?.length ?? 0;
            const unread = treeChat.get(tree.id)?.unread ?? false;
            return (
              <RailButton
                key={tree.id}
                label={[tree.name, live ? `${live} live` : null, unread ? "unread" : null].filter(Boolean).join(" · ")}
                active={(view.kind === "tree" || view.kind === "tree-settings") && view.id === tree.id}
                onClick={() => onNavigate({ kind: "tree", id: tree.id })}
              >
                <span className="relative">
                  <Avatar name={tree.name} src={api.treeAvatarUrl(tree.id, tree.updatedAt)} className="h-7 w-7 rounded-control" />
                  {live ? <LiveDot className="absolute -right-0.5 -top-0.5 h-2 w-2 outline outline-2 outline-background" /> : null}
                  {unread ? <UnreadDot className="absolute -bottom-0.5 -right-0.5 h-2 w-2 outline outline-2 outline-background" /> : null}
                </span>
              </RailButton>
            );
          })}
          {railPeople.length || chat ? <div className="my-1 h-px w-6 shrink-0 bg-border" /> : null}
          {chat && data.user ? (
            <RailButton label="Saved messages" active={view.kind === "chat" && view.id === saved.savedId} disabled={saved.opening} onClick={saved.open}>
              <SavedAvatar userId={data.user.id} name={data.preferences.displayName || data.user.username} className="h-7 w-7" />
            </RailButton>
          ) : null}
          {railPeople.map((row) => {
            const unread = rowUnread(row) > 0;
            if (row.kind === "group") {
              return (
                <RailButton
                  key={row.conversation.id}
                  label={[row.conversation.name, "group", unread ? "unread" : null].filter(Boolean).join(" · ")}
                  active={row.conversation.id === people.activeConversationId}
                  onClick={() => onNavigate({ kind: "chat", id: row.conversation.id })}
                >
                  <span className="relative">
                    <ConversationAvatar conversation={row.conversation} className="h-7 w-7 rounded-chip text-caption" />
                    {unread ? <UnreadDot className="absolute -right-0.5 -top-0.5 h-2 w-2 outline outline-2 outline-background" /> : null}
                  </span>
                </RailButton>
              );
            }
            const { person, former } = row;
            const status = former ? null : personStatus(person, data) ?? PRESENCE[person.presence].label;
            return (
              <RailButton
                key={person.id}
                label={[person.name, status, unread ? "unread" : null].filter(Boolean).join(" · ")}
                active={person.id === people.activePersonId}
                disabled={openingId === person.id}
                onClick={() => openPerson(person.id)}
              >
                <span className="relative">
                  <PersonAvatar id={person.id} name={person.name} presence={former ? undefined : person.presence} surface="canvas" className="h-7 w-7" />
                  {unread ? <UnreadDot className="absolute -right-0.5 -top-0.5 h-2 w-2 outline outline-2 outline-background" /> : null}
                </span>
              </RailButton>
            );
          })}
        </div>
      </nav>
    );
  }

  return (
    <nav aria-label="Raven" className="flex min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-2 pb-1 pt-1">
        <button
          type="button"
          onClick={() => onNavigate({ kind: "home" })}
          aria-current={view.kind === "home" ? "page" : undefined}
          aria-label={`Home, ${serverName}`}
          title={data.serverProperties.description || serverName}
          className={cn(
            "flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-control px-2 text-left transition-colors",
            view.kind === "home" ? "bg-secondary" : "hover:bg-secondary/60",
          )}
        >
          <Avatar name={serverName} src={serverAvatar} className="h-6 w-6 rounded-chip bg-foreground text-background" />
          <span className="min-w-0 flex-1 truncate text-body font-medium">{serverName}</span>
        </button>
        <Tooltip label="Collapse sidebar" side="bottom">
          <button
            type="button"
            onClick={onToggle}
            aria-label="Collapse sidebar"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-subtle transition-colors hover:bg-secondary hover:text-foreground"
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        </Tooltip>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-2 pb-3 pt-1">
        {data.pending.length > 0 ? (
          <section>
            <SectionLabel className="px-2">Reaching you</SectionLabel>
            <PendingList data={data} onNavigate={onNavigate} surface="canvas" compact />
          </section>
        ) : null}

        <section>
          <SectionLabel
            className="px-2"
            action={!capabilitiesOf(data.user).createSpaces ? undefined : (
              <Tooltip label={`New ${treeSingular.toLowerCase()}`} side="right">
                <button
                  type="button"
                  aria-label={`New ${treeSingular.toLowerCase()}`}
                  onClick={() => setCreateTreeOpen(true)}
                  className="flex h-6 w-6 items-center justify-center rounded-chip text-subtle transition-colors hover:bg-secondary hover:text-foreground"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
            )}
          >
            {data.labels.treePlural}
          </SectionLabel>
          {data.trees.length ? (
            <div className="space-y-px">
              {data.trees.map((tree) => {
                const live = liveByTree.get(tree.id) ?? [];
                const text = treeChat.get(tree.id);
                // A tree opens to show what is alive in it now: its live nests, its text nests
                // with unread messages, and the text nest that is open. The rest are in its lobby.
                const showsText = Boolean(chat && (text?.unread || openTextNestTree === tree.id));
                const expandable = live.length > 0 || showsText;
                const open = expandable && !collapsedTrees.has(tree.id);
                const active = (view.kind === "tree" || view.kind === "tree-settings") && view.id === tree.id;
                const captions = open ? captionsOf(tree.id) : undefined;
                return (
                  <div key={tree.id}>
                    <div className={cn("group flex h-9 items-center rounded-control transition-colors", active ? "bg-secondary" : "hover:bg-secondary/60")}>
                      {expandable ? (
                        <button
                          type="button"
                          aria-label={open ? `Hide ${data.labels.nestPlural.toLowerCase()} in ${tree.name}` : `Show ${data.labels.nestPlural.toLowerCase()} in ${tree.name}`}
                          aria-expanded={open}
                          onClick={() => toggleTree(tree.id)}
                          className="flex h-9 w-6 shrink-0 items-center justify-center text-subtle hover:text-foreground"
                        >
                          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                        </button>
                      ) : (
                        <span className="w-6 shrink-0" />
                      )}
                      <button
                        type="button"
                        onClick={() => onNavigate({ kind: "tree", id: tree.id })}
                        aria-current={active ? "page" : undefined}
                        className="flex h-9 min-w-0 flex-1 items-center gap-2.5 pr-2 text-left"
                      >
                        <Avatar name={tree.name} src={api.treeAvatarUrl(tree.id, tree.updatedAt)} className="h-5 w-5 rounded-chip text-[10px]" />
                        <span className={cn("min-w-0 flex-1 truncate text-small", active || live.length ? "font-medium text-foreground" : "text-muted-foreground group-hover:text-foreground")}>
                          {tree.name}
                        </span>
                        {live.length && !open ? <LiveDot /> : null}
                        {text?.unread && !open ? <UnreadDot /> : null}
                      </button>
                    </div>
                    {open ? (
                      <div className="space-y-px">
                        {chat && showsText ? <TreeTextNests chat={chat} treeId={tree.id} view={view} captions={captions} onNavigate={onNavigate} /> : null}
                        {live.map((nest) => nestRow(nest, true, captions?.get(nest.id)))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="px-2 py-1 text-small text-muted-foreground">
              Create a {treeSingular.toLowerCase()} for a group you trust, or search for a public one.
            </p>
          )}
        </section>

        {looseNests.length ? (
          <section>
            <SectionLabel className="px-2">{data.labels.temporaryNest}s</SectionLabel>
            <div className="space-y-px">{looseNests.map((nest) => nestRow(nest, false))}</div>
          </section>
        ) : null}

        <SidebarFriendsAndGroups
          chat={chat}
          data={data}
          view={view}
          showOffline={showOffline}
          onToggleOffline={() => setShowOffline(!showOffline)}
          onNavigate={onNavigate}
        />

        {treePeople.length ? (
          <section>
            <DisclosureRow open={showTreePeople} onToggle={() => setShowTreePeople(!showTreePeople)}>
              From your {data.labels.treePlural.toLowerCase()} · {treePeople.length}
            </DisclosureRow>
            {showTreePeople ? (
              <div className="space-y-px">
                {treePeople.map((person) => (
                  <PersonRow key={person.id} person={person} data={data} active={view.kind === "user" && view.id === person.id} onNavigate={onNavigate} />
                ))}
              </div>
            ) : null}
          </section>
        ) : null}
      </div>

      <NameDialog
        open={createTreeOpen}
        onOpenChange={setCreateTreeOpen}
        title={`New ${treeSingular.toLowerCase()}`}
        description={`A ${treeSingular.toLowerCase()} is a private home for a group. You choose who joins.`}
        label="Name"
        placeholder="Weekend crew"
        submitLabel={`Create ${treeSingular.toLowerCase()}`}
        onSubmit={async (name) => {
          const tree = await data.createTree(name);
          setCreateTreeOpen(false);
          onNavigate({ kind: "tree", id: tree.id });
        }}
      />
    </nav>
  );
}

function NestRow({
  nest,
  nested,
  active,
  here,
  joinable,
  joinLabel,
  caption,
  onOpen,
  onJoin,
}: {
  nest: LauncherNest;
  nested: boolean;
  caption?: string;
  active: boolean;
  here: boolean;
  joinable: boolean;
  joinLabel: string;
  onOpen: () => void;
  onJoin: () => void;
}) {
  const live = nest.lifecycleState === "active";
  const people = nest.currentParticipants.map((participant) => ({ id: participant.userId, name: displayNameFor(participant) }));
  return (
    <div className={cn("group relative flex items-center rounded-control transition-colors", caption ? "min-h-9" : "h-9", active ? "bg-secondary" : "hover:bg-secondary/60")}>
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? "page" : undefined}
        className={cn("flex min-w-0 flex-1 items-center gap-2.5 pr-2 text-left", caption ? "min-h-9 py-1" : "h-9", nested ? "pl-[34px]" : "pl-2")}
      >
        <NestGlyph kind="voice" live={live} className={live ? "text-live" : "text-subtle"} />
        {caption ? (
          <span className="min-w-0 flex-1">
            <span className="block truncate text-small text-foreground">{nest.name}</span>
            <span className="block truncate text-caption text-subtle"><bdi>{caption}</bdi></span>
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-small text-foreground">{nest.name}</span>
        )}
        {here ? (
          <span className="shrink-0 text-caption text-live">You’re here</span>
        ) : (
          <span className={cn("shrink-0", joinable && "group-focus-within:invisible group-hover:invisible")}>
            <AvatarStack people={people} surface="canvas" />
          </span>
        )}
      </button>
      {joinable && !here ? (
        <button
          type="button"
          aria-label={joinLabel}
          onClick={onJoin}
          className="absolute right-1.5 hidden h-6 items-center rounded-chip bg-primary px-2 text-caption font-medium text-primary-foreground hover:bg-primary/90 group-focus-within:flex group-hover:flex"
        >
          Join…
        </button>
      ) : null}
    </div>
  );
}

function PersonRow({
  person,
  data,
  active,
  onNavigate,
}: {
  person: ShellPerson;
  data: RavenShellData;
  active: boolean;
  onNavigate: (view: RavenView) => void;
}) {
  const status = personStatus(person, data);
  const away = reachRank(person) >= OFFLINE_RANK;
  return (
    <button
      type="button"
      onClick={() => onNavigate({ kind: "user", id: person.id })}
      aria-current={active ? "page" : undefined}
      title={`${person.name} · ${PRESENCE[person.presence].label}`}
      className={cn(
        "flex h-9 w-full items-center gap-2.5 rounded-control px-2 text-left transition-colors",
        active ? "bg-secondary" : "hover:bg-secondary/60",
      )}
    >
      <PersonAvatar id={person.id} name={person.name} presence={person.presence} surface="canvas" className={cn("h-6 w-6", away && "opacity-60")} />
      <span className={cn("min-w-0 flex-1 truncate text-small", away ? "text-muted-foreground" : "text-foreground")}>{person.name}</span>
      {status ? <span className="max-w-[45%] shrink-0 truncate text-caption text-muted-foreground">{status}</span> : null}
    </button>
  );
}

function DisclosureRow({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="flex h-7 w-full items-center gap-1 rounded-control px-2 text-left text-caption font-medium text-subtle transition-colors hover:text-foreground"
    >
      {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      {children}
    </button>
  );
}

function RailButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip label={label} side="right">
      <button
        type="button"
        aria-label={label}
        aria-current={active ? "page" : undefined}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-control text-muted-foreground transition-colors",
          active ? "bg-secondary text-foreground" : "hover:bg-secondary/60 hover:text-foreground",
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function readIdSet(key: string) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "[]");
    return new Set<string>(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set<string>();
  }
}

function useStoredFlag(key: string, fallback: boolean) {
  const [value, setValue] = useState(() => {
    const stored = localStorage.getItem(key);
    return stored === null ? fallback : stored === "true";
  });
  const update = useCallback(
    (next: boolean) => {
      localStorage.setItem(key, String(next));
      setValue(next);
    },
    [key],
  );
  return [value, update] as const;
}
