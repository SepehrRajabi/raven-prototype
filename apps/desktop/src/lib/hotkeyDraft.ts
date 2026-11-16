import type { MediaHotkeySettingsPatch } from "./mediaHotkeys";

/** The shortcuts being edited: the four media bindings and the voice overlay's. */
export type HotkeyDraft = MediaHotkeySettingsPatch & { voiceOverlay: string };

/** Whether the form differs from what was last saved, so Save is only live for a real change. */
export function hotkeyDraftDirty(draft: HotkeyDraft, saved: HotkeyDraft): boolean {
  return (
    draft.mic !== saved.mic ||
    draft.camera !== saved.camera ||
    draft.deafen !== saved.deafen ||
    draft.screenShare !== saved.screenShare ||
    draft.hand !== saved.hand ||
    draft.voiceOverlay !== saved.voiceOverlay
  );
}
