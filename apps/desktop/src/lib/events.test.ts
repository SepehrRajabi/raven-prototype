import { describe, expect, test } from "bun:test";
import type { TreeEvent } from "./api";
import { buildRule, inviteMessageCount, parseRule, repeatText, roomEventCaptions, upcomingEvents } from "./events";

function event(patch: Partial<TreeEvent> & { start: number; end: number }): TreeEvent {
  const { start, end, ...rest } = patch;
  return {
    id: "e", title: "Jam", description: "", hostUserId: "h", hostName: "Host", nestId: "n1", conversationId: null, roomName: "Standup",
    startsAt: new Date(start).toISOString(), endsAt: null, durationMinutes: null, rrule: null, tz: "UTC", inviteAll: false, inviteeIds: [],
    sendInviteMessage: false, pinned: false, occurrence: { startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() }, ...rest,
  };
}

describe("repeat rules", () => {
  test("round-trip", () => {
    const rule = { freq: "weekly" as const, interval: 2, days: [0, 1], until: null, count: 4 };
    expect(buildRule(rule)).toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,SU;COUNT=4");
    expect(parseRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,SU;COUNT=4")).toEqual({ ...rule, days: [1, 0] });
    expect(buildRule({ ...rule, freq: "never" })).toBeNull();
    expect(buildRule({ freq: "daily", interval: 1, days: [], until: "2026-12-01T18:00:00.000Z", count: null })).toBe("FREQ=DAILY;UNTIL=20261201T180000Z");
    expect(parseRule("FREQ=DAILY;UNTIL=20261201T180000Z").until).toBe("2026-12-01T18:00:00Z");
  });

  test("text", () => {
    expect(repeatText(null)).toBe("");
    expect(repeatText("FREQ=WEEKLY")).toBe("Every week");
    expect(repeatText("FREQ=DAILY;INTERVAL=3")).toBe("Every 3 days");
    expect(repeatText("FREQ=MONTHLY")).toBe("Every month");
    expect(repeatText("FREQ=WEEKLY;BYDAY=TH,MO")).toMatch(/^Every week on \S+ and \S+$/);
  });
});

describe("rooms and lists", () => {
  const now = Date.parse("2026-11-10T18:00:00Z");
  test("starting now for 15 minutes, then the title", () => {
    expect(roomEventCaptions([event({ start: now - 5 * 60_000, end: now + 60 * 60_000 })], now).get("n1")).toBe("Jam · starting now");
    expect(roomEventCaptions([event({ start: now - 20 * 60_000, end: now + 60 * 60_000 })], now).get("n1")).toBe("Jam");
    expect(roomEventCaptions([event({ start: now + 60_000, end: now + 60 * 60_000 })], now).size).toBe(0);
  });

  test("upcoming leaves out pinned, over and far events", () => {
    const list = [
      event({ id: "late", start: now + 3 * 60 * 60_000, end: now + 4 * 60 * 60_000 }),
      event({ id: "soon", start: now + 60 * 60_000, end: now + 2 * 60 * 60_000 }),
      event({ id: "pinned", pinned: true, start: now + 60_000, end: now + 120_000 }),
      event({ id: "over", start: now - 120_000, end: now - 60_000 }),
      event({ id: "far", start: now + 40 * 24 * 60 * 60_000, end: now + 41 * 24 * 60 * 60_000 }),
    ];
    expect(upcomingEvents(list, now).map((e) => e.id)).toEqual(["soon", "late"]);
  });

  test("invite message count leaves out the editor", () => {
    expect(inviteMessageCount({ inviteAll: false, inviteeIds: ["a", "b", "me"] }, [], "me")).toBe(2);
    expect(inviteMessageCount({ inviteAll: true, inviteeIds: [] }, ["a", "me", "c"], "me")).toBe(2);
  });
});
