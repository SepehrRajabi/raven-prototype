import { describe, expect, test } from "bun:test";
import type { ParticipantSummary } from "./api";
import type { TreeLayout } from "./chat/types";
import {
  ACCESS_CHANGE_WINDOW_MS,
  accessOfRoom,
  accessReason,
  accessUntil,
  callLimit,
  labelNote,
  labelsOfRoom,
  limitNotice,
  listensOnly,
  lockNote,
  lostToAccess,
  refusedForGood,
  viewNote,
  voiceAccess,
} from "./roomAccessView";

const NOW = Date.parse("2026-11-24T12:00:00Z");
const later = new Date(NOW + 2 * 60 * 60_000).toISOString();

const layout: TreeLayout = {
  treeId: "t",
  labels: [
    { id: "b", name: "Beta", visible: true, position: 1 },
    { id: "a", name: "Alpha", visible: false, position: 0 },
  ],
  categories: [],
  items: [
    { kind: "text", id: "r", position: 0, labelIds: ["b", "gone", "a"], access: { level: "view" } },
    { kind: "voice", id: "r", position: 1 },
  ],
};

describe("a room's labels and access in the layout", () => {
  test("labels come in the owner's order, without ones this person is not sent", () => {
    expect(labelsOfRoom(layout, "text", "r").map((label) => label.name)).toEqual(["Alpha", "Beta"]);
  });

  test("a voice room is not a text room with the same id", () => {
    expect(labelsOfRoom(layout, "voice", "r")).toEqual([]);
    expect(accessOfRoom(layout, "voice", "r")).toBeUndefined();
  });

  test("an older server has neither", () => {
    expect(labelsOfRoom({ treeId: "t", categories: [], items: [{ kind: "text", id: "r", position: 0 }] }, "text", "r")).toEqual([]);
    expect(labelsOfRoom(undefined, "text", "r")).toEqual([]);
    expect(accessOfRoom(undefined, "text", "r")).toBeUndefined();
  });

  test("the room's own word goes before the layout's", () => {
    expect(accessOfRoom(layout, "text", "r", { level: "full" })).toEqual({ level: "full" });
    expect(accessOfRoom(layout, "text", "r")).toEqual({ level: "view" });
  });

  test("a voice room's access is taken from a copy that carries it", () => {
    expect(voiceAccess("n", [undefined, { id: "n" }, { id: "other", access: { level: "view" } }, { id: "n", access: { level: "full" } }])).toEqual({ level: "full" });
    expect(voiceAccess("n", [{ id: "n" }])).toBeUndefined();
  });

  test("only a private label says who sees it", () => {
    expect(labelNote(layout.labels![0])).toBe("Beta");
    expect(labelNote(layout.labels![1])).toBe("Alpha. Only you can see this label.");
  });
});

describe("what a person is told", () => {
  test("nothing without a limit, or from an older server", () => {
    expect(viewNote(undefined, "text", NOW)).toBeNull();
    expect(viewNote({ level: "full" }, "voice", NOW)).toBeNull();
    expect(lockNote(undefined, "text")).toBeNull();
    expect(lockNote({ level: "full" }, "text")).toBeNull();
  });

  test("reading and listening, with who it was set for", () => {
    expect(viewNote({ level: "view", source: "person" }, "text", NOW)).toEqual({ line: "You can read here, but not write.", reason: "Set for you by the owner." });
    expect(viewNote({ level: "view", source: "everyone" }, "voice", NOW)).toEqual({ line: "You can listen here. Your microphone, camera and screen stay off.", reason: "Set for all members." });
  });

  test("the end is a real time, and is not named once it has passed", () => {
    expect(accessReason({ level: "view", source: "person", expiresAt: later }, NOW)).toMatch(/^Set for you by the owner\. Until .+\.$/);
    expect(accessUntil({ level: "full", expiresAt: later }, NOW)).toMatch(/^Until \S/);
    expect(accessUntil({ level: "full", expiresAt: new Date(NOW - 1).toISOString() }, NOW)).toBe("");
    expect(accessUntil({ level: "full", expiresAt: "nonsense" }, NOW)).toBe("");
    expect(accessUntil({ level: "full" }, NOW)).toBe("");
  });

  test("the lock says the boundary and your side of it", () => {
    expect(lockNote({ level: "full", limited: true }, "text")).toBe("Not fully open to every member.");
    expect(lockNote({ level: "view", limited: true }, "text")).toBe("Not fully open to every member. You can read, but not write.");
    expect(lockNote({ level: "view" }, "voice")).toBe("You can listen, but not talk.");
  });
});

describe("listening only", () => {
  const person = (extra: Partial<ParticipantSummary>): ParticipantSummary => ({ userId: "me", username: "me", displayName: "Me", joinedAt: "", ...extra });

  test("the room or the call saying so is enough", () => {
    expect(listensOnly({ level: "view" }, undefined, "me")).toBe(true);
    expect(listensOnly(undefined, [person({ listenOnly: true })], "me")).toBe(true);
    expect(listensOnly({ level: "full" }, [person({ listenOnly: true })], "me")).toBe(true);
  });

  test("full access says no, and someone else's limit is theirs", () => {
    expect(listensOnly({ level: "full" }, [person({ userId: "them", listenOnly: true })], "me")).toBe(false);
    expect(listensOnly(undefined, [person({ listenOnly: false })], "me")).toBe(false);
  });

  test("an older server says nothing", () => {
    expect(listensOnly(undefined, [person({})], "me")).toBeUndefined();
    expect(listensOnly(undefined, undefined, undefined)).toBeUndefined();
  });
});

describe("limits in a call", () => {
  test("the most limiting one is named", () => {
    expect(callLimit({ listenOnly: false, muted: false, deafened: false })).toBe("none");
    expect(callLimit({ listenOnly: false, muted: true, deafened: false })).toBe("muted");
    expect(callLimit({ listenOnly: true, muted: true, deafened: false })).toBe("listen");
    expect(callLimit({ listenOnly: true, muted: true, deafened: true })).toBe("deafened");
  });

  test("a moderator's limits read as before", () => {
    expect(limitNotice("none", "muted")?.title).toBe("A moderator muted you");
    expect(limitNotice("muted", "none")).toEqual({ title: "You can talk again", description: "Your mic stays off until you turn it on." });
    expect(limitNotice("muted", "deafened")?.title).toBe("A moderator deafened you");
    expect(limitNotice("deafened", "muted")).toEqual({ title: "You can hear people again" });
    expect(limitNotice("deafened", "none")?.title).toBe("You can talk again");
  });

  test("listening only starts and ends with its own words", () => {
    expect(limitNotice("none", "listen")?.title).toBe("You can only listen here now");
    expect(limitNotice("listen", "none")?.title).toBe("You can take part here again");
    expect(limitNotice("listen", "muted")?.title).toBe("A moderator muted you");
    expect(limitNotice("listen", "listen")).toBeNull();
  });
});

describe("being refused a room", () => {
  test("a room that is gone or closed to you ends the trying", () => {
    expect(refusedForGood({ status: 404 })).toBe(true);
    expect(refusedForGood({ status: 410 })).toBe(true);
    expect(refusedForGood({ status: 403, reasonCode: "forbidden" })).toBe(true);
    expect(refusedForGood({ status: 403 })).toBe(true);
  });

  test("a door, a password, a busy server or no connection do not", () => {
    expect(refusedForGood({ status: 403, reasonCode: "knock_required" })).toBe(false);
    expect(refusedForGood({ status: 403, reasonCode: "password_change_required" })).toBe(false);
    expect(refusedForGood({ status: 401 })).toBe(false);
    expect(refusedForGood({ status: 429 })).toBe(false);
    expect(refusedForGood({ status: 503 })).toBe(false);
    expect(refusedForGood(new Error("offline"))).toBe(false);
    expect(refusedForGood(undefined)).toBe(false);
  });
});

describe("losing a room", () => {
  const gone = { there: false, treeKnown: true, changedAt: NOW, now: NOW + 500 };

  test("a room that goes after access changed was lost to it", () => expect(lostToAccess(gone)).toBe(true));
  test("a room that is still there was not", () => expect(lostToAccess({ ...gone, there: true })).toBe(false));
  test("a deleted room was not", () => expect(lostToAccess({ ...gone, changedAt: undefined })).toBe(false));
  test("a change long ago does not explain it", () => expect(lostToAccess({ ...gone, now: NOW + ACCESS_CHANGE_WINDOW_MS + 1 })).toBe(false));
  test("a space that could not be fetched says nothing", () => expect(lostToAccess({ ...gone, treeKnown: false })).toBe(false));
});
