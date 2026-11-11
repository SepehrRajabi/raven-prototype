import { useEffect, useMemo, useState } from "react";
import { Plus, Search, UserPlus, Users } from "lucide-react";
import { NewGroupDialog } from "@/components/chat/ChatDialogs";
import { ConversationAvatar, ConversationRowCompact, MentionDot, MutedIndicator, SavedAvatar, UnreadCount } from "@/components/chat/ConversationRow";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import { orderTextNests } from "@/lib/chat/layout";
import { listedConversations, textNestsOfTree } from "@/lib/chat/reducer";
import type { ChatStore } from "@/lib/chat/store";
import { capabilitiesOf } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { PersonAvatar, SectionLabel } from "./atoms";
import { filterPeople, visibleTextNests, type FriendsAndGroupsRow } from "./friendsAndGroups";
import { OFFLINE_RANK, personStatus, reachRank } from "./people";
import { focusGlobalSearch } from "./searchFocus";
import { PRESENCE, type RavenShellData, type RavenView } from "./state";
import { useChatState, useFriendsAndGroups, useOpenPerson, useOpenSaved } from "./useChat";

/**
 * The People lens: who you can talk to. A find field, Saved messages, then friends and groups
 * in one list. A friend's row opens your conversation with them, a group's row opens the
 * group. Friends keep their place by reachability, offline friends come last and dimmed, and
 * unread is a count on the row. Typing in the field filters in place and also finds people
 * from your trees and archived conversations.
 */
export function SidebarFriendsAndGroups({
  chat,
  data,
  view,
  onNavigate,
}: {
  /** Text chat, or null when the server has none: friends' rows then open their profile. */
  chat: ChatStore | null;
  data: RavenShellData;
  view: RavenView;
  onNavigate: (view: RavenView) => void;
}) {
  const { shown, offline, activePersonId, activeConversationId } = useFriendsAndGroups(chat, data, view);
  const { open: openPerson, openingId } = useOpenPerson(chat, onNavigate);
  const state = useChatState(chat);
  const [query, setQuery] = useState("");
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const friends = useMemo(() => data.friends.map((friend) => ({ id: friend.userId, name: friend.displayName || friend.username })), [data.friends]);
  const canCreateGroups = Boolean(chat) && capabilitiesOf(data.user).createGroups;
  const rows = useMemo(() => [...shown, ...offline], [shown, offline]);
  const text = query.trim();
  const listedIds = useMemo(() => new Set(rows.flatMap((item) => (item.conversation ? [item.conversation.id] : []))), [rows]);

  // Archived conversations are only ever found by name, here.
  const found = useMemo(
    () =>
      text
        ? filterPeople({
            query: text,
            rows,
            people: data.people,
            others: state ? listedConversations(state).map((conversation) => conversation.summary).filter((summary) => !listedIds.has(summary.id)) : [],
            archived: state ? listedConversations(state, true).map((conversation) => conversation.summary) : [],
            treeName: (treeId) => data.getTree(treeId)?.name ?? data.labels.treeSingular,
          })
        : null,
    [text, rows, listedIds, data, state],
  );

  const row = (item: FriendsAndGroupsRow) =>
    item.kind === "group" ? (
      <GroupRow
        key={item.conversation.id}
        row={item}
        active={item.conversation.id === activeConversationId}
        onOpen={() => onNavigate({ kind: "chat", id: item.conversation.id })}
      />
    ) : (
      <PersonRow
        key={item.person.id}
        row={item}
        data={data}
        active={item.person.id === activePersonId}
        opening={openingId === item.person.id}
        onOpen={() => openPerson(item.person.id)}
      />
    );

  const listLabel = (
    <SectionLabel
      className="px-2"
      action={
        <DropdownMenu>
          <Tooltip label="Add a friend or a group" side="right">
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Add a friend or a group"
                className="flex h-6 w-6 items-center justify-center rounded-chip text-subtle transition-colors hover:bg-secondary hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
          </Tooltip>
          <DropdownMenuContent align="start">
            {canCreateGroups ? (
              <DropdownMenuItem onSelect={() => setNewGroupOpen(true)}>
                <Users className="text-muted-foreground" />
                New group…
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={() => focusGlobalSearch()}>
              <UserPlus className="text-muted-foreground" />
              Add a friend…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }
    >
      Friends and groups
    </SectionLabel>
  );

  return (
    <section>
      <div className="relative mb-1.5">
        <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
        <Input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query) {
              event.preventDefault();
              event.stopPropagation();
              setQuery("");
            }
          }}
          aria-label="Find someone"
          placeholder="Find someone…"
          autoComplete="off"
          spellCheck={false}
          className="h-8 pl-8 text-small"
        />
      </div>

      {found ? (
        <div className="space-y-2">
          {found.rows.length || found.others.length ? (
            <div>
              {listLabel}
              <div className="space-y-px">
                {found.rows.map(row)}
                {found.others.map((conversation) => (
                  <ConversationRowCompact
                    key={conversation.id}
                    conversation={conversation}
                    active={conversation.id === activeConversationId}
                    onOpen={(id) => onNavigate({ kind: "chat", id })}
                  />
                ))}
              </div>
            </div>
          ) : null}
          {found.inTrees.length ? (
            <div>
              <SectionLabel className="px-2">In your {data.labels.treePlural.toLowerCase()}</SectionLabel>
              <div className="space-y-px">
                {found.inTrees.map(({ person, caption }) => (
                  <PersonRow
                    key={person.id}
                    row={{ kind: "person", person }}
                    data={data}
                    caption={caption}
                    active={person.id === activePersonId}
                    opening={false}
                    onOpen={() => onNavigate({ kind: "user", id: person.id })}
                  />
                ))}
              </div>
            </div>
          ) : null}
          {found.archived.length ? (
            <div>
              <SectionLabel className="px-2">Archived conversations</SectionLabel>
              <div className="space-y-px">
                {found.archived.map((conversation) => (
                  <ConversationRowCompact
                    key={conversation.id}
                    conversation={conversation}
                    active={conversation.id === activeConversationId}
                    onOpen={(id) => onNavigate({ kind: "chat", id })}
                  />
                ))}
              </div>
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => focusGlobalSearch(text)}
            className="flex h-9 w-full items-center gap-2.5 rounded-control px-2 text-left text-small text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
          >
            <Search aria-hidden className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Search everyone for “{text}”</span>
          </button>
        </div>
      ) : (
        <>
          {chat && data.user ? <SavedRow chat={chat} data={data} view={view} onNavigate={onNavigate} /> : null}
          {listLabel}
          {rows.length ? <div className="space-y-px">{rows.map(row)}</div> : <p className="px-2 py-1 text-small text-muted-foreground">Search for someone to add them as a friend.</p>}
        </>
      )}
      {chat ? (
        <NewGroupDialog
          open={newGroupOpen}
          onOpenChange={setNewGroupOpen}
          friends={friends}
          onCreate={async (name, memberIds) => {
            const conversation = await chat.createGroup(name, memberIds);
            setNewGroupOpen(false);
            onNavigate({ kind: "chat", id: conversation.id });
          }}
        />
      ) : null}
    </section>
  );
}

/** Saved messages, always first: your own face and a bookmark. It never shows a count. */
function SavedRow({ chat, data, view, onNavigate }: { chat: ChatStore; data: RavenShellData; view: RavenView; onNavigate: (view: RavenView) => void }) {
  const { open, opening, savedId } = useOpenSaved(chat, onNavigate);
  const active = view.kind === "chat" && view.id === savedId;
  return (
    <button
      type="button"
      onClick={open}
      disabled={opening}
      aria-busy={opening || undefined}
      aria-current={active ? "page" : undefined}
      className={cn("mb-px flex h-9 w-full items-center gap-2.5 rounded-control px-2 text-left transition-colors disabled:cursor-progress", active ? "bg-secondary" : "hover:bg-secondary/60")}
    >
      <SavedAvatar userId={data.user!.id} name={data.preferences.displayName || data.user!.username} className="h-6 w-6 text-[10px]" />
      <span className={cn("min-w-0 flex-1 truncate text-small text-foreground", active && "font-medium")}>Saved messages</span>
    </button>
  );
}

/** A friend (or a former friend with something unread): round avatar, presence, then unread or status. */
function PersonRow({
  row,
  data,
  caption,
  active,
  opening,
  onOpen,
}: {
  row: Extract<FriendsAndGroupsRow, { kind: "person" }>;
  data: RavenShellData;
  /** Said where their status would be, for example the tree you share. */
  caption?: string;
  active: boolean;
  opening: boolean;
  onOpen: () => void;
}) {
  const { person, conversation, former } = row;
  const unread = conversation?.unreadCount ?? 0;
  const status = former ? null : caption || personStatus(person, data);
  const away = former || reachRank(person) >= OFFLINE_RANK;
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={opening}
      aria-busy={opening || undefined}
      aria-current={active ? "page" : undefined}
      title={former ? person.name : `${person.name} · ${PRESENCE[person.presence].label}`}
      className={cn(
        "flex h-9 w-full items-center gap-2.5 rounded-control px-2 text-left transition-colors disabled:cursor-progress",
        active ? "bg-secondary" : "hover:bg-secondary/60",
      )}
    >
      <PersonAvatar
        id={person.id}
        name={person.name}
        presence={former ? undefined : person.presence}
        surface="canvas"
        className={cn("h-6 w-6", away && !unread && "opacity-60")}
      />
      <span className={cn("min-w-0 flex-1 truncate text-small", unread || active ? "font-medium text-foreground" : away ? "text-muted-foreground" : "text-foreground")}>
        <bdi>{person.name}</bdi>
      </span>
      <MutedIndicator conversation={conversation} />
      <MentionDot count={conversation?.mentionCount} />
      {unread ? <UnreadCount count={unread} /> : status ? <span className="max-w-[45%] shrink-0 truncate text-caption text-muted-foreground">{status}</span> : null}
    </button>
  );
}

/** A group: the square initials avatar and "N people" set it apart from a friend; no presence, unread on the right. */
function GroupRow({
  row,
  active,
  onOpen,
}: {
  row: Extract<FriendsAndGroupsRow, { kind: "group" }>;
  active: boolean;
  onOpen: () => void;
}) {
  const { conversation } = row;
  const unread = conversation.unreadCount > 0;
  const people = conversation.memberCount === 1 ? "1 person" : `${conversation.memberCount} people`;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={active ? "page" : undefined}
      title={`${conversation.name} · ${people}`}
      className={cn("flex h-9 w-full items-center gap-2.5 rounded-control px-2 text-left transition-colors", active ? "bg-secondary" : "hover:bg-secondary/60")}
    >
      <ConversationAvatar conversation={conversation} className="h-6 w-6 rounded-chip text-[10px]" />
      <span className={cn("min-w-0 flex-1 truncate text-small text-foreground", (unread || active) && "font-medium")}>
        <bdi>{conversation.name}</bdi>
        <span className="sr-only">, group</span>
      </span>
      <MutedIndicator conversation={conversation} />
      <MentionDot count={conversation.mentionCount} />
      {unread ? <UnreadCount count={conversation.unreadCount} /> : <span className="max-w-[45%] shrink-0 truncate text-caption text-muted-foreground">{people}</span>}
    </button>
  );
}

/**
 * A tree's text nests that need attention: those with unread messages and the one that is
 * open, in the order its owners arranged them. The rest are in the tree's lobby.
 */
export function TreeTextNests({
  chat,
  treeId,
  view,
  captions,
  onNavigate,
}: {
  chat: ChatStore;
  treeId: string;
  view: RavenView;
  /** What is on in each room now, by room id. */
  captions?: ReadonlyMap<string, string>;
  onNavigate: (view: RavenView) => void;
}) {
  const state = useChatState(chat);
  const layout = state?.layouts[treeId];
  const hasLayout = Boolean(layout);

  // The order lives with the tree's layout, fetched the first time it is needed.
  useEffect(() => {
    if (!hasLayout) void chat.loadLayout(treeId).catch(() => undefined);
  }, [chat, treeId, hasLayout]);

  const activeId = view.kind === "chat" ? view.id : "";
  const nests = useMemo(
    () => (state ? visibleTextNests(orderTextNests(textNestsOfTree(state, treeId), layout), activeId) : []),
    [state, treeId, layout, activeId],
  );
  return (
    <>
      {nests.map((conversation) => (
        <ConversationRowCompact
          key={conversation.summary.id}
          conversation={conversation.summary}
          active={conversation.summary.id === activeId}
          nested
          caption={captions?.get(conversation.summary.id)}
          onOpen={(id) => onNavigate({ kind: "chat", id })}
        />
      ))}
    </>
  );
}
