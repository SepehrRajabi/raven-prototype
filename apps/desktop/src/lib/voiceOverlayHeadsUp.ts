// Which knocks and messages reach the overlay card, and how long each one shows.
//
// Two halves. The main window works out what is *new* and keeps it for a while
// (`trackHeadsUp`, fed by `knockCandidates` and `messageCandidates`). The overlay owns the
// timing of a line on screen (`advanceHeadsUp`). Both read only the clock they are given.

import type { Knock } from "@/lib/api";
import { mentionsAsText, type MentionResolver } from "@/lib/chat/mentions";
import type { ChatState } from "@/lib/chat/types";
import { knockAge } from "@/lib/notifications";
import type { VoiceOverlayCorner, VoiceOverlayHeadsUp, VoiceOverlayMessages, VoiceOverlayResolvedShape } from "./voiceOverlay";

/** A knock stays on the card this long unless it is dismissed or answered first. */
export const KNOCK_SHOW_MS = 30_000;
/** A message is there this long. */
export const MESSAGE_SHOW_MS = 6_000;
/** After the pointer leaves a line it was resting on, it stays this much longer. */
export const HOLD_GRACE_MS = 1_500;
/** At most this many lines at once; a newer one replaces the oldest. */
export const MAX_HEADS_UP_LINES = 2;
/** How long a leaving line takes to fold away (matches `animate-pop-out`). */
export const HEADS_UP_LEAVE_MS = 160;
/** A message line is cut to this many characters. */
export const MESSAGE_TEXT_MAX = 80;

/**
 * How long the main window lists a line after first seeing it. Longer than the time it
 * shows, so a line the pointer is resting on is not pulled out from under it; the overlay
 * decides when it actually goes.
 */
export const KNOCK_LISTED_MS = 60_000;
export const MESSAGE_LISTED_MS = 20_000;

export function showMsFor(kind: VoiceOverlayHeadsUp["kind"]) {
  return kind === "knock" ? KNOCK_SHOW_MS : MESSAGE_SHOW_MS;
}

/** One thing that could be a line, whether or not it may show now. */
export interface HeadsUpCandidate {
  line: Omit<VoiceOverlayHeadsUp, "at">;
  eligible: boolean;
}

export interface TrackedLine {
  line: VoiceOverlayHeadsUp;
  seenAt: number;
}

export interface HeadsUpTracker {
  /** The first look has been taken: what was already there is old news. */
  ready: boolean;
  /** Every candidate id seen and consumed, shown or not, so it never shows twice. */
  known: ReadonlySet<string>;
  live: ReadonlyArray<TrackedLine>;
}

export const NEW_TRACKER: HeadsUpTracker = { ready: false, known: new Set(), live: [] };

/**
 * Folds the current candidates into what is listed. The first look with data (`ready`)
 * only notes what exists; after that, a candidate that is new and eligible is listed with
 * the time it was first seen. Local time only, so a wrong clock on the server changes nothing.
 */
export function trackHeadsUp(
  previous: HeadsUpTracker,
  { candidates, ready, now, listedMs }: { candidates: HeadsUpCandidate[]; ready: boolean; now: number; listedMs: number },
): HeadsUpTracker {
  if (!ready) return previous;
  const present = new Map(candidates.map((candidate) => [candidate.line.id, candidate]));
  if (!previous.ready) {
    return { ready: true, known: new Set(present.keys()), live: [] };
  }
  const live: TrackedLine[] = previous.live.filter(({ line, seenAt }) => {
    const candidate = present.get(line.id);
    return candidate != null && candidate.eligible && now - seenAt < listedMs;
  });
  const listed = new Set(live.map(({ line }) => line.id));
  for (const candidate of candidates) {
    const id = candidate.line.id;
    if (previous.known.has(id) || listed.has(id) || !candidate.eligible) continue;
    live.push({ line: { ...candidate.line, at: new Date(now).toISOString() }, seenAt: now });
  }
  const known = new Set(present.keys());
  const unchanged =
    live.length === previous.live.length &&
    live.every((entry, index) => entry === previous.live[index]) &&
    known.size === previous.known.size &&
    [...known].every((id) => previous.known.has(id));
  return unchanged ? previous : { ready: true, known, live };
}

/** When the tracker next lets go of a line, or null when it lists none. */
export function nextTrackerExpiry(tracker: HeadsUpTracker, listedMs: number): number | null {
  if (tracker.live.length === 0) return null;
  return Math.min(...tracker.live.map(({ seenAt }) => seenAt + listedMs));
}

/** Knocks people have made at you, as candidates. `enabled` is the Show knocks switch. */
export function knockCandidates({
  knocks,
  enabled,
  avatarUrl,
  now,
}: {
  knocks: ReadonlyArray<Knock>;
  enabled: boolean;
  avatarUrl: (userId: string) => string | null;
  now: number;
}): HeadsUpCandidate[] {
  return knocks.map((knock) => ({
    eligible: enabled,
    line: {
      id: knockLineId(knock.id),
      kind: "knock",
      actorName: knock.fromDisplayName || knock.fromUsername,
      avatarUrl: avatarUrl(knock.fromUserId),
      text: `knocked ${knockAge(knock.createdAt, now)}`,
      answerable: !knock.nestId,
    },
  }));
}

/**
 * Answers to knocks you sent, as lines: "Sara" + "will come at 15:32. You can knock again
 * then." Shown under the same switch as knocks. They only show; nothing is sent on dismiss.
 */
export function answerCandidates({
  answers,
  enabled,
  avatarUrl,
}: {
  answers: ReadonlyArray<{ key: string; from: string; fromId: string; context: string }>;
  enabled: boolean;
  avatarUrl: (userId: string) => string | null;
}): HeadsUpCandidate[] {
  return answers.map((answer) => ({
    eligible: enabled,
    line: {
      id: `answer:${answer.key}`,
      kind: "message",
      actorName: answer.from,
      avatarUrl: avatarUrl(answer.fromId),
      text: answer.context.startsWith(`${answer.from} `) ? answer.context.slice(answer.from.length + 1) : answer.context,
    },
  }));
}

const KNOCK_PREFIX = "knock:";

export function knockLineId(knockId: string) {
  return `${KNOCK_PREFIX}${knockId}`;
}

/** The knock a knock line stands for. */
export function knockIdOfLine(lineId: string) {
  return lineId.startsWith(KNOCK_PREFIX) ? lineId.slice(KNOCK_PREFIX.length) : null;
}

/** "Cut with …" at `max` characters, counting what people see rather than UTF-16 units. */
export function cutText(text: string, max: number) {
  const flat = text.split(/\s+/).filter(Boolean).join(" ");
  const characters = Array.from(flat);
  return characters.length <= max ? flat : `${characters.slice(0, max - 1).join("").trimEnd()}…`;
}

/**
 * The newest message of every text room, as candidates. Every room is listed so that what
 * is already there when the setting is switched on, or when the call moves to another
 * tree, counts as old. Only a text message from someone else, in a text room of the
 * call's tree, in a room that is not open in a window you are looking at, may show.
 */
export function messageCandidates({
  state,
  messages,
  treeId,
  meId,
  openConversationId,
  avatarUrl,
  resolve,
}: {
  state: ChatState | null;
  messages: VoiceOverlayMessages;
  /** The tree of the nest you are calling in; null when the call is not in a tree. */
  treeId: string | null;
  meId: string;
  /** The conversation open in a Raven window you can see. */
  openConversationId: string;
  avatarUrl: (userId: string) => string | null;
  /** Names the people and nests a message mentions. */
  resolve?: MentionResolver;
}): HeadsUpCandidate[] {
  if (!state) return [];
  const out: HeadsUpCandidate[] = [];
  for (const { summary } of Object.values(state.conversations)) {
    const last = summary.lastMessage;
    if (summary.kind !== "nest" || !last) continue;
    const excerpt = last.deleted ? "" : cutText(mentionsAsText(last.excerpt, resolve), MESSAGE_TEXT_MAX);
    const eligible =
      messages === "tree" &&
      treeId != null &&
      summary.treeId === treeId &&
      last.kind === "text" &&
      excerpt !== "" &&
      last.senderId !== meId &&
      summary.id !== openConversationId;
    out.push({
      eligible,
      line: {
        id: `message:${last.id}`,
        kind: "message",
        actorName: last.senderName,
        avatarUrl: avatarUrl(last.senderId),
        text: summary.name ? `in ${summary.name}: ${excerpt}` : excerpt,
      },
    });
  }
  return out;
}

/** Newest last, as the card lists them. */
export function mergeHeadsUp(...lists: ReadonlyArray<ReadonlyArray<TrackedLine>>): VoiceOverlayHeadsUp[] {
  return lists
    .flat()
    .sort((a, b) => a.seenAt - b.seenAt)
    .map(({ line }) => line);
}

// ---- The overlay: how long a line shows ----

export interface ShownLine {
  line: VoiceOverlayHeadsUp;
  since: number;
  /** When it started to fold away; null while it shows. */
  leavingAt: number | null;
}

export interface HeadsUpShown {
  shown: ReadonlyArray<ShownLine>;
  /** Lines that have had their time; they do not come back while the main window still lists them. */
  done: ReadonlySet<string>;
}

export const NOTHING_SHOWN: HeadsUpShown = { shown: [], done: new Set() };

/**
 * One step: new lines start showing, lines the main window no longer lists or whose time
 * is up fold away, a line the pointer rests on stays, and a third line pushes out the
 * oldest. Returns `previous` itself when nothing changed.
 */
export function advanceHeadsUp(
  previous: HeadsUpShown,
  lines: ReadonlyArray<VoiceOverlayHeadsUp>,
  now: number,
  held: ReadonlySet<string> = new Set(),
): HeadsUpShown {
  const listed = new Set(lines.map((line) => line.id));
  const done = new Set(previous.done);
  let changed = false;
  let shown: ShownLine[] = previous.shown.map((entry) => {
    if (entry.leavingAt != null) return entry;
    const limit = showMsFor(entry.line.kind);
    if (!listed.has(entry.line.id)) {
      changed = true;
      return { ...entry, leavingAt: now };
    }
    if (held.has(entry.line.id)) {
      // Resting on it keeps it, with a short grace after the pointer leaves.
      const since = Math.max(entry.since, now - (limit - HOLD_GRACE_MS));
      if (since !== entry.since) {
        changed = true;
        return { ...entry, since };
      }
      return entry;
    }
    if (now - entry.since >= limit) {
      changed = true;
      done.add(entry.line.id);
      return { ...entry, leavingAt: now };
    }
    return entry;
  });

  const present = new Set(shown.map((entry) => entry.line.id));
  for (const line of lines) {
    if (present.has(line.id) || done.has(line.id)) continue;
    shown.push({ line, since: now, leavingAt: null });
    changed = true;
  }

  const showing = shown.filter((entry) => entry.leavingAt == null);
  const excess = showing.length - MAX_HEADS_UP_LINES;
  if (excess > 0) {
    const pushedOut = new Set(showing.slice(0, excess).map((entry) => entry.line.id));
    shown = shown.map((entry) => {
      if (!pushedOut.has(entry.line.id)) return entry;
      done.add(entry.line.id);
      return { ...entry, leavingAt: now };
    });
    changed = true;
  }

  const kept = shown.filter((entry) => entry.leavingAt == null || now - entry.leavingAt < HEADS_UP_LEAVE_MS);
  if (kept.length !== shown.length) changed = true;
  for (const id of done) {
    if (!listed.has(id) && !kept.some((entry) => entry.line.id === id)) {
      done.delete(id);
      changed = true;
    }
  }
  return changed ? { shown: kept, done } : previous;
}

/** A line that was answered (Open, Dismiss) folds away now and does not come back. */
export function closeHeadsUp(previous: HeadsUpShown, id: string, now: number): HeadsUpShown {
  if (!previous.shown.some((entry) => entry.line.id === id && entry.leavingAt == null)) return previous;
  const done = new Set(previous.done).add(id);
  return {
    shown: previous.shown.map((entry) => (entry.line.id === id && entry.leavingAt == null ? { ...entry, leavingAt: now } : entry)),
    done,
  };
}

/** When `advanceHeadsUp` next has something to do, or null. */
export function nextHeadsUpWake(state: HeadsUpShown, held: ReadonlySet<string> = new Set()): number | null {
  const times = state.shown.map((entry) =>
    entry.leavingAt != null
      ? entry.leavingAt + HEADS_UP_LEAVE_MS
      : held.has(entry.line.id)
        ? null
        : entry.since + showMsFor(entry.line.kind),
  );
  const real = times.filter((time): time is number => time != null);
  return real.length ? Math.min(...real) : null;
}

/** Lines that are showing, not folding away. */
export function showingLines(state: HeadsUpShown) {
  return state.shown.filter((entry) => entry.leavingAt == null);
}

/**
 * Whether the lines go before the people. They go at the end of the card away from the
 * screen edge it is anchored to, where the card grows toward: the top of a column
 * anchored at the bottom, the left end of a row anchored at the right.
 */
export function headsUpFirst(shape: VoiceOverlayResolvedShape, corner: VoiceOverlayCorner) {
  return shape === "row" ? corner === "topRight" || corner === "bottomRight" : corner === "bottomLeft" || corner === "bottomRight";
}
