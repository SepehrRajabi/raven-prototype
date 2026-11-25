import { useSyncExternalStore } from "react";

/**
 * Whether you see the labels on a space's rooms. Labels are mostly the owner's way of
 * grouping rooms, so anyone can leave them out. Kept on this device. It decides nothing
 * about access, and the owner's own settings page always lists them.
 */
const STORAGE_KEY = "raven.appearance.roomLabels";
const listeners = new Set<() => void>();
let current: boolean | null = null;

export function parseShowRoomLabels(value: string | null): boolean {
  return value !== "off";
}

function read(): boolean {
  try {
    return parseShowRoomLabels(localStorage.getItem(STORAGE_KEY));
  } catch {
    return true;
  }
}

export function writeShowRoomLabels(show: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, show ? "on" : "off");
  } catch {
    // Not saved, but still followed for this session.
  }
  current = show;
  for (const listener of listeners) listener();
}

export function useShowRoomLabels(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current ?? read(),
    () => true,
  );
}
