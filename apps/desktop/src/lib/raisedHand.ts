import { useEffect, useState } from "react";
import { stripSidecarIdentity } from "@/lib/mediaIdentity";
import type { ParticipantVoiceActivityMap } from "@/lib/speakingActivity";

/**
 * "I'd like to speak" asks the people in the call for a turn, not a host for permission.
 * Only you lower it, and it lowers itself once you have had your turn: this long of your
 * own speech with the mic live.
 */
export const HAND_TURN_TAKEN_MS = 3000;
/** Pauses between words up to this long still count as one stretch of speech. */
export const SPEECH_GAP_MS = 1200;
/** How long the room has to be quiet before the first in line is told the gap is theirs. */
export const YOUR_TURN_QUIET_MS = 1500;
/** How often a raised hand checks whether you are speaking. */
export const SPEECH_TICK_MS = 250;

export interface SpeechRun {
  startedAt: number | null;
  lastAt: number | null;
}

export const NO_SPEECH: SpeechRun = { startedAt: null, lastAt: null };

/** One look at whether you are speaking now, folded into the current stretch of speech. */
export function trackSpeech(run: SpeechRun, speaking: boolean, now: number): SpeechRun {
  const continuing = run.lastAt !== null && now - run.lastAt <= SPEECH_GAP_MS;
  if (!speaking) return continuing ? run : NO_SPEECH;
  return { startedAt: continuing && run.startedAt !== null ? run.startedAt : now, lastAt: now };
}

export function hadTurn(run: SpeechRun): boolean {
  return run.startedAt !== null && run.lastAt !== null && run.lastAt - run.startedAt >= HAND_TURN_TAKEN_MS;
}

/** Someone other than you is speaking. */
export function othersSpeaking(activity: ParticipantVoiceActivityMap, localUserId: string | undefined): boolean {
  return Object.entries(activity).some(([id, voice]) => voice.speaking && stripSidecarIdentity(id) !== localUserId);
}

/**
 * True while you are first in line and nobody else has spoken for a moment. Worked out
 * here from what this device already hears; nothing is sent.
 */
export function useYourTurn(firstInLine: boolean, roomSpeaking: boolean): boolean {
  const [yourTurn, setYourTurn] = useState(false);
  useEffect(() => {
    setYourTurn(false);
    if (!firstInLine || roomSpeaking) return;
    const timer = window.setTimeout(() => setYourTurn(true), YOUR_TURN_QUIET_MS);
    return () => window.clearTimeout(timer);
  }, [firstInLine, roomSpeaking]);
  return yourTurn;
}

/** "Would like to speak", with the place in line once more than one hand is up. */
export function handLabel(order: number, raisedCount: number): string {
  return raisedCount > 1 ? `Would like to speak, ${ordinal(order)} in line` : "Would like to speak";
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}
