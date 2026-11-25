import { describe, expect, test } from "bun:test";
import type { ParticipantSummary } from "./api";
import { callStateCatchUp, callStatesByUser, callStateSupported, participantCallState } from "./callState";

const person = (userId: string, extra: Partial<ParticipantSummary> = {}): ParticipantSummary => ({
  userId,
  username: userId,
  displayName: userId,
  joinedAt: "2026-10-27T10:00:00Z",
  ...extra,
});

describe("callStateSupported", () => {
  test("an older server sends neither field", () => {
    expect(callStateSupported({ participants: [person("a"), person("b")] })).toBe(false);
    expect(callStateSupported(null)).toBe(false);
    expect(callStateSupported({ participants: [] })).toBe(false);
  });

  test("a server with the route always sends away", () => {
    expect(callStateSupported({ participants: [person("a", { away: false, deafened: false })] })).toBe(true);
  });
});

describe("participantCallState", () => {
  test("reads one person and treats a missing field or person as off", () => {
    const participants = [person("a", { away: true, deafened: false }), person("b")];
    expect(participantCallState(participants, "a")).toEqual({ away: true, deafened: false, serverMuted: false, serverDeafened: false, listenOnly: false, hand: false, handOrder: 0 });
    expect(participantCallState(participants, "b")).toEqual({ away: false, deafened: false, serverMuted: false, serverDeafened: false, listenOnly: false, hand: false, handOrder: 0 });
    expect(participantCallState(participants, "nobody")).toEqual({ away: false, deafened: false, serverMuted: false, serverDeafened: false, listenOnly: false, hand: false, handOrder: 0 });
  });
});

describe("callStatesByUser", () => {
  test("your own markers come from what you just set, not the server's echo", () => {
    const states = callStatesByUser(
      [person("me", { away: false, deafened: false }), person("them", { away: true, deafened: true })],
      { userId: "me", away: true, deafened: false, hand: false },
    );
    expect(states.get("me")).toEqual({ away: true, deafened: false, serverMuted: false, serverDeafened: false, listenOnly: false, hand: false, handOrder: 0 });
    expect(states.get("them")).toEqual({ away: true, deafened: true, serverMuted: false, serverDeafened: false, listenOnly: false, hand: false, handOrder: 0 });
  });

  test("your own server mute still comes from the server", () => {
    const states = callStatesByUser(
      [person("me", { away: false, deafened: false, serverMuted: true })],
      { userId: "me", away: false, deafened: true, hand: false },
    );
    expect(states.get("me")).toEqual({ away: false, deafened: true, serverMuted: true, serverDeafened: false, listenOnly: false, hand: false, handOrder: 0 });
  });
});

describe("listening only", () => {
  test("is read from the server, for others and for you", () => {
    const states = callStatesByUser([person("me", { listenOnly: true }), person("them", { listenOnly: true }), person("old")], { userId: "me", away: false, deafened: false, hand: false });
    expect(states.get("me")?.listenOnly).toBe(true);
    expect(states.get("them")?.listenOnly).toBe(true);
    expect(states.get("old")?.listenOnly).toBe(false);
  });
});

describe("callStateCatchUp", () => {
  const clear = { away: false, deafened: false, hand: false };

  test("a first join with nothing set sends nothing", () => {
    expect(callStateCatchUp(clear, clear)).toBeNull();
  });

  test("rejoining after a dropped connection puts back what the person had set", () => {
    expect(callStateCatchUp(clear, { away: true, deafened: true, hand: false })).toEqual({ away: true, deafened: true });
    expect(callStateCatchUp(clear, { away: false, deafened: true })).toEqual({ deafened: true });
    expect(callStateCatchUp(clear, { away: true, deafened: false })).toEqual({ away: true });
  });

  test("a server that kept a marker the person already cleared gets told", () => {
    expect(callStateCatchUp({ away: true, deafened: true, hand: false }, clear)).toEqual({ away: false, deafened: false });
  });
});

describe("raised hands", () => {
  test("passes on the place in line, never a time", () => {
    const states = callStatesByUser([person("a", { handOrder: 2 }), person("b", { handOrder: 1 }), person("c", { handOrder: 0 })]);
    expect(states.get("a")).toMatchObject({ hand: true, handOrder: 2 });
    expect(states.get("c")).toMatchObject({ hand: false, handOrder: 0 });
  });

  test("puts a hand you just raised at the back until the server answers", () => {
    const states = callStatesByUser(
      [person("me", { handOrder: 0 }), person("them", { handOrder: 1 })],
      { userId: "me", away: false, deafened: false, hand: true },
    );
    expect(states.get("me")).toMatchObject({ hand: true, handOrder: 2 });
  });

  test("moves everyone behind you up when you lower yours", () => {
    const states = callStatesByUser(
      [person("me", { handOrder: 1 }), person("them", { handOrder: 2 })],
      { userId: "me", away: false, deafened: false, hand: false },
    );
    expect(states.get("me")).toMatchObject({ hand: false, handOrder: 0 });
    expect(states.get("them")).toMatchObject({ handOrder: 1 });
  });

  test("asks a rejoining server to raise the hand again", () => {
    expect(callStateCatchUp({ away: false, deafened: false, hand: false }, { away: false, deafened: false, hand: true })).toEqual({ hand: true });
  });
});
