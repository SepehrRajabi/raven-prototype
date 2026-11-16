import { MAX_VOLUME_PERCENT } from "@/components/media/audioSatellites";
import type { VoiceOverlayButtons } from "@/lib/voiceOverlay";

/** One scroll notch moves someone's volume this many percent. */
export const VOLUME_STEP_PERCENT = 10;
/** A mouse notch is about 100 px of wheel delta; trackpads send many small deltas that add up. */
const WHEEL_NOTCH_PX = 100;
/** Volume changes reach the main window at most this often, and always the last value. */
export const VOLUME_SEND_INTERVAL_MS = 80;
/** The percent and its bar stay for this long after the last scroll. */
export const VOLUME_READOUT_MS = 1500;

export type CardButton = "mute" | "deafen" | "away" | "hand";

/** Volume after `notches` scroll notches (positive is louder), kept to a whole 0–200. */
export function steppedVolumePercent(current: number, notches: number): number {
  return clampVolumePercent(current + notches * VOLUME_STEP_PERCENT);
}

export function clampVolumePercent(percent: number): number {
  if (!Number.isFinite(percent)) return 100;
  return Math.min(MAX_VOLUME_PERCENT, Math.max(0, Math.round(percent)));
}

/**
 * Whole notches in one wheel event, with the part that is not a whole notch carried to the
 * next event. Scrolling up (negative deltaY) is louder.
 */
export function takeWheelNotches(
  carry: number,
  deltaY: number,
  deltaMode: number,
): { notches: number; carry: number } {
  const px = deltaMode === 2 ? deltaY * WHEEL_NOTCH_PX * 3 : deltaMode === 1 ? deltaY * 34 : deltaY;
  const total = carry - px;
  const notches = Math.trunc(total / WHEEL_NOTCH_PX);
  return { notches, carry: total - notches * WHEEL_NOTCH_PX };
}

/** The buttons under your row, in order. None outside a call, while not interactive, or switched off. */
export function cardButtons({
  inCall,
  interactive,
  buttons,
  awaySupported,
  handSupported = false,
}: {
  inCall: boolean;
  interactive: boolean;
  buttons: VoiceOverlayButtons;
  awaySupported: boolean;
  handSupported?: boolean;
}): CardButton[] {
  if (!inCall || !interactive) return [];
  const shown: CardButton[] = [];
  if (buttons.mute) shown.push("mute");
  if (buttons.deafen) shown.push("deafen");
  if (buttons.away && awaySupported) shown.push("away");
  if (buttons.hand && handSupported) shown.push("hand");
  return shown;
}

/**
 * What a person's volume shows. While it is changing, and for a moment after, the percent and
 * a bar show. After that, a changed volume keeps a small percent while the card is interactive.
 */
export function volumeReadout({
  percent,
  changedAt,
  now,
  interactive,
}: {
  percent: number;
  changedAt: number | null;
  now: number;
  interactive: boolean;
}): { show: boolean; flashing: boolean } {
  const flashing = changedAt != null && now - changedAt < VOLUME_READOUT_MS;
  return { show: flashing || (interactive && percent !== 100), flashing };
}

export interface LatestThrottle<T> {
  push(value: T): void;
  cancel(): void;
}

interface ThrottleClock {
  now?: () => number;
  schedule?: (run: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

/**
 * Sends at most once per `intervalMs`, and always the last value pushed. The clock is
 * injectable so the timing can be tested without waiting.
 */
export function createLatestThrottle<T>(
  send: (value: T) => void,
  intervalMs: number,
  clock: ThrottleClock = {},
): LatestThrottle<T> {
  const now = clock.now ?? Date.now;
  const schedule = clock.schedule ?? ((run, ms) => setTimeout(run, ms));
  const cancelScheduled = clock.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let last = Number.NEGATIVE_INFINITY;
  let handle: unknown = null;
  let pending: { value: T } | null = null;

  const flush = () => {
    handle = null;
    if (!pending) return;
    const { value } = pending;
    pending = null;
    last = now();
    send(value);
  };

  return {
    push(value) {
      pending = { value };
      if (handle !== null) return;
      handle = schedule(flush, Math.max(0, intervalMs - (now() - last)));
    },
    cancel() {
      if (handle !== null) cancelScheduled(handle);
      handle = null;
      pending = null;
    },
  };
}
