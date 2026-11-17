import { describe, expect, test } from "bun:test";
import type { AudioSourceState } from "@/lib/audio";
import type { VideoSourceState } from "@/lib/video";
import {
  isConfirmedMicrophoneActive,
  isConfirmedVideoSourceActive,
  isLocalMicOn,
  isLocalVideoChosen,
  joinMutedHoldsMic,
  localSharePause,
  localVideoStatus,
  microphonesToMuteBeforeJoin,
  sourcesToMuteOnDeafen,
  sourcesToRestoreAfterDeafen,
} from "./mediaState";

const microphone = {
  sourceType: "microphone",
  enabled: true,
  publishing: true,
  publishedTrack: { trackId: "track" },
  runtime: { status: "running" },
  channelStrip: { mute: { muted: false } },
} as AudioSourceState;

const camera = {
  kind: "camera",
  enabled: true,
  publishing: true,
  publishedTrack: { trackId: "track" },
  runtime: { status: "running" },
} as VideoSourceState;

describe("confirmed local media state", () => {
  test("requires microphone capture, publication, and an unmuted channel", () => {
    expect(isConfirmedMicrophoneActive(microphone)).toBe(true);
    expect(isConfirmedMicrophoneActive({ ...microphone, runtime: { ...microphone.runtime, status: "error" } })).toBe(false);
    expect(isConfirmedMicrophoneActive({ ...microphone, publishedTrack: null })).toBe(false);
    expect(isConfirmedMicrophoneActive({
      ...microphone,
      channelStrip: { ...microphone.channelStrip, mute: { ...microphone.channelStrip.mute, muted: true } },
    })).toBe(false);
  });

  test("outside a call the mic reads on only when joining would leave it audible", () => {
    const left = { ...microphone, runtime: { ...microphone.runtime, status: "inactive" } } as AudioSourceState;
    const muted = { ...left, channelStrip: { ...left.channelStrip, mute: { ...left.channelStrip.mute, muted: true } } } as AudioSourceState;

    expect(isLocalMicOn([left], false, false)).toBe(true);
    expect(isLocalMicOn([muted], false, false)).toBe(false);
    expect(isLocalMicOn([{ ...left, publishing: false, publishedTrack: null }], false, false)).toBe(false);
    expect(isLocalMicOn([], false, false)).toBe(false);
    expect(isLocalMicOn([left], false, true)).toBe(false);
  });

  test("in a call the mic reads on only when confirmed live", () => {
    expect(isLocalMicOn([microphone], true, false)).toBe(true);
    expect(isLocalMicOn([{ ...microphone, runtime: { ...microphone.runtime, status: "inactive" } }], true, false)).toBe(false);
    expect(isLocalMicOn([microphone], true, true)).toBe(true);
  });

  test("requires video capture and publication", () => {
    expect(isConfirmedVideoSourceActive(camera)).toBe(true);
    expect(isConfirmedVideoSourceActive({ ...camera, runtime: { ...camera.runtime, status: "error" } })).toBe(false);
    expect(isConfirmedVideoSourceActive({ ...camera, publishedTrack: null })).toBe(false);
    expect(isConfirmedVideoSourceActive(null)).toBe(false);
  });

  test("includes a retained published microphone in the pre-join mute set", () => {
    expect(microphonesToMuteBeforeJoin([microphone])).toEqual([microphone]);
  });
});

describe("what the user chose versus what is being sent", () => {
  const withRuntime = (status: string) => ({ ...camera, runtime: { ...camera.runtime, status } }) as VideoSourceState;

  test("a camera turned on outside a call is ready, not live", () => {
    // The engine keeps the source but opens no device until there is a call.
    const waiting = withRuntime("inactive");
    expect(localVideoStatus(waiting)).toBe("ready");
    expect(isLocalVideoChosen(localVideoStatus(waiting))).toBe(true);
    expect(isConfirmedVideoSourceActive(waiting)).toBe(false);
  });

  test("only a confirmed source is live", () => {
    expect(localVideoStatus(camera)).toBe("live");
    expect(localVideoStatus(withRuntime("starting"))).toBe("starting");
    expect(localVideoStatus({ ...camera, publishedTrack: null })).toBe("starting");
  });

  test("a share paused because its window is minimized stays live, with the reason", () => {
    const paused = { ...withRuntime("paused"), runtime: { status: "paused", pausedReason: "minimized" } } as VideoSourceState;
    expect(isConfirmedVideoSourceActive(paused)).toBe(true);
    expect(localVideoStatus(paused)).toBe("live");
    expect(localSharePause(paused)).toBe("minimized");
    expect(localSharePause(camera)).toBeNull();
    expect(localSharePause(null)).toBeNull();
  });

  test("a failed or missing source reads as not chosen, so the next click starts it again", () => {
    expect(localVideoStatus(withRuntime("error"))).toBe("error");
    expect(isLocalVideoChosen("error")).toBe(false);
    expect(localVideoStatus(null)).toBe("off");
    expect(localVideoStatus({ ...camera, enabled: false })).toBe("off");
    expect(isLocalVideoChosen("off")).toBe(false);
  });
});

describe("joinMutedHoldsMic", () => {
  test("holds the mic off only outside a call, with Join muted on and the mic off", () => {
    expect(joinMutedHoldsMic(null, false, true)).toBe(true);
    expect(joinMutedHoldsMic("nest", false, true)).toBe(false);
    expect(joinMutedHoldsMic(null, true, true)).toBe(false);
    expect(joinMutedHoldsMic(null, false, false)).toBe(false);
  });
});

describe("deafen mutes your own audio", () => {
  const source = (id: string, sourceType: AudioSourceState["sourceType"], muted: boolean) =>
    ({ ...microphone, id, sourceType, channelStrip: { mute: { muted } } }) as AudioSourceState;
  const mic = source("mic", "microphone", false);
  const system = source("system", "systemAudio", false);
  const mutedApp = source("app", "appAudio", true);

  test("mutes the mic, and shared audio only when you stop sharing it", () => {
    expect(sourcesToMuteOnDeafen([mic, system, mutedApp], true)).toEqual(["mic"]);
    expect(sourcesToMuteOnDeafen([mic, system, mutedApp], false)).toEqual(["mic", "system"]);
  });

  test("an already muted mic is left out, so undeafening keeps it muted", () => {
    expect(sourcesToMuteOnDeafen([source("mic", "microphone", true)], true)).toEqual([]);
  });

  test("undeafening unmutes only what the deafen muted", () => {
    const afterDeafen = [source("mic", "microphone", true), source("system", "systemAudio", true), mutedApp];
    expect(sourcesToRestoreAfterDeafen(afterDeafen, ["mic", "system"], false)).toEqual(["mic", "system"]);
    expect(sourcesToRestoreAfterDeafen([source("mic", "microphone", false)], ["mic"], false)).toEqual([]);
  });

  test("a server mute keeps the mic muted on undeafen", () => {
    const afterDeafen = [source("mic", "microphone", true), source("system", "systemAudio", true)];
    expect(sourcesToRestoreAfterDeafen(afterDeafen, ["mic", "system"], true)).toEqual(["system"]);
  });
});
