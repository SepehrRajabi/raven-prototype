import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ThumbnailToolbarSnapshot } from "./thumbnailToolbar";

export const TRAY_ACTION_EVENT = "tray-action";

/** What a click in the tray menu asks this window to do. */
export type TrayAction =
  | { action: "mic" | "deafen" | "leave" | "settings" | "checkUpdates" }
  | { action: "presence"; presence: string }
  | { action: "away"; away: boolean };

export type TrayCallStatus = "connected" | "connecting" | "reconnecting" | "leaving";

export interface TrayPresenceOption {
  id: string;
  label: string;
}

/** The call fields are shared with the taskbar buttons so both enable the same actions. */
export interface TraySnapshot extends ThumbnailToolbarSnapshot {
  callName: string | null;
  callStatus: TrayCallStatus;
  presence: string;
  presences: TrayPresenceOption[];
  /** "Back in a bit" is set for everyone in the call. */
  away: boolean;
  /** The call is connected and its server shares "Back in a bit". Only the macOS menu offers it. */
  awaySupported: boolean;
}

export interface TraySettings {
  supported: boolean;
  closeToTray: boolean;
  /** Raven starts in the tray when the user signs in to the computer. Off by default. */
  launchAtStartup: boolean;
}

export type TraySettingsPatch = Partial<Pick<TraySettings, "closeToTray" | "launchAtStartup">>;

/** How the tray words the connection: only "connected" is a settled call. */
export function trayCallStatus(phase: string, reconnecting: boolean): TrayCallStatus {
  if (phase === "leaving") return "leaving";
  if (reconnecting) return "reconnecting";
  return phase === "connected" ? "connected" : "connecting";
}

export function buildTraySnapshot(input: {
  call: ThumbnailToolbarSnapshot;
  callName: string | null | undefined;
  phase: string;
  reconnecting: boolean;
  presence: string;
  presences: TrayPresenceOption[];
  away?: boolean;
  awaySupported?: boolean;
}): TraySnapshot {
  return {
    ...input.call,
    callName: input.call.hasMediaSession ? input.callName?.trim() || null : null,
    callStatus: trayCallStatus(input.phase, input.reconnecting),
    presence: input.presence,
    presences: input.presences,
    away: input.call.hasMediaSession && Boolean(input.away),
    awaySupported: input.call.hasMediaSession && Boolean(input.awaySupported),
  };
}

let revision = 0;
let lastUnread: boolean | null = null;
const generation = typeof crypto !== "undefined" && crypto.randomUUID
  ? crypto.randomUUID()
  : `${Date.now()}-${Math.random()}`;

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Keeps the Windows tray icon, its tooltip and its menu in step with the app.
 * Calls from the browser preview are intentionally a no-op.
 */
export const trayCommands = {
  update: (snapshot: TraySnapshot) => {
    if (!isTauriRuntime()) return Promise.resolve();
    revision += 1;
    return invoke<void>("tray_update", { snapshot: { ...snapshot, generation, revision } });
  },
  /** Safe to call often; it only acts on a change. */
  setUnread: (unread: boolean) => {
    if (!isTauriRuntime() || lastUnread === unread) return Promise.resolve();
    lastUnread = unread;
    return invoke<void>("tray_set_unread", { unread }).catch(() => {
      lastUnread = null;
    });
  },
  getSettings: () => invoke<TraySettings>("tray_get_settings"),
  updateSettings: (patch: TraySettingsPatch) =>
    invoke<TraySettings>("tray_update_settings", { patch }),
};

export async function subscribeTrayActions(onAction: (action: TrayAction) => void) {
  if (!isTauriRuntime()) return () => undefined;
  return getCurrentWindow().listen<TrayAction>(TRAY_ACTION_EVENT, (event) => onAction(event.payload));
}
