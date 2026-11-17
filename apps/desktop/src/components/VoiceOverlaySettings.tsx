import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  SettingsHint,
  SettingsRow,
  SettingsRows,
  SettingsSection,
  SettingsToggleRow,
} from "@/shells/ravenv1/SettingsScaffold";
import {
  DEFAULT_VOICE_OVERLAY_BACKGROUND,
  type VoiceOverlayBackground,
  type VoiceOverlayInteract,
  type VoiceOverlayNames,
  type VoiceOverlayQuietFade,
  type VoiceOverlayView,
  type VoiceOverlaySettings,
  type VoiceOverlaySettingsPatch,
  type VoiceOverlayShape,
  type VoiceOverlaySize,
  voiceOverlayCommands,
} from "@/lib/voiceOverlay";

const BACKGROUND_LABEL: Record<VoiceOverlayBackground, string> = {
  light: "Light",
  strong: "Strong",
  off: "Off",
};

const VIEW_LABEL: Record<VoiceOverlayView, string> = {
  everyone: "Everyone",
  talkersFirst: "Talkers first",
  onlyTalking: "Only talking",
};

const NAMES_LABEL: Record<VoiceOverlayNames, string> = {
  always: "Always",
  whileTalking: "While talking",
  never: "Never",
};

const QUIET_FADE_LABEL: Record<VoiceOverlayQuietFade, string> = {
  none: "Stay as it is",
  some: "Fade a little",
  lots: "Fade a lot",
};

const LINGER_LABEL: Record<"3" | "6" | "0", string> = {
  "3": "3 seconds",
  "6": "6 seconds",
  "0": "Off",
};

const SHAPE_LABEL: Record<VoiceOverlayShape, string> = {
  followEdge: "Follow edge",
  column: "Column",
  row: "Row",
};

const SIZE_LABEL: Record<VoiceOverlaySize, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
};

const INTERACT_LABEL: Record<VoiceOverlayInteract, string> = {
  hover: "When I point at it",
  hold: "While I hold the key",
  never: "Never",
};

/** `treeLabel` is the user's word for a tree, lower case ("tree" or "space"). */
export function VoiceOverlaySettingsPanel({ treeLabel = "tree" }: { treeLabel?: string }) {
  const [settings, setSettings] = useState<VoiceOverlaySettings | null>(null);
  const [saving, setSaving] = useState<keyof VoiceOverlaySettingsPatch | "position" | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    voiceOverlayCommands
      .getSettings()
      .then((nextSettings) => {
        if (!active) return;
        setSettings(nextSettings);
        setError(nextSettings.registrationError ?? "");
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  if (!settings) {
    return (
      <SettingsSection title="Overlay">
        <SettingsHint>Checking whether the overlay works on this system…</SettingsHint>
      </SettingsSection>
    );
  }

  if (!settings.supported) {
    return (
      <SettingsSection title="Overlay">
        <SettingsHint>The overlay works on Windows only for now.</SettingsHint>
      </SettingsSection>
    );
  }

  // Each change applies at once; only the control that is saving waits.
  const update = async (patch: VoiceOverlaySettingsPatch) => {
    const key = Object.keys(patch)[0] as keyof VoiceOverlaySettingsPatch;
    const previous = settings;
    setSettings({ ...settings, ...patch });
    setSaving(key);
    setError("");
    try {
      const next = await voiceOverlayCommands.updateSettings(patch);
      setSettings(next);
      setError(next.registrationError ?? "");
    } catch (err) {
      setSettings(previous);
      setError(messageFromOverlayError(err));
    } finally {
      setSaving(null);
    }
  };

  const resetPosition = async () => {
    setSaving("position");
    setError("");
    try {
      setSettings(await voiceOverlayCommands.resetPosition());
    } catch (err) {
      setError(messageFromOverlayError(err));
    } finally {
      setSaving(null);
    }
  };

  const enabled = settings.enabled;
  const background = settings.background ?? DEFAULT_VOICE_OVERLAY_BACKGROUND;
  const hotkey = hotkeyLabel(settings.hotkey);

  return (
    <div className="space-y-8">
      <SettingsSection title="Showing the overlay" description={`Show or hide it with ${hotkey}. The shortcut is set under Hotkeys.`}>
        <SettingsRows>
          <SettingsToggleRow
            label="Overlay"
            description="Shows who’s in your call over games and other apps."
            checked={enabled}
            disabled={saving === "enabled"}
            onChange={(checked) => void update({ enabled: checked })}
          />
          <SettingsToggleRow
            label="Show when I join a call"
            description="Hides again when you leave, unless you showed it yourself."
            checked={settings.showOnJoin}
            disabled={!enabled || saving === "showOnJoin"}
            onChange={(checked) => void update({ showOnJoin: checked })}
          />
        </SettingsRows>
      </SettingsSection>

      <SettingsSection title="Who it shows">
        <SettingsRows>
          <SettingsRow
            label="View"
            description="Talkers first lists who’s talking and folds the rest into a row."
            control={
              <ChoiceSelect
                label="View"
                value={settings.view}
                labels={VIEW_LABEL}
                disabled={!enabled || saving === "view"}
                onChange={(view) => void update({ view })}
              />
            }
          />
          <SettingsRow
            label="Keep a name after they stop talking"
            control={
              <ChoiceSelect
                label="Keep a name after they stop talking"
                value={String(settings.lingerSeconds) as "3" | "6" | "0"}
                labels={LINGER_LABEL}
                disabled={!enabled || saving === "lingerSeconds"}
                onChange={(seconds) => void update({ lingerSeconds: Number(seconds) })}
              />
            }
          />
          <SettingsRow
            label="Names"
            description={settings.effectiveShape === "row" ? "A row shows a name only for people who are talking." : undefined}
            control={
              <ChoiceSelect
                label="Names"
                value={settings.names}
                labels={NAMES_LABEL}
                disabled={!enabled || saving === "names"}
                onChange={(names) => void update({ names })}
              />
            }
          />
        </SettingsRows>
      </SettingsSection>

      <SettingsSection title="Look">
        <SettingsRows>
          <SettingsRow
            label="Shape"
            description="Follow edge makes it a row along the top or bottom of the screen, and a column at the sides."
            control={
              <ChoiceSelect
                label="Shape"
                value={settings.shape}
                labels={SHAPE_LABEL}
                disabled={!enabled || saving === "shape"}
                onChange={(shape) => void update({ shape })}
              />
            }
          />
          <SettingsRow
            label="Size"
            control={
              <ChoiceSelect
                label="Size"
                value={settings.size}
                labels={SIZE_LABEL}
                disabled={!enabled || saving === "size"}
                onChange={(size) => void update({ size })}
              />
            }
          />
          <SettingsRow
            label="Background"
            description="A dark fill behind the card, so it can be read over any game."
            control={
              <ChoiceSelect
                label="Background"
                value={background}
                labels={BACKGROUND_LABEL}
                disabled={!enabled || saving === "background"}
                onChange={(next) => void update({ background: next })}
              />
            }
          />
          <SettingsRow
            label="When nobody is talking"
            control={
              <ChoiceSelect
                label="When nobody is talking"
                value={settings.quietFade}
                labels={QUIET_FADE_LABEL}
                disabled={!enabled || saving === "quietFade"}
                onChange={(quietFade) => void update({ quietFade })}
              />
            }
          />
        </SettingsRows>
      </SettingsSection>

      <SettingsSection title="Using the overlay">
        <SettingsRows>
          <SettingsRow
            label="Interact"
            description={interactHint(settings.interact, hotkey)}
            control={
              <ChoiceSelect
                label="Interact"
                value={settings.interact}
                labels={INTERACT_LABEL}
                width="w-[184px]"
                disabled={!enabled || saving === "interact"}
                onChange={(interact) => void update({ interact })}
              />
            }
          />
          <SettingsToggleRow
            label="Mute button"
            checked={settings.overlayButtons.mute}
            disabled={!enabled || saving === "overlayButtons"}
            onChange={(checked) => void update({ overlayButtons: { ...settings.overlayButtons, mute: checked } })}
          />
          <SettingsToggleRow
            label="Deafen button"
            checked={settings.overlayButtons.deafen}
            disabled={!enabled || saving === "overlayButtons"}
            onChange={(checked) => void update({ overlayButtons: { ...settings.overlayButtons, deafen: checked } })}
          />
          <SettingsToggleRow
            label="Back in a bit button"
            checked={settings.overlayButtons.away}
            disabled={!enabled || saving === "overlayButtons"}
            onChange={(checked) => void update({ overlayButtons: { ...settings.overlayButtons, away: checked } })}
          />
          <SettingsToggleRow
            label="I’d like to speak button"
            checked={settings.overlayButtons.hand}
            disabled={!enabled || saving === "overlayButtons"}
            onChange={(checked) => void update({ overlayButtons: { ...settings.overlayButtons, hand: checked } })}
          />
          <SettingsToggleRow
            label="Scroll on a person to change their volume"
            description="Changes only what you hear."
            checked={settings.scrollVolume}
            disabled={!enabled || saving === "scrollVolume"}
            onChange={(checked) => void update({ scrollVolume: checked })}
          />
          <SettingsRow
            label="Position"
            description="Puts the overlay back in the top-left corner of your main screen."
            control={
              <Button size="sm" variant="secondary" disabled={!enabled || saving === "position"} onClick={() => void resetPosition()}>
                Reset position
              </Button>
            }
          />
        </SettingsRows>
      </SettingsSection>

      <SettingsSection title="Heads-up">
        <SettingsRows>
          <SettingsToggleRow
            label="Tell me when I talk while muted"
            checked={settings.mutedHint}
            disabled={!enabled || saving === "mutedHint"}
            onChange={(checked) => void update({ mutedHint: checked })}
          />
          <SettingsToggleRow
            label="Show weak connections"
            description="Your own “Reconnecting…” always shows."
            checked={settings.showWeakConnections}
            disabled={!enabled || saving === "showWeakConnections"}
            onChange={(checked) => void update({ showWeakConnections: checked })}
          />
          <SettingsToggleRow
            label="Show people joining and leaving"
            checked={settings.showJoinsAndLeaves}
            disabled={!enabled || saving === "showJoinsAndLeaves"}
            onChange={(checked) => void update({ showJoinsAndLeaves: checked })}
          />
          <SettingsToggleRow
            label="Show knocks"
            description="Open and Dismiss are there while you can click the overlay."
            checked={settings.showKnocks}
            disabled={!enabled || saving === "showKnocks"}
            onChange={(checked) => void update({ showKnocks: checked })}
          />
          <SettingsRow
            label="Show messages"
            description={`From text rooms in the ${treeLabel} you’re calling in.`}
            control={
              <ChoiceSelect
                label="Show messages"
                value={settings.showMessages}
                labels={{ off: "Off", tree: `From this ${treeLabel}` }}
                width="w-[168px]"
                disabled={!enabled || saving === "showMessages"}
                onChange={(showMessages) => void update({ showMessages })}
              />
            }
          />
        </SettingsRows>
      </SettingsSection>

      {error ? (
        <p role="alert" className="rounded-control bg-destructive/10 px-3 py-2 text-small text-destructive">{error}</p>
      ) : null}
    </div>
  );
}

function ChoiceSelect<T extends string>({
  label,
  value,
  labels,
  disabled,
  width = "w-[136px]",
  onChange,
}: {
  label: string;
  value: T;
  labels: Record<T, ReactNode>;
  disabled?: boolean;
  width?: string;
  onChange: (value: T) => void;
}) {
  return (
    <Select value={value} disabled={disabled} onValueChange={(next) => onChange(next as T)}>
      <SelectTrigger size="sm" className={width} aria-label={label}>
        <SelectValue>{labels[value]}</SelectValue>
      </SelectTrigger>
      <SelectContent align="end">
        <SelectGroup>
          {(Object.keys(labels) as T[]).map((option) => (
            <SelectItem key={option} value={option}>{labels[option]}</SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function interactHint(interact: VoiceOverlayInteract, hotkey: string) {
  if (interact === "hold") return `Hold ${hotkey} to click or drag it. A quick tap still shows or hides it.`;
  if (interact === "never") return "Clicks always go through to your game. It can’t be dragged; use Reset position to move it.";
  return "Rest the pointer on it for a moment to click or drag it. Otherwise clicks go straight through to your game.";
}

function hotkeyLabel(value: string) {
  return value.replace(/Control/g, "Ctrl").replace(/\+/g, " + ");
}

function messageFromOverlayError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "detail" in error) {
    const detail = (error as { detail?: { message?: unknown } }).detail;
    if (detail && typeof detail.message === "string") return detail.message;
  }
  return "Couldn’t save overlay settings.";
}
