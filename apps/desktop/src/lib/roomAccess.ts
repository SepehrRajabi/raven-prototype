/**
 * Who may use which room of a space. The server decides
 * (services/api/internal/http/room_access.go); this is how its answers look.
 */

import { clockTime } from "@/lib/chat/time";
import type { TreeLabel } from "@/lib/chat/types";
import { boardTime } from "@/lib/notes";

/** "none" hides the room. "view" is reading a text room, or only listening in a voice room. */
export type RoomAccessLevel = "none" | "view" | "full";

export type RoomKind = "voice" | "text";

/** What a room tells you about your own access to it. */
export interface RoomAccess {
  level: RoomAccessLevel;
  /** When the rule that decided this ends, if it does. */
  expiresAt?: string;
  /** Whether a rule about you or about every member decided. Absent when none did. */
  source?: "person" | "everyone";
  /** Ordinary members have less than full access here. */
  limited?: boolean;
}

/** What a rule is about. `kind` is absent for a label, `targetId` for every room of a kind. */
export interface AccessTarget {
  scope: "all" | "label" | "room";
  kind?: RoomKind;
  targetId?: string;
}

export interface AccessRule extends AccessTarget {
  id: string;
  /** Absent for a rule about every member. */
  userId?: string;
  level: RoomAccessLevel;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RoomRef {
  kind: RoomKind;
  id: string;
}

export interface RoomLabels extends RoomRef {
  labelIds: string[];
}

/** Everything that decides access in one space, as its owner gets it. */
export interface TreeAccess {
  labels: TreeLabel[];
  rules: AccessRule[];
  roomLabels: RoomLabels[];
}

/** The rule that decided someone's access to a room. `targetId` is absent for a label they may not see. */
export interface DecidingRule extends AccessTarget {
  everyone: boolean;
}

/** One room as one person has it. `rule` is absent when nothing is set for it. */
export interface MemberRoomAccess extends RoomRef {
  access: RoomAccess;
  rule?: DecidingRule;
}

/** One change to the rules: every subject with every target. "clear" removes the rules. */
export interface AccessChange {
  userIds: string[];
  everyone: boolean;
  targets: AccessTarget[];
  level: RoomAccessLevel | "clear";
  /** When it ends. With `ttlSeconds` absent too, it has no end. */
  expiresAt?: string | null;
  /** How long it lasts from now, by the server's clock. Never with `expiresAt`. */
  ttlSeconds?: number;
}

export interface RoomLabelChange {
  rooms: RoomRef[];
  add: string[];
  remove: string[];
}

// The limits the server holds changes to.
export const MAX_ACCESS_SUBJECTS = 200;
export const MAX_ACCESS_TARGETS = 200;
export const MAX_LABELS = 50;
export const MAX_LABEL_NAME = 40;
const MIN_TTL_MS = 60_000;

// ---- Words ----
//
// Every surface that says what someone may do in a room takes its words from here. The
// nouns for rooms are a preference, so callers pass them in, in lower case.

export interface RoomNouns {
  one: string;
  many: string;
}

export interface AccessNames {
  nouns: RoomNouns;
  room: (room: RoomRef) => string | undefined;
  label: (id: string) => string | undefined;
}

/** "No access", "Read only", "Listen only", "Full access". Two kinds at once share one phrase. */
export function levelName(level: RoomAccessLevel, kinds: RoomKind | readonly RoomKind[]): string {
  if (level === "none") return "No access";
  if (level === "full") return "Full access";
  const list = typeof kinds === "string" ? [kinds] : kinds;
  if (list.length && list.every((kind) => kind === "text")) return "Read only";
  if (list.length && list.every((kind) => kind === "voice")) return "Listen only";
  return "Read or listen only";
}

function startOfDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** When something ends: "15:32" today, "15:32 tomorrow", then "Nov 12, 2026, 6:30 PM". Empty for a bad time. */
export function endTime(iso: string, now: number): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  const days = Math.round((startOfDay(time) - startOfDay(now)) / (24 * 60 * 60_000));
  if (days === 0) return clockTime(iso);
  if (days === 1) return `${clockTime(iso)} tomorrow`;
  return boardTime(iso);
}

/** "Until 15:32 tomorrow", or "" when there is no end. */
export function untilText(iso: string | null | undefined, now: number): string {
  const when = iso ? endTime(iso, now) : "";
  return when ? `Until ${when}` : "";
}

/** "Ava", "Ava and Sam", "Ava, Sam and 3 others". */
export function listWords(words: string[], max = 3): string {
  if (words.length <= 1) return words.join("");
  if (words.length <= max) return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
  const shown = words.slice(0, max - 1);
  const rest = words.length - shown.length;
  return `${shown.join(", ")} and ${rest} ${rest === 1 ? "other" : "others"}`;
}

/** What a rule is about, as a row says it: "All voice rooms", "Label Staff", "Standup". */
export function targetName(target: AccessTarget, names: AccessNames): string {
  const { one, many } = names.nouns;
  if (target.scope === "all") return `All ${target.kind ?? ""} ${many}`.replace("  ", " ");
  if (target.scope === "label") {
    const label = target.targetId ? names.label(target.targetId) : undefined;
    return label ? `Label ${label}` : "A label";
  }
  const room = target.kind && target.targetId ? names.room({ kind: target.kind, id: target.targetId }) : undefined;
  return room ?? (target.kind === "voice" ? `A voice ${one}` : `A text ${one}`);
}

/** The same inside a sentence: "all voice rooms", "rooms labelled Staff", "Standup". */
function targetInSentence(target: AccessTarget, names: AccessNames): string {
  const name = targetName(target, names);
  if (target.scope === "all") return name.charAt(0).toLowerCase() + name.slice(1);
  if (target.scope !== "label") return name;
  const label = target.targetId ? names.label(target.targetId) : undefined;
  return label ? `${names.nouns.many} labelled ${label}` : `${names.nouns.many} with a label`;
}

/** Which kinds of room a target reaches. A label on no room yet could reach either. */
export function targetKinds(target: AccessTarget, roomLabels: readonly RoomLabels[]): RoomKind[] {
  if (target.kind) return [target.kind];
  const kinds = new Set(roomLabels.filter((room) => target.targetId && room.labelIds.includes(target.targetId)).map((room) => room.kind));
  if (kinds.size === 0) return ["text", "voice"];
  return (["text", "voice"] as const).filter((kind) => kinds.has(kind));
}

export function kindsOf(targets: readonly AccessTarget[], roomLabels: readonly RoomLabels[]): RoomKind[] {
  const kinds = new Set(targets.flatMap((target) => targetKinds(target, roomLabels)));
  return (["text", "voice"] as const).filter((kind) => kinds.has(kind));
}

/** What a level means for the rooms chosen, under its name. */
export function levelCopy(level: AccessChange["level"], kinds: readonly RoomKind[], nouns: RoomNouns): string {
  const text = kinds.includes("text") || kinds.length === 0;
  const voice = kinds.includes("voice") || kinds.length === 0;
  if (level === "none") return voice ? "Hidden from them. If they are in the call, they are taken out." : "Hidden from them, with everything written there.";
  if (level === "view") {
    if (text && voice) return `They read text ${nouns.many} without writing, and join voice ${nouns.many} without microphone, camera or screen.`;
    return voice ? "They can join and hear. Microphone, camera and screen stay off." : "They can read, but not write.";
  }
  if (level === "full") return "Nothing is held back. Use it for an exception to a wider rule.";
  return "Removes what is set for exactly these. Wider rules apply again, or full access.";
}

const LEVEL_IN_SENTENCE: Record<RoomAccessLevel, (kinds: readonly RoomKind[]) => string> = {
  none: () => "no access to",
  view: (kinds) => `${levelName("view", kinds).toLowerCase()} in`,
  full: () => "full access to",
};
/** Rooms before labels, so that "rooms labelled Staff" does not run on into the next name. */
const SENTENCE_ORDER: Record<AccessTarget["scope"], number> = { all: 0, room: 1, label: 2 };

/** One sentence that says what a change will do: "Ava and Sam: read only in general, until 15:32." */
export function changeSummary(
  change: { everyone: boolean; people: string[]; targets: readonly AccessTarget[]; level: AccessChange["level"]; until?: string | null },
  names: AccessNames,
  roomLabels: readonly RoomLabels[],
  now: number,
): string {
  const who = change.everyone ? "Every member" : listWords(change.people);
  const targets = [...change.targets].sort((a, b) => SENTENCE_ORDER[a.scope] - SENTENCE_ORDER[b.scope]);
  const where = listWords(targets.map((target) => targetInSentence(target, names)));
  if (!who || !where) return "";
  if (change.level === "clear") return `${who}: what is set for ${where} is removed.`;
  const end = change.until ? endTime(change.until, now) : "";
  return `${who}: ${LEVEL_IN_SENTENCE[change.level](kindsOf(targets, roomLabels))} ${where}${end ? `, until ${end}` : ""}.`;
}

/** Why someone has the access they have: "Set for Ava in this room", "Set for every member, label Staff". `who` is a name, or "you". */
export function whyText(rule: DecidingRule | undefined, who: string, names: AccessNames): string {
  if (!rule) return "Nothing set";
  const subject = rule.everyone ? "every member" : who;
  if (rule.scope === "room") return `Set for ${subject} in this ${names.nouns.one}`;
  const target = targetName(rule, names);
  return `Set for ${subject}, ${target.charAt(0).toLowerCase()}${target.slice(1)}`;
}

// ---- Rules ----

export const targetKey = (target: AccessTarget) => `${target.scope}:${target.kind ?? ""}:${target.targetId ?? ""}`;
export const roomKey = (room: RoomRef) => `${room.kind}:${room.id}`;
/** The target that means one room. */
export const roomTarget = (room: RoomRef): AccessTarget => ({ scope: "room", kind: room.kind, targetId: room.id });

const ruleKey = (userId: string | undefined, target: AccessTarget) => `${userId ?? ""}|${targetKey(target)}`;

export function liveRules(rules: readonly AccessRule[], now: number): AccessRule[] {
  return rules.filter((rule) => !rule.expiresAt || Date.parse(rule.expiresAt) > now);
}

/** When the next rule ends, or null when none does. */
export function nextEnd(rules: readonly AccessRule[], now: number): number | null {
  const ends = rules.flatMap((rule) => (rule.expiresAt ? [Date.parse(rule.expiresAt)] : [])).filter((end) => end > now);
  return ends.length ? Math.min(...ends) : null;
}

const LEVEL_RANK: Record<RoomAccessLevel, number> = { none: 0, view: 1, full: 2 };
const SCOPE_RANK: Record<AccessTarget["scope"], number> = { all: 1, label: 2, room: 3 };

function covers(target: AccessTarget, room: RoomRef, roomLabels: readonly RoomLabels[]): boolean {
  if (target.scope === "all") return target.kind === room.kind;
  if (target.scope === "room") return target.kind === room.kind && target.targetId === room.id;
  return roomLabels.some((entry) => entry.kind === room.kind && entry.id === room.id && Boolean(target.targetId) && entry.labelIds.includes(target.targetId!));
}

/**
 * What an ordinary member with no rule of their own may do in a room. The server decides
 * (`accessModel.resolve` in room_access.go); this is only for saying beforehand what a
 * change would hide.
 */
export function everyMemberLevel(access: Pick<TreeAccess, "rules" | "roomLabels">, room: RoomRef, now: number): RoomAccessLevel {
  const matching = liveRules(access.rules, now).filter((rule) => !rule.userId && covers(rule, room, access.roomLabels));
  matching.sort((a, b) => SCOPE_RANK[b.scope] - SCOPE_RANK[a.scope] || LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);
  return matching[0]?.level ?? "full";
}

/** The rooms a change takes away from every member that they have now. */
export function newlyHidden(before: Pick<TreeAccess, "rules" | "roomLabels">, after: Pick<TreeAccess, "rules" | "roomLabels">, rooms: readonly RoomRef[], now: number): RoomRef[] {
  return rooms.filter((room) => everyMemberLevel(before, room, now) !== "none" && everyMemberLevel(after, room, now) === "none");
}

/** The rules a change would replace or remove. */
export function replacedRules(rules: readonly AccessRule[], change: Pick<AccessChange, "userIds" | "everyone" | "targets">): AccessRule[] {
  const subjects = [...(change.everyone ? [undefined] : []), ...change.userIds];
  const keys = new Set(subjects.flatMap((userId) => change.targets.map((target) => ruleKey(userId, target))));
  return rules.filter((rule) => keys.has(ruleKey(rule.userId, rule)));
}

/** The rules as a change would leave them. */
export function withChange(rules: readonly AccessRule[], change: AccessChange): AccessRule[] {
  const replaced = new Set(replacedRules(rules, change));
  const kept = rules.filter((rule) => !replaced.has(rule));
  const level = change.level;
  if (level === "clear") return kept;
  const at = new Date(0).toISOString();
  const subjects = [...(change.everyone ? [undefined] : []), ...change.userIds];
  return [
    ...kept,
    ...subjects.flatMap((userId) => change.targets.map((target) => ({ ...target, id: ruleKey(userId, target), userId, level, createdAt: at, updatedAt: at }))),
  ];
}

/** The rooms' labels as a change would leave them. */
export function withRoomLabels(roomLabels: readonly RoomLabels[], change: RoomLabelChange): RoomLabels[] {
  const byRoom = new Map(roomLabels.map((room) => [roomKey(room), room]));
  for (const room of change.rooms) {
    const labelIds = new Set(byRoom.get(roomKey(room))?.labelIds ?? []);
    for (const id of change.remove) labelIds.delete(id);
    for (const id of change.add) labelIds.add(id);
    byRoom.set(roomKey(room), { kind: room.kind, id: room.id, labelIds: [...labelIds] });
  }
  return [...byRoom.values()];
}

/** The rules of one subject. `userId` is absent for every member. */
export interface RuleGroup {
  userId?: string;
  rules: AccessRule[];
}

/**
 * The rules as the list shows them: every member first, then people in the order given.
 * Inside a group, the widest first: every room of a kind, labels, then rooms in the order given.
 */
export function ruleGroups(rules: readonly AccessRule[], order: { people: readonly string[]; labels: readonly string[]; rooms: readonly RoomRef[] }): RuleGroup[] {
  const people = new Map(order.people.map((id, index) => [id, index]));
  const labels = new Map(order.labels.map((id, index) => [id, index]));
  const rooms = new Map(order.rooms.map((room, index) => [roomKey(room), index]));
  const last = Number.MAX_SAFE_INTEGER;
  const place = (rule: AccessRule) => {
    if (rule.scope === "all") return rule.kind === "text" ? 0 : 1;
    if (rule.scope === "label") return labels.get(rule.targetId ?? "") ?? last;
    return rooms.get(`${rule.kind}:${rule.targetId}`) ?? last;
  };
  const groups = new Map<string, AccessRule[]>();
  for (const rule of rules) groups.set(rule.userId ?? "", [...(groups.get(rule.userId ?? "") ?? []), rule]);
  return [...groups]
    .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : (people.get(a) ?? last) - (people.get(b) ?? last) || a.localeCompare(b)))
    .map(([userId, list]) => ({
      ...(userId ? { userId } : {}),
      rules: [...list].sort((a, b) => SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope] || place(a) - place(b) || a.id.localeCompare(b.id)),
    }));
}

/** Keeps the groups and rules that match what was typed: a person keeps all of theirs, a target only its own rows. */
export function filterGroups(groups: readonly RuleGroup[], query: string, personName: (userId: string | undefined) => string, names: AccessNames): RuleGroup[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...groups];
  return groups.flatMap((group) => {
    if (personName(group.userId).toLocaleLowerCase().includes(needle)) return [group];
    const rules = group.rules.filter((rule) => targetName(rule, names).toLocaleLowerCase().includes(needle));
    return rules.length ? [{ ...group, rules }] : [];
  });
}

// ---- Choosing an end ----

export type EndChoice = "none" | "hour" | "day" | "week" | "month" | "date" | "keep";

export const END_CHOICES: readonly { id: Exclude<EndChoice, "keep">; label: string }[] = [
  { id: "none", label: "No end" },
  { id: "hour", label: "1 hour" },
  { id: "day", label: "1 day" },
  { id: "week", label: "1 week" },
  { id: "month", label: "1 month" },
  { id: "date", label: "Date and time…" },
];

/** The moment a choice ends, or null for no end. `date` and `keep` take the time given. */
export function endOf(choice: EndChoice, given: string | null, now: number): string | null {
  if (choice === "none") return null;
  if (choice === "date" || choice === "keep") return given;
  const end = new Date(now);
  if (choice === "hour") end.setTime(now + 3_600_000);
  else if (choice === "day") end.setDate(end.getDate() + 1);
  else if (choice === "week") end.setDate(end.getDate() + 7);
  else {
    const day = end.getDate();
    end.setMonth(end.getMonth() + 1);
    // 31 January plus a month is the last day of February, not a day in March.
    if (end.getDate() !== day) end.setDate(0);
  }
  return end.toISOString();
}

/** A duration is sent as one, so that it counts by the server's clock; a date is sent as it is. */
export function endPayload(choice: EndChoice, given: string | null, now: number): Pick<AccessChange, "expiresAt" | "ttlSeconds"> {
  const end = endOf(choice, given, now);
  if (!end) return {};
  if (choice === "date" || choice === "keep") return { expiresAt: end };
  return { ttlSeconds: Math.round((Date.parse(end) - now) / 1000) };
}

/** What is missing or wrong in a change, as a sentence, or "" when it can be saved. */
export function changeProblem(
  change: { everyone: boolean; userIds: readonly string[]; targets: readonly AccessTarget[]; end: EndChoice; endAt: string | null; level: AccessChange["level"] },
  nouns: RoomNouns,
  now: number,
): string {
  if (!change.everyone && change.userIds.length === 0) return "Choose at least one person.";
  if (change.userIds.length > MAX_ACCESS_SUBJECTS) return `Choose at most ${MAX_ACCESS_SUBJECTS} people.`;
  if (change.targets.length === 0) return `Choose at least one ${nouns.one} or label.`;
  if (change.targets.length > MAX_ACCESS_TARGETS) return `Choose at most ${MAX_ACCESS_TARGETS} ${nouns.many} and labels.`;
  if (change.level === "clear" || change.end === "none") return "";
  const end = endOf(change.end, change.endAt, now);
  const time = end ? Date.parse(end) : Number.NaN;
  if (!Number.isFinite(time)) return "Pick when it ends.";
  if (time - now < MIN_TTL_MS) return "Pick an end at least a minute from now.";
  const limit = new Date(now);
  limit.setFullYear(limit.getFullYear() + 5);
  if (time > limit.getTime()) return "Pick an end within five years.";
  return "";
}

// ---- Labels ----

/** What is wrong with a label's name, or "". `except` is the label being renamed. */
export function labelNameProblem(name: string, labels: readonly TreeLabel[], except?: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "Write a name.";
  if ([...trimmed].length > MAX_LABEL_NAME) return `Use at most ${MAX_LABEL_NAME} characters.`;
  const same = labels.some((label) => label.id !== except && label.name.trim().toLocaleLowerCase() === trimmed.toLocaleLowerCase());
  return same ? "Another label has that name." : "";
}

/** How many rooms carry a label. */
export function labelRoomCount(labelId: string, roomLabels: readonly RoomLabels[]): number {
  return roomLabels.filter((room) => room.labelIds.includes(labelId)).length;
}

/** How many rules are about a label, which go with it. */
export function labelRuleCount(labelId: string, rules: readonly AccessRule[]): number {
  return rules.filter((rule) => rule.scope === "label" && rule.targetId === labelId).length;
}

/** The rules and rooms as deleting a label would leave them. */
export function withoutLabel(access: Pick<TreeAccess, "rules" | "roomLabels">, labelId: string): Pick<TreeAccess, "rules" | "roomLabels"> {
  return {
    rules: access.rules.filter((rule) => rule.scope !== "label" || rule.targetId !== labelId),
    roomLabels: access.roomLabels.map((room) => ({ ...room, labelIds: room.labelIds.filter((id) => id !== labelId) })),
  };
}

/** What deleting a label takes with it, and what that hides or opens, before it is confirmed. */
export function labelDeleteCopy(labelId: string, access: Pick<TreeAccess, "rules" | "roomLabels">, rooms: readonly RoomRef[], names: AccessNames, now: number): string {
  const { one, many } = names.nouns;
  const roomCount = labelRoomCount(labelId, access.roomLabels);
  const ruleCount = labelRuleCount(labelId, access.rules);
  const after = withoutLabel(access, labelId);
  const hidden = newlyHidden(access, after, rooms, now);
  const opened = newlyHidden(after, access, rooms, now);
  const list = (refs: RoomRef[]) => listWords(refs.map((room) => names.room(room) ?? `a ${one}`));
  return [
    roomCount ? `It comes off ${roomCount} ${roomCount === 1 ? one : many}.` : `No ${one} has it.`,
    ruleCount ? `${ruleCount === 1 ? "The rule" : `The ${ruleCount} rules`} about it ${ruleCount === 1 ? "goes" : "go"} too.` : "",
    opened.length ? `Every member can then see ${list(opened)}.` : "",
    hidden.length ? `Every member then loses ${list(hidden)}.` : "",
  ].filter(Boolean).join(" ");
}

/** The warning before a change hides rooms from every member. */
export function hideCopy(hidden: readonly RoomRef[], names: AccessNames): { title: string; text: string } {
  const list = listWords(hidden.map((room) => names.room(room) ?? `a ${names.nouns.one}`), 4);
  const one = hidden.length === 1;
  return {
    title: one ? `Hide ${list} from every member?` : `Hide ${hidden.length} ${names.nouns.many} from every member?`,
    text: `${one ? "It disappears" : `${list} disappear`} for everyone but you, moderators, and people with a rule of their own that says otherwise. Members inside are taken out.`,
  };
}
