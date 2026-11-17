import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { api, type NestDetails, type SessionSummary, type User, type KnockReply } from "@/lib/api";
import { callStatesByUser, callStateSupported, raisedHandSupported } from "@/lib/callState";
import type { AudioMixerState, RemoteAudioTrackState } from "@/lib/audio";
import { gainDbToVolumePercent } from "@/components/media/audioSatellites";
import type { VideoConnectionQuality, VideoMixerState } from "@/lib/video";
import { connectedPeerIds } from "@/lib/callArrivals";
import { stripSidecarIdentity } from "@/lib/mediaIdentity";
import {
  resolveParticipantVoicePresentation,
  speakingIntensityPercent,
  type ParticipantVoiceActivityMap,
} from "@/lib/speakingActivity";

export const VOICE_OVERLAY_STATE_CHANGED_EVENT = "voice-overlay-state-changed";
export const VOICE_OVERLAY_SETTINGS_CHANGED_EVENT = "voice-overlay-settings-changed";
export const VOICE_OVERLAY_INTERACTION_CHANGED_EVENT = "voice-overlay-interaction-changed";
export const VOICE_OVERLAY_LAYOUT_CHANGED_EVENT = "voice-overlay-layout-changed";
export const VOICE_OVERLAY_ACTION_EVENT = "voice-overlay-action";
export const DEFAULT_VOICE_OVERLAY_HOTKEY = "Alt+F8";

export interface VoiceOverlaySettings {
  supported: boolean;
  enabled: boolean;
  hotkey: string;
  shape: VoiceOverlayShape;
  /** The shape the card is drawn in now: Follow edge resolved against where it sits. */
  effectiveShape: VoiceOverlayResolvedShape;
  size: VoiceOverlaySize;
  interact: VoiceOverlayInteract;
  names: VoiceOverlayNames;
  background: VoiceOverlayBackground;
  view: VoiceOverlayView;
  /** Seconds a name stays after someone stops talking: 0 (off), 3 or 6. */
  lingerSeconds: number;
  quietFade: VoiceOverlayQuietFade;
  mutedHint: boolean;
  showWeakConnections: boolean;
  showJoinsAndLeaves: boolean;
  showKnocks: boolean;
  showMessages: VoiceOverlayMessages;
  showOnJoin: boolean;
  overlayButtons: VoiceOverlayButtons;
  /** Scroll on a person's row to change their volume while the card is interactive. */
  scrollVolume: boolean;
  registrationError: string | null;
}

/** Which buttons the card shows under your row while it is interactive. */
export interface VoiceOverlayButtons {
  mute: boolean;
  deafen: boolean;
  away: boolean;
  /** "I'd like to speak". Off by default. */
  hand: boolean;
}

/** A button or scroll on the card. The main window carries it out. */
export type VoiceOverlayAction =
  | { kind: "mic" }
  | { kind: "deafen" }
  | { kind: "away"; away: boolean }
  | { kind: "hand"; hand: boolean }
  | { kind: "volume"; userId: string; percent: number }
  /** Open the knock in Raven (`open`) or dismiss it. */
  | { kind: "knock"; knockId: string; open: boolean }
  /** Answer a knock on you from its line. `until` (ISO 8601) is for Ask me later and Not today. */
  | { kind: "knockReply"; knockId: string; reply: KnockReply; until?: string };

/** Which text-room messages show as a line on the card: none, or those of the call's tree. */
export type VoiceOverlayMessages = "off" | "tree";

/** A knock or a message that could still be on the card. The overlay decides how long it shows. */
export interface VoiceOverlayHeadsUp {
  /** Stable for the same knock or message. */
  id: string;
  kind: "knock" | "message";
  actorName: string;
  avatarUrl: string | null;
  /** What follows the name: "knocked", or "in design: can someone check the build". */
  text: string;
  /** When Raven first saw it (ISO 8601). */
  at: string;
  /** A knock on you rather than on a nest: it takes an answer. */
  answerable?: boolean;
}

/** A row along the top or bottom edge and a column elsewhere, or always one of them. */
export type VoiceOverlayShape = "followEdge" | "column" | "row";
export type VoiceOverlayResolvedShape = "column" | "row";
export type VoiceOverlaySize = "small" | "medium" | "large";
/** How clicks reach the overlay; otherwise they go through to the app underneath. */
export type VoiceOverlayInteract = "hover" | "hold" | "never";

/** The card's fill, so it stays readable over any game. */
export type VoiceOverlayBackground = "off" | "light" | "strong";
export const DEFAULT_VOICE_OVERLAY_BACKGROUND: VoiceOverlayBackground = "light";

export type VoiceOverlayNames = "always" | "whileTalking" | "never";
/** Who the card lists. */
export type VoiceOverlayView = "everyone" | "talkersFirst" | "onlyTalking";
/** How far the card fades after a few seconds with nobody talking. */
export type VoiceOverlayQuietFade = "none" | "some" | "lots";
export type VoiceOverlayConnectionQuality = "good" | "poor" | "lost" | "unknown";

export interface VoiceOverlaySettingsPatch {
  enabled?: boolean;
  hotkey?: string;
  shape?: VoiceOverlayShape;
  size?: VoiceOverlaySize;
  interact?: VoiceOverlayInteract;
  names?: VoiceOverlayNames;
  background?: VoiceOverlayBackground;
  view?: VoiceOverlayView;
  lingerSeconds?: number;
  quietFade?: VoiceOverlayQuietFade;
  mutedHint?: boolean;
  showWeakConnections?: boolean;
  showJoinsAndLeaves?: boolean;
  showKnocks?: boolean;
  showMessages?: VoiceOverlayMessages;
  showOnJoin?: boolean;
  overlayButtons?: VoiceOverlayButtons;
  scrollVolume?: boolean;
}

/** What the overlay window lays itself out with; Rust works it out from the monitor. */
export interface VoiceOverlayLayout {
  shape: VoiceOverlayResolvedShape;
  size: VoiceOverlaySize;
  interact: VoiceOverlayInteract;
  /** Clicks land on the overlay right now (pointing at it, or holding its key). */
  interactive: boolean;
  /** The screen corner the card grows away from; heads-up lines go at the far end. */
  anchorCorner: VoiceOverlayCorner;
  maxCardWidth: number;
  maxCardHeight: number;
}

export type VoiceOverlayCorner = "topLeft" | "topRight" | "bottomLeft" | "bottomRight";

/** The window the overlay wants and the card inside it, in CSS px. */
export interface VoiceOverlayContentSize {
  width: number;
  height: number;
  card: { x: number; y: number; width: number; height: number };
}

export interface VoiceOverlayParticipant {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  isLocal: boolean;
  speaking: boolean;
  speakingLevel: number;
  muted: boolean;
  deafened: boolean;
  /** "Back in a bit". */
  away: boolean;
  /** "I'd like to speak": place in line, 0 when the hand is down. */
  handOrder: number;
  screenSharing: boolean;
  /** Others watching this person's screen share, by user id, in name order. */
  watchers: string[];
  cameraOn: boolean;
  connectionQuality: VoiceOverlayConnectionQuality;
  /** When they joined the call (ISO 8601); the card keeps people in this order. */
  joinedAt: string | null;
  /** Their volume for you, 0–200. 100 when you have not changed it or it does not apply. */
  volumePercent: number;
}

export interface VoiceOverlaySnapshot {
  nestId: string | null;
  nestName: string | null;
  locationLabel: string;
  connected: boolean;
  /** Your own connection is being re-made; the card always says so. */
  reconnecting: boolean;
  /** You are talking while muted (once per mute, for a few seconds). */
  localMutedHint: boolean;
  /** False against a server that predates the shared call state: no Back in a bit button. */
  awaySupported: boolean;
  /** False against a server that predates raised hands: no hand button. */
  handSupported: boolean;
  /** Knocks and messages that could still show, oldest first. Knocks come with or without a call. */
  headsUp: VoiceOverlayHeadsUp[];
  participants: VoiceOverlayParticipant[];
}

export const EMPTY_VOICE_OVERLAY_SNAPSHOT: VoiceOverlaySnapshot = {
  nestId: null,
  nestName: null,
  locationLabel: "nest",
  connected: false,
  reconnecting: false,
  localMutedHint: false,
  awaySupported: false,
  handSupported: false,
  headsUp: [],
  participants: [],
};

export const voiceOverlayCommands = {
  isSupported: () => invoke<boolean>("overlay_is_supported"),
  getSettings: () => invoke<VoiceOverlaySettings>("overlay_get_settings"),
  updateSettings: (patch: VoiceOverlaySettingsPatch) =>
    invoke<VoiceOverlaySettings>("overlay_update_settings", { patch }),
  toggle: () => invoke<boolean>("overlay_toggle"),
  /** Resolves true when this call made the overlay appear (it was hidden before). */
  show: () => invoke<boolean>("overlay_show"),
  hide: () => invoke<void>("overlay_hide"),
  setContentSize: (size: VoiceOverlayContentSize) => invoke<void>("overlay_set_content_size", { size }),
  /** A button or scroll on the card; the main window runs it through the dock's own path. */
  action: (action: VoiceOverlayAction) => invoke<void>("overlay_action", { action }),
  /**
   * The button went down on the card: follow the cursor until release, then snap and anchor.
   * `dragId` grows with each drag; `dragRelease` with the same id ends it.
   */
  drag: (dragId: number) => invoke<VoiceOverlaySettings>("overlay_drag", { dragId }),
  /** The button came up on the card. A game in front can hide that from Rust, so the card tells it. */
  dragRelease: (dragId: number) => invoke<void>("overlay_drag_release", { dragId }),
  resetPosition: () => invoke<VoiceOverlaySettings>("overlay_reset_position"),
  getLayout: () => invoke<VoiceOverlayLayout>("overlay_get_layout"),
  getSnapshot: () => invoke<VoiceOverlaySnapshot>("overlay_get_snapshot"),
  updateSnapshot: (snapshot: VoiceOverlaySnapshot) =>
    invoke<void>("overlay_update_snapshot", { snapshot }),
};

export async function subscribeVoiceOverlaySnapshot(
  onSnapshot: (snapshot: VoiceOverlaySnapshot) => void,
) {
  return listen<VoiceOverlaySnapshot>(VOICE_OVERLAY_STATE_CHANGED_EVENT, (event) =>
    onSnapshot(event.payload),
  );
}

export async function subscribeVoiceOverlaySettings(
  onSettings: (settings: VoiceOverlaySettings) => void,
) {
  return listen<VoiceOverlaySettings>(VOICE_OVERLAY_SETTINGS_CHANGED_EVENT, (event) =>
    onSettings(event.payload),
  );
}

export async function subscribeVoiceOverlayLayout(onLayout: (layout: VoiceOverlayLayout) => void) {
  return listen<VoiceOverlayLayout>(VOICE_OVERLAY_LAYOUT_CHANGED_EVENT, (event) => onLayout(event.payload));
}

export async function subscribeVoiceOverlayInteraction(onInteraction: (interactive: boolean) => void) {
  return listen<{ interactive: boolean }>(VOICE_OVERLAY_INTERACTION_CHANGED_EVENT, (event) =>
    onInteraction(event.payload.interactive),
  );
}

export async function subscribeVoiceOverlayActions(onAction: (action: VoiceOverlayAction) => void) {
  return listen<VoiceOverlayAction>(VOICE_OVERLAY_ACTION_EVENT, (event) => onAction(event.payload));
}

export function buildVoiceOverlaySnapshot({
  user,
  details,
  activeSession,
  connected,
  mixerState,
  videoMixer,
  speakingActivity,
  screenSharingUserIds,
  locationLabel,
  reconnecting,
  localMutedHint,
  localCallState,
  headsUp = [],
}: {
  user: User;
  details: NestDetails;
  activeSession: SessionSummary | null;
  connected: boolean;
  mixerState: AudioMixerState | null;
  videoMixer: VideoMixerState | null;
  speakingActivity: ParticipantVoiceActivityMap;
  screenSharingUserIds: string[];
  locationLabel: string;
  reconnecting: boolean;
  localMutedHint: boolean;
  /** What you just set; the server's echo of it arrives a moment later. */
  localCallState?: { away: boolean; deafened: boolean; hand: boolean };
  headsUp?: VoiceOverlayHeadsUp[];
}): VoiceOverlaySnapshot {
  const callStates = callStatesByUser(
    activeSession?.participants,
    localCallState ? { userId: user.id, ...localCallState } : undefined,
  );
  // Who is listed is exactly who the room view counts as connected (`connectedPeerIds`),
  // so a slow joiner shows up here at the same moment their avatar stops "connecting".
  const connectedIds = connectedPeerIds({ session: activeSession, audioState: mixerState, videoState: videoMixer });
  const names = new Map<string, string>();
  for (const participant of activeSession?.participants ?? []) {
    names.set(participant.userId, participant.displayName || participant.username);
  }
  for (const remoteParticipant of mixerState?.remoteParticipants ?? []) {
    const userId = stripSidecarIdentity(remoteParticipant.participantId);
    if (userId && !names.has(userId) && remoteParticipant.displayName) names.set(userId, remoteParticipant.displayName);
  }
  for (const track of videoMixer?.remoteTracks ?? []) {
    const userId = stripSidecarIdentity(track.participantId);
    if (userId && !names.has(userId) && track.displayName) names.set(userId, track.displayName);
  }

  const participants = new Map<
    string,
    { userId: string; displayName: string; isLocal: boolean; joinedAt: string | null }
  >();
  for (const participant of activeSession?.participants ?? []) {
    participants.set(participant.userId, {
      userId: participant.userId,
      displayName: names.get(participant.userId) ?? participant.userId,
      isLocal: participant.userId === user.id,
      joinedAt: participant.joinedAt ?? null,
    });
  }

  if (connected || participants.size > 0) {
    participants.set(user.id, {
      userId: user.id,
      displayName: participants.get(user.id)?.displayName ?? user.displayName ?? user.username,
      isLocal: true,
      joinedAt: participants.get(user.id)?.joinedAt ?? null,
    });
  }

  for (const userId of connectedIds) {
    if (participants.has(userId)) continue;
    participants.set(userId, {
      userId,
      displayName: names.get(userId) ?? userId,
      isLocal: userId === user.id,
      joinedAt: null,
    });
  }

  const screenSharing = new Set(screenSharingUserIds.map(stripSidecarIdentity).filter(Boolean));
  if (
    videoMixer?.localSources.some(
      (source) =>
        (source.kind === "display" || source.kind === "window") &&
        (source.publishing || source.publishedTrack != null),
    )
  ) {
    screenSharing.add(user.id);
  }
  const cameraUsers = cameraUserIdsForOverlay(videoMixer, user.id);
  const watchers = shareWatchersForOverlay(videoMixer, (userId) => names.get(userId) ?? userId);
  const liveKitSpeaking = new Map<string, boolean>();
  for (const participant of videoMixer?.participants ?? []) {
    const userId = stripSidecarIdentity(participant.participantId);
    liveKitSpeaking.set(userId, Boolean(liveKitSpeaking.get(userId) || participant.speaking));
  }
  const connectionQuality = new Map<string, VoiceOverlayConnectionQuality>();
  for (const participant of videoMixer?.participants ?? []) {
    connectionQuality.set(
      stripSidecarIdentity(participant.participantId),
      overlayConnectionQuality(participant.connectionQuality),
    );
  }

  return {
    nestId: details.nest.id,
    nestName: details.nest.name,
    locationLabel: normalizeVoiceOverlayLocationLabel(locationLabel),
    connected,
    reconnecting,
    localMutedHint,
    awaySupported: callStateSupported(activeSession),
    handSupported: raisedHandSupported(activeSession),
    headsUp,
    participants: Array.from(participants.values()).map((participant) => {
      const voice = resolveParticipantVoicePresentation(
        liveKitSpeaking.get(participant.userId) ?? false,
        speakingActivity[participant.userId],
      );
      return {
        userId: participant.userId,
        displayName: participant.displayName,
        avatarUrl: api.userAvatarUrl(participant.userId),
        isLocal: participant.isLocal,
        speaking: voice.speaking,
        speakingLevel: speakingIntensityPercent(voice.intensity),
        muted: participant.isLocal
          ? isLocalMuted(mixerState)
          : isRemoteMuted(mixerState, participant.userId),
        deafened: callStates.get(participant.userId)?.deafened ?? false,
        away: callStates.get(participant.userId)?.away ?? false,
        handOrder: callStates.get(participant.userId)?.handOrder ?? 0,
        screenSharing: screenSharing.has(participant.userId),
        watchers: screenSharing.has(participant.userId) ? (watchers.get(participant.userId) ?? []) : [],
        cameraOn: cameraUsers.has(participant.userId),
        connectionQuality: connectionQuality.get(participant.userId) ?? "unknown",
        joinedAt: participant.joinedAt,
        volumePercent: participant.isLocal ? 100 : personVolumePercent(mixerState, participant.userId),
      };
    }),
  };
}

function overlayConnectionQuality(quality: VideoConnectionQuality): VoiceOverlayConnectionQuality {
  return quality === "excellent" ? "good" : quality;
}

export function normalizeVoiceOverlayLocationLabel(locationLabel: string) {
  return locationLabel.trim().toLowerCase() || "nest";
}

/** Who is watching whose share, by user id: others only, as on the stage's watcher stack. */
export function shareWatchersForOverlay(videoMixer: VideoMixerState | null, nameOf: (userId: string) => string) {
  const watchers = new Map<string, string[]>();
  for (const person of videoMixer?.participants ?? []) {
    if (person.isLocal) continue;
    const watcherId = stripSidecarIdentity(person.participantId);
    if (!watcherId) continue;
    for (const target of person.watching ?? []) {
      const sharerId = stripSidecarIdentity(target);
      if (!sharerId || sharerId === watcherId) continue;
      const list = watchers.get(sharerId) ?? [];
      if (!list.includes(watcherId)) list.push(watcherId);
      watchers.set(sharerId, list);
    }
  }
  for (const list of watchers.values()) list.sort((left, right) => nameOf(left).localeCompare(nameOf(right)));
  return watchers;
}

export function cameraUserIdsForOverlay(videoMixer: VideoMixerState | null, localUserId: string) {
  const cameraUsers = new Set<string>();
  if (
    videoMixer?.localSources.some(
      (source) => source.kind === "camera" && (source.publishing || source.publishedTrack != null),
    )
  ) {
    cameraUsers.add(localUserId);
  }
  for (const track of videoMixer?.remoteTracks ?? []) {
    if (track.source !== "camera" || track.muted) continue;
    const userId = stripSidecarIdentity(track.participantId);
    // LiveKit can briefly retain the local participant's subscribed camera track
    // after the native source has stopped. The local source is authoritative for
    // the local camera indicator; remote tracks are only authoritative for peers.
    if (userId && userId !== localUserId) cameraUsers.add(userId);
  }
  return cameraUsers;
}

export function formatHotkeyEvent(event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">): string | null {
  const key = normalizeHotkeyKey(event.key, event.code);
  if (!key) return null;

  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Control");
  if (event.metaKey) parts.push("Command");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(key);

  return parts.join("+");
}

function isLocalMuted(mixerState: AudioMixerState | null) {
  const micSources = (mixerState?.localSources ?? []).filter((source) => source.sourceType === "microphone");
  if (micSources.length === 0) return true;
  return !micSources.some(
    (source) =>
      source.publishedTrack != null &&
      !source.publishedTrack.muted &&
      !source.channelStrip.mute.muted,
  );
}

function isRemoteMuted(mixerState: AudioMixerState | null, participantId: string) {
  const tracks = remoteMicTracks(mixerState, participantId);
  if (tracks.length === 0) return true;
  return tracks.every((track) => track.track.muted);
}

/** Every microphone track of one other person, as the Mixer lists them. */
export function remoteMicTracks(mixerState: AudioMixerState | null, participantId: string): RemoteAudioTrackState[] {
  return (mixerState?.remoteTracks ?? []).filter(
    (track) =>
      stripSidecarIdentity(track.track.participantId) === participantId &&
      track.track.sourceType === "microphone",
  );
}

/** The volume you have set for someone, read from their first microphone track. */
function personVolumePercent(mixerState: AudioMixerState | null, participantId: string) {
  const first = remoteMicTracks(mixerState, participantId)[0];
  if (!first) return 100;
  return gainDbToVolumePercent(first.receiverChannelStrip.gainDb);
}

function normalizeHotkeyKey(key: string, code: string) {
  const aliases: Record<string, string> = {
    " ": "Space",
    Esc: "Escape",
    Del: "Delete",
    Ins: "Insert",
    Up: "ArrowUp",
    Down: "ArrowDown",
    Left: "ArrowLeft",
    Right: "ArrowRight",
  };
  const normalized = aliases[key] ?? key;
  if (["Control", "Alt", "Shift", "Meta", "OS"].includes(normalized)) return null;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(normalized)) return normalized;
  if (/^[a-z]$/i.test(normalized)) return normalized.toUpperCase();
  if (/^[0-9]$/.test(normalized)) return normalized;
  if (code.startsWith("Numpad") && /^[0-9]$/.test(key)) return key;
  return normalized;
}
