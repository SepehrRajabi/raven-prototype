import { describe, expect, it } from "bun:test";
import type { RemoteVideoTrackState } from "./video";
import {
  DEFAULT_SOUND_CUE_SETTINGS,
  handCueStep,
  INITIAL_HAND_CUE_STATE,
  INITIAL_SHARE_CUE_STATE,
  normalizeSoundCueSettings,
  remoteSharers,
  SHARE_CUE_SETTLE_MS,
  shareCueStep,
  type ShareCueState,
} from "./soundCues";

function track(participantId: string, patch: Partial<RemoteVideoTrackState> = {}): RemoteVideoTrackState {
  return {
    streamId: `${participantId}-screen`,
    participantId,
    displayName: participantId,
    source: "screenshare",
    muted: false,
    subscribed: false,
    desired: false,
    isSelf: false,
    pausedReason: null,
    ...patch,
  };
}

describe("sound cue settings", () => {
  it("default to everything on", () => {
    expect(normalizeSoundCueSettings(undefined)).toEqual(DEFAULT_SOUND_CUE_SETTINGS);
    expect(DEFAULT_SOUND_CUE_SETTINGS.enabled).toBe(true);
    expect(normalizeSoundCueSettings({ knocks: false }).messages).toBe(true);
    expect(normalizeSoundCueSettings({ messages: false }).messages).toBe(false);
    expect(normalizeSoundCueSettings({ messages: "yes" }).messages).toBe(true);
  });

  it("keep what was chosen and repair the rest", () => {
    expect(normalizeSoundCueSettings({ people: false, volume: 3, knocks: "no" })).toEqual({
      ...DEFAULT_SOUND_CUE_SETTINGS,
      people: false,
      volume: 1,
    });
    expect(normalizeSoundCueSettings({ volume: Number.NaN }).volume).toBe(DEFAULT_SOUND_CUE_SETTINGS.volume);
  });
});

describe("remote sharers", () => {
  it("counts other people's screen shares, paused or not, and never yours or a camera", () => {
    const sharers = remoteSharers({
      remoteTracks: [
        track("anna"),
        track("ben", { muted: true, pausedReason: "minimized" }),
        track("cleo", { source: "camera" }),
        track("me", { isSelf: true }),
      ],
    });
    expect([...sharers].sort()).toEqual(["anna", "ben"]);
  });
});

describe("share cues", () => {
  const connect = (sharers: string[], now = 0) =>
    shareCueStep(INITIAL_SHARE_CUE_STATE, { nestId: "n1", viewerConnected: true, sharers: new Set(sharers) }, now);
  const step = (state: ShareCueState, sharers: string[], now: number, nestId = "n1", viewerConnected = true) =>
    shareCueStep(state, { nestId, viewerConnected, sharers: new Set(sharers) }, now);
  const settled = SHARE_CUE_SETTLE_MS + 1;

  it("never plays for shares already in the room when you join", () => {
    const joined = connect(["anna"]);
    expect(joined.cues).toEqual([]);
    // Shares announced while the room settles are not news either.
    const late = step(joined.state, ["anna", "ben"], 500);
    expect(late.cues).toEqual([]);
    expect(step(late.state, ["anna", "ben"], settled).cues).toEqual([]);
  });

  it("plays when someone starts or stops sharing after that", () => {
    const joined = connect([]);
    const started = step(joined.state, ["anna"], settled);
    expect(started.cues).toEqual(["shareStarted"]);
    const stopped = step(started.state, [], settled + 5000);
    expect(stopped.cues).toEqual(["shareStopped"]);
    const same = step(stopped.state, [], settled + 6000);
    expect(same.cues).toEqual([]);
  });

  it("starts over without a burst when the room changes or the viewer reconnects", () => {
    const joined = connect([]);
    const moved = step(joined.state, ["anna", "ben"], settled, "n2");
    expect(moved.cues).toEqual([]);
    const lost = step(moved.state, [], settled + 100, "n2", false);
    expect(lost.cues).toEqual([]);
    const back = step(lost.state, ["anna", "ben"], settled + 200, "n2");
    expect(back.cues).toEqual([]);
  });

  it("is silent outside a call", () => {
    const result = shareCueStep(INITIAL_SHARE_CUE_STATE, { nestId: null, viewerConnected: false, sharers: new Set(["anna"]) }, 0);
    expect(result.cues).toEqual([]);
    expect(result.state.sharers).toBeNull();
  });
});

describe("handCueStep", () => {
  const at = (nestId: string | null, ...ids: string[]) => ({ nestId, raised: nestId ? new Set(ids) : null });

  it("stays quiet about hands already up when you arrive", () => {
    expect(handCueStep(INITIAL_HAND_CUE_STATE, at("n", "a")).cue).toBe(false);
  });

  it("plays when a hand goes up, never when it goes down", () => {
    const first = handCueStep(INITIAL_HAND_CUE_STATE, at("n"));
    const up = handCueStep(first.state, at("n", "a"));
    expect(up.cue).toBe(true);
    expect(handCueStep(up.state, at("n")).cue).toBe(false);
  });

  it("starts over in another room", () => {
    const first = handCueStep(INITIAL_HAND_CUE_STATE, at("n"));
    expect(handCueStep(first.state, at("m", "a")).cue).toBe(false);
  });
});
