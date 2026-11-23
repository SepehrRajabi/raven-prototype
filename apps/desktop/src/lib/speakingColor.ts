import { useSyncExternalStore } from "react";

/**
 * The colour of the speaking ring and your own mic level. Kept on this device. Every
 * window (main, overlay, studio) applies it through the `--speaking-choice` CSS variable,
 * which `--speaking` follows unless a custom theme sets `--speaking` itself, and follows
 * changes made in another window through the `storage` event.
 */
export type SpeakingColorId = "aqua" | "blue" | "violet" | "rose" | "green";

export const SPEAKING_COLORS: readonly { id: SpeakingColorId; label: string; hsl: string }[] = [
  { id: "aqua", label: "Aqua", hsl: "172 42% 60%" },
  { id: "blue", label: "Blue", hsl: "212 72% 68%" },
  { id: "violet", label: "Violet", hsl: "262 62% 74%" },
  { id: "rose", label: "Rose", hsl: "336 64% 72%" },
  { id: "green", label: "Green", hsl: "128 42% 60%" },
];

export const DEFAULT_SPEAKING_COLOR: SpeakingColorId = "aqua";

const STORAGE_KEY = "raven.appearance.speakingColor";
const listeners = new Set<() => void>();
let current: SpeakingColorId | null = null;

export function parseSpeakingColor(value: string | null): SpeakingColorId {
  return SPEAKING_COLORS.some((color) => color.id === value) ? (value as SpeakingColorId) : DEFAULT_SPEAKING_COLOR;
}

function read(): SpeakingColorId {
  try {
    return parseSpeakingColor(localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_SPEAKING_COLOR;
  }
}

function apply(id: SpeakingColorId) {
  const color = SPEAKING_COLORS.find((candidate) => candidate.id === id) ?? SPEAKING_COLORS[0];
  document.documentElement.style.setProperty("--speaking-choice", color.hsl);
}

function set(id: SpeakingColorId) {
  current = id;
  apply(id);
  for (const listener of listeners) listener();
}

/** Apply the saved colour and follow changes from other windows. Call once per window. */
export function installSpeakingColor() {
  set(read());
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) set(parseSpeakingColor(event.newValue));
  });
}

export function writeSpeakingColor(id: SpeakingColorId) {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Not saved, but still shown for this session.
  }
  set(id);
}

export function useSpeakingColor(): SpeakingColorId {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current ?? read(),
  );
}
