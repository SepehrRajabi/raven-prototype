import { describe, expect, it } from "bun:test";
import type { Knock } from "./api";
import { eventNotificationText, isProfileKnockFor, knockAge, loadNotificationSettings, newProfileKnocks, saveNotificationSettings } from "./notifications";

const ME = "me";

function knock(id: string, patch: Partial<Knock> = {}): Knock {
  return {
    id,
    fromUserId: "sara",
    fromUsername: "sara",
    fromDisplayName: "Sara",
    toUserId: ME,
    status: "pending",
    createdAt: "2026-10-16T10:00:00Z",
    expiresAt: "2026-10-16T10:10:00Z",
    ...patch,
  };
}

describe("which knocks are new", () => {
  it("records what is there on the first load and reports nothing", () => {
    const { seen, fresh } = newProfileKnocks(null, ME, [knock("a"), knock("b")]);
    expect(fresh).toEqual([]);
    expect([...seen.ids].sort()).toEqual(["a", "b"]);
  });

  it("reports a knock that arrives after the first load, once", () => {
    const first = newProfileKnocks(null, ME, [knock("a")]);
    const second = newProfileKnocks(first.seen, ME, [knock("b"), knock("a")]);
    expect(second.fresh.map((k) => k.id)).toEqual(["b"]);
    const third = newProfileKnocks(second.seen, ME, [knock("b"), knock("a")]);
    expect(third.fresh).toEqual([]);
  });

  it("does not replay a knock after it was answered and another refresh came", () => {
    const first = newProfileKnocks(null, ME, []);
    const arrived = newProfileKnocks(first.seen, ME, [knock("a")]);
    expect(arrived.fresh).toHaveLength(1);
    const answered = newProfileKnocks(arrived.seen, ME, []);
    expect(answered.fresh).toEqual([]);
    expect(answered.seen.ids.size).toBe(0);
  });

  it("seeds again for a different user instead of reporting their knocks", () => {
    const first = newProfileKnocks(null, ME, [knock("a")]);
    const other = newProfileKnocks(first.seen, "someone-else", [knock("c", { toUserId: "someone-else" })]);
    expect(other.fresh).toEqual([]);
    expect(other.seen.userId).toBe("someone-else");
  });

  it("ignores knocks on a nest and knocks the user sent", () => {
    const first = newProfileKnocks(null, ME, []);
    const next = newProfileKnocks(first.seen, ME, [
      knock("nest", { toUserId: null, nestId: "n1", nestName: "Standup" }),
      knock("sent", { fromUserId: ME, toUserId: "sara" }),
      knock("profile"),
    ]);
    expect(next.fresh.map((k) => k.id)).toEqual(["profile"]);
    // Every knock counts as seen, so one that changes kind later is still not news.
    expect(next.seen.ids.has("nest")).toBe(true);
  });

  it("knows a profile knock from a nest knock", () => {
    expect(isProfileKnockFor(knock("a"), ME)).toBe(true);
    expect(isProfileKnockFor(knock("a", { nestId: "n1" }), ME)).toBe(false);
    expect(isProfileKnockFor(knock("a", { toUserId: "other" }), ME)).toBe(false);
  });
});

describe("notification settings", () => {
  function memory() {
    const values = new Map<string, string>();
    return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
  }

  it("are off by default and survive a save", () => {
    const storage = memory();
    expect(loadNotificationSettings(storage)).toEqual({ knocks: false, messages: false, messageText: true, events: true });
    saveNotificationSettings({ knocks: true, messages: true, messageText: false, events: false }, storage);
    expect(loadNotificationSettings(storage)).toEqual({ knocks: true, messages: true, messageText: false, events: false });
  });

  it("loads older settings and repairs each malformed flag independently", () => {
    const storage = memory();
    for (const value of [{ knocks: true }, { knocks: true, messages: "yes", messageText: null }]) {
      storage.setItem("raven.notificationSettings", JSON.stringify(value));
      expect(loadNotificationSettings(storage)).toEqual({ knocks: true, messages: false, messageText: true, events: true });
    }
  });

  it("fall back to off when the stored value is broken", () => {
    const storage = memory();
    storage.setItem("raven.notificationSettings", "{not json");
    expect(loadNotificationSettings(storage)).toEqual({ knocks: false, messages: false, messageText: true, events: true });
  });
});

describe("eventNotificationText", () => {
  const notice = { id: "e", treeId: "t", title: "Jam", space: "Core", room: "Standup", host: "Ava", startsAt: "" };
  it("words invitations and reminders and ignores anything else", () => {
    expect(eventNotificationText("event.invited", notice)).toEqual({ title: "Jam", body: "Ava invited you · Standup" });
    expect(eventNotificationText("event.reminder", notice)).toEqual({ title: "Jam", body: "Starts in 10 minutes · Standup" });
    expect(eventNotificationText("event.starting", notice)).toBeNull();
    expect(eventNotificationText("event.invited", undefined)).toBeNull();
  });
});

describe("knockAge", () => {
  const at = Date.parse("2026-10-16T10:00:00Z");
  const age = (ms: number) => knockAge("2026-10-16T10:00:00Z", at + ms);

  it("says how long ago, the way a person would", () => {
    expect(age(30_000)).toBe("just now");
    expect(age(6 * 60_000)).toBe("6 min ago");
    expect(age(60 * 60_000)).toBe("1 hr ago");
    expect(age(26 * 60 * 60_000)).toBe("1 day ago");
    expect(age(50 * 60 * 60_000)).toBe("2 days ago");
  });

  it("treats a clock behind the server as just now", () => {
    expect(age(-90_000)).toBe("just now");
  });
});
