import { describe, expect, test } from "bun:test";

import type { AudioInputDevice } from "@/lib/audio";
import { headsetCallModeView } from "@/lib/headsetCallMode";

function device(name: string, patch: Partial<AudioInputDevice> = {}): AudioInputDevice {
  return { deviceId: name, name, isDefault: false, sampleRate: 48_000, channelCount: 1, format: "float32", ...patch };
}

const headset = device("Headset", { isDefault: true, bluetooth: true });
const builtIn = device("Laptop mic", { headsetStandIn: true });

describe("headset call mode switch", () => {
  test("shows for a Bluetooth microphone, as the default or as the choice", () => {
    expect(headsetCallModeView([headset, builtIn], null, true)?.locked).toBe(false);
    const notDefault = [device("Headset", { bluetooth: true }), device("Laptop mic", { isDefault: true, headsetStandIn: true })];
    expect(headsetCallModeView(notDefault, "Headset", true)).not.toBeNull();
    expect(headsetCallModeView(notDefault, null, true)).toBeNull();
  });

  test("stays out of the way when another microphone is in use or nothing is Bluetooth", () => {
    expect(headsetCallModeView([headset, builtIn], "Laptop mic", true)).toBeNull();
    expect(headsetCallModeView([device("Headset", { isDefault: true }), builtIn], null, true)).toBeNull();
    expect(headsetCallModeView([], null, true)).toBeNull();
  });

  test("a missing choice counts as the system default, which is what Raven opens", () => {
    expect(headsetCallModeView([headset, builtIn], "Unplugged mic", true)).not.toBeNull();
  });

  test("names the microphone that is used instead", () => {
    expect(headsetCallModeView([headset, builtIn], null, false)?.hint).toContain("Laptop mic");
  });

  test("says when no other microphone can be used, and can still be turned back on", () => {
    expect(headsetCallModeView([headset], null, true)?.locked).toBe(true);
    const off = headsetCallModeView([headset], null, false);
    expect(off?.locked).toBe(false);
    expect(off?.hint).toContain("still uses Headset");
  });
});
