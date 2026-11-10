// Scheduled events on the space board. Times show in the viewer's own zone, never with a
// zone name; repeats are a small subset of RFC 5545 that the server also checks.
import type { TreeEvent } from "./api";
import { boardTime } from "./notes";

/** How long a room says "starting now" after an occurrence begins. */
export const STARTING_NOW_MS = 15 * 60_000;
/** How far ahead the lobby's "Upcoming" line looks. */
export const UPCOMING_MS = 30 * 24 * 60 * 60_000;

export type RepeatFreq = "never" | "daily" | "weekly" | "monthly";

export interface RepeatRule {
  freq: RepeatFreq;
  interval: number;
  /** Weekly only: 0 Sunday … 6 Saturday, as `Date.getDay()`. */
  days: number[];
  /** Repeats until this ISO time, or this many times, or forever when both are null. */
  until: string | null;
  count: number | null;
}

const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "long" });
/** 2026-11-01 is a Sunday, so day i of the week is the 1st plus i. */
const dayName = (day: number) => WEEKDAY.format(new Date(2026, 10, 1 + day));

export function parseRule(rrule: string | null): RepeatRule {
  const rule: RepeatRule = { freq: "never", interval: 1, days: [], until: null, count: null };
  if (!rrule) return rule;
  for (const part of rrule.split(";")) {
    const [key, value = ""] = part.split("=");
    switch (key?.toUpperCase()) {
      case "FREQ":
        rule.freq = value === "DAILY" ? "daily" : value === "WEEKLY" ? "weekly" : value === "MONTHLY" ? "monthly" : "never";
        break;
      case "INTERVAL":
        rule.interval = Math.max(1, Number.parseInt(value, 10) || 1);
        break;
      case "BYDAY":
        rule.days = value.split(",").map((code) => DAY_CODES.indexOf(code)).filter((day) => day >= 0);
        break;
      case "COUNT":
        rule.count = Number.parseInt(value, 10) || null;
        break;
      case "UNTIL": {
        const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
        rule.until = match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z` : null;
        break;
      }
    }
  }
  return rule;
}

/** The rule as the server takes it, or null for a one-off. */
export function buildRule(rule: RepeatRule): string | null {
  if (rule.freq === "never") return null;
  const parts = [`FREQ=${rule.freq.toUpperCase()}`];
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.freq === "weekly" && rule.days.length) parts.push(`BYDAY=${[...new Set(rule.days)].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((day) => DAY_CODES[day]).join(",")}`);
  if (rule.until) {
    const until = new Date(rule.until);
    if (Number.isFinite(until.getTime())) parts.push(`UNTIL=${until.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`);
  } else if (rule.count) {
    parts.push(`COUNT=${rule.count}`);
  }
  return parts.join(";");
}

function listOf(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** "Every week", "Every 2 weeks on Monday and Thursday"; empty for a one-off. */
export function repeatText(rrule: string | null): string {
  const rule = parseRule(rrule);
  if (rule.freq === "never") return "";
  const unit = rule.freq === "daily" ? "day" : rule.freq === "weekly" ? "week" : "month";
  let text = rule.interval > 1 ? `Every ${rule.interval} ${unit}s` : `Every ${unit}`;
  if (rule.freq === "weekly" && rule.days.length > 1) {
    const days = [...new Set(rule.days)].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    text += ` on ${listOf(days.map(dayName))}`;
  }
  return text;
}

/** "Nov 12, 2026, 6:30 PM · Standup": the occurrence under way or next, and its room. */
export function eventWhen(event: TreeEvent): string {
  return [boardTime(event.occurrence.startsAt), event.roomName].filter(Boolean).join(" · ");
}

function bounds(event: TreeEvent): [number, number] {
  return [Date.parse(event.occurrence.startsAt), Date.parse(event.occurrence.endsAt)];
}

/** Events not yet over; the server drops the rest, this keeps an open lobby honest. */
export function liveEvents(events: TreeEvent[] | undefined, now = Date.now()): TreeEvent[] {
  return (events ?? []).filter((event) => bounds(event)[1] > now);
}

/** Events on the lobby's pinned list. */
export function pinnedEvents(events: TreeEvent[] | undefined, now = Date.now()): TreeEvent[] {
  return liveEvents(events, now).filter((event) => event.pinned);
}

/** Events not pinned that start in the next 30 days or are under way, soonest first. */
export function upcomingEvents(events: TreeEvent[] | undefined, now = Date.now()): TreeEvent[] {
  return liveEvents(events, now)
    .filter((event) => !event.pinned && bounds(event)[0] < now + UPCOMING_MS)
    .sort((a, b) => bounds(a)[0] - bounds(b)[0]);
}

/**
 * What a room shows while one of its events is on: "{title} · starting now" for the first
 * 15 minutes, then the title until it ends. Keyed by nest or text room id.
 */
export function roomEventCaptions(events: TreeEvent[] | undefined, now = Date.now()): Map<string, string> {
  const captions = new Map<string, string>();
  for (const event of events ?? []) {
    const [start, end] = bounds(event);
    if (!(start <= now && now < end)) continue;
    const room = event.nestId ?? event.conversationId;
    if (!room || captions.has(room)) continue;
    captions.set(room, now - start < STARTING_NOW_MS ? `${event.title} · starting now` : event.title);
  }
  return captions;
}

/** How many people Raven writes to when an event is saved: the invitees except you. */
export function inviteMessageCount(input: { inviteAll: boolean; inviteeIds: string[] }, memberIds: string[], selfId: string | undefined): number {
  const ids = input.inviteAll ? memberIds : input.inviteeIds;
  return new Set(ids.filter((id) => id !== selfId)).size;
}
