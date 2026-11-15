import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  subscribeAudioMeterChanged,
  type AudioMeterUpdate,
  type AudioMixerState,
  type AudioSourceState,
  type RemoteAudioTrackState,
} from "@/lib/audio";
import { stripSidecarIdentity } from "@/lib/mediaIdentity";

export const SPEAKING_ENTER_RMS_DB = -52;
export const SPEAKING_EXIT_RMS_DB = -56;
export const SPEAKING_RELEASE_HOLD_MS = 240;
/**
 * Loudness alone lights up for keyboards, clicks and coughs, so a microphone also needs
 * the voice detector to agree. Without a probability (an older engine, a source that is
 * not a microphone) the level decides, as it did before. Soft or noise-suppressed speech
 * often peaks between 0.4 and 0.6, so the entry is kept low: at 0.6 people who were
 * clearly heard got no ring.
 */
export const SPEAKING_ENTER_VOICE_PROBABILITY = 0.4;
export const SPEAKING_EXIT_VOICE_PROBABILITY = 0.2;
export const FALLBACK_SPEAKING_INTENSITY = 0.35;

const FULL_INTENSITY_RMS_DB = -18;

export interface ParticipantVoiceActivity {
  speaking: boolean;
  intensity: number;
  meterObserved: boolean;
}

export type ParticipantVoiceActivityMap = Readonly<Record<string, ParticipantVoiceActivity>>;

/** Activity of one published audio track, keyed by `localSourceActivityKey` or `remoteTrackActivityKey`. */
export interface SourceActivity {
  active: boolean;
  intensity: number;
}

export type SourceActivityMap = Readonly<Record<string, SourceActivity>>;

type TrackedTrack = {
  participantId: string;
  /** Only microphones make a person speak; other sources light their own satellite. */
  microphone: boolean;
  active: boolean;
  intensity: number;
  belowSinceMs: number | null;
};

type MeterTarget = {
  key: string;
  participantId: string;
  microphone: boolean;
};

export function localSourceActivityKey(sourceId: string) {
  return `local:${sourceId}`;
}

export function remoteTrackActivityKey(participantId: string, trackId: string) {
  return `remote:${participantId}:${trackId}`;
}

/**
 * Convert the voice-activation range to a stable 0..1 visual value. RMS is
 * already averaged by the native 120 ms meter window, so CSS can interpolate
 * between these samples without adding another delayed smoothing layer.
 */
export function rmsDbToSpeakingIntensity(rmsDb: number) {
  if (!Number.isFinite(rmsDb)) return 0;
  const normalized = (rmsDb - SPEAKING_ENTER_RMS_DB)
    / (FULL_INTENSITY_RMS_DB - SPEAKING_ENTER_RMS_DB);
  return roundIntensity(Math.min(1, Math.max(0, normalized)));
}

export function speakingIntensityPercent(intensity: number) {
  if (!Number.isFinite(intensity)) return 0;
  return Math.round(Math.min(1, Math.max(0, intensity)) * 100);
}

export function speakingGlowStyle(intensity: number, variant: "tile" | "avatar") {
  const level = Number.isFinite(intensity) ? Math.min(1, Math.max(0, intensity)) : 0;
  const compact = variant === "avatar";
  return {
    "--raven-speaking-level": String(roundIntensity(level)),
    "--raven-speaking-border-alpha": String(roundIntensity(0.62 + level * 0.36)),
    "--raven-speaking-glow-alpha": String(roundIntensity((compact ? 0.16 : 0.14) + level * 0.3)),
    "--raven-speaking-glow-radius": `${roundIntensity((compact ? 8 : 12) + level * (compact ? 12 : 22))}px`,
  } as CSSProperties;
}

export function resolveParticipantVoicePresentation(
  fallbackSpeaking: boolean,
  activity: ParticipantVoiceActivity | undefined,
) {
  if (activity?.meterObserved) {
    return { speaking: activity.speaking, intensity: activity.intensity };
  }
  return {
    speaking: fallbackSpeaking,
    intensity: fallbackSpeaking ? FALLBACK_SPEAKING_INTENSITY : 0,
  };
}

/**
 * Stateful threshold/hysteresis reducer over every published audio track.
 *
 * People speak only through their microphones: a participant stays active while
 * any one of their microphones is. Every track, microphone or not, also has its
 * own activity in `sources()`, so a satellite can show that Sara's music is
 * playing without lighting Sara.
 */
export class ParticipantVoiceActivityTracker {
  private readonly tracks = new Map<string, TrackedTrack>();
  private readonly observedParticipants = new Set<string>();

  processMeter(
    state: AudioMixerState | null,
    update: AudioMeterUpdate,
    nowMs: number,
    localUserId?: string,
  ) {
    const target = state ? meterTargetForUpdate(state, update, localUserId) : null;
    if (!target) return this.reconcile(state, localUserId);

    if (target.microphone) this.observedParticipants.add(target.participantId);
    const current = this.tracks.get(target.key);
    // Remote tracks report the level as received. The strip meter is post-fader, so
    // using it would hide someone you turned down, muted locally, or deafened. A local
    // source's input meter is its level while muted, which nobody hears: never active.
    const rmsDb = (update.sourceId ? update.meter : update.inputMeter ?? update.meter).rmsDb;
    const voice = update.voiceProbability;
    let active = current?.active ?? false;
    let belowSinceMs = current?.belowSinceMs ?? null;

    if (rmsDb >= SPEAKING_ENTER_RMS_DB && (voice == null || voice >= SPEAKING_ENTER_VOICE_PROBABILITY)) {
      active = true;
      belowSinceMs = null;
    } else if (rmsDb <= SPEAKING_EXIT_RMS_DB || (voice != null && voice < SPEAKING_EXIT_VOICE_PROBABILITY)) {
      if (active) {
        belowSinceMs ??= nowMs;
        if (nowMs - belowSinceMs >= SPEAKING_RELEASE_HOLD_MS) active = false;
      } else {
        belowSinceMs ??= nowMs;
      }
    } else {
      // The hysteresis band preserves the current state and cancels a pending
      // release when speech rises again without crossing the entry threshold.
      belowSinceMs = null;
    }

    this.tracks.set(target.key, {
      participantId: target.participantId,
      microphone: target.microphone,
      active,
      intensity: rmsDbToSpeakingIntensity(rmsDb),
      belowSinceMs,
    });
    return this.reconcile(state, localUserId);
  }

  reconcile(state: AudioMixerState | null, localUserId?: string): ParticipantVoiceActivityMap {
    if (!state) {
      this.tracks.clear();
      this.observedParticipants.clear();
      return {};
    }

    const eligible = eligibleTracks(state);
    const knownParticipants = knownMicrophoneParticipants(state, localUserId);
    for (const key of this.tracks.keys()) {
      if (!eligible.has(key)) this.tracks.delete(key);
    }
    for (const participantId of this.observedParticipants) {
      if (!knownParticipants.has(participantId)) this.observedParticipants.delete(participantId);
    }

    const activity: Record<string, ParticipantVoiceActivity> = {};
    for (const participantId of this.observedParticipants) {
      activity[participantId] = { speaking: false, intensity: 0, meterObserved: true };
    }
    for (const track of this.tracks.values()) {
      if (!track.microphone) continue;
      const participant = activity[track.participantId];
      if (!participant || !track.active) continue;
      participant.speaking = true;
      participant.intensity = Math.max(participant.intensity, track.intensity);
    }
    return activity;
  }

  /** Activity per eligible track, as of the last `processMeter` or `reconcile`. */
  sources(): SourceActivityMap {
    const sources: Record<string, SourceActivity> = {};
    for (const [key, track] of this.tracks) {
      sources[key] = { active: track.active, intensity: track.active ? track.intensity : 0 };
    }
    return sources;
  }
}

/** Speaking per person (microphones only) and activity per published track. */
export function useVoiceActivity(audioState: AudioMixerState | null, localUserId?: string) {
  const trackerRef = useRef(new ParticipantVoiceActivityTracker());
  const audioStateRef = useRef(audioState);
  const [participants, setParticipants] = useState<ParticipantVoiceActivityMap>({});
  const [sources, setSources] = useState<SourceActivityMap>({});
  audioStateRef.current = audioState;

  useEffect(() => {
    setActivityIfChanged(setParticipants, trackerRef.current.reconcile(audioState, localUserId));
    setSourcesIfChanged(setSources, trackerRef.current.sources());
  }, [audioState, localUserId]);

  useEffect(() => {
    let mounted = true;
    let unsubscribe: (() => void) | null = null;
    void subscribeAudioMeterChanged((update) => {
      if (!mounted) return;
      const next = trackerRef.current.processMeter(
        audioStateRef.current,
        update,
        Date.now(),
        localUserId,
      );
      setActivityIfChanged(setParticipants, next);
      setSourcesIfChanged(setSources, trackerRef.current.sources());
    })
      .then((unlisten) => {
        if (!mounted) unlisten();
        else unsubscribe = unlisten;
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, [localUserId]);

  return { participants, sources };
}

function meterTargetForUpdate(
  state: AudioMixerState,
  update: AudioMeterUpdate,
  localUserId?: string,
): MeterTarget | null {
  if (update.sourceId) {
    const source = state.localSources.find((candidate) => candidate.id === update.sourceId);
    if (!source || !localSourceEligible(source)) return null;
    return {
      key: localSourceActivityKey(source.id),
      participantId: localParticipantId(state, source, localUserId),
      microphone: source.sourceType === "microphone",
    };
  }

  if (!update.participantId || !update.trackId) return null;
  const track = state.remoteTracks.find(
    (candidate) => candidate.track.participantId === update.participantId
      && candidate.track.trackId === update.trackId,
  );
  if (!track || !remoteTrackEligible(track)) return null;
  return {
    key: remoteTrackActivityKey(track.track.participantId, track.track.trackId),
    participantId: stripSidecarIdentity(track.track.participantId),
    microphone: track.track.sourceType === "microphone",
  };
}

function eligibleTracks(state: AudioMixerState) {
  const eligible = new Set<string>();
  for (const source of state.localSources) {
    if (localSourceEligible(source)) eligible.add(localSourceActivityKey(source.id));
  }
  for (const track of state.remoteTracks) {
    if (remoteTrackEligible(track)) eligible.add(remoteTrackActivityKey(track.track.participantId, track.track.trackId));
  }
  return eligible;
}

function knownMicrophoneParticipants(state: AudioMixerState, localUserId?: string) {
  const participants = new Set<string>();
  for (const source of state.localSources) {
    if (source.sourceType !== "microphone") continue;
    participants.add(localParticipantId(state, source, localUserId));
  }
  for (const track of state.remoteTracks) {
    if (track.track.sourceType !== "microphone") continue;
    participants.add(stripSidecarIdentity(track.track.participantId));
  }
  return participants;
}

function localParticipantId(
  state: AudioMixerState,
  source: AudioSourceState,
  localUserId?: string,
) {
  return stripSidecarIdentity(localUserId || source.ownerId || state.localParticipantId || "local");
}

function localSourceEligible(source: AudioSourceState) {
  return source.enabled
    && source.publishing
    && source.publishedTrack != null
    && !source.publishedTrack.muted
    && !source.channelStrip.mute.muted;
}

function remoteTrackEligible(track: RemoteAudioTrackState) {
  // Whether *this* listener muted the track is deliberately not considered: activity is
  // a fact about the other person, not about what you chose to hear.
  return track.subscribed && !track.track.muted;
}

function roundIntensity(value: number) {
  return Math.round(value * 100) / 100;
}

// Meters arrive every 120 ms per source and these maps feed the whole shell, so a level
// that moved less than this keeps the previous map and nothing re-renders. Reaching or
// leaving zero always counts.
const INTENSITY_RENDER_STEP = 0.1;

function sameIntensity(a: number, b: number) {
  if (a === 0 || b === 0) return a === b;
  return Math.abs(a - b) < INTENSITY_RENDER_STEP;
}

function setActivityIfChanged(
  setActivity: React.Dispatch<React.SetStateAction<ParticipantVoiceActivityMap>>,
  next: ParticipantVoiceActivityMap,
) {
  setActivity((current) => activityMapsEqual(current, next) ? current : next);
}

function activityMapsEqual(left: ParticipantVoiceActivityMap, right: ParticipantVoiceActivityMap) {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => {
    const a = left[key];
    const b = right[key];
    return b != null
      && a.speaking === b.speaking
      && sameIntensity(a.intensity, b.intensity)
      && a.meterObserved === b.meterObserved;
  });
}

function setSourcesIfChanged(
  setSources: React.Dispatch<React.SetStateAction<SourceActivityMap>>,
  next: SourceActivityMap,
) {
  setSources((current) => {
    const currentKeys = Object.keys(current);
    if (currentKeys.length !== Object.keys(next).length) return next;
    const same = currentKeys.every((key) => next[key] != null && next[key].active === current[key].active && sameIntensity(next[key].intensity, current[key].intensity));
    return same ? current : next;
  });
}
