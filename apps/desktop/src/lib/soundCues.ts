import type { SoundCue, SoundCueSettings } from "./audio";
import type { VideoMixerState } from "./video";

export const DEFAULT_SOUND_CUE_SETTINGS: SoundCueSettings = {
  enabled: true,
  volume: 0.7,
  microphone: true,
  knocks: true,
  messages: true,
  screenShares: true,
  people: true,
  entryHeadsUp: true,
  hands: true,
};

/** Saved settings with anything missing or malformed set to its default (on). */
export function normalizeSoundCueSettings(value: unknown): SoundCueSettings {
  const saved = (value && typeof value === "object" ? value : {}) as Partial<Record<keyof SoundCueSettings, unknown>>;
  const flag = (key: Exclude<keyof SoundCueSettings, "volume">) =>
    typeof saved[key] === "boolean" ? (saved[key] as boolean) : DEFAULT_SOUND_CUE_SETTINGS[key];
  const volume = typeof saved.volume === "number" && Number.isFinite(saved.volume)
    ? Math.min(1, Math.max(0, saved.volume))
    : DEFAULT_SOUND_CUE_SETTINGS.volume;
  return {
    enabled: flag("enabled"),
    volume,
    microphone: flag("microphone"),
    knocks: flag("knocks"),
    messages: flag("messages"),
    screenShares: flag("screenShares"),
    people: flag("people"),
    entryHeadsUp: flag("entryHeadsUp"),
    hands: flag("hands"),
  };
}

/**
 * After the viewer connects to a room, the shares already in it arrive one by one as
 * their tracks are announced. They are not news, so changes in this window only update
 * what is known.
 */
export const SHARE_CUE_SETTLE_MS = 2500;

export interface ShareCueState {
  nestId: string | null;
  /** Who is sharing, by participant; `null` until the viewer is connected. */
  sharers: ReadonlySet<string> | null;
  settleUntil: number;
}

export const INITIAL_SHARE_CUE_STATE: ShareCueState = { nestId: null, sharers: null, settleUntil: 0 };

/** Other people sharing a screen in the room the viewer is in. A paused share still counts. */
export function remoteSharers(video: Pick<VideoMixerState, "remoteTracks"> | null): Set<string> {
  return new Set(
    (video?.remoteTracks ?? [])
      .filter((track) => track.source === "screenshare" && !track.isSelf)
      .map((track) => track.participantId),
  );
}

/**
 * Which share cues a new video state calls for. Shares are counted per person, so a share
 * that is republished (a new stream from the same person) is not a stop and a start.
 * Joining a room, changing room or the viewer reconnecting never plays a burst.
 */
export function shareCueStep(
  state: ShareCueState,
  input: { nestId: string | null; viewerConnected: boolean; sharers: ReadonlySet<string> },
  now: number,
): { state: ShareCueState; cues: SoundCue[] } {
  if (!input.nestId || !input.viewerConnected) {
    return { state: { nestId: input.nestId, sharers: null, settleUntil: 0 }, cues: [] };
  }
  if (state.sharers === null || state.nestId !== input.nestId) {
    return { state: { nestId: input.nestId, sharers: new Set(input.sharers), settleUntil: now + SHARE_CUE_SETTLE_MS }, cues: [] };
  }
  const next: ShareCueState = { ...state, sharers: new Set(input.sharers) };
  if (now < state.settleUntil) return { state: next, cues: [] };
  const previous = state.sharers;
  const started = [...input.sharers].some((id) => !previous.has(id));
  const stopped = [...previous].some((id) => !input.sharers.has(id));
  const cues: SoundCue[] = [];
  if (started) cues.push("shareStarted");
  if (stopped) cues.push("shareStopped");
  return { state: next, cues };
}

export interface HandCueState {
  nestId: string | null;
  /** Others with a hand up; `null` until the call's participants are known. */
  raised: ReadonlySet<string> | null;
}

export const INITIAL_HAND_CUE_STATE: HandCueState = { nestId: null, raised: null };

/**
 * Whether someone else just raised their hand. Only a hand going up plays; lowering is
 * silent, and the hands already up when you join or change room are not news.
 */
export function handCueStep(
  state: HandCueState,
  input: { nestId: string | null; raised: ReadonlySet<string> | null },
): { state: HandCueState; cue: boolean } {
  if (!input.nestId || !input.raised) return { state: { nestId: input.nestId, raised: null }, cue: false };
  const next: HandCueState = { nestId: input.nestId, raised: new Set(input.raised) };
  if (state.raised === null || state.nestId !== input.nestId) return { state: next, cue: false };
  const previous = state.raised;
  return { state: next, cue: [...input.raised].some((id) => !previous.has(id)) };
}
