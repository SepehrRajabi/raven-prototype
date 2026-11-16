import { useEffect, useState } from "react";
import { Keyboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsField, SettingsHint, SettingsSection } from "@/shells/ravenv1/SettingsScaffold";
import {
  DEFAULT_MEDIA_HOTKEYS,
  mediaHotkeyCommands,
  type MediaHotkeySettings,
  type MediaHotkeySettingsPatch,
} from "@/lib/mediaHotkeys";
import { hotkeyDraftDirty, type HotkeyDraft } from "@/lib/hotkeyDraft";
import { PushToTalkKeyField } from "@/components/PushToTalkKeyField";
import { usePushToTalk, usePushToTalkPicker } from "@/shells/ravenv1/usePushToTalk";
import {
  DEFAULT_VOICE_OVERLAY_HOTKEY,
  formatHotkeyEvent,
  type VoiceOverlaySettings,
  voiceOverlayCommands,
} from "@/lib/voiceOverlay";

const DEFAULT_HOTKEY_DRAFT: HotkeyDraft = {
  ...DEFAULT_MEDIA_HOTKEYS,
  voiceOverlay: DEFAULT_VOICE_OVERLAY_HOTKEY,
};

const FIELDS: { id: keyof HotkeyDraft; label: string; hint: string }[] = [
  { id: "mic", label: "Microphone", hint: "Mute or unmute your microphone." },
  { id: "camera", label: "Camera", hint: "Turn your camera on or off." },
  { id: "deafen", label: "Stop hearing people", hint: "Silence everyone, or hear them again." },
  { id: "screenShare", label: "Screen share", hint: "Choose what to share, or stop sharing." },
  { id: "hand", label: "I’d like to speak", hint: "Raise or lower your hand in a call, even when the bar hides its button." },
  { id: "voiceOverlay", label: "Voice overlay", hint: "Show or hide the overlay." },
];

export function MediaHotkeySettingsPanel() {
  const [settings, setSettings] = useState<MediaHotkeySettings | null>(null);
  const [overlaySettings, setOverlaySettings] = useState<VoiceOverlaySettings | null>(null);
  const [draft, setDraftState] = useState<HotkeyDraft>(DEFAULT_HOTKEY_DRAFT);
  const [saved, setSaved] = useState<HotkeyDraft>(DEFAULT_HOTKEY_DRAFT);
  const [justSaved, setJustSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Any edit takes the "Saved." note away: the form no longer says what was saved.
  const setDraft = (update: HotkeyDraft | ((current: HotkeyDraft) => HotkeyDraft)) => {
    setJustSaved(false);
    setDraftState(update);
  };

  useEffect(() => {
    let active = true;
    Promise.all([mediaHotkeyCommands.getSettings(), voiceOverlayCommands.getSettings()])
      .then(([next, nextOverlay]) => {
        if (!active) return;
        setSettings(next);
        setOverlaySettings(nextOverlay);
        const loaded = { ...pickBindings(next), voiceOverlay: nextOverlay.hotkey || DEFAULT_VOICE_OVERLAY_HOTKEY };
        setDraftState(loaded);
        setSaved(loaded);
        setError(next.registrationError ?? nextOverlay.registrationError ?? "");
      })
      .catch((err) => {
        if (!active) return;
        setSettings({ supported: false, ...DEFAULT_MEDIA_HOTKEYS, registrationError: null });
        setOverlaySettings(null);
        setError(messageFromHotkeyError(err));
      });
    return () => { active = false; };
  }, []);

  if (!settings || !overlaySettings) {
    return <SettingsSection title="Shortcuts"><SettingsHint>Checking whether shortcuts work on this system…</SettingsHint></SettingsSection>;
  }

  if (!settings.supported) {
    return (
      <SettingsSection title="Shortcuts">
        <SettingsHint>{settings.unsupportedReason || "Background shortcuts are not available on this system yet."}</SettingsHint>
      </SettingsSection>
    );
  }

  const dirty = hotkeyDraftDirty(draft, saved);

  const save = async () => {
    setSaving(true);
    setError("");
    setJustSaved(false);
    try {
      const mediaPatch = pickMediaDraft(draft);
      const [next, nextOverlay] = await Promise.all([
        mediaHotkeyCommands.updateSettings(mediaPatch),
        voiceOverlayCommands.updateSettings({ hotkey: draft.voiceOverlay }),
      ]);
      setSettings(next);
      setOverlaySettings(nextOverlay);
      const stored = { ...pickBindings(next), voiceOverlay: nextOverlay.hotkey || DEFAULT_VOICE_OVERLAY_HOTKEY };
      const refused = next.registrationError ?? nextOverlay.registrationError ?? "";
      setDraftState(stored);
      setSaved(stored);
      setError(refused);
      // A key the system refused is not a success, even when the others registered.
      setJustSaved(!refused);
    } catch (err) {
      setError(messageFromHotkeyError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection
      title="Shortcuts"
      description="Click a field, then press the keys you want."
    >
      <div className="grid gap-4 md:grid-cols-2">
        {FIELDS.map((field) => (
          <SettingsField key={field.id} label={field.label} hint={field.hint}>
            <div className="relative">
              <Keyboard className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
              <Input
                className="rv-mono cursor-default pl-9 text-small"
                value={draft[field.id]}
                readOnly
                aria-label={`${field.label} global hotkey`}
                onFocus={(event) => event.currentTarget.select()}
                onKeyDown={(event) => {
                  event.preventDefault();
                  const hotkey = formatHotkeyEvent(event);
                  if (hotkey) setDraft((current) => ({ ...current, [field.id]: hotkey }));
                }}
              />
            </div>
          </SettingsField>
        ))}
        <PushToTalkShortcutField />
      </div>

      {error ? <p role="alert" className="rounded-control bg-destructive/10 px-3 py-2 text-small text-destructive">{error}</p> : null}

      <div className="flex items-center justify-between gap-3">
        <Button type="button" variant="ghost" onClick={() => setDraft(DEFAULT_HOTKEY_DRAFT)} disabled={saving}>Restore defaults</Button>
        <div className="flex items-center gap-3">
          {justSaved && !dirty ? <span role="status" className="text-small text-muted-foreground">Saved.</span> : null}
          <Button type="button" onClick={() => void save()} disabled={saving || !dirty || Object.values(draft).some((value) => !value.trim())}>
            {saving ? "Saving…" : "Save shortcuts"}
          </Button>
        </div>
      </div>
    </SettingsSection>
  );
}

/** Saved as soon as it is picked: it is one key, and Audio and video works the same way. */
function PushToTalkShortcutField() {
  const pushToTalk = usePushToTalk();
  const picker = usePushToTalkPicker(pushToTalk);
  const { settings } = pushToTalk;
  if (!settings?.supported) return null;
  return (
    <SettingsField
      label="Push to talk"
      hint={settings.enabled ? "Hold to talk. Any key or mouse button." : "Turn it on in Audio and video."}
    >
      <PushToTalkKeyField value={settings.key} listening={picker.listening} onListeningChange={picker.setListening} onPick={picker.pick} />
      {picker.error ? <p role="alert" className="mt-1 text-caption text-destructive">{picker.error}</p> : null}
    </SettingsField>
  );
}

function pickMediaDraft(draft: HotkeyDraft): MediaHotkeySettingsPatch {
  return {
    mic: draft.mic,
    camera: draft.camera,
    deafen: draft.deafen,
    screenShare: draft.screenShare,
    hand: draft.hand,
  };
}

function pickBindings(settings: MediaHotkeySettings): MediaHotkeySettingsPatch {
  return {
    mic: settings.mic,
    camera: settings.camera,
    deafen: settings.deafen,
    screenShare: settings.screenShare,
    hand: settings.hand,
  };
}

function messageFromHotkeyError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "detail" in error) {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === "string") return detail;
    if (detail && typeof detail === "object" && "message" in detail && typeof (detail as { message?: unknown }).message === "string") {
      return (detail as { message: string }).message;
    }
  }
  return "Could not save global media hotkeys";
}
