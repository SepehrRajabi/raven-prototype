// Pinned messages in text rooms: who may pin, and how a pin is described.
//
// Pins exist only in a space's text rooms. People who manage the room pin and unpin;
// the author of a message may also unpin their own. The server has the final say on
// every request. Keeping the list in step with incoming messages is in `reducer.ts`.

import { messageExcerpt, summaryOf } from "./attachments";
import { excerptOf } from "./reducer";
import { listTime, fullTime } from "./time";
import type { ChatMessage, ChatPin } from "./types";

export interface PinLimits {
  /** How many messages one room can have pinned at once. */
  max: number;
}

/** What this server allows, or null when it has no pins (an older server): then no pin UI at all. */
export function pinLimits(properties: Record<string, unknown> | undefined): PinLimits | null {
  const chat = properties?.chat;
  const raw = chat && typeof chat === "object" && !Array.isArray(chat) ? (chat as Record<string, unknown>).pins : undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const max = (raw as Record<string, unknown>).max;
  return typeof max === "number" && Number.isInteger(max) && max > 0 ? { max } : null;
}

export interface PinRights {
  /** The viewer may pin here: they run the room, or the room lets members pin. */
  canPin: boolean;
  /** The viewer runs the room: they may unpin anything. */
  canManage: boolean;
  /** The viewer can write here: needed to take off a pin they made. */
  canWrite: boolean;
  /** The viewer's own id. */
  me: string;
}

/**
 * Which of Pin and Unpin a message's menu offers. Anyone who may pin pins; whoever runs
 * the room unpins anything; the author may unpin their own message; whoever made a pin
 * may take it off while they can write. Only text messages that are still there can be
 * pinned; the caller decides whether the room has pins at all.
 */
export function pinActions(message: Pick<ChatMessage, "kind" | "deletedAt" | "pin" | "senderId">, { canPin, canManage, canWrite, me }: PinRights): { pin: boolean; unpin: boolean } {
  if (message.kind !== "text" || message.deletedAt) return { pin: false, unpin: false };
  if (!message.pin) return { pin: canPin, unpin: false };
  const mine = message.senderId === me;
  const madeIt = message.pin.byId === me && canWrite;
  return { pin: false, unpin: canManage || mine || madeIt };
}

/** "Pinned by Sara" or "Pinned by you". */
function pinnedBy(pin: ChatPin, me: string): string {
  return `Pinned by ${pin.byId === me ? "you" : pin.byName || "someone"}`;
}

/** "Pinned by Sara · 11 October 2026, 10:42": the tooltip on a pinned message. */
export function pinTooltip(pin: ChatPin, me: string): string {
  const at = fullTime(pin.at);
  return at ? `${pinnedBy(pin, me)} · ${at}` : pinnedBy(pin, me);
}

/** "Pinned by Sara · Mon": the quiet line under an entry of the pinned list. */
export function pinLine(pin: ChatPin, me: string, now = Date.now()): string {
  const at = listTime(Date.parse(pin.at), now);
  return at ? `${pinnedBy(pin, me)} · ${at}` : pinnedBy(pin, me);
}

/** The one line that stands for a pinned message: its text, or what it holds ("Photo"). */
export function pinExcerpt(message: ChatMessage): string {
  return messageExcerpt(excerptOf(message.body), summaryOf(message));
}
