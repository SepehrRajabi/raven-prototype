import type { AudioInputDevice } from "@/lib/audio";

/** What the "Headset call mode" switch shows. Null: no headset microphone is in question. */
export interface HeadsetCallModeView {
  hint: string;
  /** Nothing else can be used, so turning it off would change nothing. */
  locked: boolean;
}

/**
 * A Bluetooth headset drops to call quality while its microphone is open. The switch is
 * offered only when the microphone Raven would use (the chosen one, or the system default)
 * is a Bluetooth one, since no other microphone affects the headset.
 */
export function headsetCallModeView(
  devices: readonly AudioInputDevice[],
  selectedMic: string | null,
  allowed: boolean,
): HeadsetCallModeView | null {
  // A chosen device that is not connected is stood in for by the system default.
  const wanted = devices.find((device) => device.deviceId === selectedMic) ?? devices.find((device) => device.isDefault);
  if (!wanted?.bluetooth) return null;
  const standIn = devices.find((device) => device.headsetStandIn);
  if (!standIn) {
    return {
      hint: allowed
        ? "Lowers its sound to call quality. Connect another microphone to turn this off."
        : `No other microphone is connected, so Raven still uses ${wanted.name}.`,
      locked: allowed,
    };
  }
  return {
    hint: allowed
      ? "Uses the headset’s microphone, which lowers its sound to call quality."
      : `Raven uses ${standIn.name}, so the headset keeps its full sound.`,
    locked: false,
  };
}
