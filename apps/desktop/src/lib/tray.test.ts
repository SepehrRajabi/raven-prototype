import { describe, expect, it } from "bun:test";
import type { ThumbnailToolbarSnapshot } from "./thumbnailToolbar";
import { buildTraySnapshot, trayCallStatus } from "./tray";

const call: ThumbnailToolbarSnapshot = {
  signedIn: true,
  micEnabled: true,
  micSupported: true,
  deafened: false,
  deafenSupported: true,
  hasMediaSession: true,
  busy: false,
  micPending: false,
  deafenPending: false,
  leavePending: false,
};

const presences = [{ id: "open", label: "Open to talk" }];

describe("tray snapshot", () => {
  it("words the connection from the media phase", () => {
    expect(trayCallStatus("connected", false)).toBe("connected");
    expect(trayCallStatus("joining", false)).toBe("connecting");
    expect(trayCallStatus("connected", true)).toBe("reconnecting");
    expect(trayCallStatus("leaving", true)).toBe("leaving");
  });

  it("carries the call fields unchanged beside the call's name", () => {
    const snapshot = buildTraySnapshot({
      call,
      callName: "  Lounge ",
      phase: "connected",
      reconnecting: false,
      presence: "open",
      presences,
    });
    expect(snapshot).toEqual({ ...call, callName: "Lounge", callStatus: "connected", presence: "open", presences, away: false, awaySupported: false });
  });

  it("names no call once the call is over", () => {
    const snapshot = buildTraySnapshot({
      call: { ...call, hasMediaSession: false },
      callName: "Lounge",
      phase: "idle",
      reconnecting: false,
      presence: "open",
      presences,
    });
    expect(snapshot.callName).toBeNull();
  });

  it("carries Back in a bit only during a call", () => {
    const input = { call, callName: "Lounge", phase: "connected", reconnecting: false, presence: "open", presences, away: true, awaySupported: true };
    expect(buildTraySnapshot(input)).toMatchObject({ away: true, awaySupported: true });
    expect(buildTraySnapshot({ ...input, call: { ...call, hasMediaSession: false } })).toMatchObject({ away: false, awaySupported: false });
  });
});
