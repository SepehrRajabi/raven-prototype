import type { ParticipantVoiceActivityMap } from "@/lib/speakingActivity";

/** The parts of a live nest that decide where its card goes. */
export interface LiveNestLike {
  id: string;
  createdAt: string;
  currentParticipants: readonly { userId: string }[];
}

const timeOf = (value: string) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * The nests for the Live strip, in card order: yours first, then those with a friend
 * inside, then the rest by when they started. A nest listed as active and as temporary
 * appears once.
 */
export function orderLiveNests<T extends LiveNestLike>({
  active,
  temporary,
  hereId,
  friendIds,
}: {
  active: readonly T[];
  temporary: readonly T[];
  /** The nest you are in, if any. */
  hereId?: string | null;
  friendIds: ReadonlySet<string>;
}): T[] {
  const seen = new Set<string>();
  const nests: T[] = [];
  for (const nest of [...active, ...temporary]) {
    if (seen.has(nest.id)) continue;
    seen.add(nest.id);
    nests.push(nest);
  }
  const rank = (nest: T) => (nest.id === hereId ? 0 : nest.currentParticipants.some((participant) => friendIds.has(participant.userId)) ? 1 : 2);
  return nests.sort((a, b) => rank(a) - rank(b) || timeOf(a.createdAt) - timeOf(b.createdAt) || a.id.localeCompare(b.id));
}

export interface SeatPerson {
  id: string;
  name: string;
  joinedAt: string;
}

export type Seat =
  | { kind: "person"; id: string; name: string; speaking: boolean; intensity: number }
  | {
      kind: "more";
      /** How many people the tile stands for. */
      count: number;
      /** Their full names, for the tooltip. */
      names: string[];
      speaking: boolean;
      intensity: number;
    };

/** How many tiles a card shows: a room you are not in, and the one you are in. */
export const SEATS_OTHER = 4;
export const SEATS_HERE = 8;

/**
 * Who gets a tile. Friends first, then people you share a tree with, then everyone else;
 * within each group by when they joined, so a seat only frees up when someone leaves. When
 * the room is bigger than `max`, the last tile becomes "+N" for the rest. Speaking comes
 * from `activity`, which only your own room has; a speaker without a seat lights the "+N".
 */
export function seatsFor({
  people,
  friendIds,
  contextIds,
  max,
  activity,
}: {
  people: readonly SeatPerson[];
  friendIds: ReadonlySet<string>;
  contextIds: ReadonlySet<string>;
  max: number;
  activity?: ParticipantVoiceActivityMap;
}): Seat[] {
  const group = (person: SeatPerson) => (friendIds.has(person.id) ? 0 : contextIds.has(person.id) ? 1 : 2);
  const ordered = [...people].sort((a, b) => group(a) - group(b) || timeOf(a.joinedAt) - timeOf(b.joinedAt) || a.id.localeCompare(b.id));
  const voice = (id: string) => ({ speaking: activity?.[id]?.speaking ?? false, intensity: activity?.[id]?.intensity ?? 0 });
  const toSeat = (person: SeatPerson): Seat => ({ kind: "person", id: person.id, name: person.name, ...voice(person.id) });
  if (ordered.length <= max) return ordered.map(toSeat);
  const seated = ordered.slice(0, Math.max(1, max - 1));
  const rest = ordered.slice(seated.length);
  const speakers = rest.map((person) => voice(person.id)).filter((state) => state.speaking);
  return [
    ...seated.map(toSeat),
    {
      kind: "more",
      count: rest.length,
      names: rest.map((person) => person.name),
      speaking: speakers.length > 0,
      intensity: Math.max(0, ...speakers.map((state) => state.intensity)),
    },
  ];
}

/**
 * The name under a tile: the first name, or the first name and a last initial where two
 * people in the room share a first name ("Ali R." and "Ali K."). Keyed by person id.
 */
export function shortNames(people: readonly { id: string; name: string }[]): Map<string, string> {
  const parts = (name: string) => name.trim().split(/\s+/).filter(Boolean);
  const firstOf = (name: string) => parts(name)[0] ?? name;
  const counts = new Map<string, number>();
  for (const person of people) {
    const key = firstOf(person.name).toLocaleLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const result = new Map<string, string>();
  for (const person of people) {
    const words = parts(person.name);
    const first = firstOf(person.name);
    if (words.length > 1 && (counts.get(first.toLocaleLowerCase()) ?? 0) > 1) {
      const initial = Array.from(words[words.length - 1])[0].toLocaleUpperCase();
      result.set(person.id, `${first} ${initial}.`);
    } else {
      result.set(person.id, first);
    }
  }
  return result;
}
