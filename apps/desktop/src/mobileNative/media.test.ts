import { describe, expect, test } from "bun:test";
import { capturePermissionGranted, isNewerState, stateTransition, type MobileNativeMediaState } from "./media";

const snapshot = (epoch: number, patch: Partial<MobileNativeMediaState> = {}): MobileNativeMediaState => ({
  foreground: true,
  epoch,
  callActive: false,
  microphone: "notRequested",
  camera: "notRequested",
  ...patch,
});

describe("MobileNative lifecycle snapshots", () => {
  test("ends the old call when JavaScript resumes after missing background events", () => {
    const call = snapshot(4, { callActive: true, microphone: "granted" });
    const resumed = snapshot(5, { foreground: true, callActive: false, microphone: "granted" });
    expect(stateTransition(call, resumed).stopCall).toBe(true);
    expect(stateTransition(resumed, resumed).stopCall).toBe(false);
  });
  test("keeps a backgrounded call running and returns it with a refresh only", () => {
    const call = snapshot(4, { callActive: true, microphone: "granted" });
    const away = snapshot(4, { foreground: false, callActive: true, microphone: "granted" });
    expect(stateTransition(call, away)).toEqual({ stopCall: false, refresh: false });
    expect(stateTransition(away, call)).toEqual({ stopCall: false, refresh: true });
  });

  test("discards an older query result after a newer lifecycle event", () => {
    const backgrounded = snapshot(8, { foreground: false, callActive: false });
    expect(isNewerState(backgrounded, snapshot(7))).toBe(false);
    expect(isNewerState(backgrounded, snapshot(8, { microphone: "granted" }))).toBe(true);
  });

  test("represents background teardown as terminal while permission return stays foreground", () => {
    const call = snapshot(4, { callActive: true, microphone: "granted" });
    const stopped = snapshot(5, { foreground: false, callActive: false, microphone: "granted" });
    const settingsReturn = snapshot(6, { foreground: true, callActive: false, microphone: "requiresSettings" });
    expect(isNewerState(call, stopped)).toBe(true);
    expect(isNewerState(stopped, settingsReturn)).toBe(true);
    expect(settingsReturn.callActive).toBe(false);
    expect(stateTransition(call, stopped)).toEqual({ stopCall: true, refresh: false });
    expect(stateTransition(stopped, settingsReturn)).toEqual({ stopCall: false, refresh: true });
  });

  test("reports permission before joining and blocks stale background capture", () => {
    const preJoin = snapshot(1, { microphone: "granted" });
    expect(capturePermissionGranted(preJoin, "microphone")).toBe(true);
    const deniedReceiveOnly = snapshot(2, { callActive: true, microphone: "denied", camera: "granted" });
    const background = snapshot(3, { foreground: false, callActive: false, microphone: "granted", camera: "granted" });
    expect(capturePermissionGranted(deniedReceiveOnly, "microphone")).toBe(false);
    expect(capturePermissionGranted(deniedReceiveOnly, "camera")).toBe(true);
    expect(capturePermissionGranted(background, "microphone")).toBe(false);
    expect(capturePermissionGranted(background, "camera")).toBe(false);
  });
});
