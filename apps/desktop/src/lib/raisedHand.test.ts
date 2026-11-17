import { describe, expect, test } from "bun:test";
import { HAND_TURN_TAKEN_MS, handLabel, hadTurn, NO_SPEECH, othersSpeaking, SPEECH_GAP_MS, trackSpeech, type SpeechRun } from "./raisedHand";

function speak(pattern: [number, boolean][]): SpeechRun {
  let run = NO_SPEECH;
  for (const [at, speaking] of pattern) run = trackSpeech(run, speaking, at);
  return run;
}

describe("trackSpeech", () => {
  test("a few seconds of speech is a turn taken", () => {
    const ticks: [number, boolean][] = [];
    for (let at = 0; at <= HAND_TURN_TAKEN_MS; at += 250) ticks.push([at, true]);
    expect(hadTurn(speak(ticks))).toBe(true);
  });

  test("short pauses between words do not start over", () => {
    expect(hadTurn(speak([[0, true], [1000, true], [1500, false], [2000, false], [2100, true], [3100, true]]))).toBe(true);
  });

  test("a long pause starts over", () => {
    expect(hadTurn(speak([[0, true], [1000, true], [1000 + SPEECH_GAP_MS + 1, false], [2500, true], [3200, true]]))).toBe(false);
  });

  test("a short word is not a turn", () => {
    expect(hadTurn(speak([[0, true], [600, true], [900, false]]))).toBe(false);
  });
});

test("othersSpeaking ignores you, including your sidecar identities", () => {
  const voice = (speaking: boolean) => ({ speaking, intensity: 0, meterObserved: true });
  expect(othersSpeaking({ me: voice(true), them: voice(false) }, "me")).toBe(false);
  expect(othersSpeaking({ me: voice(false), them: voice(true) }, "me")).toBe(true);
});

test("handLabel gives the place only when more than one hand is up", () => {
  expect(handLabel(1, 1)).toBe("Would like to speak");
  expect(handLabel(2, 3)).toBe("Would like to speak, 2nd in line");
  expect(handLabel(11, 12)).toBe("Would like to speak, 11th in line");
});
