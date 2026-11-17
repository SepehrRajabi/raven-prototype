import { useMemo, useRef } from "react";
import {
  type SelfPreviewMode,
  type VideoConnectionQuality,
  type VideoMixerState,
  type VideoPauseReason,
  type VideoStreamEndpoint,
  type VideoTrackSource,
  videoStreamUrl,
} from "@/lib/video";
import { stripSidecarIdentity } from "@/lib/mediaIdentity";
import { sharesWatchedBy, watchersOfShare, type WatchPerson, type WatchTarget } from "./watchers";
import {
  resolveParticipantVoicePresentation,
  type ParticipantVoiceActivityMap,
} from "@/lib/speakingActivity";

export type NativeMediaTile = {
  key: string;
  participantId: string;
  displayName: string;
  isLocal: boolean;
  source: VideoTrackSource;
  streamUrl?: string;
  /** The received stream's id, for Stream info. Only for remote video you receive. */
  streamId?: string;
  mediaError?: string;
  audioMuted: boolean;
  cameraEnabled: boolean;
  cameraPublished: boolean;
  screenSharing: boolean;
  speaking: boolean;
  speakingIntensity: number;
  connectionQuality: VideoConnectionQuality;
  videoAvailable: boolean;
  /**
   * Whether the engine is set to receive this remote video: cameras by default, shares
   * only once watched. Your own video is always true; the stage decides whether your
   * share is previewed.
   */
  receiving: boolean;
  shareStartedAt?: number;
  loading?: boolean;
  /** A share whose app is minimized: its last picture stays, and it resumes by itself. */
  sharePaused?: VideoPauseReason | null;
  /** Your own window share's app, to say which app is minimized. */
  shareAppName?: string;
  /** On a person's tile: the shares they are watching, for the eye beside their name. */
  watchedShares: WatchTarget[];
  /** On a share's tile: the other people watching it, for the avatar stack. */
  shareWatchers: WatchPerson[];
  /** Listed by LiveKit, but no media from them yet (see `connectedPeerIds`). Set by the stage. */
  connecting?: boolean;
  /** "Back in a bit", shared through the server. Set by the stage from the call's participants. */
  away?: boolean;
  /** They turned their sound off. Set by the stage, like `away`. */
  deafened?: boolean;
  /** A moderator muted or deafened them. Set by the stage, like `away`. */
  serverMuted?: boolean;
  serverDeafened?: boolean;
  /** "I'd like to speak": place in line, 0 when the hand is down. Set by the stage, like `away`. */
  handOrder?: number;
};

export function useNativeMediaTiles(
  state: VideoMixerState | null,
  endpoint: VideoStreamEndpoint | null,
  selfPreviewMode: SelfPreviewMode,
  speakingActivity: ParticipantVoiceActivityMap,
  /** Your name in this place, for the moment before the engine lists you. */
  localDisplayName = "",
) {
  const shareStartOrderRef = useRef(new Map<string, number>());
  const shareSequenceRef = useRef(0);

  const tiles = useMemo(() => {
    if (!state) return [];
    const localParticipant = state.participants.find((participant) => participant.isLocal);
    const participants = localParticipant
      ? state.participants
      : [{
          participantId: "local",
          displayName: localDisplayName,
          isLocal: true,
          audioMuted: true,
          speaking: false,
          connectionQuality: "unknown" as const,
        }, ...state.participants];
    const localCamera = state.localSources.find((source) => source.kind === "camera" && source.publishing);
    const localScreen = state.localSources.find(
      (source) => (source.kind === "display" || source.kind === "window") && source.publishing,
    );
    const activeShareKeys = new Set<string>();
    const next: NativeMediaTile[] = [];

    for (const participant of participants) {
      const voice = participantVoiceFields(
        participant.participantId,
        participant.speaking,
        speakingActivity,
      );
      const cameraTrack = state.remoteTracks.find(
        (track) => track.participantId === participant.participantId && track.source === "camera",
      );
      const screenTrack = state.remoteTracks.find(
        (track) => track.participantId === participant.participantId && track.source === "screenshare",
      );
      const cameraEnabled = participant.isLocal ? Boolean(localCamera) : Boolean(cameraTrack && !cameraTrack.muted);
      const screenSharing = participant.isLocal ? Boolean(localScreen) : Boolean(screenTrack && !screenTrack.muted);
      const cameraStreamId = selectPresentationStreamId(
        participant.isLocal,
        selfPreviewMode,
        localCamera?.id,
        cameraTrack,
      );
      const screenStreamId = selectPresentationStreamId(
        participant.isLocal,
        selfPreviewMode,
        localScreen?.id,
        screenTrack,
      );
      const cameraReceiving = participant.isLocal || !cameraTrack || cameraTrack.desired;
      const cameraStreamUrl = endpoint && cameraStreamId ? videoStreamUrl(endpoint, cameraStreamId) : undefined;
      const screenStreamUrl = endpoint && screenStreamId ? videoStreamUrl(endpoint, screenStreamId) : undefined;

      // Everyone has a person tile, so someone sharing without a camera still sits in
      // the voice room or strip (with a sharing mark) while their share is a card.
      next.push({
        key: `${participant.participantId}:camera`,
        participantId: participant.participantId,
        displayName: participant.isLocal ? participant.displayName || localDisplayName : participant.displayName,
        isLocal: participant.isLocal,
        source: "camera",
        streamUrl: cameraStreamUrl,
        streamId: !participant.isLocal && cameraStreamUrl ? cameraStreamId : undefined,
        mediaError: participant.isLocal && localCamera?.runtime.status === "error"
          ? localCamera.runtime.error ?? "Camera capture could not start"
          : undefined,
        audioMuted: participant.audioMuted,
        cameraEnabled,
        cameraPublished: participant.isLocal ? Boolean(localCamera?.publishedTrack) : Boolean(cameraTrack),
        screenSharing,
        ...voice,
        connectionQuality: participant.connectionQuality,
        videoAvailable: Boolean(cameraStreamUrl),
        receiving: cameraReceiving,
        loading: cameraEnabled && cameraReceiving && !cameraStreamUrl,
        watchedShares: sharesWatchedBy(state.participants, participant.participantId),
        shareWatchers: [],
      });

      if (screenSharing) {
        const key = `${participant.participantId}:screen`;
        activeShareKeys.add(key);
        if (!shareStartOrderRef.current.has(key)) {
          shareStartOrderRef.current.set(key, ++shareSequenceRef.current);
        }
        next.push({
          key,
          participantId: participant.participantId,
          displayName: participant.isLocal ? participant.displayName || localDisplayName : participant.displayName,
          isLocal: participant.isLocal,
          source: "screenshare",
          streamUrl: screenStreamUrl,
          streamId: !participant.isLocal && screenStreamUrl ? screenStreamId : undefined,
          mediaError: participant.isLocal && localScreen?.runtime.status === "error"
            ? localScreen.runtime.error ?? "Screen capture could not start"
            : undefined,
          audioMuted: participant.audioMuted,
          cameraEnabled,
          cameraPublished: participant.isLocal ? Boolean(localCamera?.publishedTrack) : Boolean(cameraTrack),
          screenSharing: true,
          ...voice,
          connectionQuality: participant.connectionQuality,
          videoAvailable: Boolean(screenStreamUrl),
          receiving: participant.isLocal || Boolean(screenTrack?.desired),
          loading: !screenStreamUrl,
          shareStartedAt: shareStartOrderRef.current.get(key),
          sharePaused: participant.isLocal
            ? localScreen?.runtime.status === "paused" ? localScreen.runtime.pausedReason ?? "minimized" : null
            : screenTrack?.pausedReason ?? null,
          shareAppName: participant.isLocal && localScreen?.kind === "window" ? localScreen.displayName : undefined,
          watchedShares: [],
          shareWatchers: watchersOfShare(state.participants, participant.participantId),
        });
      }
    }

    for (const key of shareStartOrderRef.current.keys()) {
      if (!activeShareKeys.has(key)) shareStartOrderRef.current.delete(key);
    }
    return next;
  }, [endpoint, localDisplayName, selfPreviewMode, speakingActivity, state]);

  return { tiles };
}

export function participantVoiceFields(
  participantId: string,
  fallbackSpeaking: boolean,
  speakingActivity: ParticipantVoiceActivityMap,
): Pick<NativeMediaTile, "speaking" | "speakingIntensity"> {
  const voice = resolveParticipantVoicePresentation(
    fallbackSpeaking,
    speakingActivity[stripSidecarIdentity(participantId)],
  );
  return { speaking: voice.speaking, speakingIntensity: voice.intensity };
}

export function selectPresentationStreamId(
  isLocal: boolean,
  selfPreviewMode: SelfPreviewMode,
  localSourceId: string | undefined,
  track: VideoMixerState["remoteTracks"][number] | undefined,
) {
  if (isLocal && selfPreviewMode === "local") {
    return localSourceId ? `local-${localSourceId}` : undefined;
  }
  return track && track.subscribed && track.desired && !track.muted ? track.streamId : undefined;
}
