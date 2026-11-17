import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CaptureKind } from "@/lib/callHost";

export type MobileNativePermission = "notRequested" | "granted" | "denied" | "requiresSettings";

/** State owned by the native lifecycle and permission adapter (`src-tauri/src/mobile_native`). */
export interface MobileNativeMediaState {
  foreground: boolean;
  epoch: number;
  callActive: boolean;
  microphone: MobileNativePermission;
  camera: MobileNativePermission;
}

export const MOBILE_NATIVE_MEDIA_STATE_CHANGED_EVENT = "mobile-native-media-state";

export const mobileNativeCommands = {
  getState: () => invoke<MobileNativeMediaState>("mobile_native_get_state"),
  beginCall: (expectedEpoch: number) =>
    invoke<MobileNativeMediaState>("mobile_native_begin_call", { expectedEpoch }),
  endCall: () => invoke<MobileNativeMediaState>("mobile_native_end_call"),
  requestPermission: (kind: CaptureKind, expectedEpoch: number) =>
    invoke<MobileNativeMediaState>("mobile_native_request_permission", { kind, expectedEpoch }),
  openSettings: () => invoke<void>("mobile_native_open_settings"),
};

export function subscribeMobileNativeMediaState(onState: (state: MobileNativeMediaState) => void) {
  return listen<MobileNativeMediaState>(MOBILE_NATIVE_MEDIA_STATE_CHANGED_EVENT, (event) => onState(event.payload));
}

/** Accept snapshots monotonically so a delayed initial query cannot overwrite an event. */
export function isNewerState(current: MobileNativeMediaState | null, next: MobileNativeMediaState) {
  return current === null || next.epoch >= current.epoch;
}

/** Lifecycle decisions: only a call that ended (terminal background, new epoch) stops. A backgrounded call keeps running; return only refreshes. */
export function stateTransition(previous: MobileNativeMediaState | null, next: MobileNativeMediaState) {
  return {
    stopCall: !next.callActive && (!next.foreground || Boolean(previous?.callActive && next.epoch > previous.epoch)),
    refresh: (!previous?.foreground && next.foreground)
      || previous?.microphone !== next.microphone
      || previous?.camera !== next.camera,
  };
}

/**
 * Whether the OS permission is granted while the app is in the foreground. This is not
 * a capture gate: the native engines also require an active call for microphone and camera.
 */
export function capturePermissionGranted(state: MobileNativeMediaState | null, kind: CaptureKind) {
  return Boolean(state?.foreground && state[kind] === "granted");
}
