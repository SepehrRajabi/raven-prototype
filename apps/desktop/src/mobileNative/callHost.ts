import type { CallHost, CaptureKind } from "@/lib/callHost";
import { logUiError } from "@/lib/diagnostics";
import {
  capturePermissionGranted,
  isNewerState,
  mobileNativeCommands,
  stateTransition,
  subscribeMobileNativeMediaState,
  type MobileNativeMediaState,
} from "./media";

/**
 * The MobileNative call host. A call starts in the foreground and, held by a foreground
 * service, keeps its audio running in the background while it holds communication audio
 * focus. OS permissions are asked when the user starts a capture.
 * It keeps the newest accepted native snapshot. The shell creates one per mounted app.
 */
export function createMobileNativeCallHost(): CallHost {
  let current: MobileNativeMediaState | null = null;
  const accept = (next: MobileNativeMediaState) => {
    if (!isNewerState(current, next)) return false;
    current = next;
    return true;
  };

  return {
    beginCall: async () => {
      const state = current ?? await mobileNativeCommands.getState();
      accept(state);
      accept(await mobileNativeCommands.beginCall(state.epoch));
    },
    endCall: async () => {
      accept(await mobileNativeCommands.endCall());
    },
    requestCapture: async (kind: CaptureKind) => {
      const state = await mobileNativeCommands.getState();
      accept(state);
      const answered = state[kind] === "granted" ? state : await mobileNativeCommands.requestPermission(kind, state.epoch);
      accept(answered);
      return capturePermissionGranted(answered, kind);
    },
    capturePermitted: (kind: CaptureKind) => current?.[kind] === "granted",
    subscribe: (events) => {
      let active = true;
      let unlisten: (() => void) | null = null;
      const handle = (state: MobileNativeMediaState) => {
        if (!active) return;
        const previous = current;
        if (!accept(state)) return;
        const transition = stateTransition(previous, state);
        if (transition.refresh) events.onChanged();
        if (transition.stopCall) events.onEnded();
      };
      void subscribeMobileNativeMediaState(handle).then((stop) => {
        if (!active) {
          stop();
          return;
        }
        unlisten = stop;
        // Register first, then read the current value. Monotonic epochs resolve the race.
        void mobileNativeCommands.getState().then(handle).catch(() => undefined);
      }).catch((error) => {
        // Without the listener no lifecycle or end-of-call event can arrive, so end the call.
        logUiError("mobile_native_subscribe", error);
        if (active) events.onEnded();
      });
      return () => {
        active = false;
        unlisten?.();
      };
    },
  };
}
