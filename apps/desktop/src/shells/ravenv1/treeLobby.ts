import type { LauncherNest, Nest, TreeDetails, TreeMember, TreeVisibility } from "@/lib/api";
import { namesSentence } from "@/lib/chat/text";
import { displayNameFor, presenceFromApi } from "./state";

export type CreateChoice = "voice" | "text" | "category";
export type MoreChoice = "arrange" | "addPerson";

/**
 * What the lobby header offers. Creating things needs `rooms.manage`, adding a person needs
 * `members.manage`: they are separate permissions, so neither hides the other's entry.
 * Text nests, categories and arranging only exist when the server has chat.
 */
export function lobbyMenus({ canRooms, canMembers, hasChat }: { canRooms: boolean; canMembers: boolean; hasChat: boolean }): { create: CreateChoice[]; more: MoreChoice[] } {
  const create: CreateChoice[] = canRooms ? (hasChat ? ["voice", "text", "category"] : ["voice"]) : [];
  const more: MoreChoice[] = [];
  if (canRooms && hasChat) more.push("arrange");
  if (canMembers) more.push("addPerson");
  return { create, more };
}

/** The header's one line, in parts so the member count can be a button on a narrow window. */
export function treeSubtitleParts({ visibility, members, inside, nestSingular }: { visibility: TreeVisibility; members: number; inside: number; nestSingular: string }) {
  return {
    visibility: visibility === "public" ? "Public" : "Private",
    members: `${members} ${members === 1 ? "member" : "members"}`,
    inside: inside > 0 ? `${inside} in a ${nestSingular}` : null,
  };
}

/** The tree's live rooms, with the launcher's richer data (who is inside) where it has it. */
export function liveTreeNests(details: Pick<TreeDetails, "activeNests">, launcher: readonly LauncherNest[]): (Nest | LauncherNest)[] {
  return details.activeNests.map((nest) => launcher.find((candidate) => candidate.id === nest.id) ?? nest);
}

export type SummaryPerson = { id: string; name: string };
export type SummaryNest = { id: string; name: string; people: SummaryPerson[] };
export type LobbySummary = { kind: "live" | "here" | "around" | "quiet"; text: string; nestId?: string };

// Three names in full; more than that shows two and the count, as "Ava, Sam and 2 others".
const names = (list: string[]) => namesSentence(list, list.length > 3 ? 2 : 3);
const isAre = (count: number) => (count === 1 ? "is" : "are");

/** Members who are reachable and not in a room: the people "around". Never offline or invisible, never yourself. */
export function peopleAround(members: readonly TreeMember[], selfId: string | undefined, insideIds: ReadonlySet<string>): SummaryPerson[] {
  return members
    .filter((member) => {
      if (member.userId === selfId || member.activeNestId || insideIds.has(member.userId)) return false;
      const presence = presenceFromApi({ state: member.presenceState, reachability: member.reachability });
      return presence === "open" || presence === "around" || presence === "focused";
    })
    .map((member) => ({ id: member.userId, name: displayNameFor(member) }));
}

/** The one sentence under the lobby header. It counts only the people it was given. */
export function lobbySummary({ nests, selfId, activeNestId, around }: { nests: readonly SummaryNest[]; selfId?: string; activeNestId?: string | null; around: readonly SummaryPerson[] }): LobbySummary {
  const inside = activeNestId ? nests.find((nest) => nest.id === activeNestId) : undefined;
  if (inside) {
    const others = inside.people.filter((person) => person.id !== selfId).map((person) => person.name);
    return { kind: "here", nestId: inside.id, text: others.length ? `You're in ${inside.name} with ${names(others)}.` : `You're in ${inside.name}.` };
  }
  if (nests.length === 1) {
    const [nest] = nests;
    const list = nest.people.map((person) => person.name);
    return { kind: "live", nestId: nest.id, text: list.length ? `${nest.name} is live. ${names(list)} ${isAre(list.length)} in it.` : `${nest.name} is live.` };
  }
  if (nests.length > 1) {
    const head = nests.length === 2 ? `${nests[0].name} and ${nests[1].name}` : `${nests[0].name}, ${nests[1].name} and ${nests.length - 2} more`;
    const count = new Set(nests.flatMap((nest) => nest.people.map((person) => person.id))).size;
    return { kind: "live", text: `${head} are live.${count ? ` ${count} ${count === 1 ? "person is" : "people are"} in them.` : ""}` };
  }
  if (around.length) {
    const list = around.map((person) => person.name);
    return { kind: "around", text: `Quiet right now. ${names(list)} ${isAre(list.length)} around.` };
  }
  return { kind: "quiet", text: "Quiet right now." };
}

export type MemberGroups = { here: TreeMember[]; around: TreeMember[] };

function rank(member: TreeMember) {
  const presence = presenceFromApi({ state: member.presenceState, reachability: member.reachability });
  if (presence === "open") return 0;
  if (presence === "around") return 1;
  if (presence === "focused") return 2;
  return 3;
}

/** People in a nest, then people who are around. Offline and invisible members are left out; Space settings › Members lists everyone. */
export function groupMembers(members: readonly TreeMember[]): MemberGroups {
  const sorted = [...members].sort((a, b) => rank(a) - rank(b) || displayNameFor(a).localeCompare(displayNameFor(b)));
  const groups: MemberGroups = { here: [], around: [] };
  for (const member of sorted) {
    const presence = presenceFromApi({ state: member.presenceState, reachability: member.reachability });
    if (presence === "offline" || presence === "invisible") continue;
    if (member.activeNestId) groups.here.push(member);
    else groups.around.push(member);
  }
  return groups;
}
