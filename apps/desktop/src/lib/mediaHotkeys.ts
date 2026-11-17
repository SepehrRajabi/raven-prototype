import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export const MEDIA_HOTKEY_EVENT = "media-hotkey-pressed";

export type MediaHotkeyAction = "mic" | "camera" | "deafen" | "screenShare" | "hand";

export interface MediaHotkeySettings {
  supported: boolean;
  /** Why hotkeys are unavailable in this session, when `supported` is false. */
  unsupportedReason?: string | null;
  mic: string;
  camera: string;
  deafen: string;
  screenShare: string;
  /** "I'd like to speak". Works whether or not the bar shows its button. */
  hand: string;
  registrationError: string | null;
}

export type MediaHotkeySettingsPatch = Pick<
  MediaHotkeySettings,
  "mic" | "camera" | "deafen" | "screenShare" | "hand"
>;

const PRIMARY_MODIFIER =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform)
    ? "Command"
    : "Control";

export const DEFAULT_MEDIA_HOTKEYS: MediaHotkeySettingsPatch = {
  mic: `${PRIMARY_MODIFIER}+Shift+M`,
  camera: `${PRIMARY_MODIFIER}+Shift+V`,
  deafen: `${PRIMARY_MODIFIER}+Shift+D`,
  screenShare: `${PRIMARY_MODIFIER}+Shift+S`,
  hand: `${PRIMARY_MODIFIER}+Shift+H`,
};

export const mediaHotkeyCommands = {
  getSettings: () => invoke<MediaHotkeySettings>("media_hotkeys_get_settings"),
  updateSettings: (patch: MediaHotkeySettingsPatch) =>
    invoke<MediaHotkeySettings>("media_hotkeys_update_settings", { patch }),
};

export async function subscribeMediaHotkeys(onAction: (action: MediaHotkeyAction) => void) {
  return listen<MediaHotkeyAction>(MEDIA_HOTKEY_EVENT, (event) => onAction(event.payload));
}
