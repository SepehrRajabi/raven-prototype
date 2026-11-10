import { describe, expect, test } from "bun:test";
import { joinSummary, mustKnock } from "./threshold";

describe("mustKnock", () => {
  const room = { door: "knock" as const, peopleInside: 1, canManage: false, selfInside: false };
  test("a knock-first room with someone inside asks for a knock", () => expect(mustKnock(room)).toBe(true));
  test("an empty room does not", () => expect(mustKnock({ ...room, peopleInside: 0 })).toBe(false));
  test("people who run the room walk in", () => expect(mustKnock({ ...room, canManage: true })).toBe(false));
  test("someone already inside walks back in", () => expect(mustKnock({ ...room, selfInside: true })).toBe(false));
  test("open, quiet and older servers do not", () => {
    expect(mustKnock({ ...room, door: "open" })).toBe(false);
    expect(mustKnock({ ...room, door: "quiet" })).toBe(false);
    expect(mustKnock({ ...room, door: undefined })).toBe(false);
  });
});

describe("joinSummary", () => {
  test("muted with the camera off", () => {
    expect(joinSummary({ micOn: false, cameraOn: false, sharing: false, treeName: "Weekend crew" })).toEqual({
      reveal: "You’ll join muted with your camera off.",
      audience: "Members of Weekend crew will see you arrive.",
    });
  });

  test("heard and seen", () => {
    expect(joinSummary({ micOn: true, cameraOn: true, sharing: false }).reveal).toBe("People will hear you and see you.");
  });

  test("push to talk names the key", () => {
    expect(joinSummary({ micOn: true, pushToTalkKey: "F8", cameraOn: false, sharing: false }).reveal).toBe("People will hear you while you hold F8.");
  });

  test("seen but muted, and a screen counts as being seen", () => {
    expect(joinSummary({ micOn: false, cameraOn: true, sharing: false }).reveal).toBe("You’ll join muted. People will see you.");
    expect(joinSummary({ micOn: false, cameraOn: false, sharing: true }).reveal).toBe("You’ll join muted. People will see your screen.");
    expect(joinSummary({ micOn: true, cameraOn: true, sharing: true }).reveal).toBe("People will hear you and see you and your screen.");
  });

  test("a temporary nest is seen by the people let in", () => {
    expect(joinSummary({ micOn: true, cameraOn: false, sharing: false }).audience).toBe("People invited or let in will see you arrive.");
  });
});
