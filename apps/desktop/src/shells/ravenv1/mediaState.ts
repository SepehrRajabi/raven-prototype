import type { AudioSourceState } from "@/lib/audio";
import type { VideoSourceState } from "@/lib/video";

export function isConfirmedMicrophoneActive(source: AudioSourceState) {
  return source.sourceType === "microphone"
    && source.enabled
    && source.publishing
    && source.publishedTrack != null
    && source.runtime.status === "running"
    && !source.channelStrip.mute.muted;
}

/**
 * Whether the mic reads as on. In a call that means confirmed live. Outside a call nothing is
 * captured, so it means people will hear this mic on joining: a published, unmuted source keeps
 * its state into the next call, and one without a track joins muted (`prepareMicrophone`).
 */
export function isLocalMicOn(sources: AudioSourceState[], inCall: boolean, alwaysJoinMuted: boolean) {
  if (inCall) return sources.some(isConfirmedMicrophoneActive);
  return !alwaysJoinMuted && sources.some((source) => source.sourceType === "microphone"
    && source.enabled
    && source.publishing
    && source.publishedTrack != null
    && !source.channelStrip.mute.muted);
}

/** Outside a call, Join muted decides the mic: turning it on now would be undone on joining. */
export function joinMutedHoldsMic(activeNestId: string | null | undefined, localMicOn: boolean, alwaysJoinMuted: boolean) {
  return alwaysJoinMuted && activeNestId == null && !localMicOn;
}

export function microphonesToMuteBeforeJoin(sources: AudioSourceState[]) {
  return sources.filter((source) => source.sourceType === "microphone");
}

/**
 * The local sources your own deafen mutes: every microphone, and your shared system and app
 * audio unless you keep sharing it. A source already muted is left out, so undeafening never
 * unmutes something you muted yourself.
 */
export function sourcesToMuteOnDeafen(sources: AudioSourceState[], keepSharingMyAudio: boolean) {
  return sources
    .filter((source) => !source.channelStrip.mute.muted)
    .filter((source) => source.sourceType === "microphone" || !keepSharingMyAudio)
    .map((source) => source.id);
}

/**
 * The sources undeafening unmutes: those the deafen muted that are still there and still muted.
 * Under a server mute microphones stay muted, so lifting it never opens someone's mic.
 */
export function sourcesToRestoreAfterDeafen(sources: AudioSourceState[], mutedByDeafen: readonly string[], publishRevoked: boolean) {
  return sources
    .filter((source) => mutedByDeafen.includes(source.id) && source.channelStrip.mute.muted)
    .filter((source) => !(publishRevoked && source.sourceType === "microphone"))
    .map((source) => source.id);
}

export function isConfirmedVideoSourceActive(source: VideoSourceState | null) {
  return source != null
    && source.enabled
    && source.publishing
    && source.publishedTrack != null
    // Paused (a shared window is minimized) is still sent: people keep the last picture.
    && (source.runtime.status === "running" || source.runtime.status === "paused");
}

/** Why the user's own share is paused, if it is. A paused share still counts as live. */
export function localSharePause(source: VideoSourceState | null) {
  return source != null && source.runtime.status === "paused"
    ? source.runtime.pausedReason ?? "minimized"
    : null;
}

/**
 * What a local camera or screen source is doing, from the user's side.
 *
 * - `off`: nothing chosen.
 * - `ready`: chosen, but nothing is captured or sent. This is every chosen source
 *   outside a call: the engine only opens the device once there is a call to send to.
 * - `starting`: the device is opening, or it is open and not confirmed as sent yet.
 * - `live`: confirmed capturing and published. Only this means other people see it.
 *   It includes a paused share (minimized window), which goes on sending its last picture.
 * - `error`: chosen, but capture failed. Shown as off, with the reason elsewhere.
 */
export type LocalVideoStatus = "off" | "ready" | "starting" | "live" | "error";

export function localVideoStatus(source: VideoSourceState | null): LocalVideoStatus {
  if (!source || !source.enabled) return "off";
  if (source.runtime.status === "error") return "error";
  if (isConfirmedVideoSourceActive(source)) return "live";
  if (source.runtime.status === "starting" || source.runtime.status === "running") return "starting";
  return "ready";
}

/** The user has turned this source on, whether or not it is being sent yet. */
export function isLocalVideoChosen(status: LocalVideoStatus) {
  return status === "ready" || status === "starting" || status === "live";
}
