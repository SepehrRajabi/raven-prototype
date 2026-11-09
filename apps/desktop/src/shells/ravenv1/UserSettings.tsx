import { useEffect, useState } from "react";
import { PasswordChangeForm } from "./PasswordChangeForm";
import { InvitationsSettings } from "./InvitationsSettings";
import { YourDataSettings } from "./YourDataSettings";
import { WorkshopSettings } from "./WorkshopSettings";
import { capabilitiesOf } from "@/lib/permissions";
import { Bell, Check, Download, Info, Keyboard, MessageSquare, MonitorUp, Palette, PanelBottom, RefreshCw, Server as ServerIcon, ShieldCheck, Ticket, User as UserIcon, Video, Wrench } from "lucide-react";
import { ChatSettingsPage } from "@/components/chat/ChatSettings";
import type { ChatStore } from "@/lib/chat/store";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { VoiceOverlaySettingsPanel } from "@/components/VoiceOverlaySettings";
import { MediaHotkeySettingsPanel } from "@/components/MediaHotkeySettings";
import { PushToTalkSettings } from "@/components/PushToTalkSettings";
import { TraySettingsPanel } from "@/components/TraySettings";
import { NotificationSettingsPanel } from "@/components/NotificationSettings";
import { SquareImageUpload } from "@/components/SquareImageUpload";
import { UpdatesSettingsPanel } from "@/components/updates/UpdatesSettings";
import { api, type AuthSession, type UILabelPreference } from "@/lib/api";
import type { RavenUpdater } from "@/lib/updater";
import {
  SettingsChoice,
  SettingsField,
  SettingsHint,
  SettingsNav,
  SettingsPage,
  SettingsReadOnlyRow,
  SettingsRow,
  SettingsRows,
  SettingsSection,
  SettingsToggleRow,
  type SettingsCategoryGroup,
} from "./SettingsScaffold";
import { InfoTooltip } from "./atoms";
import { cn } from "@/lib/utils";
import { SPEAKING_COLORS, useSpeakingColor, writeSpeakingColor } from "@/lib/speakingColor";
import { THEME_COLORS, THEME_DEPTHS, THEME_STRENGTHS, useTheme, writeTheme, type ThemeColorId } from "@/lib/theme";
import { ConfirmLeaveSection, DockOrderSection } from "./DockSettings";
import type { RavenShellData, RavenView } from "./state";
import type {
  NetworkActivityCategory,
  NetworkActivityDirection,
  RavenMediaAdapterState,
} from "./useRavenMediaAdapter";

const onMacSettings = typeof navigator !== "undefined" && /Macintosh|Mac OS X/i.test(navigator.userAgent);

export type UserSettingsSection = "profile" | "messages" | "sessions" | "data" | "invitations" | "appearance" | "audio-video" | "hotkeys" | "voice-overlay" | "tray" | "notifications" | "server" | "workshop" | "updates" | "about";

const GROUPS: SettingsCategoryGroup[] = [
  {
    label: "You",
    categories: [
      { id: "profile", label: "Profile", icon: <UserIcon /> },
      { id: "messages", label: "Messages", icon: <MessageSquare /> },
      { id: "sessions", label: "Password and devices", icon: <ShieldCheck /> },
      { id: "data", label: "Your data", icon: <Download /> },
      { id: "invitations", label: "Invitations", icon: <Ticket /> },
    ],
  },
  {
    label: "App",
    categories: [
      { id: "appearance", label: "Appearance", icon: <Palette /> },
      { id: "audio-video", label: "Audio and video", icon: <Video /> },
      { id: "hotkeys", label: "Hotkeys", icon: <Keyboard /> },
      { id: "voice-overlay", label: "Voice overlay", icon: <MonitorUp /> },
      { id: "tray", label: "Tray", icon: <PanelBottom /> },
      { id: "notifications", label: "Notifications", icon: <Bell /> },
    ],
  },
  {
    label: "System",
    categories: [
      { id: "server", label: "Server", icon: <ServerIcon /> },
      { id: "workshop", label: "Workshop", icon: <Wrench /> },
      { id: "updates", label: "Updates", icon: <RefreshCw /> },
      { id: "about", label: "About", icon: <Info /> },
    ],
  },
];

const SECTION_IDS = new Set(GROUPS.flatMap((group) => group.categories.map((category) => category.id)));

/** Invitations is there only for people allowed to invite; anyone else lands on Profile. */
export function resolveUserSettingsSection(section: string | undefined, canInvite: boolean): UserSettingsSection {
  if (section === "invitations" && !canInvite) return "profile";
  return section && SECTION_IDS.has(section) ? (section as UserSettingsSection) : "profile";
}

const GROUPS_WITHOUT_INVITATIONS = GROUPS.map((group) => ({
  ...group,
  categories: group.categories.filter((category) => category.id !== "invitations"),
}));

export function UserSettingsNav({
  section,
  canInvite,
  onSelect,
  onBack,
}: {
  section: UserSettingsSection;
  canInvite: boolean;
  onSelect: (section: UserSettingsSection) => void;
  onBack: () => void;
}) {
  return (
    <SettingsNav
      title="Settings"
      backLabel="Back"
      onBack={onBack}
      groups={canInvite ? GROUPS : GROUPS_WITHOUT_INVITATIONS}
      activeId={section}
      onSelect={(id) => onSelect(id as UserSettingsSection)}
    />
  );
}

/**
 * Preferences apply as soon as you change them. The stored value stays the
 * source of truth; the local copy only covers the moment before it comes back.
 */
function useAppliedPreference<T>(stored: T, apply: (value: T) => Promise<void>) {
  const [value, setValue] = useState(stored);
  useEffect(() => setValue(stored), [stored]);
  const change = (next: T) => {
    setValue(next);
    void apply(next).catch(() => setValue(stored));
  };
  return [value, change] as const;
}

export function UserSettingsView({
  section,
  data,
  media,
  updater,
  chat = null,
  onNavigate,
}: {
  section: UserSettingsSection;
  data: RavenShellData;
  media: RavenMediaAdapterState;
  updater: RavenUpdater;
  chat?: ChatStore | null;
  /** Absent where there is nowhere to go, such as while Raven needs an update. */
  onNavigate?: (view: RavenView) => void;
}) {
  switch (section) {
    case "profile":
      return <ProfileSettings data={data} />;
    case "messages":
      return <ChatSettingsPage chat={chat} labels={data.labels} />;
    case "invitations":
      return capabilitiesOf(data.user).createInvites ? <InvitationsSettings data={data} /> : <ProfileSettings data={data} />;
    case "sessions":
      return (
        <SettingsPage title="Password and devices" description="Your password, and every place your account is signed in. Sign out anything you do not recognise.">
          <SessionSettings data={data} />
        </SettingsPage>
      );
    case "data":
      return <YourDataSettings data={data} onNavigate={onNavigate} />;
    case "appearance":
      return <AppearanceSettings data={data} />;
    case "audio-video":
      return <AudioVideoSettings data={data} media={media} />;
    case "hotkeys":
      return (
        <SettingsPage title="Hotkeys" description="Shortcuts that work even when Raven is in the background.">
          <MediaHotkeySettingsPanel />
        </SettingsPage>
      );
    case "voice-overlay":
      return (
        <SettingsPage title="Voice overlay" description="A small panel that stays on top of other windows and shows who is speaking.">
          <VoiceOverlaySettingsPanel treeLabel={data.labels.treeSingular.toLowerCase()} />
        </SettingsPage>
      );
    case "tray":
      return (
        <SettingsPage title="Tray" description={`Raven’s icon ${onMacSettings ? "in the menu bar" : "next to the clock"}, and what closing the window does.`}>
          <TraySettingsPanel />
        </SettingsPage>
      );
    case "notifications":
      return (
        <SettingsPage title="Notifications" description="What Raven tells you about while you are in another app or it is in the tray.">
          <NotificationSettingsPanel />
        </SettingsPage>
      );
    case "server":
      return <ServerSettings data={data} />;
    case "workshop":
      return <WorkshopSettings data={data} />;
    case "updates":
      return (
        <SettingsPage title="Updates">
          <UpdatesSettingsPanel updater={updater} />
        </SettingsPage>
      );
    case "about":
      return (
        <SettingsPage title="About">
          <SettingsRows>
            <SettingsReadOnlyRow label="Version" value={updater.state?.currentVersion ?? "…"} />
            {onNavigate ? (
              <SettingsRow
                label="Open-source licences"
                description="The projects Raven is built on."
                control={<Button variant="secondary" onClick={() => onNavigate({ kind: "licences" })}>Open</Button>}
              />
            ) : null}
          </SettingsRows>
        </SettingsPage>
      );
  }
}

function ProfileSettings({ data }: { data: RavenShellData }) {
  const username = data.user?.username ?? "";
  const [displayName, setDisplayName] = useState(data.preferences.displayName);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => setDisplayName(data.preferences.displayName), [data.preferences.displayName]);

  const saveName = async () => {
    const next = displayName.trim();
    if (!next) {
      setDisplayName(data.preferences.displayName);
      return;
    }
    if (next === data.preferences.displayName) return;
    setStatus("saving");
    setError("");
    try {
      await data.updatePreferences({ displayName: next });
      setStatus("saved");
    } catch (err) {
      setStatus("idle");
      setError(err instanceof Error ? err.message : "Your name could not be saved.");
    }
  };

  const uploadAvatar = async (file: File) => {
    setUploading(true);
    setError("");
    try {
      await api.uploadProfileAvatar(file);
      await data.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Your picture could not be uploaded.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <SettingsPage title="Profile" description="How you appear to other people in Raven.">
      <SettingsSection title="Picture and name">
        <div className="flex items-center gap-4">
          <Avatar name={displayName || username} src={data.user ? api.userAvatarUrl(data.user.id, data.user.updatedAt) : undefined} className="h-16 w-16 text-title" />
          <div className="min-w-0">
            <SquareImageUpload disabled={uploading} label={uploading ? "Uploading…" : "Choose a picture"} onUpload={uploadAvatar} onError={setError} />
            <p className="mt-1.5 text-caption text-muted-foreground">You crop it to a square. Raven keeps it under 512 KB.</p>
          </div>
        </div>
        <SettingsField
          label="Display name"
          hint={status === "saved" ? "Saved." : status === "saving" ? "Saving…" : "This is the name people see. It saves when you leave the field."}
        >
          <Input
            value={displayName}
            onChange={(event) => {
              setDisplayName(event.currentTarget.value);
              setStatus("idle");
            }}
            onBlur={() => void saveName()}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") setDisplayName(data.preferences.displayName);
            }}
            placeholder={username}
            maxLength={80}
          />
        </SettingsField>
        {error ? <p role="alert" className="text-small text-destructive">{error}</p> : null}
      </SettingsSection>

      <SettingsSection title="Account">
        <SettingsReadOnlyRow label="Username" value={username ? `@${username}` : ""} />
        <SettingsHint>You sign in with your username, and people find you by it. It cannot be changed here.</SettingsHint>
      </SettingsSection>

      <SettingsSection title="Sign out">
        <SettingsRow
          label="Sign out of Raven on this device"
          description="If you are in a call, you leave it first."
          control={<Button variant="secondary" size="sm" onClick={data.logout}>Sign out</Button>}
        />
      </SettingsSection>
    </SettingsPage>
  );
}

function AppearanceSettings({ data }: { data: RavenShellData }) {
  const [uiLabels, setUiLabels] = useAppliedPreference<UILabelPreference>(data.preferences.uiLabels, (value) => data.updatePreferences({ uiLabels: value }));
  return (
    <SettingsPage title="Appearance">
      <ThemeSection />
      <SettingsSection title="Words" description="What Raven calls groups and the rooms inside them.">
        <SettingsRows>
          <SettingsChoice
            title="Tree and Nest"
            copy="Raven’s own names: a Tree is a group, a Nest is a room in it."
            selected={uiLabels === "tree_nest"}
            onSelect={() => setUiLabels("tree_nest")}
          />
          <SettingsChoice
            title="Space and Room"
            copy="Plainer names for the same two things."
            selected={uiLabels === "space_room"}
            onSelect={() => setUiLabels("space_room")}
          />
        </SettingsRows>
      </SettingsSection>
      <SpeakingColorSection />
      <DockOrderSection />
    </SettingsPage>
  );
}

/** A row of colour swatches, one of which is chosen, with the chosen one's name beside them. */
function SwatchRow<Id extends string>({
  label,
  swatches,
  selected,
  onSelect,
}: {
  label: string;
  swatches: readonly { id: Id; label: string; background: string }[];
  selected: Id;
  onSelect: (id: Id) => void;
}) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-4 px-4 py-2.5">
      <div className="text-body">{swatches.find((swatch) => swatch.id === selected)?.label}</div>
      <div role="radiogroup" aria-label={label} className="flex items-center gap-2.5">
        {swatches.map((swatch) => (
          <Tooltip key={swatch.id} label={swatch.label}>
            <button
              type="button"
              role="radio"
              aria-checked={selected === swatch.id}
              aria-label={swatch.label}
              onClick={() => onSelect(swatch.id)}
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-full transition-[box-shadow] duration-150",
                selected === swatch.id && "shadow-[0_0_0_2px_hsl(var(--card)),0_0_0_4px_hsl(var(--foreground))]",
              )}
              style={{ background: swatch.background }}
            >
              {selected === swatch.id ? <Check className="h-3.5 w-3.5 text-primary-foreground" /> : null}
            </button>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}

/** Three or so short options on one track. */
function SegmentedChoice<Id extends string>({
  label,
  options,
  selected,
  disabled = false,
  onSelect,
}: {
  label: string;
  options: readonly { id: Id; label: string }[];
  selected: Id;
  disabled?: boolean;
  onSelect: (id: Id) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-control bg-background/60 p-0.5">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={selected === option.id}
          disabled={disabled}
          onClick={() => onSelect(option.id)}
          className={cn(
            "h-7 rounded-chip px-2.5 text-small transition-colors",
            selected === option.id ? "bg-accent text-foreground" : "text-muted-foreground enabled:hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

const THEME_SWATCH = (hue: number) => `hsl(${hue} 45% 55%)`;
const THEME_SWATCHES: readonly { id: ThemeColorId; label: string; background: string }[] = THEME_COLORS.map((color) => ({
  id: color.id,
  label: color.label,
  background: color.hue === null ? "hsl(30 5% 55%)" : THEME_SWATCH(color.hue),
}));
const CUSTOM_SWATCH_SWEEP = `conic-gradient(${[0, 60, 120, 180, 240, 300, 360].map(THEME_SWATCH).join(", ")})`;

/** The colour of Raven's surfaces. Kept on this device. */
function ThemeSection() {
  const theme = useTheme();
  const swatches = [
    ...THEME_SWATCHES,
    { id: "custom" as const, label: "Custom", background: theme.color === "custom" ? THEME_SWATCH(theme.customHue) : CUSTOM_SWATCH_SWEEP },
  ];
  const noColor = theme.color === "graphite";
  return (
    <SettingsSection title="Theme" description="The colour of the window and its panels. People, speaking and warnings keep their own colours. It is kept on this device.">
      <SettingsRows>
        <SwatchRow label="Theme colour" swatches={swatches} selected={theme.color} onSelect={(color) => writeTheme({ color })} />
        {theme.color === "custom" ? (
          <SettingsRow
            label="Hue"
            control={(
              <input
                className="raven-fader raven-hue-fader w-56"
                type="range"
                aria-label="Hue"
                min={0}
                max={360}
                step={1}
                value={theme.customHue}
                onChange={(event) => writeTheme({ customHue: Number(event.target.value) })}
              />
            )}
          />
        ) : null}
        <SettingsRow
          label="Strength"
          description="How much colour the surfaces carry."
          className={cn(noColor && "opacity-55")}
          control={<SegmentedChoice label="Strength" options={THEME_STRENGTHS} selected={theme.strength} disabled={noColor} onSelect={(strength) => writeTheme({ strength })} />}
        />
        <SettingsRow
          label="Depth"
          description="How dark the window and panels are."
          control={<SegmentedChoice label="Depth" options={THEME_DEPTHS} selected={theme.depth} onSelect={(depth) => writeTheme({ depth })} />}
        />
      </SettingsRows>
    </SettingsSection>
  );
}

/** The colour that shows who is talking. Kept on this device. */
function SpeakingColorSection() {
  return (
    <SettingsSection title="Speaking colour" description="The ring around whoever is talking, and your own mic level. It is kept on this device.">
      <SettingsRows>
        <SwatchRow
          label="Speaking colour"
          swatches={SPEAKING_COLORS.map((color) => ({ id: color.id, label: color.label, background: `hsl(${color.hsl})` }))}
          selected={useSpeakingColor()}
          onSelect={writeSpeakingColor}
        />
      </SettingsRows>
    </SettingsSection>
  );
}

function SoundCueSection({ media, nest }: { media: RavenMediaAdapterState; nest: string }) {
  const cues = media.soundCues;
  const off = !cues.enabled;
  return (
    <SettingsSection title="Sounds" description="Short, quiet sounds for what happens around you. Only you hear them. Kept on this device.">
      <SettingsRows>
        <SettingsToggleRow label="Play sounds" checked={cues.enabled} onChange={(enabled) => media.setSoundCues({ enabled })} />
        <SettingsRow
          label="Volume"
          className={cn(off && "opacity-55")}
          control={<SoundCueVolume value={cues.volume} disabled={off} onCommit={(volume) => {
            media.setSoundCues({ volume });
            media.previewSoundCue(volume);
          }} />}
        />
        <SettingsToggleRow
          label="Your microphone"
          description="When you mute or unmute. Heard even after you stop hearing people."
          checked={cues.microphone}
          disabled={off}
          onChange={(microphone) => media.setSoundCues({ microphone })}
        />
        <SettingsToggleRow
          label="Someone about to join"
          description={`The heads-up a few seconds before someone enters your ${nest}.`}
          checked={cues.entryHeadsUp}
          disabled={off}
          onChange={(entryHeadsUp) => media.setSoundCues({ entryHeadsUp })}
        />
        <SettingsToggleRow
          label="People joining and leaving"
          description={`When someone arrives in your ${nest} and can be heard, or leaves it.`}
          checked={cues.people}
          disabled={off}
          onChange={(people) => media.setSoundCues({ people })}
        />
        <SettingsToggleRow
          label="Screen shares"
          description={`When someone in your ${nest} starts or stops sharing.`}
          checked={cues.screenShares}
          disabled={off}
          onChange={(screenShares) => media.setSoundCues({ screenShares })}
        />
        <SettingsToggleRow
          label="Knocks"
          description="When someone knocks on you, in a call or not. Do not disturb silences it."
          checked={cues.knocks}
          disabled={off}
          onChange={(knocks) => media.setSoundCues({ knocks })}
        />
        <SettingsToggleRow
          label="Messages"
          description="When a message arrives in a conversation you aren’t looking at. Muted conversations and Do not disturb stay quiet."
          checked={cues.messages}
          disabled={off}
          onChange={(messages) => media.setSoundCues({ messages })}
        />
      </SettingsRows>
    </SettingsSection>
  );
}

/** The cue volume. It is applied, and a sample played, when you let go. */
function SoundCueVolume({ value, disabled, onCommit }: { value: number; disabled: boolean; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = (next: number) => {
    if (next !== value) onCommit(next);
  };
  const percent = `${Math.round(draft * 100)}%`;
  return (
    <div className="flex items-center gap-3">
      <input
        className="raven-fader w-40"
        type="range"
        aria-label="Sound volume"
        aria-valuetext={percent}
        min={0}
        max={1}
        step={0.05}
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(Number(event.target.value))}
        onPointerUp={(event) => commit(Number(event.currentTarget.value))}
        onKeyUp={(event) => commit(Number(event.currentTarget.value))}
      />
      <span className="w-10 text-right text-small tabular-nums text-muted-foreground">{percent}</span>
    </div>
  );
}

function AudioVideoSettings({ data, media }: { data: RavenShellData; media: RavenMediaAdapterState }) {
  const nest = data.labels.nestSingular.toLowerCase();
  const [joinMuted, setJoinMuted] = useAppliedPreference(data.preferences.alwaysJoinMuted, (value) => data.updatePreferences({ alwaysJoinMuted: value }));
  const [joinCameraOff, setJoinCameraOff] = useAppliedPreference(data.preferences.joinWithCameraOff, (value) => data.updatePreferences({ joinWithCameraOff: value }));
  const [joinNoShare, setJoinNoShare] = useAppliedPreference(data.preferences.joinWithoutScreenSharing, (value) => data.updatePreferences({ joinWithoutScreenSharing: value }));

  return (
    <SettingsPage title="Audio and video" description="Devices and their live controls are in the bar at the bottom. These settings decide how Raven behaves around them.">
      <SettingsSection title={`When you join a ${nest}`}>
        <SettingsRows>
          <SettingsToggleRow label="Join muted" description="Your microphone stays off until you unmute." checked={joinMuted} onChange={setJoinMuted} />
          <SettingsToggleRow label="Join with camera off" description="Your camera stays off until you turn it on." checked={joinCameraOff} onChange={setJoinCameraOff} />
          <SettingsToggleRow label="Never join already sharing" description="A screen share you started earlier does not carry into the next call." checked={joinNoShare} onChange={setJoinNoShare} />
        </SettingsRows>
      </SettingsSection>

      <PushToTalkSettings />

      <ConfirmLeaveSection />

      <SettingsSection title="Seeing yourself" description="How Raven shows your own camera or screen back to you. Other people are not affected.">
        <SettingsRows>
          <SettingsChoice
            title="Straight from this device"
            copy="No delay and no extra network use. Recommended."
            selected={media.selfMediaPreviewMode === "local"}
            disabled={media.busy}
            onSelect={() => void media.setSelfMediaPreviewMode("local")}
          />
          <SettingsChoice
            title="As other people receive it"
            copy="Shows what the call actually delivers. Uses network and adds a short delay."
            selected={media.selfMediaPreviewMode === "rtc"}
            disabled={media.busy}
            onSelect={() => void media.setSelfMediaPreviewMode("rtc")}
          />
        </SettingsRows>
      </SettingsSection>

      <SettingsSection title="Video smoothness" description="How much of this computer Raven uses to draw video. It does not change what you send to others.">
        <SettingsRows>
          <SettingsChoice
            title="Efficient"
            copy="Least processor and battery use. Screen shares up to 15 frames a second."
            selected={media.videoPresentationProfile === "efficiency"}
            disabled={media.busy}
            onSelect={() => void media.setVideoPresentationProfile("efficiency")}
          />
          <SettingsChoice
            title="Balanced"
            copy="Screen shares as smooth as they are sent, up to 30 frames a second. Recommended."
            selected={media.videoPresentationProfile === "balanced"}
            disabled={media.busy}
            onSelect={() => void media.setVideoPresentationProfile("balanced")}
          />
          <SettingsChoice
            title="Best quality"
            copy="Larger camera video and screen shares up to 60 frames a second. Uses more of the processor."
            selected={media.videoPresentationProfile === "quality"}
            disabled={media.busy}
            onSelect={() => void media.setVideoPresentationProfile("quality")}
          />
        </SettingsRows>
      </SettingsSection>

      <SettingsSection title="When you stop hearing people" description="What the headphones button in the bottom bar does.">
        <SettingsRows>
          <SettingsChoice
            title="Silence it here"
            copy="Sound keeps arriving but is not played. Comes back instantly."
            selected={media.deafenMode === "instant"}
            disabled={media.busy}
            onSelect={() => void media.setDeafenMode("instant")}
          />
          <SettingsChoice
            title="Stop receiving it"
            copy="Saves network. Sound takes a moment to return."
            selected={media.deafenMode === "bandwidthSaver"}
            disabled={media.busy}
            onSelect={() => void media.setDeafenMode("bandwidthSaver")}
          />
        </SettingsRows>
      </SettingsSection>

      <SoundCueSection media={media} nest={nest} />

      <SettingsSection
        title={(
          <span className="inline-flex items-center gap-1.5">
            Network activity
            <InfoTooltip label="About network activity">
              Media only. Total is what Raven measures for audio, video and screen sharing; sign-in, signalling and other system traffic are not included. Audio includes shared sound. These choices are kept on this device.
            </InfoTooltip>
          </span>
        )}
        description="A small live readout in the bottom bar while you are in a call."
      >
        <SettingsRows>
          <SettingsToggleRow
            label="Show network activity"
            checked={media.networkActivity.enabled}
            onChange={(enabled) => media.setNetworkActivity({ enabled })}
          />
          {NETWORK_DIRECTIONS.map((direction) => (
            <SettingsToggleRow
              key={direction.id}
              label={direction.label}
              checked={media.networkActivity.directions.includes(direction.id)}
              disabled={!media.networkActivity.enabled}
              onChange={(checked) => media.setNetworkActivity({
                directions: toggleSelection(media.networkActivity.directions, direction.id, checked),
              })}
            />
          ))}
        </SettingsRows>
        <SettingsRows>
          {NETWORK_CATEGORIES.map((category) => (
            <SettingsToggleRow
              key={category.id}
              label={category.label}
              description={category.description}
              checked={media.networkActivity.categories.includes(category.id)}
              disabled={!media.networkActivity.enabled}
              onChange={(checked) => media.setNetworkActivity({
                categories: toggleSelection(media.networkActivity.categories, category.id, checked),
              })}
            />
          ))}
        </SettingsRows>
      </SettingsSection>
    </SettingsPage>
  );
}

function ServerSettings({ data }: { data: RavenShellData }) {
  const serverName = data.serverProperties.name || "Raven";

  return (
    <SettingsPage title="Server" description="The Raven server this app is connected to. Your calls and account live there.">
      <SettingsSection title="Connection">
        <SettingsRows>
          <SettingsReadOnlyRow label="Name" value={serverName} />
          {data.serverProperties.description ? <SettingsReadOnlyRow label="Description" value={data.serverProperties.description} /> : null}
          <SettingsReadOnlyRow label="Address" value={data.apiServerUrl} />
          <SettingsReadOnlyRow label="Calls go through" value={data.serverProperties.rtcServerUrl || "Not announced by this server"} />
        </SettingsRows>
        <SettingsHint>To use another server or account, add it from your account menu.</SettingsHint>
      </SettingsSection>
    </SettingsPage>
  );
}

function SessionSettings({ data }: { data: RavenShellData }) {
  const [sessions, setSessions] = useState<AuthSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [terminating, setTerminating] = useState("");
  const [error, setError] = useState("");

  const load = async () => {
    setError("");
    try {
      const result = await api.authSessions();
      setSessions(result.sessions);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load your signed-in devices.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const terminate = async (session: AuthSession) => {
    setTerminating(session.id);
    setError("");
    try {
      const result = await api.revokeAuthSession(session.id);
      if (result.current) {
        data.logout();
        return;
      }
      setSessions((current) => current.filter((item) => item.id !== session.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "That device could not be signed out.");
    } finally {
      setTerminating("");
    }
  };

  return (
    <>
    <SettingsSection title="Password" description="Changing it signs you out on your other devices.">
      <PasswordChangeForm currentLabel="Current password" onChange={data.changePassword} onChanged={() => void load()} />
    </SettingsSection>
    <SettingsSection title="Devices">
      {error ? <p role="alert" className="text-small text-destructive">{error}</p> : null}
      {loading ? <SettingsHint>Loading…</SettingsHint> : null}
      {!loading && sessions.length === 0 && !error ? <SettingsHint>No signed-in devices were found.</SettingsHint> : null}
      {sessions.length ? (
        <SettingsRows>
          {sessions.map((session) => (
            <div key={session.id} className="flex items-start justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-body font-medium">{session.deviceName || "Raven desktop"}</span>
                  {session.current ? <span className="rounded-chip bg-accent px-1.5 py-0.5 text-caption text-foreground">This device</span> : null}
                </div>
                <div className="mt-0.5 text-caption text-muted-foreground">{session.os || "Unknown system"} · {session.latestIp || "Unknown address"}</div>
                <div className="mt-0.5 text-caption text-muted-foreground">
                  Last used {formatSessionTime(session.lastAccessedAt)} · Signed in {formatSessionTime(session.createdAt)}
                </div>
              </div>
              <Button
                variant="secondary"
                size="sm"
                className="shrink-0"
                disabled={Boolean(terminating)}
                onClick={() => void terminate(session)}
              >
                {terminating === session.id ? "Signing out…" : "Sign out"}
              </Button>
            </div>
          ))}
        </SettingsRows>
      ) : null}
      <SettingsHint>The address is the last one this server saw for the device. Behind a proxy it may show the proxy instead.</SettingsHint>
    </SettingsSection>
    </>
  );
}

function formatSessionTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "at an unknown time";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const NETWORK_DIRECTIONS: Array<{ id: NetworkActivityDirection; label: string }> = [
  { id: "incoming", label: "Show incoming" },
  { id: "outgoing", label: "Show outgoing" },
];

const NETWORK_CATEGORIES: Array<{ id: NetworkActivityCategory; label: string; description?: string }> = [
  { id: "audio", label: "Audio", description: "Voice and any sound you or others share." },
  { id: "video", label: "Video" },
  { id: "screenShare", label: "Screen share" },
  { id: "total", label: "Total" },
  { id: "connection", label: "Connection", description: "Your round trip to the server and how the link is holding, like “42 ms · Good”. Shown when you open the readout." },
];

function toggleSelection<T extends string>(values: T[], value: T, checked: boolean): T[] {
  if (checked) return values.includes(value) ? values : [...values, value];
  return values.filter((candidate) => candidate !== value);
}
