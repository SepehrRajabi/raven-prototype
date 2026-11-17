/** Capture an OS may gate behind a user permission. */
export type CaptureKind = "microphone" | "camera";

export interface CallHostEvents {
  /** The host ended the call itself, e.g. MobileNative went to the background. */
  onEnded: () => void;
  /** Foreground or OS permissions changed, so devices need re-listing. */
  onChanged: () => void;
}

/**
 * The platform's share of a call, outside the native engines: OS call ownership,
 * capture permissions and lifecycle. `useRavenMediaAdapter` supervises the call and
 * delegates only these steps, so it never branches on the platform. Each shell passes
 * its host once, at composition.
 */
export interface CallHost {
  /** Open OS call ownership before local capture starts for a user-initiated join.
   * Reconnects do not call it, so they cannot revive a call the host ended. */
  beginCall: () => Promise<void>;
  /** Release OS call ownership at a real end of the call, before engine teardown. */
  endCall: () => Promise<void>;
  /** Ask for capture permission when the user acts. Resolves to false when denied. */
  requestCapture: (kind: CaptureKind) => Promise<boolean>;
  /** Whether capture is already permitted, without prompting. */
  capturePermitted: (kind: CaptureKind) => boolean;
  /** Report host-initiated changes. Returns the unsubscribe function. */
  subscribe: (events: CallHostEvents) => () => void;
}

/** Desktop: the engines own devices and the OS asks for permission when they open. */
export const desktopCallHost: CallHost = {
  beginCall: async () => undefined,
  endCall: async () => undefined,
  requestCapture: async () => true,
  capturePermitted: () => true,
  subscribe: () => () => undefined,
};
