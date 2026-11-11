import type { ChatConversation, ConversationState } from "@/lib/chat/types";
import { OFFLINE_RANK, reachRank } from "./people";
import type { ShellPerson } from "./state";

/** How many groups the sidebar lists; the rest are found by name in the find field. */
export const GROUPS_SHOWN = 6;
/** A group with no unread messages stays in the sidebar this long after it was last active. */
export const GROUP_RECENT_MS = 14 * 24 * 60 * 60 * 1000;

export type FriendsAndGroupsRow =
  | {
      kind: "person";
      person: ShellPerson;
      /** The direct message with them, when there is one. */
      conversation?: ChatConversation;
      /** Not a friend any more: shown only while something is unread, without presence. */
      former?: boolean;
    }
  | { kind: "group"; conversation: ChatConversation };

export interface FriendsAndGroups {
  /** Always shown, in order. */
  shown: FriendsAndGroupsRow[];
  /** Offline friends with nothing unread, last in the list and dimmed. */
  offline: FriendsAndGroupsRow[];
}

const byReach = (a: ShellPerson, b: ShellPerson) => reachRank(a) - reachRank(b) || a.name.localeCompare(b.name);

/**
 * Friends and groups as one live map, not an inbox: friends keep their place when a
 * message arrives. Reachable friends come first, then groups that are unread or were
 * active recently, then offline friends behind a disclosure. Unread is never hidden: an offline
 * friend with unread messages is lifted into the list, and a direct message with someone
 * who is no longer a friend shows while it has unread messages.
 */
export function friendsAndGroups({
  friends,
  conversations,
  personFor,
  activeConversationId = "",
  now,
}: {
  friends: ShellPerson[];
  /** Direct messages and groups that are not archived. */
  conversations: ChatConversation[];
  /** Looks up someone who is not a friend, for a former friend's direct message. */
  personFor: (id: string, name: string) => ShellPerson;
  activeConversationId?: string;
  now: number;
}): FriendsAndGroups {
  const dmByPeer = new Map<string, ChatConversation>();
  for (const conversation of conversations) {
    if (conversation.kind === "dm" && conversation.peer) dmByPeer.set(conversation.peer.id, conversation);
  }

  const friendIds = new Set(friends.map((person) => person.id));
  const sorted = [...friends].sort(byReach);
  const reachable: FriendsAndGroupsRow[] = [];
  const lifted: FriendsAndGroupsRow[] = [];
  const offline: FriendsAndGroupsRow[] = [];
  for (const person of sorted) {
    const conversation = dmByPeer.get(person.id);
    const row: FriendsAndGroupsRow = { kind: "person", person, conversation };
    if (reachRank(person) < OFFLINE_RANK) reachable.push(row);
    else if ((conversation?.unreadCount ?? 0) > 0 || (conversation && conversation.id === activeConversationId)) lifted.push(row);
    else offline.push(row);
  }

  const former: FriendsAndGroupsRow[] = conversations
    .filter((conversation) => conversation.kind === "dm" && conversation.peer && !friendIds.has(conversation.peer.id))
    .filter((conversation) => conversation.unreadCount > 0 || conversation.id === activeConversationId)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((conversation) => ({ kind: "person", person: personFor(conversation.peer!.id, conversation.name), conversation, former: true }));

  const groups = conversations
    .filter((conversation) => conversation.kind === "group")
    .filter((conversation) => conversation.unreadCount > 0 || conversation.id === activeConversationId || now - conversation.lastActivityMs < GROUP_RECENT_MS)
    .sort((a, b) => b.lastActivityMs - a.lastActivityMs || a.id.localeCompare(b.id));
  // Unread and the open group always make the cut; the rest fill what is left.
  const must = groups.filter((conversation) => conversation.unreadCount > 0 || conversation.id === activeConversationId);
  const rest = groups.filter((conversation) => !must.includes(conversation)).slice(0, Math.max(0, GROUPS_SHOWN - must.length));
  const keep = new Set([...must, ...rest]);
  const groupRows: FriendsAndGroupsRow[] = groups.filter((conversation) => keep.has(conversation)).map((conversation) => ({ kind: "group", conversation }));

  // Offline people lifted for their unread messages sit just above the disclosure they
  // were lifted out of.
  return { shown: [...reachable, ...groupRows, ...lifted, ...former], offline };
}

export interface PeopleFilter {
  /** Friends and groups whose name matches. */
  rows: FriendsAndGroupsRow[];
  /** People you share a tree with who are not friends, each with the first tree you share. */
  inTrees: { person: ShellPerson; caption: string }[];
  /** Groups and direct messages that match but are not in the list (quiet groups, former friends). */
  others: ChatConversation[];
  /** Archived conversations whose name matches. */
  archived: ChatConversation[];
}

/**
 * What typing in the sidebar's find field leaves: the friends and groups that match, the
 * people from your trees, and the archived conversations. Names are matched anywhere in the
 * word, ignoring case; a person is also matched by their handle.
 */
export function filterPeople({
  query,
  rows,
  people,
  others,
  archived,
  treeName,
}: {
  query: string;
  /** Every friends-and-groups row, offline friends included. */
  rows: readonly FriendsAndGroupsRow[];
  /** Everyone this client knows. Friends in it are left out of `inTrees`. */
  people: readonly ShellPerson[];
  /** Conversations that are not archived and not among `rows`. */
  others: readonly ChatConversation[];
  archived: readonly ChatConversation[];
  treeName: (treeId: string) => string;
}): PeopleFilter {
  const needle = query.trim().replace(/^@/, "").toLocaleLowerCase();
  if (!needle) return { rows: [...rows], inTrees: [], others: [], archived: [] };
  const has = (text?: string) => Boolean(text && text.toLocaleLowerCase().includes(needle));
  return {
    rows: rows.filter((row) => (row.kind === "group" ? has(row.conversation.name) : has(row.person.name) || has(row.person.username))),
    inTrees: people
      .filter((person) => person.relationship === "context" && (has(person.name) || has(person.username)))
      .sort(byReach)
      .map((person) => ({ person, caption: person.treeIds[0] ? treeName(person.treeIds[0]) : "" })),
    others: others.filter((conversation) => has(conversation.name)),
    archived: archived.filter((conversation) => has(conversation.name)),
  };
}

/** Whether a row has anything unread. */
export function rowUnread(row: FriendsAndGroupsRow): number {
  return row.conversation?.unreadCount ?? 0;
}

/**
 * The text nests an expanded tree lists: those with unread messages and the one that is
 * open. The rest are in the tree's lobby. Keeps the order it is given.
 */
export function visibleTextNests(nests: ConversationState[], activeConversationId = ""): ConversationState[] {
  return nests.filter(({ summary }) => summary.unreadCount > 0 || summary.id === activeConversationId);
}
