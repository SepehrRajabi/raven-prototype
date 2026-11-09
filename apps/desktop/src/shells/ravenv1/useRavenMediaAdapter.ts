import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, type UserPresenceState, type UserReachability } from "@/lib/api";
import {
  AppAudioSource,
  audioCommands,
  AudioInputDevice,
  AudioMixerState,
  AudioOutputDevice,
  AudioSourceState,
  NativeAudioCapabilityReport,
  NoiseSuppressionDepth,
  NoiseSuppressionMode,
  NoiseSuppressionRuntime,
  type SoundCueSettings,
  subscribeAudioDevicesChanged,
  subscribeAudioStateChanged,
  WebRtcAudioProcessingSettings,
} from "@/lib/audio";
import { readAutoLevelPreference } from "@/lib/autoLevelPreference";
import { pipKey, SELF_CAMERA_PIP, type PipTarget } from "@/lib/pictureInPicture";
import { usePictureInPicture } from "./usePictureInPicture";
import { useCallVote, type CallVoteState } from "./useCallVote";
import { commitOutputVolume, migrateLegacyOutputVolume, readLegacyOutputVolume } from "@/lib/outputVolume";
import {
  CameraDevice,
  DEFAULT_VIDEO_PROFILE,
  DisplayTarget,
  NativeVideoCapabilityReport,
  type SelfPreviewMode,
  subscribeVideoStateChanged,
  videoCommands,
  type VideoPauseReason,
  type VideoPresentationProfile,
  type VideoStreamEndpoint,
  VideoMixerState,
  VideoQualityProfile,
  VideoSourceState,
  WindowTarget,
} from "@/lib/video";
import {
  type ParticipantVoiceActivityMap,
  type SourceActivityMap,
  useVoiceActivity,
} from "@/lib/speakingActivity";
import { DEFAULT_NETWORK_ACTIVITY_SETTINGS, normalizeNetworkActivitySettings } from "./networkActivity";
import type { NetworkActivityCategory, NetworkActivityDirection, NetworkActivitySettings } from "./networkActivity";
import {
  DEFAULT_SOUND_CUE_SETTINGS,
  INITIAL_SHARE_CUE_STATE,
  normalizeSoundCueSettings,
  remoteSharers,
  shareCueStep,
} from "@/lib/soundCues";
import {
  isConfirmedMicrophoneActive,
  isLocalMicOn,
  isLocalVideoChosen,
  localSharePause,
  localVideoStatus,
  type LocalVideoStatus,
  microphonesToMuteBeforeJoin,
} from "./mediaState";
import { normalizeSelectedDeviceId, selectedDeviceIdForSource } from "@/lib/mediaDevicePreference";
import { DeviceSwitchWatcher, devicesInUse } from "@/lib/deviceSwitch";
import { toast } from "@/components/ui/toast";
import { studioJustFellBack, studioTooSlowNotice } from "@/lib/noiseSuppression";
import { NestEntryCancelled } from "./nestEntry";
import { presenceForActiveNest } from "./state";
import { callStateCatchUp, callStateSupported, participantCallState } from "@/lib/callState";
import { rememberActiveNest } from "@/lib/crashRecovery";

export type SelfMediaPreviewMode = SelfPreviewMode;

export type {
  MeasuredNetworkCategory,
  NetworkActivityCategory,
  NetworkActivityDirection,
  NetworkActivitySettings,
  NetworkTransferRate,
} from "./networkActivity";

const NEST_HEARTBEAT_INTERVAL_MS = 5000;
const NEST_HEARTBEAT_TIMEOUT_MS = 8000;
const DEAFEN_SHARE_DEBOUNCE_MS = 300;
const screenSourcesNeedPermission = typeof navigator !== "undefined" && /Macintosh|Mac OS X/i.test(navigator.userAgent);
/** Backoff between attempts to rejoin after the realtime connection was lost. */
export const MEDIA_RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10_000, 20_000, 30_000];

export function mediaReconnectDelayMs(attempt: number) {
  const step = Number.isFinite(attempt) ? Math.trunc(attempt) : 0;
  const index = Math.min(Math.max(step, 0), MEDIA_RECONNECT_DELAYS_MS.length - 1);
  return MEDIA_RECONNECT_DELAYS_MS[index];
}
const MEDIA_SETTINGS_KEY = "raven.mediaSettings";

/** One run of `joinMediaSession`, so a Cancel only ever ends the join it was meant for. */
interface JoinAttempt {
  cancelled: boolean;
  /** Connected: too late to cancel, leaving is the way out. */
  committed: boolean;
  aborted: Promise<never>;
  /** The step in flight, settled either way. */
  last: Promise<void>;
  cancel: () => void;
}

export type MediaAdapterPhase = "idle" | "joining" | "connected" | "leaving" | "error";
export type DeafenMode = "instant" | "bandwidthSaver";
export type MediaErrorKind =
  | "permission_denied"
  | "missing_device"
  | "capture_failure"
  | "rtc_failure"
  | "publish_failure"
  | "unsupported";

export interface MediaAdapterError {
  message: string;
  kind: MediaErrorKind;
  action: string;
}

export interface ParticipantMediaState {
  participantId: string;
  displayName: string;
  isLocal: boolean;
  audioMuted: boolean;
  videoEnabled: boolean;
  screenSharing: boolean;
  speaking: boolean;
}

export interface RavenMediaAdapterState {
  phase: MediaAdapterPhase;
  activeNestId: string | null;
  error: string;
  lastError: MediaAdapterError | null;
  audioState: AudioMixerState | null;
  videoState: VideoMixerState | null;
  speakingActivity: ParticipantVoiceActivityMap;
  /** Activity per published audio track, for the satellites of extra sources on the stage. */
  sourceActivity: SourceActivityMap;
  audioCapabilities: NativeAudioCapabilityReport | null;
  videoCapabilities: NativeVideoCapabilityReport | null;
  selfMediaPreviewMode: SelfMediaPreviewMode;
  videoPresentationProfile: VideoPresentationProfile;
  videoStreamEndpoint: VideoStreamEndpoint | null;
  /** Confirmed captured and published right now. Always false outside a call. */
  localMicEnabled: boolean;
  /** What to tell the user: live in a call, or people will hear this mic on joining. */
  localMicOn: boolean;
  /** The user has the camera turned on. Outside a call that means chosen, not capturing. */
  localCameraEnabled: boolean;
  /** `live` is the only status in which other people can see the camera. */
  cameraStatus: LocalVideoStatus;
  localDeafened: boolean;
  /** A moderator muted you, or deafened you, which also mutes. LiveKit enforces it. */
  localServerMuted: boolean;
  /** A moderator deafened you. Kept apart from your own deafen, which it returns to. */
  localServerDeafened: boolean;
  /** Whether you are marked "Back in a bit" for everyone in the call. */
  localAway: boolean;
  /** The vote to remove someone in this call, if you are part of one. */
  callVote: CallVoteState;
  /** False against a server that predates the shared call state. */
  awaySupported: boolean;
  deafenMode: DeafenMode;
  deafenSupported: boolean;
  outputMuteSupported: boolean;
  /** The user has picked something to share. Outside a call nothing is captured or sent. */
  screenSharing: boolean;
  /** `live` is the only status in which other people can see the share. */
  screenShareStatus: LocalVideoStatus;
  /**
   * Why the share is paused (the shared app is minimized), or null. A paused share is still
   * `live`: people see its last picture, and it resumes by itself.
   */
  screenSharePause: VideoPauseReason | null;
  /** The app being shared, for a window share. Never the window's title. */
  sharedAppName: string | null;
  windowSharing: boolean;
  appAudioCapturing: boolean;
  selectedMic: string | null;
  selectedCamera: string | null;
  selectedOutput: string | null;
  activeCameraProfile: VideoQualityProfile | null;
  preferredCameraProfile: VideoQualityProfile;
  activeShareProfile: VideoQualityProfile | null;
  localAudioProcessing: WebRtcAudioProcessingSettings | null;
  /** What the microphone's noise suppression is really doing; it can differ from the mode chosen. */
  localNoiseSuppression: NoiseSuppressionRuntime | null;
  availableInputDevices: AudioInputDevice[];
  availableOutputDevices: AudioOutputDevice[];
  availableCameras: CameraDevice[];
  availableDisplays: DisplayTarget[];
  availableWindows: WindowTarget[];
  availableAppAudioSources: AppAudioSource[];
  participantMedia: ParticipantMediaState[];
  screenSharingUserIds: string[];
  networkActivity: NetworkActivitySettings;
  /** Sound cue switches and volume, kept on this device. */
  soundCues: SoundCueSettings;
  /** The one volume for everything Raven plays, -40 to +6 dB. */
  outputVolumeDb: number;
  bitrateSupported: boolean;
  bitrateLabel: string;
  micLabel: string;
  cameraLabel: string;
  outputLabel: string;
  visibilityLabel: string;
  deviceReadiness: string;
  audioNotice: string;
  audioNoticeKind: "recovering" | "error" | null;
  /** The realtime connection dropped and Raven is rejoining on its own. */
  reconnecting: boolean;
  audioSupported: boolean;
  cameraSupported: boolean;
  screenShareSupported: boolean;
  busy: boolean;
  joinMediaSession: (nestId: string) => Promise<void>;
  /** Abandon a join that is still connecting; the pending `joinMediaSession` rejects with `NestEntryCancelled`. */
  cancelMediaJoin: () => void;
  leaveMediaSession: () => Promise<void>;
  toggleMic: () => Promise<void>;
  toggleCamera: () => Promise<void>;
  toggleDeafen: () => Promise<void>;
  setAway: (away: boolean) => Promise<void>;
  startScreenShare: () => Promise<void>;
  stopScreenShare: () => Promise<void>;
  refreshMediaDevices: () => Promise<void>;
  setMicDevice: (deviceId: string | null) => Promise<void>;
  setOutputDevice: (deviceId: string | null) => Promise<void>;
  testOutputDevice: () => Promise<void>;
  setDeafenMode: (mode: DeafenMode) => Promise<void>;
  setCameraDevice: (deviceId: string | null) => Promise<void>;
  setCameraProfile: (profile: VideoQualityProfile) => Promise<void>;
  startCamera: (camera: CameraDevice, profile?: VideoQualityProfile) => Promise<void>;
  stopCamera: () => Promise<void>;
  startDisplayShare: (display: DisplayTarget, withAudio: boolean, profile?: VideoQualityProfile) => Promise<void>;
  startWindowShare: (windowTarget: WindowTarget, withAudio: boolean, profile?: VideoQualityProfile) => Promise<void>;
  publishMic: () => Promise<void>;
  unpublishMic: () => Promise<void>;
  setMicProcessing: (processing: WebRtcAudioProcessingSettings) => Promise<void>;
  setNetworkActivity: (patch: Partial<NetworkActivitySettings>) => void;
  setSoundCues: (patch: Partial<SoundCueSettings>) => void;
  /** Set the volume for good and remember it. While dragging, use `previewOutputVolume`. */
  setOutputVolume: (volumeDb: number) => Promise<void>;
  /** Play a sample cue at this volume, whatever the switches say. */
  previewSoundCue: (volume: number) => void;
  setSelfMediaPreviewMode: (mode: SelfMediaPreviewMode) => Promise<void>;
  setVideoPresentationProfile: (profile: VideoPresentationProfile) => Promise<void>;
  setLocalPreviewSurfaceVisible: (visible: boolean) => Promise<void>;
  /** Videos in their own always-on-top window (`pipKey`). They all close when the call ends. */
  pictureInPictureKeys: ReadonlySet<string>;
  openPictureInPicture: (target: PipTarget) => void;
  closePictureInPicture: (target: PipTarget) => void;
  retryIncomingAudio: () => Promise<void>;
  /** This listener's own volume for one incoming track. Nobody else hears the change. */
  setRemoteTrackVolume: (participantId: string, trackId: string, gainDb: number) => Promise<void>;
  setRemoteTrackMuted: (participantId: string, trackId: string, muted: boolean) => Promise<void>;
  clearError: () => void;
}

export function useRavenMediaAdapter(
  onStateChanged?: () => Promise<void> | void,
  options: {
    alwaysJoinMuted?: boolean;
    joinWithCameraOff?: boolean;
    joinWithoutScreenSharing?: boolean;
    nestLabel?: string;
    rtcServerUrl?: string;
    presenceState?: UserPresenceState;
    presenceReachability?: UserReachability;
    localUserId?: string;
  } = {},
): RavenMediaAdapterState {
  const [phase, setPhase] = useState<MediaAdapterPhase>("idle");
  const [activeNestId, setActiveNestId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [audioState, setAudioState] = useState<AudioMixerState | null>(null);
  const [videoState, setVideoState] = useState<VideoMixerState | null>(null);
  const { participants: speakingActivity, sources: sourceActivity } = useVoiceActivity(audioState, options.localUserId);
  const [audioCapabilities, setAudioCapabilities] = useState<NativeAudioCapabilityReport | null>(null);
  const [videoCapabilities, setVideoCapabilities] = useState<NativeVideoCapabilityReport | null>(null);
  const [inputDevices, setInputDevices] = useState<AudioInputDevice[]>([]);
  const [outputDevices, setOutputDevices] = useState<AudioOutputDevice[]>([]);
  const [cameras, setCameras] = useState<CameraDevice[]>([]);
  const [displays, setDisplays] = useState<DisplayTarget[]>([]);
  const [windows, setWindows] = useState<WindowTarget[]>([]);
  const [appAudioSources, setAppAudioSources] = useState<AppAudioSource[]>([]);
  const [lastError, setLastError] = useState<MediaAdapterError | null>(null);
  const [preferredCameraId, setPreferredCameraId] = useState<string | null>(null);
  const [preferredCameraProfile, setPreferredCameraProfile] = useState<VideoQualityProfile>(DEFAULT_VIDEO_PROFILE);
  const initialSettings = useMemo(readMediaSettings, []);
  const [selectedMicPreference, setSelectedMicPreference] = useState<string | null>(initialSettings.selectedMic ?? null);
  const [selfMediaPreviewMode, setSelfMediaPreviewModeState] = useState<SelfMediaPreviewMode>(initialSettings.selfMediaPreviewMode ?? "local");
  const [videoPresentationProfile, setVideoPresentationProfileState] = useState<VideoPresentationProfile>(initialSettings.videoPresentationProfile ?? "balanced");
  const [videoStreamEndpoint, setVideoStreamEndpoint] = useState<VideoStreamEndpoint | null>(null);
  const [selectedOutputPreference, setSelectedOutputPreference] = useState<string | null>(initialSettings.selectedOutput ?? null);
  const deviceSwitchRef = useRef(new DeviceSwitchWatcher());
  const [deafenMode, setDeafenModeState] = useState<DeafenMode>(initialSettings.deafenMode ?? "instant");
  const [networkActivitySettings, setNetworkActivitySettings] = useState<NetworkActivitySettings>(
    initialSettings.networkActivity ?? DEFAULT_NETWORK_ACTIVITY_SETTINGS,
  );
  const [soundCues, setSoundCuesState] = useState<SoundCueSettings>(initialSettings.soundCues ?? DEFAULT_SOUND_CUE_SETTINGS);
  const [deafened, setDeafened] = useState(false);
  const [away, setAwayState] = useState(false);
  const [awaySupported, setAwaySupported] = useState(false);
  const awayRef = useRef(false);
  /** The deafened value the server last confirmed for this participation. */
  const deafenSharedRef = useRef(false);
  const localUserIdRef = useRef(options.localUserId);
  localUserIdRef.current = options.localUserId;
  const [reconnecting, setReconnecting] = useState(false);
  const deafenRef = useRef({ deafened: false, mode: deafenMode });
  deafenRef.current = { deafened, mode: deafenMode };
  const reconnectLoopRef = useRef<Promise<void> | null>(null);
  const mediaLossRef = useRef(false);
  /** The microphone whose processing has been restored from the remembered settings. */
  const restoredMicRef = useRef<string | null>(null);
  const joiningRef = useRef<Promise<void> | null>(null);
  const joinAttemptRef = useRef<JoinAttempt | null>(null);
  const leavingRef = useRef<Promise<void> | null>(null);
  const activeNestRef = useRef<string | null>(null);
  const alwaysJoinMutedRef = useRef(Boolean(options.alwaysJoinMuted));
  const joinWithCameraOffRef = useRef(Boolean(options.joinWithCameraOff));
  const joinWithoutScreenSharingRef = useRef(Boolean(options.joinWithoutScreenSharing));
  const presenceRef = useRef({ state: options.presenceState, reachability: options.presenceReachability });
  const onStateChangedRef = useRef(onStateChanged);
  onStateChangedRef.current = onStateChanged;
  const selfMediaPreviewModeRef = useRef<SelfMediaPreviewMode>(initialSettings.selfMediaPreviewMode ?? "local");
  const localPreviewSurfaceVisibleRef = useRef(true);
  const ownCameraInPictureInPictureRef = useRef(false);
  // What the native output currently has selected: `undefined` until the saved speaker
  // has been applied once, then the id (or null for "follow the system default").
  const appliedOutputRef = useRef<string | null | undefined>(undefined);
  const prepareMicrophoneRef = useRef<() => Promise<void>>(async () => undefined);
  const nestLabel = options.nestLabel ?? "Nest";
  const rtcServerUrl = options.rtcServerUrl?.trim() || null;

  useEffect(() => {
    alwaysJoinMutedRef.current = Boolean(options.alwaysJoinMuted);
  }, [options.alwaysJoinMuted]);

  useEffect(() => {
    joinWithCameraOffRef.current = Boolean(options.joinWithCameraOff);
  }, [options.joinWithCameraOff]);

  useEffect(() => {
    joinWithoutScreenSharingRef.current = Boolean(options.joinWithoutScreenSharing);
  }, [options.joinWithoutScreenSharing]);

  useEffect(() => {
    presenceRef.current = { state: options.presenceState, reachability: options.presenceReachability };
  }, [options.presenceReachability, options.presenceState]);

  const refreshNativeState = useCallback(async () => {
    const [audio, video] = await Promise.allSettled([audioCommands.getState(), videoCommands.getState()]);
    if (audio.status === "fulfilled") setAudioState(audio.value);
    if (video.status === "fulfilled") setVideoState(video.value);
  }, []);

  const refreshMediaDevices = useCallback(async () => {
    // On macOS, listing screens, windows or apps goes through ScreenCaptureKit, which
    // asks for Screen Recording access. Leave that to the share picker and the Mixer,
    // which list them when opened, so Raven does not ask on every start.
    const skipScreenSources = screenSourcesNeedPermission;
    const none = Promise.resolve([] as never[]);
    const [inputs, outputs, apps, cameraList, displayList, windowList] = await Promise.allSettled([
      audioCommands.listInputDevices(),
      audioCommands.listOutputDevices(),
      skipScreenSources ? none : audioCommands.listAppAudioSources(),
      videoCommands.listCameras(),
      skipScreenSources ? none : videoCommands.listDisplays(),
      skipScreenSources ? none : videoCommands.listWindows(),
    ]);
    if (inputs.status === "fulfilled") setInputDevices(inputs.value);
    if (outputs.status === "fulfilled") setOutputDevices(outputs.value);
    if (apps.status === "fulfilled") setAppAudioSources(apps.value);
    if (cameraList.status === "fulfilled") setCameras(cameraList.value);
    if (displayList.status === "fulfilled") setDisplays(displayList.value);
    if (windowList.status === "fulfilled") setWindows(windowList.value);
  }, []);

  const saveMediaSettings = useCallback((patch: Partial<MediaSettings>) => {
    const next = { ...readMediaSettings(), ...patch };
    writeMediaSettings(next);
  }, []);

  const syncLocalPreviewEnabled = useCallback(() => {
    // Your own camera in its own window stays on screen with Raven hidden or the Mixer open.
    const enabled = selfMediaPreviewModeRef.current === "local"
      && (ownCameraInPictureInPictureRef.current
        || (localPreviewSurfaceVisibleRef.current && document.visibilityState !== "hidden"));
    return videoCommands.setLocalPreviewEnabled(enabled);
  }, []);

  const setLocalPreviewSurfaceVisible = useCallback(async (visible: boolean) => {
    localPreviewSurfaceVisibleRef.current = visible;
    await syncLocalPreviewEnabled();
  }, [syncLocalPreviewEnabled]);

  const setNetworkActivity = useCallback((patch: Partial<NetworkActivitySettings>) => {
    setNetworkActivitySettings((current) => {
      const next = { ...current, ...patch };
      saveMediaSettings({ networkActivity: next });
      return next;
    });
  }, [saveMediaSettings]);

  const setSoundCues = useCallback((patch: Partial<SoundCueSettings>) => {
    setSoundCuesState((current) => {
      const next = normalizeSoundCueSettings({ ...current, ...patch });
      saveMediaSettings({ soundCues: next });
      return next;
    });
  }, [saveMediaSettings]);

  // The engine decides the joined and left cues itself, so it needs the switches too.
  useEffect(() => {
    void audioCommands.setSoundCueSettings(soundCues).catch(() => undefined);
  }, [soundCues]);

  // Read before anything saves the media settings again, which would drop the old key.
  const legacyOutputVolume = useMemo(readLegacyOutputVolume, []);
  const outputVolumeDb = audioState?.session.outputVolumeDb ?? 0;

  const setOutputVolume = useCallback(async (volumeDb: number) => {
    setAudioState(await commitOutputVolume(volumeDb));
  }, []);

  const previewSoundCue = useCallback((volume: number) => {
    void audioCommands.previewSoundCue("personJoined", volume).catch(() => undefined);
  }, []);

  const setSelfMediaPreviewMode = useCallback(async (mode: SelfMediaPreviewMode) => {
    const previousMode = selfMediaPreviewModeRef.current;
    selfMediaPreviewModeRef.current = mode;
    try {
      await syncLocalPreviewEnabled();
      setVideoState(await videoCommands.setSelfPreviewMode(mode));
    } catch (error) {
      selfMediaPreviewModeRef.current = previousMode;
      throw error;
    }
    setSelfMediaPreviewModeState(mode);
    saveMediaSettings({ selfMediaPreviewMode: mode });
  }, [saveMediaSettings, syncLocalPreviewEnabled]);

  const setVideoPresentationProfile = useCallback(async (profile: VideoPresentationProfile) => {
    setVideoState(await videoCommands.setPresentationProfile(profile));
    setVideoPresentationProfileState(profile);
    saveMediaSettings({ videoPresentationProfile: profile });
  }, [saveMediaSettings]);

  useEffect(() => {
    let mounted = true;
    let cleanupAudio: (() => void) | null = null;
    let cleanupVideo: (() => void) | null = null;
    let cleanupDevices: (() => void) | null = null;
    void Promise.allSettled([
      audioCommands.getCapabilities().then((report) => mounted && setAudioCapabilities(report)),
      videoCommands.getCapabilities().then((report) => mounted && setVideoCapabilities(report)),
      videoCommands.getStreamEndpoint().then((endpoint) => mounted && setVideoStreamEndpoint(endpoint)),
      videoCommands.setSelfPreviewMode(selfMediaPreviewModeRef.current).then((state) => mounted && setVideoState(state)),
      videoCommands.setPresentationProfile(initialSettings.videoPresentationProfile ?? "balanced").then((state) => mounted && setVideoState(state)),
      refreshNativeState(),
      refreshMediaDevices(),
      // The engine starts with Auto-level off; bring back the listener's choice.
      readAutoLevelPreference()
        ? audioCommands.setAutoLevel(true).then((state) => mounted && setAudioState(state))
        : Promise.resolve(),
      // The engine keeps the volume itself; move one an older version saved here.
      audioCommands
        .getState()
        .then((state) => migrateLegacyOutputVolume(legacyOutputVolume, state.session.outputVolumeSaved))
        .then((next) => {
          if (mounted && next) setAudioState(next);
        }),
    ]).catch(() => undefined);
    void subscribeAudioStateChanged((state) => {
      if (mounted) setAudioState(state);
    })
      .then((unsubscribe) => {
        if (!mounted) unsubscribe();
        else cleanupAudio = unsubscribe;
      })
      .catch(() => undefined);
    void subscribeVideoStateChanged((state) => {
      if (mounted) setVideoState(state);
    })
      .then((unsubscribe) => {
        if (!mounted) unsubscribe();
        else cleanupVideo = unsubscribe;
      })
      .catch(() => undefined);
    // A headset was plugged in, removed, or the system default moved: refresh the pickers.
    void subscribeAudioDevicesChanged(() => {
      if (mounted) void refreshMediaDevices().catch(() => undefined);
    })
      .then((unsubscribe) => {
        if (!mounted) unsubscribe();
        else cleanupDevices = unsubscribe;
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
      cleanupAudio?.();
      cleanupVideo?.();
      cleanupDevices?.();
    };
  }, [initialSettings.videoPresentationProfile, refreshMediaDevices, refreshNativeState]);

  useEffect(() => {
    const sync = () => {
      void syncLocalPreviewEnabled().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => document.removeEventListener("visibilitychange", sync);
  }, [syncLocalPreviewEnabled]);

  const micSources = useMemo(
    () => (audioState?.localSources ?? []).filter((source) => source.sourceType === "microphone"),
    [audioState],
  );
  const cameraSource = useMemo(
    () => (videoState?.localSources ?? []).find((source) => source.kind === "camera") ?? null,
    [videoState],
  );
  const screenSource = useMemo(
    () => (videoState?.localSources ?? []).find((source) => source.kind === "display" || source.kind === "window") ?? null,
    [videoState],
  );

  const localMicEnabled = micSources.some(isConfirmedMicrophoneActive);
  const localMicOn = isLocalMicOn(micSources, activeNestId != null, Boolean(options.alwaysJoinMuted));
  // "On" is the user's choice; "live" is what the engine has confirmed. The two differ
  // outside a call (chosen, nothing captured) and while a source is still starting.
  const cameraStatus = localVideoStatus(cameraSource);
  const screenShareStatus = localVideoStatus(screenSource);
  const localCameraEnabled = isLocalVideoChosen(cameraStatus);
  const screenSharing = isLocalVideoChosen(screenShareStatus);
  const windowSharing = screenSource?.kind === "window";
  const screenSharePause = localSharePause(screenSource);
  const sharedAppName = windowSharing ? screenSource?.displayName || null : null;
  const appAudioCapturing = (audioState?.localSources ?? []).some(
    (source) => source.sourceType === "appAudio" && source.enabled && source.runtime.status !== "error",
  );
  const localAudioProcessing = micSources[0]?.channelStrip.webrtcProcessing ?? null;
  const localNoiseSuppression = micSources[0]?.runtime.noiseSuppression ?? null;
  // Studio handing over to Strong mid-call is said once, so nobody wonders whether they
  // went silent. The caption under the mode says it for as long as it lasts.
  const noiseSuppressionSeenRef = useRef(localNoiseSuppression);
  const localMicMuted = micSources[0]?.channelStrip.mute.muted ?? true;
  useEffect(() => {
    if (studioJustFellBack(noiseSuppressionSeenRef.current, localNoiseSuppression)) {
      toast(studioTooSlowNotice(localMicMuted));
    }
    noiseSuppressionSeenRef.current = localNoiseSuppression;
  }, [localNoiseSuppression, localMicMuted]);
  // Whichever surface changes the microphone's processing, the next run starts from it.
  // Not before the remembered settings were applied to the source, or the engine's defaults
  // would overwrite them.
  const restoredMicId = micSources[0]?.id;
  const noiseSuppressionMode = localAudioProcessing?.noiseSuppression;
  const noiseSuppressionDepth = localAudioProcessing?.noiseSuppressionDepth;
  const echoCancellation = localAudioProcessing?.echoCancellation;
  const autoGainControl = localAudioProcessing?.autoGainControl;
  useEffect(() => {
    if (!restoredMicId || restoredMicId !== restoredMicRef.current) return;
    saveMediaSettings({
      noiseSuppression: noiseSuppressionMode,
      noiseSuppressionDepth,
      echoCancellation,
      autoGainControl,
    });
  }, [restoredMicId, noiseSuppressionMode, noiseSuppressionDepth, echoCancellation, autoGainControl, saveMediaSettings]);
  const participantMedia = useMemo<ParticipantMediaState[]>(() => {
    const tracks = videoState?.remoteTracks ?? [];
    return (videoState?.participants ?? []).map((participant) => ({
      participantId: participant.participantId,
      displayName: participant.displayName,
      isLocal: participant.isLocal,
      audioMuted: participant.audioMuted,
      videoEnabled: tracks.some((track) => track.participantId === participant.participantId && track.source === "camera" && !track.muted),
      screenSharing: tracks.some((track) => track.participantId === participant.participantId && track.source === "screenshare" && !track.muted),
      speaking: participant.speaking,
    }));
  }, [videoState]);
  const screenSharingUserIds = useMemo(
    () => participantMedia.filter((participant) => participant.screenSharing).map((participant) => participant.participantId).sort(),
    [participantMedia],
  );

  // A cue when someone in this room starts or stops sharing. The viewer only sees the
  // room the user is in, and joining never replays the shares already there.
  const shareCuesRef = useRef(INITIAL_SHARE_CUE_STATE);
  useEffect(() => {
    const { state, cues } = shareCueStep(
      shareCuesRef.current,
      { nestId: activeNestId, viewerConnected: Boolean(videoState?.viewerConnected), sharers: remoteSharers(videoState) },
      Date.now(),
    );
    shareCuesRef.current = state;
    for (const cue of cues) void audioCommands.playSoundCue(cue).catch(() => undefined);
  }, [activeNestId, videoState]);

  const setSafeError = useCallback((message: string, kind: MediaErrorKind = "capture_failure", action = "Check the selected source and try again.") => {
    setError(message);
    setLastError({ message, kind, action });
    setPhase("error");
  }, []);

  const setNonFatalError = useCallback((message: string, kind: MediaErrorKind = "capture_failure", action = "Check the selected source and try again.") => {
    setError(message);
    setLastError({ message, kind, action });
  }, []);

  const pictureInPicture = usePictureInPicture(activeNestId, setNonFatalError);
  useEffect(() => {
    ownCameraInPictureInPictureRef.current = pictureInPicture.keys.has(pipKey(SELF_CAMERA_PIP));
    void syncLocalPreviewEnabled().catch(() => undefined);
  }, [pictureInPicture.keys, syncLocalPreviewEnabled]);

  const clearError = useCallback(() => {
    setError("");
    setLastError(null);
    if (phase === "error") setPhase(activeNestRef.current ? "connected" : "idle");
  }, [phase]);

  /**
   * End the call's media: leave both rooms and release local capture. Every caller is a
   * real end of the call (leave, a failed join, a reconnect the user left during); the
   * reconnect loop itself only calls `connectMedia`, so the mic stays open across it.
   */
  const cleanupMediaOnly = useCallback(async () => {
    const [audioResult, videoResult] = await Promise.allSettled([
      audioCommands.disconnectRoom(),
      videoCommands.disconnectRoom(),
    ]);
    if (videoResult.status === "fulfilled") setVideoState(videoResult.value);
    const released = await audioCommands.setCallActive(false).catch(() => null);
    if (released) setAudioState(released);
    else if (audioResult.status === "fulfilled") setAudioState(audioResult.value);
  }, []);

  const muteLocalMicrophones = useCallback(async () => {
    let state = await audioCommands.getState();
    const microphones = microphonesToMuteBeforeJoin(state.localSources);
    for (const source of microphones) {
      // Muting is enough: capture zeroes a muted source before anything is published,
      // and keeping the track means the first unmute is instant.
      if (!source.channelStrip.mute.muted) state = await audioCommands.setLocalChannelMute(source.id, true);
    }
    setAudioState(state);
  }, []);

  const stopLocalVideoSources = useCallback(async (shouldStop: (source: VideoSourceState) => boolean) => {
    let state = await videoCommands.getState();
    for (const source of state.localSources.filter(shouldStop)) {
      state = await videoCommands.stopSource(source.id);
    }
    setVideoState(state);
  }, []);

  const applyVideoJoinDefaults = useCallback(async () => {
    if (!joinWithCameraOffRef.current && !joinWithoutScreenSharingRef.current) return;
    await stopLocalVideoSources((source) =>
      (joinWithCameraOffRef.current && source.kind === "camera") ||
      (joinWithoutScreenSharingRef.current && (source.kind === "display" || source.kind === "window")),
    );
  }, [stopLocalVideoSources]);

  // The server drops "Back in a bit" and deafened with the participation, and a
  // new participation starts clear, so leaving forgets our copy.
  const resetSharedCallState = useCallback(() => {
    awayRef.current = false;
    deafenSharedRef.current = false;
    setAwayState(false);
    setAwaySupported(false);
  }, []);

  /**
   * Register this client in the Nest's session (first join, automatic rejoin and the
   * heartbeat's rejoin all land here) and bring the server's copy of our call state in
   * line with ours: a fresh participation starts clear, but a deafened or stepped-away
   * person who rejoins after a dropped connection is still deafened or away.
   */
  const registerSession = useCallback(async (nestId: string) => {
    const { session } = await api.joinSession(nestId);
    const supported = callStateSupported(session);
    setAwaySupported(supported);
    if (!supported) return;
    const server = participantCallState(session.participants, localUserIdRef.current ?? "");
    const want = { away: awayRef.current, deafened: deafenRef.current.deafened };
    deafenSharedRef.current = want.deafened;
    const patch = callStateCatchUp(server, want);
    if (!patch) return;
    // A courtesy to the others in the call; the join must not fail over it.
    void api.setCallState(nestId, patch).catch(() => {
      deafenSharedRef.current = server.deafened;
    });
  }, []);
  const registerSessionRef = useRef(registerSession);
  registerSessionRef.current = registerSession;

  const leaveMediaSession = useCallback(() => {
    if (leavingRef.current) return leavingRef.current;
    const nestId = activeNestRef.current;
    if (!nestId) return Promise.resolve();

    const operation = (async () => {
      setPhase("leaving");
      setError("");
      activeNestRef.current = null;
      setActiveNestId(null);
      resetSharedCallState();
      try {
        await cleanupMediaOnly();
        // Media is already down. If the goodbye does not reach the API (offline, signed
        // out), the server times this client out of the Nest on its own.
        await api.disconnectFromNest(nestId).catch(() => undefined);
        setPhase("idle");
        await refreshNativeState();
        await Promise.resolve(onStateChanged?.()).catch(() => undefined);
      } catch (err) {
        setSafeError(messageFromError(err, `Could not leave the ${nestLabel} cleanly`));
      }
    })();
    leavingRef.current = operation;
    const clearLeave = () => {
      if (leavingRef.current === operation) leavingRef.current = null;
    };
    void operation.then(clearLeave, clearLeave);
    return operation;
  }, [cleanupMediaOnly, nestLabel, onStateChanged, refreshNativeState, resetSharedCallState, setSafeError]);

  useEffect(() => {
    const disconnectActiveNest = () => {
      const nestId = activeNestRef.current;
      if (!nestId) return;
      void api.disconnectFromNest(nestId).catch(() => undefined);
    };

    window.addEventListener("pagehide", disconnectActiveNest);
    window.addEventListener("beforeunload", disconnectActiveNest);

    return () => {
      window.removeEventListener("pagehide", disconnectActiveNest);
      window.removeEventListener("beforeunload", disconnectActiveNest);
    };
  }, []);

  // A reload of this window returns to this call (see crashRecovery.ts).
  useEffect(() => rememberActiveNest(activeNestId), [activeNestId]);

  useEffect(() => () => {
    const nestId = activeNestRef.current;
    activeNestRef.current = null;
    if (nestId) void api.disconnectFromNest(nestId).catch(() => undefined);
    void Promise.allSettled([
      audioCommands.disconnectRoom().then(() => audioCommands.setCallActive(false)),
      videoCommands.disconnectRoom(),
    ]);
  }, []);

  useEffect(() => {
    if (!activeNestId) return;
    let cancelled = false;
    let timer: number | null = null;
    let requestController: AbortController | null = null;

    const heartbeat = async () => {
      requestController = new AbortController();
      const controller = requestController;
      const timeout = window.setTimeout(() => controller.abort(), NEST_HEARTBEAT_TIMEOUT_MS);
      try {
        const result = await api.presenceHeartbeat(controller.signal, true, activeNestId);
        if (!cancelled && result.nestActive === false && activeNestRef.current === activeNestId) {
          // The server timed this client out of the Nest (a stalled network, a sleeping
          // laptop) while its media stayed connected. Put the membership back so the
          // others see who they are talking to.
          await api.joinNest(activeNestId);
          await registerSessionRef.current(activeNestId);
          await api.joinNestPresence(activeNestId);
          const nextPresence = presenceForActiveNest(presenceRef.current);
          await api.updatePresence(nextPresence.state, nextPresence.reachability, activeNestId);
          await onStateChangedRef.current?.();
        }
      } catch {
        // Presence expiry is server-owned; retry after the normal interval.
      } finally {
        window.clearTimeout(timeout);
        if (requestController === controller) requestController = null;
        if (!cancelled) timer = window.setTimeout(() => void heartbeat(), NEST_HEARTBEAT_INTERVAL_MS);
      }
    };
    void heartbeat();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      requestController?.abort();
      requestController = null;
    };
  }, [activeNestId]);

  /**
   * Connect both native sidecars to a Nest with fresh tokens and register this client in
   * its session. Used for the first join and for every automatic rejoin; local sources
   * keep their desired state, so whatever was live is published again by the engines.
   */
  const connectMedia = useCallback(async (nestId: string, attempt?: JoinAttempt) => {
    // The native connects cannot be interrupted, so a cancelled join stops at the next gap.
    const checkpoint = () => {
      if (attempt?.cancelled) throw new NestEntryCancelled();
    };
    const viewerToken = await api.liveKitToken(nestId);
    const audioToken = await api.liveKitToken(nestId, "audio");
    checkpoint();
    let nextAudioState = await audioCommands.connectRoom(rtcServerUrl || audioToken.url, audioToken.token);
    checkpoint();
    const deafen = deafenRef.current;
    nextAudioState = await audioCommands.setRemoteAudioReceiving(!(deafen.deafened && deafen.mode === "bandwidthSaver"));
    nextAudioState = await audioCommands.setOutputMuted(deafen.deafened);
    setAudioState(nextAudioState);

    const videoToken = await api.liveKitToken(nestId, "video");
    checkpoint();
    let nextVideoState = await videoCommands.connectRoom(
      rtcServerUrl || videoToken.url || viewerToken.url,
      videoToken.token,
      viewerToken.token,
    );
    checkpoint();
    nextVideoState = await videoCommands.setSelfPreviewMode(selfMediaPreviewModeRef.current);
    setVideoState(nextVideoState);

    await registerSession(nestId);
    checkpoint();
    await api.joinNestPresence(nestId);
    const nextPresence = presenceForActiveNest(presenceRef.current);
    await api.updatePresence(nextPresence.state, nextPresence.reachability, nestId);
  }, [registerSession, rtcServerUrl]);

  const joinMediaSession = useCallback(
    async (nestId: string) => {
      // A cancelled join still tears its media down; wait for that before starting over.
      while (joiningRef.current) {
        if (!joinAttemptRef.current?.cancelled) return joiningRef.current;
        await joiningRef.current.catch(() => undefined);
      }

      let abort!: () => void;
      const aborted = new Promise<never>((_, reject) => {
        abort = () => reject(new NestEntryCancelled());
      });
      aborted.catch(() => undefined);
      const attempt: JoinAttempt = {
        cancelled: false,
        committed: false,
        aborted,
        last: Promise.resolve(),
        cancel: () => {
          if (attempt.cancelled || attempt.committed) return;
          attempt.cancelled = true;
          abort();
        },
      };
      joinAttemptRef.current = attempt;
      // Each step races the cancel, so Cancel answers at once even while a native connect
      // is still working. The step itself finishes (or fails) in the background.
      const guard = <T,>(step: Promise<T>): Promise<T> => {
        attempt.last = step.then(() => undefined, () => undefined);
        return Promise.race([step, aborted]);
      };

      const work = (async () => {
        setPhase("joining");
        setError("");
        try {
          if (activeNestRef.current && activeNestRef.current !== nestId) {
            await guard(leaveMediaSession());
            setPhase("joining");
          }

          // Native sidecars reconcile and publish existing sources as soon as they
          // connect, so join defaults must be enforced before either sidecar joins.
          await guard(applyVideoJoinDefaults());
          if (alwaysJoinMutedRef.current) await guard(muteLocalMicrophones());

          // Open local capture before connecting, so a microphone kept from an earlier
          // call is already running when its track is published. A device that fails to
          // open is reported on its strip and retried; it must not fail the join.
          await guard(audioCommands.setCallActive(true).catch(() => undefined));
          await guard(connectMedia(nestId, attempt));
          await guard(prepareMicrophoneRef.current().catch(() => undefined));

          attempt.committed = true;
          activeNestRef.current = nestId;
          setActiveNestId(nestId);
          setPhase("connected");
          await refreshNativeState();
          await refreshMediaDevices();
          await onStateChanged?.();
        } catch (err) {
          // Let whatever step was in flight finish before taking its work apart.
          if (attempt.cancelled) await attempt.last;
          await cleanupMediaOnly();
          activeNestRef.current = null;
          setActiveNestId(null);
          resetSharedCallState();
          await Promise.allSettled([api.leaveSession(nestId), api.leaveNestPresence(nestId)]);
          if (attempt.cancelled) {
            if (joinAttemptRef.current === attempt) setPhase("idle");
            await onStateChanged?.();
            throw new NestEntryCancelled();
          }
          if (err instanceof ApiError && err.status === 403) {
            // The server said no, for example after a vote. Nothing is wrong with the
            // connection or a device, so only the reason is shown.
            setError(err.message);
            setLastError(null);
            setPhase("error");
          } else {
            setSafeError(
              messageFromError(err, `Could not join media for this ${nestLabel}`),
              "rtc_failure",
              "Check the realtime server connection, then try joining media again.",
            );
          }
          await onStateChanged?.();
          throw err;
        } finally {
          joiningRef.current = null;
        }
      })();
      joiningRef.current = work;
      work.catch(() => undefined);
      return Promise.race([work, aborted]);
    },
    [applyVideoJoinDefaults, cleanupMediaOnly, connectMedia, leaveMediaSession, muteLocalMicrophones, nestLabel, onStateChanged, refreshMediaDevices, refreshNativeState, resetSharedCallState, setSafeError],
  );

  const cancelMediaJoin = useCallback(() => {
    const attempt = joinAttemptRef.current;
    if (!attempt || attempt.cancelled || attempt.committed) return;
    attempt.cancel();
    // The teardown continues in the background; the call is already not "joining".
    setPhase((current) => (current === "joining" ? "idle" : current));
  }, []);

  // --- Session supervisor --------------------------------------------------------------
  // LiveKit retries a dropped connection by itself for a while. When it gives up, or the
  // server restarts, the native engines report the room as lost. A call must survive
  // that without the user leaving and rejoining: reconnect with fresh tokens, backing off
  // while the network is down, and try again the moment it returns.
  const audioLoss = audioState?.session.connectionLost ?? null;
  const videoLost = Boolean(videoState?.sessionLost);
  mediaLossRef.current = Boolean(audioLoss?.recoverable) || (videoLost && !audioLoss);

  const callVote = useCallVote(activeNestId, options.localUserId, () => {
    void leaveMediaSession().catch(() => undefined);
    toast({ title: "You were voted out of this call.", description: "You can come back in 15 minutes." });
  });

  useEffect(() => {
    if (phase !== "connected" || !activeNestId) return;
    if (!audioLoss || audioLoss.recoverable) return;
    // Signed in from another device, removed, or the room closed: rejoining would fight
    // the server. Leave locally and say why.
    const message = audioState?.session.error || `You are no longer in this ${nestLabel}.`;
    void leaveMediaSession().then(() => {
      setNonFatalError(message, "rtc_failure", `Enter the ${nestLabel} again when you are ready.`);
    });
  }, [activeNestId, audioLoss, audioState?.session.error, leaveMediaSession, nestLabel, phase, setNonFatalError]);

  useEffect(() => {
    if (phase !== "connected" || !activeNestId) return;
    if (!mediaLossRef.current || reconnectLoopRef.current) return;
    const nestId = activeNestId;
    setReconnecting(true);
    reconnectLoopRef.current = (async () => {
      let attempt = 0;
      while (activeNestRef.current === nestId && mediaLossRef.current) {
        await waitForDelayOrOnline(mediaReconnectDelayMs(attempt));
        if (activeNestRef.current !== nestId) break;
        try {
          // Membership may have lapsed while the connection was down.
          await api.joinNest(nestId).catch(() => undefined);
          await connectMedia(nestId);
          if (activeNestRef.current !== nestId) {
            // The user left while this attempt was in flight.
            await cleanupMediaOnly();
            break;
          }
          await refreshNativeState();
          await Promise.resolve(onStateChangedRef.current?.()).catch(() => undefined);
          break;
        } catch {
          attempt += 1;
        }
      }
    })().finally(() => {
      reconnectLoopRef.current = null;
      setReconnecting(false);
    });
  }, [activeNestId, audioLoss?.reason, cleanupMediaOnly, connectMedia, phase, reconnecting, refreshNativeState, videoLost]);

  const ensureDefaultMic = useCallback(async (restorePreference = true): Promise<AudioSourceState> => {
    let state = await audioCommands.getState();
    let mic = state.localSources.find((source) => source.sourceType === "microphone");
    if (!mic) {
      state = await audioCommands.addLocalSource(
        "microphone",
        "Microphone",
        restorePreference ? selectedMicPreference ?? null : null,
      );
      const mics = state.localSources.filter((source) => source.sourceType === "microphone");
      mic = mics[mics.length - 1];
      // Like the device below, the remembered voice processing is applied once, when the
      // source is created; no capture is running yet, so nothing reopens.
      if (mic) {
        const micId = mic.id;
        state = await audioCommands.setLocalWebRtcProcessing(micId, rememberedProcessing(mic.channelStrip.webrtcProcessing));
        mic = state.localSources.find((source) => source.id === micId) ?? mic;
      }
    }
    if (!mic) throw new Error("No microphone source is available.");
    restoredMicRef.current = mic.id;

    // A microphone source is created lazily, so apply the persisted native device
    // before the first publish/processing operation. Existing sources retain their
    // active choice (including an explicit Default selection).
    if (restorePreference && !mic.captureDeviceId && selectedMicPreference) {
      const micId = mic.id;
      state = await audioCommands.setLocalSourceCaptureDevice(micId, selectedMicPreference);
      mic = state.localSources.find((source) => source.id === micId) ?? mic;
    }
    setAudioState(state);
    return mic;
  }, [selectedMicPreference]);

  /**
   * Have a microphone track ready as soon as the session is up. A source that was never
   * published is muted first and then published, so joining never opens a live mic, but
   * the first unmute is immediate instead of waiting for a publish handshake. A source
   * retained from an earlier session keeps whatever state it already had.
   */
  const prepareMicrophone = useCallback(async () => {
    if (!audioCapabilities?.supportsMicrophone) return;
    const mic = await ensureDefaultMic();
    if (mic.publishedTrack) return;
    if (!mic.channelStrip.mute.muted) await audioCommands.setLocalChannelMute(mic.id, true);
    setAudioState(await audioCommands.publishAudioSource(mic.id));
  }, [audioCapabilities?.supportsMicrophone, ensureDefaultMic]);
  prepareMicrophoneRef.current = prepareMicrophone;

  const publishMic = useCallback(async () => {
    setError("");
    if (!audioCapabilities?.supportsMicrophone) {
      setSafeError("Microphone capture is not supported on this system.", "unsupported", "Use a supported OS/audio backend or add another audio source in the mixer.");
      return;
    }
    try {
      const primaryMic = await ensureDefaultMic();
      const sources = micSources.length ? [primaryMic, ...micSources.slice(1)] : [primaryMic];
      let state: AudioMixerState | null = null;
      for (const source of sources) {
        if (source.channelStrip.mute.muted) state = await audioCommands.setLocalChannelMute(source.id, false);
        if (!source.publishedTrack) state = await audioCommands.publishAudioSource(source.id);
      }
      if (state) setAudioState(state);
    } catch (err) {
      setSafeError(classifyMediaError(err, "Microphone could not be published").message, classifyMediaError(err).kind, "Check microphone permission or pick another input device.");
    }
  }, [audioCapabilities?.supportsMicrophone, ensureDefaultMic, micSources, setSafeError]);

  const unpublishMic = useCallback(async () => {
    setError("");
    try {
      let state: AudioMixerState | null = null;
      for (const source of micSources) {
        state = source.publishedTrack
          ? await audioCommands.unpublishAudioSource(source.id)
          : await audioCommands.setLocalChannelMute(source.id, true);
      }
      if (state) setAudioState(state);
    } catch (err) {
      setSafeError(messageFromError(err, "Microphone could not be unpublished"), "publish_failure", "Try muting again or leave the media session.");
    }
  }, [micSources, setSafeError]);

  /** Mute without unpublishing: the track stays up, so unmuting is instant. */
  const muteMic = useCallback(async () => {
    setError("");
    try {
      let state: AudioMixerState | null = null;
      for (const source of micSources) {
        if (!source.channelStrip.mute.muted) state = await audioCommands.setLocalChannelMute(source.id, true);
      }
      if (state) setAudioState(state);
    } catch (err) {
      setSafeError(messageFromError(err, "Microphone could not be muted"), "publish_failure", "Try muting again or leave the media session.");
    }
  }, [micSources, setSafeError]);

  const serverMuted = audioState?.session.publishRevoked === true;
  const serverDeafened = audioState?.session.subscribeRevoked === true;

  const toggleMic = useCallback(async () => {
    if (serverMuted) return;
    // Heard at once, as the answer to the click or hotkey. Only in a call: the engine
    // drops it when no call is playing.
    void audioCommands.playSoundCue(localMicOn ? "mute" : "unmute").catch(() => undefined);
    if (localMicOn) {
      await muteMic();
    } else {
      await publishMic();
    }
  }, [localMicOn, muteMic, publishMic, serverMuted]);

  const setMicDevice = useCallback(async (deviceId: string | null) => {
    setError("");
    try {
      // An explicit picker action must be able to replace a missing saved device;
      // do not try to restore the stale preference first.
      const mic = await ensureDefaultMic(false);
      deviceSwitchRef.current.notePick("microphone", Date.now());
      const state = await audioCommands.setLocalSourceCaptureDevice(mic.id, deviceId);
      setAudioState(state);
      setSelectedMicPreference(deviceId);
      saveMediaSettings({ selectedMic: deviceId });
    } catch (err) {
      setSafeError(messageFromError(err, "Microphone input could not be changed"), "capture_failure", "Pick another input device or check OS microphone access.");
    }
  }, [ensureDefaultMic, saveMediaSettings, setSafeError]);

  const startCamera = useCallback(async (camera: CameraDevice, profile: VideoQualityProfile = DEFAULT_VIDEO_PROFILE) => {
    setError("");
    setPreferredCameraId(camera.id);
    setPreferredCameraProfile(profile);
    if (!videoCapabilities?.supportsCamera) {
      setSafeError("Camera capture is not supported on this system.", "unsupported", "Use a supported camera backend or continue audio-only.");
      return;
    }
    try {
      if (cameraSource) await videoCommands.stopSource(cameraSource.id);
      setVideoState(await videoCommands.startCamera(camera.id, camera.name || "Camera", profile));
    } catch (err) {
      const classified = classifyMediaError(err, "Camera could not be started");
      setSafeError(classified.message, classified.kind, "Check camera permission or choose another camera.");
    }
  }, [cameraSource, setSafeError, videoCapabilities?.supportsCamera]);

  const setCameraDevice = useCallback(async (deviceId: string | null) => {
    setError("");
    setPreferredCameraId(deviceId);
    if (!deviceId || !cameraSource) return;
    const camera = cameras.find((candidate) => candidate.id === deviceId) ?? (await videoCommands.listCameras()).find((candidate) => candidate.id === deviceId);
    if (!camera) {
      setSafeError("Camera device is not available.", "missing_device", "Pick another camera or reconnect the device.");
      return;
    }
    await startCamera(camera, cameraSource.profile ?? preferredCameraProfile);
  }, [cameraSource, cameras, preferredCameraProfile, setSafeError, startCamera]);

  const setCameraProfile = useCallback(async (profile: VideoQualityProfile) => {
    setError("");
    setPreferredCameraProfile(profile);
    if (!cameraSource) return;
    try {
      setVideoState(await videoCommands.setSourceProfile(cameraSource.id, profile));
    } catch (err) {
      setSafeError(messageFromError(err, "Camera quality could not be changed"), "capture_failure", "Try another quality setting or restart the camera.");
    }
  }, [cameraSource, setSafeError]);

  const stopCamera = useCallback(async () => {
    setError("");
    setLastError(null);
    try {
      if (cameraSource) setVideoState(await videoCommands.stopSource(cameraSource.id));
    } catch (err) {
      // A native stop can finish before its state event/invoke response fails. Re-read
      // the engine so a completed stop is reflected immediately instead of requiring
      // a second hotkey press.
      const refreshed = await videoCommands.getState().catch(() => null);
      if (refreshed) {
        setVideoState(refreshed);
        if (!refreshed.localSources.some((source) => source.kind === "camera")) return;
      }
      setSafeError(messageFromError(err, "Camera could not be stopped"), "capture_failure", "Try stopping camera again or leave the media session.");
    }
  }, [cameraSource, setSafeError]);

  const toggleCamera = useCallback(async () => {
    if (localCameraEnabled) {
      await stopCamera();
      return;
    }
    const listedCameras = cameras.length ? cameras : await videoCommands.listCameras();
    const camera = listedCameras.find((candidate) => candidate.id === preferredCameraId) ?? listedCameras[0];
    if (!camera) {
      setSafeError("No camera device is available.", "missing_device", "Connect a camera or continue audio-only.");
      return;
    }
    await startCamera(camera, preferredCameraProfile);
  }, [cameras, localCameraEnabled, preferredCameraId, preferredCameraProfile, setSafeError, startCamera, stopCamera]);

  const setRemoteAudioReceiving = useCallback(async (enabled: boolean) => {
    try {
      setAudioState(await audioCommands.setRemoteAudioReceiving(enabled));
    } catch (err) {
      setNonFatalError(
        messageFromError(err, enabled ? "Incoming audio could not be restored" : "Incoming audio could not be paused"),
        "unsupported",
        enabled ? "Try leaving and rejoining media." : "Use Instant deafen mode if this keeps happening.",
      );
    }
  }, [setNonFatalError]);

  /**
   * Deafen is a master mute on Raven's output: instant, exact, and independent of any
   * per-person mute the listener set in the mixer. Bandwidth saver additionally stops
   * receiving the audio, which takes a moment to resume when undeafening.
   */
  const applyDeafenStrategy = useCallback(async (nextDeafened: boolean, mode: DeafenMode) => {
    setAudioState(await audioCommands.setOutputMuted(nextDeafened));
    await setRemoteAudioReceiving(!(nextDeafened && mode === "bandwidthSaver"));
  }, [setRemoteAudioReceiving]);

  const toggleDeafen = useCallback(async () => {
    if (serverDeafened) return;
    const nextDeafened = !deafened;
    setError("");
    setLastError(null);
    setDeafened(nextDeafened);
    try {
      await applyDeafenStrategy(nextDeafened, deafenMode);
    } catch (err) {
      setDeafened(!nextDeafened);
      setNonFatalError(
        messageFromError(err, nextDeafened ? "Incoming audio could not be muted" : "Incoming audio could not be restored"),
        "unsupported",
        "Try again, or leave and rejoin media.",
      );
    }
  }, [applyDeafenStrategy, deafenMode, deafened, setNonFatalError]);

  // Others only need to know that you can't hear them. Quick toggles collapse to the
  // last value, and a failed send is not worth interrupting the user for.
  useEffect(() => {
    if (!activeNestId || !awaySupported || deafenSharedRef.current === deafened) return;
    const timer = window.setTimeout(() => {
      const previous = deafenSharedRef.current;
      deafenSharedRef.current = deafened;
      void api.setCallState(activeNestId, { deafened }).catch(() => {
        if (deafenSharedRef.current === deafened) deafenSharedRef.current = previous;
      });
    }, DEAFEN_SHARE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [activeNestId, awaySupported, deafened]);

  const setAway = useCallback(async (next: boolean) => {
    const nestId = activeNestRef.current;
    if (!nestId || !awaySupported || awayRef.current === next) return;
    awayRef.current = next;
    setAwayState(next);
    try {
      await api.setCallState(nestId, { away: next });
    } catch (err) {
      if (awayRef.current === next && activeNestRef.current === nestId) {
        awayRef.current = !next;
        setAwayState(!next);
      }
      setNonFatalError(
        messageFromError(err, "Back in a bit could not be shared"),
        "rtc_failure",
        next
          ? `Others in the ${nestLabel} can't see that you stepped away. Try again.`
          : `Others in the ${nestLabel} may still see you as away. Try again.`,
      );
    }
  }, [awaySupported, nestLabel, setNonFatalError]);

  // Back in a bit clears itself when you come back: unmuting, or talking with the mic on.
  const localSpeaking = Boolean(options.localUserId && speakingActivity[options.localUserId]?.speaking);
  const micWasEnabledRef = useRef(localMicEnabled);
  useEffect(() => {
    const unmuted = localMicEnabled && !micWasEnabledRef.current;
    micWasEnabledRef.current = localMicEnabled;
    if (awayRef.current && localMicEnabled && (unmuted || localSpeaking)) void setAway(false);
  }, [localMicEnabled, localSpeaking, setAway]);

  const setOutputDevice = useCallback(async (deviceId: string | null) => {
    setError("");
    try {
      deviceSwitchRef.current.notePick("speaker", Date.now());
      const selected = await audioCommands.setOutputDevice(deviceId);
      const next = deviceId ? selected?.deviceId ?? deviceId : null;
      appliedOutputRef.current = next;
      setSelectedOutputPreference(next);
      saveMediaSettings({ selectedOutput: next });
      await refreshMediaDevices();
    } catch (err) {
      setSafeError(messageFromError(err, "Speaker could not be changed"), "unsupported", "Pick another speaker or use the system default.");
    }
  }, [refreshMediaDevices, saveMediaSettings, setSafeError]);

  const testOutputDevice = useCallback(async () => {
    setError("");
    try {
      await audioCommands.testOutputDevice(selectedOutputPreference);
    } catch (err) {
      setSafeError(messageFromError(err, "Test sound could not play"), "unsupported", "Pick another speaker or check the device connection.");
    }
  }, [selectedOutputPreference, setSafeError]);

  const setDeafenMode = useCallback(async (mode: DeafenMode) => {
    setError("");
    setDeafenModeState(mode);
    saveMediaSettings({ deafenMode: mode });
    if (deafened) {
      await applyDeafenStrategy(true, mode);
    }
  }, [applyDeafenStrategy, deafened, saveMediaSettings]);

  // Hand the saved speaker to the native output once, and again only if it was missing
  // and has since been connected. The preference itself is never dropped: a headset that
  // is switched off at launch is picked up when it appears, and re-listing devices does
  // not touch (or restart) the running output.
  useEffect(() => {
    if (!audioCapabilities?.supportsOutputDevices) return;
    if (appliedOutputRef.current === selectedOutputPreference) return;
    if (selectedOutputPreference && !outputDevices.some((device) => device.deviceId === selectedOutputPreference)) {
      return;
    }
    const target = selectedOutputPreference;
    appliedOutputRef.current = target;
    // Restoring the saved speaker is a choice the user already made, not a switch to report.
    deviceSwitchRef.current.notePick("speaker", Date.now());
    void audioCommands.setOutputDevice(target).catch(() => {
      // Still unavailable to the backend; try again when the device list next changes.
      if (appliedOutputRef.current === target) appliedOutputRef.current = undefined;
    });
  }, [audioCapabilities?.supportsOutputDevices, outputDevices, selectedOutputPreference]);

  // Raven followed a device on its own (a headset plugged in, a speaker gone): say so.
  useEffect(() => {
    const notices = deviceSwitchRef.current.update(devicesInUse(audioState, selectedOutputPreference), Date.now());
    for (const notice of notices) toast({ title: notice.title, description: notice.description });
  }, [audioState, selectedOutputPreference]);


  const startDisplayShare = useCallback(async (
    display: DisplayTarget,
    withAudio: boolean,
    profile: VideoQualityProfile = DEFAULT_VIDEO_PROFILE,
  ) => {
    setError("");
    if (!videoCapabilities || (!videoCapabilities.supportsDisplayCapture && !videoCapabilities.supportsWindowCapture)) {
      setSafeError("Screen sharing is not supported on this system.", "unsupported", "Use a supported OS screen capture backend.");
      return;
    }
    try {
      if (screenSource) await videoCommands.stopSource(screenSource.id);
      setVideoState(await videoCommands.startDisplayShare(
        display.id,
        display.name || "Display",
        withAudio && Boolean(videoCapabilities.supportsDisplayAudio),
        profile,
        display.width,
        display.height,
      ));
    } catch (err) {
      const classified = classifyMediaError(err, "Display sharing could not be started");
      setSafeError(classified.message, classified.kind, "Check screen recording permission or choose another source.");
    }
  }, [screenSource, setSafeError, videoCapabilities]);

  const startWindowShare = useCallback(async (
    windowTarget: WindowTarget,
    withAudio: boolean,
    profile: VideoQualityProfile = DEFAULT_VIDEO_PROFILE,
  ) => {
    setError("");
    if (!videoCapabilities?.supportsWindowCapture) {
      setSafeError("Window capture is not supported on this system.", "unsupported", "Use display sharing if available.");
      return;
    }
    try {
      if (screenSource) await videoCommands.stopSource(screenSource.id);
      setVideoState(await videoCommands.startWindowShare(
        windowTarget.id,
        windowTarget.processId,
        // The app's name, not the window title: it is shown on the share, and a title can
        // reveal what someone is doing.
        windowTarget.appName || "the app",
        withAudio && Boolean(videoCapabilities.supportsWindowAudio),
        profile,
        windowTarget.width,
        windowTarget.height,
      ));
    } catch (err) {
      const classified = classifyMediaError(err, "Window sharing could not be started");
      setSafeError(classified.message, classified.kind, "Check capture permission or choose another window.");
    }
  }, [screenSource, setSafeError, videoCapabilities]);

  const startScreenShare = useCallback(async () => {
    const display = displays[0] ?? (await videoCommands.listDisplays())[0];
    if (!display) {
      setSafeError("No shareable display is available.", "missing_device", "Open the source picker or check OS screen capture permission.");
      return;
    }
    await startDisplayShare(display, false);
  }, [displays, setSafeError, startDisplayShare]);

  const stopScreenShare = useCallback(async () => {
    setError("");
    try {
      if (screenSource) setVideoState(await videoCommands.stopSource(screenSource.id));
    } catch (err) {
      setSafeError(messageFromError(err, "Screen sharing could not be stopped"), "capture_failure", "Try stopping share again or leave the media session.");
    }
  }, [screenSource, setSafeError]);

  const setMicProcessing = useCallback(async (processing: WebRtcAudioProcessingSettings) => {
    setError("");
    try {
      const mic = await ensureDefaultMic();
      setAudioState(await audioCommands.setLocalWebRtcProcessing(mic.id, processing));
    } catch (err) {
      setSafeError(messageFromError(err, "Microphone processing could not be changed"), "publish_failure", "Try again from the mixer or leave and rejoin media.");
    }
  }, [ensureDefaultMic, setSafeError]);

  const retryIncomingAudio = useCallback(async () => {
    setError("");
    try {
      await audioCommands.setRemoteAudioReceiving(false);
      setAudioState(await audioCommands.setRemoteAudioReceiving(!(deafened && deafenMode === "bandwidthSaver")));
    } catch (err) {
      setNonFatalError(
        messageFromError(err, "Incoming audio could not be restored"),
        "rtc_failure",
        "Check the selected speaker, then retry or leave and rejoin media.",
      );
    }
  }, [deafenMode, deafened, setNonFatalError]);

  // A listener's own fader and mute for one track. They reject on failure so the
  // caller can say so where the change was made; nothing about the call is at risk.
  const setRemoteTrackVolume = useCallback(async (participantId: string, trackId: string, gainDb: number) => {
    setAudioState(await audioCommands.setRemoteTrackGain(participantId, trackId, gainDb));
  }, []);

  const setRemoteTrackMuted = useCallback(async (participantId: string, trackId: string, muted: boolean) => {
    setAudioState(await audioCommands.setRemoteTrackMute(participantId, trackId, muted));
  }, []);

  const audioSession = audioState?.session;
  const audioNotice = audioSession?.error
    ?? (audioSession?.connectionStatus === "reconnecting"
      ? "Restoring the realtime audio connection…"
      : audioSession?.playbackStatus === "error"
        ? audioSession.playbackError ?? "Raven could not open a speaker."
        : audioSession?.playbackStatus === "recovering"
          ? "Restoring the speaker…"
          : audioSession?.outputFallback
            ? `Your selected speaker is unavailable. Playing through ${audioSession.outputDeviceName ?? "the system default"}.`
            : (audioSession?.eligibleRemoteTrackCount ?? 0) > (audioSession?.activeRemoteTrackCount ?? 0)
              ? "Restoring incoming audio…"
              : "");
  const recoveringConnection = reconnecting || Boolean(audioSession?.connectionLost?.recoverable);
  const audioNoticeKind: RavenMediaAdapterState["audioNoticeKind"] = audioNotice
    ? !recoveringConnection
      && (audioSession?.connectionStatus === "error"
        || audioSession?.playbackStatus === "error"
        || Boolean(audioSession?.error))
      ? "error"
      : "recovering"
    : null;

  const selectedOutput = useMemo(
    () => outputDevices.find((device) => device.deviceId === selectedOutputPreference)?.deviceId
      ?? outputDevices.find((device) => device.isDefault)?.deviceId
      ?? outputDevices[0]?.deviceId
      ?? null,
    [outputDevices, selectedOutputPreference],
  );

  return {
    phase,
    activeNestId,
    error,
    lastError,
    audioState,
    videoState,
    speakingActivity,
    sourceActivity,
    audioCapabilities,
    videoCapabilities,
    selfMediaPreviewMode,
    videoPresentationProfile,
    videoStreamEndpoint,
    localMicEnabled,
    localMicOn,
    localCameraEnabled,
    cameraStatus,
    localDeafened: deafened,
    localServerMuted: serverMuted,
    localServerDeafened: serverDeafened,
    localAway: away,
    callVote,
    awaySupported,
    deafenMode,
    deafenSupported: true,
    outputMuteSupported: false,
    screenSharing,
    screenShareStatus,
    screenSharePause,
    sharedAppName,
    windowSharing,
    appAudioCapturing,
    selectedMic: selectedDeviceIdForSource(micSources[0]?.captureDeviceId, selectedMicPreference),
    selectedCamera: cameraSource?.targetId ?? preferredCameraId,
    selectedOutput,
    activeCameraProfile: cameraSource?.profile ?? null,
    preferredCameraProfile,
    activeShareProfile: screenSource?.profile ?? null,
    localAudioProcessing,
    localNoiseSuppression,
    availableInputDevices: inputDevices,
    availableOutputDevices: outputDevices,
    availableCameras: cameras,
    availableDisplays: displays,
    availableWindows: windows,
    availableAppAudioSources: appAudioSources,
    participantMedia,
    screenSharingUserIds,
    networkActivity: networkActivitySettings,
    soundCues,
    outputVolumeDb,
    bitrateSupported: false,
    bitrateLabel: "Managed by the native video profile",
    micLabel: micStateLabel(micSources, localMicOn),
    cameraLabel: localCameraEnabled ? cameraSource?.displayName ?? "Camera on" : "Camera off",
    outputLabel: deafened ? "Deafened" : "Sound on",
    visibilityLabel: activeNestId ? `Visible in ${nestLabel}` : `Not in a ${nestLabel}`,
    deviceReadiness: readinessLabel(audioCapabilities, videoCapabilities, phase, nestLabel),
    audioNotice,
    audioNoticeKind,
    reconnecting,
    audioSupported: audioCapabilities?.supportsMicrophone ?? false,
    cameraSupported: videoCapabilities?.supportsCamera ?? false,
    screenShareSupported: Boolean(videoCapabilities?.supportsDisplayCapture || videoCapabilities?.supportsWindowCapture),
    busy: phase === "joining" || phase === "leaving",
    joinMediaSession,
    cancelMediaJoin,
    leaveMediaSession,
    toggleMic,
    toggleCamera,
    toggleDeafen,
    setAway,
    startScreenShare,
    stopScreenShare,
    refreshMediaDevices,
    setMicDevice,
    setOutputDevice,
    testOutputDevice,
    setDeafenMode,
    setCameraDevice,
    setCameraProfile,
    startCamera,
    stopCamera,
    startDisplayShare,
    startWindowShare,
    publishMic,
    unpublishMic,
    setMicProcessing,
    setNetworkActivity,
    setSoundCues,
    setOutputVolume,
    previewSoundCue,
    setSelfMediaPreviewMode,
    setVideoPresentationProfile,
    setLocalPreviewSurfaceVisible,
    pictureInPictureKeys: pictureInPicture.keys,
    openPictureInPicture: pictureInPicture.open,
    closePictureInPicture: pictureInPicture.close,
    retryIncomingAudio,
    setRemoteTrackVolume,
    setRemoteTrackMuted,
    clearError,
  };
}

/** Resolve after `delayMs`, or sooner if the network comes back. */
function waitForDelayOrOnline(delayMs: number) {
  return new Promise<void>((resolve) => {
    const finish = () => {
      window.clearTimeout(timer);
      window.removeEventListener("online", finish);
      resolve();
    };
    const timer = window.setTimeout(finish, delayMs);
    window.addEventListener("online", finish, { once: true });
  });
}

function micStateLabel(sources: AudioSourceState[], enabled: boolean) {
  if (!sources.length) return "Mic not selected";
  if (sources[0].runtime.status === "error") return "Mic unavailable";
  if (!enabled) return "Muted";
  if (sources[0].runtime.fallbackDevice) return "Using default mic";
  return sources[0].displayName || "Microphone";
}

function readinessLabel(
  audio: NativeAudioCapabilityReport | null,
  video: NativeVideoCapabilityReport | null,
  phase: MediaAdapterPhase,
  nestLabel: string,
) {
  if (phase === "joining") return `Joining ${nestLabel}`;
  if (phase === "leaving") return `Leaving ${nestLabel}`;
  if (!audio && !video) return "Checking devices";
  const issue = [...(audio?.issues ?? []), ...(video?.issues ?? [])][0];
  if (issue) return issue;
  const parts = [
    audio?.supportsMicrophone ? "Mic ready" : "Mic unavailable",
    video?.supportsCamera ? "Camera ready" : "Camera unavailable",
  ];
  return parts.join(" · ");
}

function messageFromError(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function classifyMediaError(error: unknown, fallback = "Media action failed"): MediaAdapterError {
  const message = messageFromError(error, fallback);
  const lower = message.toLowerCase();
  if (lower.includes("permission") || lower.includes("denied") || lower.includes("notallowed")) {
    return { message, kind: "permission_denied", action: "Allow the device permission in the OS or browser prompt, then retry." };
  }
  if (lower.includes("not found") || lower.includes("no ") || lower.includes("missing") || lower.includes("notreadable")) {
    return { message, kind: "missing_device", action: "Connect or select another device, then retry." };
  }
  if (lower.includes("publish") || lower.includes("track")) {
    return { message, kind: "publish_failure", action: "Leave and rejoin media if retrying does not recover." };
  }
  return { message, kind: "capture_failure", action: "Check the selected source and try again." };
}

type MediaSettings = {
  selectedMic?: string | null;
  selectedOutput?: string | null;
  noiseSuppression?: NoiseSuppressionMode;
  noiseSuppressionDepth?: NoiseSuppressionDepth;
  echoCancellation?: boolean;
  autoGainControl?: boolean;
  deafenMode?: DeafenMode;
  networkActivity?: NetworkActivitySettings;
  soundCues?: SoundCueSettings;
  selfMediaPreviewMode?: SelfMediaPreviewMode;
  videoPresentationProfile?: VideoPresentationProfile;
};

export function readMediaSettings(): MediaSettings {
  try {
    const raw = window.localStorage.getItem(MEDIA_SETTINGS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as MediaSettings;
    return {
      selectedMic: normalizeSelectedDeviceId(parsed.selectedMic),
      selectedOutput: typeof parsed.selectedOutput === "string" ? parsed.selectedOutput : null,
      noiseSuppression: isNoiseSuppressionMode(parsed.noiseSuppression) ? parsed.noiseSuppression : undefined,
      noiseSuppressionDepth: isNoiseSuppressionDepth(parsed.noiseSuppressionDepth) ? parsed.noiseSuppressionDepth : undefined,
      echoCancellation: typeof parsed.echoCancellation === "boolean" ? parsed.echoCancellation : undefined,
      autoGainControl: typeof parsed.autoGainControl === "boolean" ? parsed.autoGainControl : undefined,
      deafenMode: isDeafenMode(parsed.deafenMode) ? parsed.deafenMode : "instant",
      networkActivity: normalizeNetworkActivitySettings(parsed.networkActivity),
      soundCues: normalizeSoundCueSettings(parsed.soundCues),
      selfMediaPreviewMode: isSelfMediaPreviewMode(parsed.selfMediaPreviewMode) ? parsed.selfMediaPreviewMode : "local",
      videoPresentationProfile: isVideoPresentationProfile(parsed.videoPresentationProfile) ? parsed.videoPresentationProfile : "balanced",
    };
  } catch {
    return {};
  }
}

function writeMediaSettings(settings: MediaSettings) {
  try {
    window.localStorage.setItem(MEDIA_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Settings persistence is best-effort; the active media state still updates.
  }
}

function isNoiseSuppressionMode(value: unknown): value is NoiseSuppressionMode {
  return value === "off" || value === "standard" || value === "strong" || value === "studio";
}

function isNoiseSuppressionDepth(value: unknown): value is NoiseSuppressionDepth {
  return value === "gentle" || value === "balanced" || value === "full";
}

/** The microphone's processing with whatever the user last chose laid over it; what was never chosen keeps the engine's default. */
function rememberedProcessing(current: WebRtcAudioProcessingSettings): WebRtcAudioProcessingSettings {
  const saved = readMediaSettings();
  return {
    noiseSuppression: saved.noiseSuppression ?? current.noiseSuppression,
    noiseSuppressionDepth: saved.noiseSuppressionDepth ?? current.noiseSuppressionDepth,
    echoCancellation: saved.echoCancellation ?? current.echoCancellation,
    autoGainControl: saved.autoGainControl ?? current.autoGainControl,
  };
}

function isDeafenMode(value: unknown): value is DeafenMode {
  return value === "instant" || value === "bandwidthSaver";
}

function isSelfMediaPreviewMode(value: unknown): value is SelfMediaPreviewMode {
  return value === "local" || value === "rtc";
}

function isVideoPresentationProfile(value: unknown): value is VideoPresentationProfile {
  return value === "efficiency" || value === "balanced" || value === "quality";
}

