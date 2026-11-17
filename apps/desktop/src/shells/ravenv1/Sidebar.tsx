import { useCallback, useMemo, useState, type ReactNode } from "react";
import { capabilitiesOf } from "@/lib/permissions";
import { Avatar } from "@/components/ui/avatar";
import { Tooltip } from "@/components/ui/tooltip";
import { api, type LauncherNest } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight, House, MapPin, PanelLeftClose, PanelLeftOpen, Plus, Users } from "lucide-react";
import { ConversationAvatar, RavenAvatar, SavedAvatar, UnreadDot } from "@/components/chat/ConversationRow";
import type { ChatStore } from "@/lib/chat/store";
import { LiveDot, NestGlyph, PersonAvatar, SectionLabel } from "./atoms";
import { PendingList } from "./Inbox";
import { OFFLINE_RANK, personStatus, reachRank } from "./people";
import { rowUnread } from "./friendsAndGroups";
import { orderLiveNests } from "./liveCards";
import { SidebarFriendsAndGroups } from "./SidebarChat";
import { SidebarLive } from "./SidebarLive";
import { TreeNests } from "./SidebarTreeNests";
import { lensForView, readLens, storeLens, type SidebarLens } from "./sidebarLens";
import { PRESENCE, type RavenShellData, type RavenView } from "./state";
import { useChatSelector, useFriendsAndGroups, useMessagesUnread, useOpenPerson, useOpenSaved, useRavenConversation, useTreeChatSummaries } from "./useChat";
import type { RavenMediaAdapterState } from "./useRavenMediaAdapter";
import type { NestEntryController } from "./useNestEntry";
import { NameDialog } from "./views/dialogs";
import { nestView } from "./views/shared";

const COLLAPSED_TREES_KEY = "raven.sidebar.collapsedTrees";

/**
 * The live social map. Above everything, what is live right now. Below it two lenses, one
 * at a time: Places (where can I go?) and People (who can I talk to?).
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
  const ravenConversation = useRavenConversation(chat);
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
  const activeChatKind = useChatSelector(chat, (state) => (activeChatId ? state.conversations[activeChatId]?.summary.kind ?? "" : ""), "", activeChatId);
  const activeChatName = useChatSelector(chat, (state) => (activeChatId ? state.conversations[activeChatId]?.summary.name ?? "" : ""), "", activeChatId);
  const [collapsedTrees, setCollapsedTrees] = useState<Set<string>>(() => readIdSet(COLLAPSED_TREES_KEY));
  const [createTreeOpen, setCreateTreeOpen] = useState(false);

  // The lens is remembered per device and changes only when the person changes it. Opening
  // a view that is listed under the other lens leaves the lens alone and shows where it is.
  const [lens, setLensState] = useState<SidebarLens>(readLens);
  const setLens = useCallback((next: SidebarLens) => {
    storeLens(next);
    setLensState(next);
  }, []);
  const viewLens = lensForView(view, activeChatKind);
  const placesUnread = useMemo(() => [...treeChat.values()].some((summary) => summary.unread), [treeChat]);
  const lensUnread: Record<SidebarLens, boolean> = { places: placesUnread, people: messagesUnread };
  const otherLens: SidebarLens = lens === "places" ? "people" : "places";

  const serverName = data.serverProperties.name || "Raven";
  const serverAvatar = data.serverProperties.avatar ? api.assetUrl(data.serverProperties.avatar) : undefined;
  const treeSingular = data.labels.treeSingular;

  const friendIds = useMemo(() => new Set(data.friends.map((friend) => friend.userId)), [data.friends]);
  const liveNests = useMemo(
    () => orderLiveNests({ active: data.activeNests, temporary: data.temporaryNests, hereId: media.activeNestId, friendIds }),
    [data.activeNests, data.temporaryNests, media.activeNestId, friendIds],
  );

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

  // On the rail: friends who are reachable, and anyone or any group with unread messages.
  const railPeople = people.shown.filter((row) => rowUnread(row) > 0 || (row.kind === "person" && !row.former && reachRank(row.person) < OFFLINE_RANK));

  const toggleTree = useCallback((treeId: string) => {
    setCollapsedTrees((current) => {
      const next = new Set(current);
      if (next.has(treeId)) next.delete(treeId);
      else next.add(treeId);
      localStorage.setItem(COLLAPSED_TREES_KEY, JSON.stringify([...next]));
      return next;
    });
  }, []);

  if (collapsed) {
    return (
      <nav aria-label="Raven" className="flex min-h-0 flex-col items-center gap-1 pb-2 pt-1">
        <RailButton label="Expand sidebar" onClick={onToggle}>
          <PanelLeftOpen className="h-4 w-4" />
        </RailButton>
        <RailButton label="Home" active={view.kind === "home"} onClick={() => onNavigate({ kind: "home" })}>
          <Avatar name={serverName} src={serverAvatar} className="h-7 w-7 rounded-control bg-foreground text-background" />
        </RailButton>
        <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto">
          {liveNests.map((nest) => {
            const tree = nest.treeId ? data.getTree(nest.treeId) : undefined;
            const here = media.activeNestId === nest.id;
            return (
              <RailButton
                key={nest.id}
                label={[nest.name, tree?.name ?? "Temporary", here ? "you’re here" : "live"].join(" · ")}
                active={(view.kind === "nest" || view.kind === "waiting") && view.id === nest.id}
                onClick={() => onNavigate(nestView(nest))}
              >
                <span className="flex rounded-control ring-2 ring-live ring-offset-1 ring-offset-background">
                  {tree ? (
                    <Avatar name={tree.name} src={api.treeAvatarUrl(tree.id, tree.updatedAt)} className="h-7 w-7 rounded-control" />
                  ) : (
                    <span className="flex h-7 w-7 items-center justify-center rounded-control bg-secondary">
                      <NestGlyph kind="voice" live className="text-live" />
                    </span>
                  )}
                </span>
              </RailButton>
            );
          })}
          <div className="my-1 h-px w-6 shrink-0 bg-border" />
          <RailButton label={[lens === "places" ? "Show people" : `Show ${data.labels.treePlural.toLowerCase()}`, lensUnread[otherLens] ? "unread" : null].filter(Boolean).join(" · ")} onClick={() => setLens(otherLens)}>
            <span className="relative">
              {lens === "places" ? <Users className="h-4 w-4" /> : <MapPin className="h-4 w-4" />}
              {lensUnread[otherLens] ? <UnreadDot className="absolute -right-1.5 -top-1.5 h-2 w-2 outline outline-2 outline-background" /> : null}
            </span>
          </RailButton>
          {lens === "places"
            ? data.trees.map((tree) => {
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
              })
            : null}
          {lens === "people" && chat && data.user ? (
            <RailButton label="Saved messages" active={view.kind === "chat" && view.id === saved.savedId} disabled={saved.opening} onClick={saved.open}>
              <SavedAvatar userId={data.user.id} name={data.preferences.displayName || data.user.username} className="h-7 w-7" />
            </RailButton>
          ) : null}
          {lens === "people" && ravenConversation ? (
            <RailButton
              label={[ravenConversation.name, ravenConversation.unreadCount > 0 ? "unread" : null].filter(Boolean).join(" · ")}
              active={view.kind === "chat" && view.id === ravenConversation.id}
              onClick={() => onNavigate({ kind: "chat", id: ravenConversation.id })}
            >
              <span className="relative">
                <RavenAvatar className="h-7 w-7" />
                {ravenConversation.unreadCount > 0 ? <UnreadDot className="absolute -right-0.5 -top-0.5 h-2 w-2 outline outline-2 outline-background" /> : null}
              </span>
            </RailButton>
          ) : null}
          {lens === "people"
            ? railPeople.map((row) => {
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
              })
            : null}
        </div>
      </nav>
    );
  }

  return (
    <nav aria-label="Raven" className="flex min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-2 pb-1 pt-1">
        <Tooltip label="Home" side="bottom">
          <button
            type="button"
            onClick={() => onNavigate({ kind: "home" })}
            aria-current={view.kind === "home" ? "page" : undefined}
            aria-label={`Home, ${serverName}`}
            className={cn(
              "flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-control px-2 text-left transition-colors",
              view.kind === "home" ? "bg-secondary" : "hover:bg-secondary/60",
            )}
          >
            <Avatar name={serverName} src={serverAvatar} className="h-6 w-6 rounded-chip bg-foreground text-background" />
            <span className="min-w-0 flex-1 truncate text-body font-medium">{serverName}</span>
            <House aria-hidden className="h-3.5 w-3.5 shrink-0 text-subtle" />
          </button>
        </Tooltip>
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

        <SidebarLive nests={liveNests} data={data} media={media} entry={entry} view={view} onNavigate={onNavigate} />

        <LensSwitch labels={{ places: data.labels.treePlural, people: "People" }} lens={lens} unread={lensUnread} onChange={setLens} />

        {viewLens && viewLens !== lens ? (
          <HereRow here={hereCue(view, data, { chatName: activeChatName, chatTreeId: openTextNestTree })} onClick={() => setLens(viewLens)} />
        ) : null}

        {lens === "places" ? (
          <section>
            {data.trees.length ? (
              <div className="space-y-px">
                {data.trees.map((tree) => {
                  const live = liveByTree.get(tree.id) ?? [];
                  const text = treeChat.get(tree.id);
                  // A tree opens to show all its nests, voice and text, in its lobby's order. A voice
                  // nest opens its threshold; nothing here joins.
                  const details = data.treeDetails[tree.id];
                  const expandable = Boolean(details?.activeNests.length || details?.inactiveNests.length || (chat && text?.count));
                  const open = expandable && !collapsedTrees.has(tree.id);
                  const active = (view.kind === "tree" || view.kind === "tree-settings") && view.id === tree.id;
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
                          {live.length ? <LiveDot /> : null}
                          {text?.unread && !open ? <UnreadDot /> : null}
                        </button>
                      </div>
                      {open ? (
                        <div className="space-y-px">
                          <TreeNests chat={chat} data={data} treeId={tree.id} view={view} hereId={media.activeNestId} onNavigate={onNavigate} />
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
            {capabilitiesOf(data.user).createSpaces ? (
              <button
                type="button"
                onClick={() => setCreateTreeOpen(true)}
                className="mt-1 flex h-8 w-full items-center gap-2.5 rounded-control px-2 text-left text-small text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
              >
                <Plus className="h-4 w-4 shrink-0" />
                New {treeSingular.toLowerCase()}
              </button>
            ) : null}
          </section>
        ) : (
          <SidebarFriendsAndGroups chat={chat} data={data} view={view} onNavigate={onNavigate} />
        )}
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

/** The open view, when it is listed under the lens that is not showing. Opens that lens on request. */
function HereRow({ here, onClick }: { here: { name: string; detail: string } | null; onClick: () => void }) {
  if (!here) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current="page"
      className="flex h-9 w-full items-center gap-2 rounded-control bg-secondary px-2 text-left"
    >
      <span className="min-w-0 flex-1 truncate text-small font-medium">{here.name}</span>
      <span className="shrink-0 text-caption text-subtle">{here.detail}</span>
    </button>
  );
}

/** What to call the open view in the sidebar: its name, and where it sits. */
function hereCue(view: RavenView, data: RavenShellData, chat: { chatName: string; chatTreeId: string }): { name: string; detail: string } | null {
  const treeName = (id?: string | null) => data.trees.find((tree) => tree.id === id)?.name;
  switch (view.kind) {
    case "tree":
    case "tree-settings":
      return { name: treeName(view.id) ?? data.labels.treeSingular, detail: "Open now" };
    case "tree-preview":
      return { name: view.result.tree.name, detail: "Open now" };
    case "nest":
    case "waiting": {
      const nest = data.getNest(view.id);
      return { name: nest?.name ?? data.labels.nestSingular, detail: treeName(nest?.treeId) ?? "Open now" };
    }
    case "user":
      return { name: data.getPerson(view.id)?.name ?? view.person?.name ?? "Profile", detail: "Open now" };
    case "chat":
      return { name: chat.chatName || "Conversation", detail: treeName(chat.chatTreeId) ?? "Open now" };
    default:
      return null;
  }
}

/** Trees (or Spaces, in the user's words) | People. The lens that is not showing gets a dot when it holds something unread. */
function LensSwitch({
  labels,
  lens,
  unread,
  onChange,
}: {
  labels: Record<SidebarLens, string>;
  lens: SidebarLens;
  unread: Record<SidebarLens, boolean>;
  onChange: (lens: SidebarLens) => void;
}) {
  return (
    <div role="group" aria-label="Sidebar view" className="flex rounded-control bg-background/60 p-0.5">
      {(["places", "people"] as const).map((item) => {
        const selected = lens === item;
        return (
          <button
            key={item}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(item)}
            className={cn(
              "flex h-7 flex-1 items-center justify-center gap-1.5 rounded-chip text-small transition-colors",
              selected ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {labels[item]}
            {!selected && unread[item] ? <UnreadDot /> : null}
          </button>
        );
      })}
    </div>
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
