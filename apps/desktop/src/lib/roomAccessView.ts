// What a person is told about their own access to a room, and what the app does when it
// changes. The rules themselves and their words for the owner are in roomAccess.ts.

import type { Nest, ParticipantSummary } from "@/lib/api";
import type { TreeLabel, TreeLayout } from "@/lib/chat/types";
import { untilText, type RoomAccess, type RoomKind } from "@/lib/roomAccess";

// ---- Reading the layout ----

/** The labels of a room that this person may see, in the owner's order. */
export function labelsOfRoom(layout: TreeLayout | undefined, kind: RoomKind, id: string): TreeLabel[] {
  const ids = layout?.items.find((item) => item.kind === kind && item.id === id)?.labelIds;
  if (!ids?.length || !layout?.labels?.length) return [];
  return layout.labels.filter((label) => ids.includes(label.id)).sort((a, b) => a.position - b.position);
}

/** Your access to a room: from the room itself where it says, otherwise from the layout. */
export function accessOfRoom(layout: TreeLayout | undefined, kind: RoomKind, id: string, own?: RoomAccess): RoomAccess | undefined {
  return own ?? layout?.items.find((item) => item.kind === kind && item.id === id)?.access;
}

/** A voice room's access from whichever copy of the room carries it. */
export function voiceAccess(id: string, copies: readonly (Pick<Nest, "id" | "access"> | undefined)[]): RoomAccess | undefined {
  return copies.find((nest) => nest?.id === id && nest.access)?.access;
}

// ---- Words ----

/** Said before joining, and again by any control that would send something. */
export const LISTEN_ONLY_LINE = "You can listen here. Your microphone, camera and screen stay off.";

const VIEW_LINE: Record<RoomKind, string> = {
  text: "You can read here, but not write.",
  voice: LISTEN_ONLY_LINE,
};

/** "Until 15:32 tomorrow". Empty with no end, and once the end has passed: the server says what follows. */
export function accessUntil(access: RoomAccess | undefined, now: number): string {
  if (!access?.expiresAt || !(Date.parse(access.expiresAt) > now)) return "";
  return untilText(access.expiresAt, now);
}

/** Who a limit was set for, and when it ends: "Set for you by the owner. Until 15:32 tomorrow." */
export function accessReason(access: RoomAccess | undefined, now: number): string {
  const source = access?.source === "person" ? "Set for you by the owner." : access?.source === "everyone" ? "Set for all members." : "";
  const until = accessUntil(access, now);
  return [source, until ? `${until}.` : ""].filter(Boolean).join(" ");
}

/** What you can do in a room you don't have in full. Null when nothing is limited for you. */
export function viewNote(access: RoomAccess | undefined, kind: RoomKind, now: number): { line: string; reason: string } | null {
  if (access?.level !== "view") return null;
  return { line: VIEW_LINE[kind], reason: accessReason(access, now) };
}

/** What you can't do in a room, in two words. Null when you have it in full. */
export function ownLimit(access: RoomAccess | undefined, kind: RoomKind): string | null {
  if (access?.level !== "view") return null;
  return kind === "text" ? "Read only" : "Listen only";
}

/**
 * Said in a room that an ordinary member cannot use in full, which can mean hidden or only
 * readable, so it does not say which. Empty for a room open to everyone in the space.
 */
export function boundaryLine(access: RoomAccess | undefined): string {
  return access?.limited ? "Not fully open to every member" : "";
}

/** A label's tooltip. Only the owner is ever sent a label that is not visible. */
export function labelNote(label: TreeLabel): string {
  return label.visible ? label.name : `${label.name}. Only you can see this label.`;
}

// ---- In a call ----

/**
 * Whether you may only listen in a voice room. The room and the call each say; either saying
 * so is enough. Undefined against a server that has no such rule.
 */
export function listensOnly(access: RoomAccess | undefined, participants: readonly ParticipantSummary[] | undefined, userId: string | undefined): boolean | undefined {
  const own = userId ? participants?.find((participant) => participant.userId === userId) : undefined;
  if (access?.level === "view" || own?.listenOnly === true) return true;
  return access || typeof own?.listenOnly === "boolean" ? false : undefined;
}

export const LISTEN_ONLY_TITLE = "You can only listen here";

/** What someone else has taken away from you in a call, the most limiting first. */
export type CallLimit = "none" | "muted" | "listen" | "deafened";

export function callLimit({ listenOnly, muted, deafened }: { listenOnly: boolean; muted: boolean; deafened: boolean }): CallLimit {
  if (deafened) return "deafened";
  if (listenOnly) return "listen";
  return muted ? "muted" : "none";
}

/** Told once, when a limit changes during a call. */
export function limitNotice(from: CallLimit, to: CallLimit): { title: string; description?: string } | null {
  if (from === to) return null;
  if (to === "deafened") return { title: "A moderator deafened you", description: "You can’t hear anyone, and they can’t hear you." };
  if (from === "deafened" && to === "muted") return { title: "You can hear people again" };
  if (from === "deafened" && to === "listen") return { title: "You can hear people again", description: "You can only listen here." };
  if (to === "listen") return { title: "You can only listen here now", description: "Your microphone, camera and screen are off. Nobody here can hear or see you." };
  if (to === "muted") return { title: "A moderator muted you", description: "People here can’t hear you." };
  if (from === "listen") return { title: "You can take part here again", description: "Your microphone and camera stay off until you turn them on." };
  return { title: "You can talk again", description: "Your mic stays off until you turn it on." };
}

/** Refusals that say nothing about the room: knocking or a new password would change them. */
const REFUSALS_THAT_PASS = new Set(["knock_required", "password_change_required"]);

/**
 * The server will not let this person into the room, and trying again will not change that.
 * A dropped connection or a busy server is not a refusal.
 */
export function refusedForGood(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { status, reasonCode } = error as { status?: unknown; reasonCode?: unknown };
  if (status === 404 || status === 410) return true;
  return status === 403 && !(typeof reasonCode === "string" && REFUSALS_THAT_PASS.has(reasonCode));
}

// ---- Losing a room ----

/** A room that is on screen, or that the call is in. */
export interface SeenRoom {
  kind: RoomKind;
  id: string;
  treeId: string;
  name: string;
}

/** How long after "access changed" a room that goes missing counts as lost to it. */
export const ACCESS_CHANGE_WINDOW_MS = 30_000;

/**
 * Whether a room went because this person may no longer use it. A room can also be deleted,
 * or its space left; those have their own words. `treeKnown` is false while the space's
 * details could not be fetched, when a missing room means nothing.
 */
export function lostToAccess({ there, treeKnown, changedAt, now }: { there: boolean; treeKnown: boolean; changedAt: number | undefined; now: number }): boolean {
  return !there && treeKnown && changedAt !== undefined && now - changedAt <= ACCESS_CHANGE_WINDOW_MS;
}

/** Isolated, so a right-to-left name does not reorder the sentence around it. */
export function lostRoomTitle(name: string): string {
  return `You no longer have access to ⁨${name}⁩.`;
}
