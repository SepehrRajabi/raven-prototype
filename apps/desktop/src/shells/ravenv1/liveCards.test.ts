import { describe, expect, test } from "bun:test";
import { orderLiveNests, seatsFor, shortNames, type SeatPerson } from "./liveCards";

const nest = (id: string, createdAt: string, ...people: string[]) => ({ id, createdAt, currentParticipants: people.map((userId) => ({ userId })) });
const who = (id: string, joinedAt: string, name = id): SeatPerson => ({ id, name, joinedAt });
const ids = (set: string[]) => new Set(set);

describe("orderLiveNests", () => {
  test("your room, then rooms with a friend, then the rest by start time", () => {
    const result = orderLiveNests({
      active: [nest("late", "2026-11-11T12:00:00Z", "x"), nest("friend", "2026-11-11T11:00:00Z", "ava"), nest("early", "2026-11-11T09:00:00Z", "y"), nest("mine", "2026-11-11T13:00:00Z", "me")],
      temporary: [],
      hereId: "mine",
      friendIds: ids(["ava"]),
    });
    expect(result.map((entry) => entry.id)).toEqual(["mine", "friend", "early", "late"]);
  });

  test("a nest that is both active and temporary shows once, and temporary nests are included", () => {
    const both = nest("both", "2026-11-11T09:00:00Z");
    const result = orderLiveNests({ active: [both], temporary: [both, nest("tmp", "2026-11-11T10:00:00Z")], friendIds: ids([]) });
    expect(result.map((entry) => entry.id)).toEqual(["both", "tmp"]);
  });

  test("no nests, no cards", () => {
    expect(orderLiveNests({ active: [], temporary: [], friendIds: ids([]) })).toEqual([]);
  });
});

describe("seatsFor", () => {
  const people = [
    who("zed", "2026-11-11T09:00:00Z"),
    who("ctx-late", "2026-11-11T09:30:00Z"),
    who("ava", "2026-11-11T10:00:00Z"),
    who("ctx-early", "2026-11-11T09:10:00Z"),
    who("ben", "2026-11-11T09:05:00Z"),
  ];
  const friendIds = ids(["ava", "ben"]);
  const contextIds = ids(["ctx-early", "ctx-late"]);

  test("friends first, then people from your trees, then everyone else; each by joining time", () => {
    const seats = seatsFor({ people, friendIds, contextIds, max: 8 });
    expect(seats.map((seat) => (seat.kind === "person" ? seat.id : "+"))).toEqual(["ben", "ava", "ctx-early", "ctx-late", "zed"]);
  });

  test("a bigger room caps at max with the last tile as +N, listing the rest by name", () => {
    const seats = seatsFor({ people, friendIds, contextIds, max: 4 });
    expect(seats).toHaveLength(4);
    expect(seats.slice(0, 3).map((seat) => (seat.kind === "person" ? seat.id : "+"))).toEqual(["ben", "ava", "ctx-early"]);
    const more = seats[3];
    expect(more.kind === "more" && more.count).toBe(2);
    expect(more.kind === "more" && more.names).toEqual(["ctx-late", "zed"]);
  });

  test("a room exactly at the cap has no +N", () => {
    const seats = seatsFor({ people: people.slice(0, 4), friendIds, contextIds, max: 4 });
    expect(seats.every((seat) => seat.kind === "person")).toBe(true);
  });

  test("a seat is held until someone leaves: a later arrival from the same group sits after", () => {
    const before = seatsFor({ people, friendIds, contextIds, max: 8 });
    const after = seatsFor({ people: [...people, who("zoe", "2026-11-11T11:00:00Z")], friendIds, contextIds, max: 8 });
    expect(after.slice(0, before.length - 1).map((seat) => seat.kind === "person" && seat.id)).toEqual(before.slice(0, -1).map((seat) => seat.kind === "person" && seat.id));
    expect(after[after.length - 1].kind === "person" && (after[after.length - 1] as { id: string }).id).toBe("zoe");
  });

  test("speaking rings follow the activity; a speaker without a seat lights the +N", () => {
    const activity = { ben: { speaking: true, intensity: 0.5, meterObserved: true }, zed: { speaking: true, intensity: 0.8, meterObserved: true } };
    const seats = seatsFor({ people, friendIds, contextIds, max: 4, activity });
    const ben = seats[0];
    expect(ben.kind === "person" && ben.speaking).toBe(true);
    const ava = seats[1];
    expect(ava.kind === "person" && ava.speaking).toBe(false);
    const more = seats[3];
    expect(more.speaking).toBe(true);
    expect(more.intensity).toBe(0.8);
  });

  test("without activity nobody is speaking", () => {
    expect(seatsFor({ people, friendIds, contextIds, max: 4 }).some((seat) => seat.speaking)).toBe(false);
  });
});

describe("shortNames", () => {
  test("first names, with a last initial where first names repeat", () => {
    const names = shortNames([
      { id: "1", name: "Ali Rezaei" },
      { id: "2", name: "Ali Karimi" },
      { id: "3", name: "Sara Zand" },
      { id: "4", name: "Maryam" },
    ]);
    expect(names.get("1")).toBe("Ali R.");
    expect(names.get("2")).toBe("Ali K.");
    expect(names.get("3")).toBe("Sara");
    expect(names.get("4")).toBe("Maryam");
  });

  test("repeats are found regardless of case, and a lone name stays whole", () => {
    const names = shortNames([
      { id: "1", name: "ali rezaei" },
      { id: "2", name: "Ali" },
    ]);
    expect(names.get("1")).toBe("ali R.");
    expect(names.get("2")).toBe("Ali");
  });
});
