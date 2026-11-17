import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export const AUDIO_STATE_CHANGED_EVENT = "audio-state-changed";
export const AUDIO_METER_CHANGED_EVENT = "audio-meter-changed";
export const AUDIO_DEVICES_CHANGED_EVENT = "audio-devices-changed";
export const AUDIO_TRACK_PUBLISH_INSTRUCTION_EVENT = "audio-track-publish-instruction";

export type AudioSourceId = string;
export type PublishedTrackId = string;
export type ParticipantId = string;
export type AudioProcessorId = string;
export type GainDb = number;
export type AudioParameterValue = boolean | number;

export type TrackKind = "audio" | "video";

export type AudioSourceType =
  | "microphone"
  | "screenAudio"
  | "systemAudio"
  | "appAudio"
  // | "fileAudio"
  | "testTone"
  | "unknown";

export type AudioProcessorKind =
  | "gain"
  | "mute"
  | "eq"
  | "compressor"
  | "limiter"
  | "noiseGate"
  | "highPassFilter"
  | "lowPassFilter"
  | "meter"
  | "custom"
  | "unknown";

export type AudioPreset = "neutral" | "voice" | "music" | "screenShare" | "custom";
export type AudioPresetTarget =
  | "localMicrophone"
  | "localScreenAudio"
  | "localMusic"
  | "remoteVoice"
  | "remoteMusic"
  | "anyAudioChannel";
export type AudioSampleFormat = "f32" | "i16" | "u16" | "unknown";
export type AudioSourceRuntimeStatus = "inactive" | "starting" | "running" | "error";

export interface MuteState {
  muted: boolean;
  mutedByUser: boolean;
}

export interface MeterState {
  peakDb: GainDb;
  rmsDb: GainDb;
  clipping: boolean;
}

export interface ChannelHealthState {
  clipping: boolean;
  clippingCount: number;
  recentClipping: boolean;
  tooQuiet: boolean;
  tooLoud: boolean;
  nearClipping: boolean;
  silenceDetected: boolean;
  peakDb: GainDb;
  rmsDb: GainDb;
  shortTermLoudnessDb: GainDb | null;
  latencySamples: number;
  processorCpuEstimate: number | null;
  /** Microphones: the noise suppressor's measured mean cost per 10 ms hop, in ms. */
  suppressorCostMs?: number | null;
  /** The most one hop has cost since that suppressor started, in ms. */
  suppressorWorstMs?: number | null;
  safetyLimiterActive: boolean;
  safetyLimiterCeilingDb: GainDb;
}

export interface AudioProcessorState {
  id: AudioProcessorId;
  kind: AudioProcessorKind;
  displayName: string;
  enabled: boolean;
  parameters: AudioProcessorParameters;
  latencySamples: number | null;
}

export interface AudioProcessorParameters {
  gainDb?: GainDb | null;
  muted?: boolean | null;
  cutoffHz?: number | null;
  thresholdDb?: GainDb | null;
  ratio?: number | null;
  attackMs?: number | null;
  releaseMs?: number | null;
  eqBands?: EqBandParameters[];
}

export interface EqBandParameters {
  frequencyHz: number;
  gainDb: GainDb;
  q: number;
}

export interface ProcessorChainState {
  processors: AudioProcessorState[];
}

export type NoiseSuppressionMode = "off" | "standard" | "strong" | "studio";
export type NoiseSuppressionDepth = "gentle" | "balanced" | "full";
export type NoiseSuppressionFallback = "notAvailable" | "failedToStart" | "starting" | "tooSlow";

/** What a microphone's noise suppression is really doing, as opposed to the mode chosen. */
export interface NoiseSuppressionRuntime {
  active: NoiseSuppressionMode;
  fallback: NoiseSuppressionFallback | null;
}

export interface WebRtcAudioProcessingSettings {
  noiseSuppression: NoiseSuppressionMode;
  noiseSuppressionDepth: NoiseSuppressionDepth;
  echoCancellation: boolean;
  autoGainControl: boolean;
}

export interface AudioPresetDefinition {
  presetId: string;
  name: string;
  description: string;
  target: AudioPresetTarget;
  gainDb: GainDb;
  muted: boolean;
  processorChain: ProcessorChainState;
  builtIn: boolean;
  userCreated: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AudioSourceRuntimeState {
  status: AudioSourceRuntimeStatus;
  sampleRate: number | null;
  channelCount: number | null;
  format: AudioSampleFormat;
  deviceId: string | null;
  deviceName: string | null;
  error: string | null;
  updatedAt: string | null;
  /** The chosen device is unavailable and the system default is standing in for it. */
  fallbackDevice?: boolean;
  noiseSuppression?: NoiseSuppressionRuntime | null;
}

export interface AudioInputDevice {
  deviceId: string;
  name: string;
  isDefault: boolean;
  sampleRate: number | null;
  channelCount: number | null;
  format: AudioSampleFormat;
}

export interface AudioOutputDevice {
  deviceId: string;
  name: string;
  isDefault: boolean;
  sampleRate: number | null;
  channelCount: number | null;
  format: AudioSampleFormat;
}

export interface AppAudioSource {
  processId: number;
  exeName: string;
  displayName: string;
  iconDataUrl: string | null;
  hasAudioSession: boolean;
}

export interface NativeAudioCapabilityReport {
  os: string;
  issues: string[];
  supportedSourceTypes: AudioSourceType[];
  supportsMicrophone: boolean;
  supportsMonitoring: boolean;
  supportsSystemAudio: boolean;
  supportsAppAudio: boolean;
  supportsScreenAudio: boolean;
  supportsTestTone: boolean;
  supportsInputDevices: boolean;
  supportsOutputDevices: boolean;
  supportsAppAudioProcessList: boolean;
}

export interface LocalChannelStripState {
  gainDb: GainDb;
  pan: number;
  mute: MuteState;
  solo: boolean;
  monitorEnabled: boolean;
  webrtcProcessing: WebRtcAudioProcessingSettings;
  preset: AudioPreset;
  presetId: string | null;
  safetyLimiterCeilingDb: GainDb;
  processorChain: ProcessorChainState;
  meter: MeterState;
  health: ChannelHealthState;
}

export interface RemoteChannelStripState {
  gainDb: GainDb;
  mute: MuteState;
  pinned: boolean;
  /** Noise suppression on this person's microphone, for this listener only. */
  noiseCleanup: boolean;
  /** What Auto-level is doing with this fader. Microphones only; "off" otherwise. */
  autoLevel: RemoteAutoLevelState;
  preset: AudioPreset;
  presetId: string | null;
  safetyLimiterCeilingDb: GainDb;
  processorChain: ProcessorChainState;
  meter: MeterState;
  health: ChannelHealthState;
}

export type RemoteTrackChannelStripState = RemoteChannelStripState;

/** What Auto-level is doing with one person's microphone fader. */
export type AutoLevelStatus = "off" | "listening" | "leveled" | "adjusting" | "atLimit" | "manual";

export interface RemoteAutoLevelState {
  status: AutoLevelStatus;
  /** How loud this person's speech is (K-weighted, before the listener's fader), in dB. */
  speechLoudnessDb: number | null;
}

/** Auto-level for the whole mixer: whether it moves the incoming microphones' faders. */
export interface AutoLevelState {
  enabled: boolean;
}

export interface PublishedTrackMetadata {
  trackId: PublishedTrackId;
  sourceId: AudioSourceId;
  participantId: ParticipantId;
  kind: TrackKind;
  sourceType: AudioSourceType;
  displayName: string;
  deviceName: string | null;
  appName: string | null;
  appExeName: string | null;
  appIconDataUrl: string | null;
  controllable: boolean;
  defaultGainDb: GainDb;
  muted: boolean;
  codec: string | null;
  encoding: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  webrtcTrackId: string | null;
}

export interface PublishedTrackMetadataPatch {
  displayName?: string;
  deviceName?: string;
  appName?: string;
  appExeName?: string;
  appIconDataUrl?: string;
  controllable?: boolean;
  defaultGainDb?: GainDb;
  muted?: boolean;
  codec?: string;
  encoding?: string;
  webrtcTrackId?: string;
}

export interface AudioTrackSource {
  sourceId: AudioSourceId;
  participantId: ParticipantId;
  sourceType: AudioSourceType;
  displayName: string;
  deviceName?: string | null;
  appName?: string | null;
  appExeName?: string | null;
  appIconDataUrl?: string | null;
  defaultGainDb: GainDb;
  muted: boolean;
  webrtcProcessing: WebRtcAudioProcessingSettings;
}

export type TrackLifecycleEvent =
  | { event: "track_published"; payload: { track: PublishedTrackMetadata } }
  | { event: "track_unpublished"; payload: { track: PublishedTrackMetadata } }
  | { event: "track_muted"; payload: { trackId: PublishedTrackId } }
  | { event: "track_unmuted"; payload: { trackId: PublishedTrackId } }
  | { event: "track_metadata_updated"; payload: { track: PublishedTrackMetadata } };

export type AudioTrackPublishInstruction =
  | {
      action: "publish";
      source: AudioTrackSource;
      track: PublishedTrackMetadata;
      webrtcTrackId: string;
    }
  | {
      action: "unpublish";
      sourceId: AudioSourceId;
      trackId: PublishedTrackId;
      webrtcTrackId: string | null;
    };

export interface AudioSourceState {
  id: AudioSourceId;
  ownerId: ParticipantId;
  sourceType: AudioSourceType;
  displayName: string;
  captureDeviceId: string | null;
  appExeName: string | null;
  appIconDataUrl: string | null;
  enabled: boolean;
  publishing: boolean;
  runtime: AudioSourceRuntimeState;
  channelStrip: LocalChannelStripState;
  publishedTrack: PublishedTrackMetadata | null;
}

export interface RemoteAudioTrackState {
  track: PublishedTrackMetadata;
  receiverChannelStrip: RemoteTrackChannelStripState;
  preference: RemoteTrackPreference;
  subscribed: boolean;
  subscriptionStatus: AudioSubscriptionStatus;
}

export type AudioConnectionStatus = "disconnected" | "connecting" | "connected" | "reconnecting" | "error";
export type AudioPlaybackStatus = "stopped" | "starting" | "running" | "recovering" | "error";
export type AudioSubscriptionStatus = "pending" | "subscribed" | "recovering" | "failed";

export interface AudioSessionHealth {
  connectionStatus: AudioConnectionStatus;
  playbackStatus: AudioPlaybackStatus;
  eligibleRemoteTrackCount: number;
  activeRemoteTrackCount: number;
  error: string | null;
  /** Why the speaker is not (yet) playing; separate from connection/subscription errors. */
  playbackError: string | null;
  /** Name of the speaker actually in use. */
  outputDeviceName: string | null;
  /** True while the chosen speaker is unavailable and the system default stands in. */
  outputFallback: boolean;
  /** Master output mute (deafen). */
  outputMuted: boolean;
  /** While deafened, others' shared system and app audio keeps playing. Voices stay silent. */
  deafenKeepsSatellites: boolean;
  /** The one volume for everything Raven plays, -40 to +6 dB. It moves no fader. */
  outputVolumeDb: number;
  /** True once the engine has a saved volume on disk; the engine owns the saved value. */
  outputVolumeSaved: boolean;
  /** What the whole output played, after the volume. Refreshed by meter events. */
  outputMeter: MeterState;
  /** Set when the sidecar lost the room for good, with whether rejoining can fix it. */
  connectionLost: AudioConnectionLoss | null;
  /** LiveKit will not take audio from this connection: a moderator muted or deafened them. */
  publishRevoked: boolean;
  /** LiveKit will not send audio to this connection: a moderator deafened them. */
  subscribeRevoked: boolean;
}

export interface AudioConnectionLoss {
  /** `connectionLost`, `serverShutdown`, `duplicateIdentity`, `participantRemoved`, `roomClosed`. */
  reason: string;
  recoverable: boolean;
}

export interface RemoteTrackPreference {
  remoteParticipantId: ParticipantId;
  remoteTrackId: PublishedTrackId;
  gainDb: GainDb;
  muted: boolean;
  processorChain: ProcessorChainState;
  localDisplayAlias: string | null;
}

export interface RemoteParticipantAudioState {
  participantId: ParticipantId;
  displayName: string | null;
  tracks: RemoteAudioTrackState[];
}

export interface AudioMixerState {
  localParticipantId: ParticipantId | null;
  localSources: AudioSourceState[];
  remoteTracks: RemoteAudioTrackState[];
  remoteParticipants: RemoteParticipantAudioState[];
  trackEvents: TrackLifecycleEvent[];
  session: AudioSessionHealth;
  autoLevel: AutoLevelState;
}

export interface AudioMeterUpdate {
  sourceId: AudioSourceId | null;
  participantId: ParticipantId | null;
  trackId: PublishedTrackId | null;
  meter: MeterState;
  health: ChannelHealthState | null;
  /**
   * Remote tracks: level as received, before this peer's fader, mute and chain.
   * Local sources: present only while muted, the level before the mute.
   */
  inputMeter?: MeterState | null;
  /**
   * Microphones: the highest chance, 0 to 1, that the last meter window held a human voice.
   * Worked out on this machine and never sent anywhere; it only tells speech from
   * keyboards and coughs. Absent from older engines and non-microphone sources.
   */
  voiceProbability?: number | null;
  /** True for the whole output (everything you hear): it names no strip. */
  output?: boolean;
}

export type AudioUiSound = "knock";

/** Short sounds for things that happen in a call. Synthesised and mixed natively. */
export type SoundCue =
  | "mute"
  | "unmute"
  | "profileKnock"
  | "message"
  | "shareStarted"
  | "shareStopped"
  | "personJoined"
  | "personLeft"
  | "entryHeadsUp"
  | "handRaised";

/** Kept on this device with the other media settings and pushed to the engine. */
export interface SoundCueSettings {
  enabled: boolean;
  /** 0 to 1. */
  volume: number;
  microphone: boolean;
  knocks: boolean;
  messages: boolean;
  screenShares: boolean;
  people: boolean;
  entryHeadsUp: boolean;
  /** Someone else raised their hand. */
  hands: boolean;
}

export interface AudioNetworkTotals {
  sentBytes: number;
  receivedBytes: number;
  /** Packets of your own audio sent so far, and how many the server reported missing. */
  sentPackets?: number;
  sentPacketsLost?: number;
  /** The worst round trip and jitter the server reports for your audio. */
  sentRoundTripMs?: number | null;
  sentJitterMs?: number | null;
  /** Round trip to the server on the connection's active path. */
  roundTripMs?: number | null;
  /** LiveKit's verdict on your connection. */
  connectionQuality?: AudioConnectionQuality | null;
}

export type AudioConnectionQuality = "excellent" | "good" | "poor" | "lost";

export type AudioStateUnsubscribe = () => void;

export const audioCommands = {
  getState: () => invoke<AudioMixerState>("audio_get_state"),

  getCapabilities: () => invoke<NativeAudioCapabilityReport>("audio_get_capabilities"),

  getNetworkTotals: () => invoke<AudioNetworkTotals>("audio_get_network_totals"),

  /** Connect the native audio sidecar to the nest's LiveKit room (Rust owns audio). */
  connectRoom: (url: string, token: string) =>
    invoke<AudioMixerState>("audio_connect_room", { url, token }),

  /** Disconnect the native audio sidecar (on leaving the nest). */
  disconnectRoom: () => invoke<AudioMixerState>("audio_disconnect_room"),

  /**
   * In a call from join until a real leave. Local capture runs only while this or
   * monitoring is set; reconnecting the room leaves it alone so the mic stays open.
   */
  setCallActive: (active: boolean) =>
    invoke<AudioMixerState>("audio_set_call_active", { active }),

  /** Keep local capture (and its meters) running outside a call while the Mixer is shown. */
  setMonitoring: (enabled: boolean) =>
    invoke<AudioMixerState>("audio_set_monitoring", { enabled }),

  getChannelHealth: (
    sourceId?: AudioSourceId | null,
    remoteParticipantId?: ParticipantId | null,
    remoteTrackId?: PublishedTrackId | null,
  ) =>
    invoke<ChannelHealthState>("audio_get_channel_health", {
      sourceId: sourceId ?? null,
      remoteParticipantId: remoteParticipantId ?? null,
      remoteTrackId: remoteTrackId ?? null,
    }),

  listInputDevices: () => invoke<AudioInputDevice[]>("audio_list_input_devices"),

  listOutputDevices: () => invoke<AudioOutputDevice[]>("audio_list_output_devices"),

  getSelectedOutputDevice: () => invoke<AudioOutputDevice | null>("audio_get_selected_output_device"),

  setOutputDevice: (deviceId: string | null) =>
    invoke<AudioOutputDevice | null>("audio_set_output_device", { deviceId }),

  testOutputDevice: (deviceId: string | null) =>
    invoke<void>("audio_test_output_device", { deviceId }),

  /** Master output mute (deafen): instant, and independent of per-track receiver mutes. */
  setOutputMuted: (muted: boolean) =>
    invoke<AudioMixerState>("audio_set_output_muted", { muted }),

  /** The one volume for everything Raven plays, -40 to +6 dB. Works with no call running. */
  setOutputVolume: (volumeDb: number, persist = true) =>
    invoke<AudioMixerState>("audio_set_output_volume", { volumeDb, persist }),

  /** Play a short interface sound. `knock` is the `entryHeadsUp` sound cue. */
  playUiSound: (sound: AudioUiSound) => invoke<void>("audio_play_ui_sound", { sound }),

  /** Play a sound cue if the user's cue settings and deafen allow it. */
  playSoundCue: (cue: SoundCue) => invoke<void>("audio_play_sound_cue", { cue }),

  /** A sample cue at `volume` (0 to 1), regardless of the cue settings. */
  previewSoundCue: (cue: SoundCue, volume: number) =>
    invoke<void>("audio_preview_sound_cue", { cue, volume }),

  setSoundCueSettings: (settings: SoundCueSettings) =>
    invoke<void>("audio_set_sound_cue_settings", { settings }),

  /** While deafened, keep hearing others' shared system and app audio (and keep receiving it in Bandwidth saver). */
  setDeafenKeepsSatellites: (keep: boolean) =>
    invoke<AudioMixerState>("audio_set_deafen_keeps_satellites", { keep }),

  setRemoteAudioReceiving: (enabled: boolean) =>
    invoke<AudioMixerState>("audio_set_remote_audio_receiving", { enabled }),

  listAppAudioSources: () => invoke<AppAudioSource[]>("audio_list_app_audio_sources"),

  setLocalSourceAppProcess: (sourceId: AudioSourceId, processId: number) =>
    invoke<AudioMixerState>("audio_set_local_source_capture_device", {
      sourceId,
      captureDeviceId: String(processId),
    }),

  listPresets: () => invoke<AudioPresetDefinition[]>("audio_list_presets"),

  applyPresetToLocalChannel: (sourceId: AudioSourceId, presetId: string) =>
    invoke<AudioMixerState>("audio_apply_preset_to_local_channel", { sourceId, presetId }),

  applyPresetToRemoteTrack: (remoteParticipantId: ParticipantId, remoteTrackId: PublishedTrackId, presetId: string) =>
    invoke<AudioMixerState>("audio_apply_preset_to_remote_track", { remoteParticipantId, remoteTrackId, presetId }),

  saveLocalChannelAsPreset: (
    sourceId: AudioSourceId,
    name: string,
    description: string,
    target: AudioPresetTarget,
  ) =>
    invoke<AudioPresetDefinition[]>("audio_save_local_channel_as_preset", {
      sourceId,
      name,
      description,
      target,
    }),

  saveRemoteTrackAsPreset: (
    remoteParticipantId: ParticipantId,
    remoteTrackId: PublishedTrackId,
    name: string,
    description: string,
    target: AudioPresetTarget,
  ) =>
    invoke<AudioPresetDefinition[]>("audio_save_remote_track_as_preset", {
      remoteParticipantId,
      remoteTrackId,
      name,
      description,
      target,
    }),

  deleteUserPreset: (presetId: string) =>
    invoke<AudioPresetDefinition[]>("audio_delete_user_preset", { presetId }),

  renameUserPreset: (presetId: string, name: string) =>
    invoke<AudioPresetDefinition[]>("audio_rename_user_preset", { presetId, name }),

  resetLocalChannelProcessorChain: (sourceId: AudioSourceId) =>
    invoke<AudioMixerState>("audio_reset_local_channel_processor_chain", { sourceId }),

  resetRemoteTrackProcessorChain: (remoteParticipantId: ParticipantId, remoteTrackId: PublishedTrackId) =>
    invoke<AudioMixerState>("audio_reset_remote_track_processor_chain", { remoteParticipantId, remoteTrackId }),

  resetLocalChannelToSafeDefaults: (sourceId: AudioSourceId) =>
    invoke<AudioMixerState>("audio_reset_local_channel_to_safe_defaults", { sourceId }),

  resetRemoteTrackToSafeDefaults: (remoteParticipantId: ParticipantId, remoteTrackId: PublishedTrackId) =>
    invoke<AudioMixerState>("audio_reset_remote_track_to_safe_defaults", { remoteParticipantId, remoteTrackId }),

  /** `captureDeviceId` is the input/output device id, or the process id for app audio. */
  addLocalSource: (sourceType: AudioSourceType, displayName: string, captureDeviceId: string | null = null) =>
    invoke<AudioMixerState>("audio_add_local_source", { sourceType, displayName, captureDeviceId }),

  removeLocalSource: (sourceId: AudioSourceId) =>
    invoke<AudioMixerState>("audio_remove_local_source", { sourceId }),

  renameLocalSource: (sourceId: AudioSourceId, displayName: string) =>
    invoke<AudioMixerState>("audio_rename_local_source", { sourceId, displayName }),

  setLocalSourceEnabled: (sourceId: AudioSourceId, enabled: boolean) =>
    invoke<AudioMixerState>("audio_set_local_source_enabled", { sourceId, enabled }),

  setLocalSourceCaptureDevice: (sourceId: AudioSourceId, captureDeviceId: string | null) =>
    invoke<AudioMixerState>("audio_set_local_source_capture_device", { sourceId, captureDeviceId }),

  setLocalChannelGain: (sourceId: AudioSourceId, gainDb: GainDb) =>
    invoke<AudioMixerState>("audio_set_local_channel_gain", { sourceId, gainDb }),

  setLocalChannelMute: (sourceId: AudioSourceId, muted: boolean) =>
    invoke<AudioMixerState>("audio_set_local_channel_mute", { sourceId, muted }),

  setLocalWebRtcProcessing: (sourceId: AudioSourceId, processing: WebRtcAudioProcessingSettings) =>
    invoke<AudioMixerState>("audio_set_local_webrtc_processing", { sourceId, processing }),

  setLocalSafetyLimiterCeiling: (sourceId: AudioSourceId, ceilingDb: GainDb) =>
    invoke<AudioMixerState>("audio_set_local_safety_limiter_ceiling", { sourceId, ceilingDb }),

  setRemoteSafetyLimiterCeiling: (
    remoteParticipantId: ParticipantId,
    remoteTrackId: PublishedTrackId,
    ceilingDb: GainDb,
  ) =>
    invoke<AudioMixerState>("audio_set_remote_safety_limiter_ceiling", {
      remoteParticipantId,
      remoteTrackId,
      ceilingDb,
    }),

  publishAudioSource: (sourceId: AudioSourceId) =>
    invoke<AudioMixerState>("audio_publish_audio_source", { sourceId }),

  unpublishAudioSource: (sourceId: AudioSourceId) =>
    invoke<AudioMixerState>("audio_unpublish_audio_source", { sourceId }),

  publishLocalSourceMetadata: (sourceId: AudioSourceId) =>
    invoke<AudioMixerState>("audio_publish_local_source_metadata", { sourceId }),

  unpublishLocalSourceMetadata: (sourceId: AudioSourceId) =>
    invoke<AudioMixerState>("audio_unpublish_local_source_metadata", { sourceId }),

  updatePublishedTrackMetadata: (trackId: PublishedTrackId, patch: PublishedTrackMetadataPatch) =>
    invoke<AudioMixerState>("audio_update_published_track_metadata", { trackId, patch }),

  addOrUpdateRemoteTrack: (metadata: PublishedTrackMetadata) =>
    invoke<AudioMixerState>("audio_add_or_update_remote_track", { metadata }),

  removeRemoteTrack: (remoteParticipantId: ParticipantId, remoteTrackId: PublishedTrackId) =>
    invoke<AudioMixerState>("audio_remove_remote_track", { remoteParticipantId, remoteTrackId }),

  setRemoteTrackGain: (remoteParticipantId: ParticipantId, remoteTrackId: PublishedTrackId, gainDb: GainDb) =>
    invoke<AudioMixerState>("audio_set_remote_track_gain", { remoteParticipantId, remoteTrackId, gainDb }),

  /** Auto-level moves the incoming microphones' faders so everyone speaks at one loudness. */
  setAutoLevel: (enabled: boolean) => invoke<AudioMixerState>("audio_set_auto_level", { enabled }),

  /** Hand a person's microphone fader back to Auto-level after it was moved by hand. */
  resumeAutoLevel: (remoteParticipantId: ParticipantId) =>
    invoke<AudioMixerState>("audio_resume_auto_level", { remoteParticipantId }),

  setRemoteTrackMute: (remoteParticipantId: ParticipantId, remoteTrackId: PublishedTrackId, muted: boolean) =>
    invoke<AudioMixerState>("audio_set_remote_track_mute", { remoteParticipantId, remoteTrackId, muted }),

  setRemoteNoiseCleanup: (remoteParticipantId: ParticipantId, remoteTrackId: PublishedTrackId, enabled: boolean) =>
    invoke<AudioMixerState>("audio_set_remote_noise_cleanup", { remoteParticipantId, remoteTrackId, enabled }),

  addProcessorToRemoteTrack: (
    remoteParticipantId: ParticipantId,
    remoteTrackId: PublishedTrackId,
    kind: AudioProcessorKind,
  ) =>
    invoke<AudioMixerState>("audio_add_processor_to_remote_track", {
      remoteParticipantId,
      remoteTrackId,
      kind,
    }),

  setRemoteProcessorEnabled: (
    remoteParticipantId: ParticipantId,
    remoteTrackId: PublishedTrackId,
    processorId: AudioProcessorId,
    enabled: boolean,
  ) =>
    invoke<AudioMixerState>("audio_set_remote_processor_enabled", {
      remoteParticipantId,
      remoteTrackId,
      processorId,
      enabled,
    }),

  removeProcessorFromRemoteTrack: (
    remoteParticipantId: ParticipantId,
    remoteTrackId: PublishedTrackId,
    processorId: AudioProcessorId,
  ) =>
    invoke<AudioMixerState>("audio_remove_processor_from_remote_track", {
      remoteParticipantId,
      remoteTrackId,
      processorId,
    }),

  updateRemoteProcessorParameter: (
    remoteParticipantId: ParticipantId,
    remoteTrackId: PublishedTrackId,
    processorId: AudioProcessorId,
    parameterName: string,
    value: AudioParameterValue,
  ) =>
    invoke<AudioMixerState>("audio_update_remote_processor_parameter", {
      remoteParticipantId,
      remoteTrackId,
      processorId,
      parameterName,
      value,
    }),

  reorderRemoteProcessors: (
    remoteParticipantId: ParticipantId,
    remoteTrackId: PublishedTrackId,
    orderedProcessorIds: AudioProcessorId[],
  ) =>
    invoke<AudioMixerState>("audio_reorder_remote_processors", {
      remoteParticipantId,
      remoteTrackId,
      orderedProcessorIds,
    }),

  setProcessorEnabled: (sourceId: AudioSourceId, processorId: AudioProcessorId, enabled: boolean) =>
    invoke<AudioMixerState>("audio_set_processor_enabled", { sourceId, processorId, enabled }),

  addProcessorToLocalChannel: (sourceId: AudioSourceId, kind: AudioProcessorKind) =>
    invoke<AudioMixerState>("audio_add_processor_to_local_channel", { sourceId, kind }),

  removeProcessorFromLocalChannel: (sourceId: AudioSourceId, processorId: AudioProcessorId) =>
    invoke<AudioMixerState>("audio_remove_processor_from_local_channel", { sourceId, processorId }),

  updateProcessorParameter: (
    sourceId: AudioSourceId,
    processorId: AudioProcessorId,
    parameterName: string,
    value: AudioParameterValue,
  ) =>
    invoke<AudioMixerState>("audio_update_processor_parameter", {
      sourceId,
      processorId,
      parameterName,
      value,
    }),

  reorderProcessors: (sourceId: AudioSourceId, orderedProcessorIds: AudioProcessorId[]) =>
    invoke<AudioMixerState>("audio_reorder_processors", { sourceId, orderedProcessorIds }),
};

export async function subscribeAudioStateChanged(
  onState: (state: AudioMixerState) => void,
): Promise<AudioStateUnsubscribe> {
  return listen<AudioMixerState>(AUDIO_STATE_CHANGED_EVENT, (event) => onState(event.payload));
}

/** Fires when an audio device is plugged, unplugged, or the system default moves. */
export async function subscribeAudioDevicesChanged(
  onChange: () => void,
): Promise<AudioStateUnsubscribe> {
  return listen<void>(AUDIO_DEVICES_CHANGED_EVENT, () => onChange());
}

export async function subscribeAudioMeterChanged(
  onUpdate: (update: AudioMeterUpdate) => void,
): Promise<AudioStateUnsubscribe> {
  return listen<AudioMeterUpdate>(AUDIO_METER_CHANGED_EVENT, (event) => onUpdate(event.payload));
}

/** Apply a compact meter event without replacing unrelated mixer state. */
export function applyAudioMeterUpdate(
  state: AudioMixerState,
  update: AudioMeterUpdate,
): AudioMixerState {
  if (update.sourceId) {
    let changed = false;
    const localSources = state.localSources.map((source) => {
      if (source.id !== update.sourceId) return source;
      changed = true;
      return {
        ...source,
        channelStrip: {
          ...source.channelStrip,
          meter: update.meter,
          health: update.health ?? source.channelStrip.health,
        },
      };
    });
    return changed ? { ...state, localSources } : state;
  }

  if (!update.participantId || !update.trackId) return state;
  let changed = false;
  const updateTrack = (track: RemoteAudioTrackState) => {
    if (track.track.participantId !== update.participantId || track.track.trackId !== update.trackId) {
      return track;
    }
    changed = true;
    return {
      ...track,
      receiverChannelStrip: {
        ...track.receiverChannelStrip,
        meter: update.meter,
        health: update.health ?? track.receiverChannelStrip.health,
      },
    };
  };
  const remoteTracks = state.remoteTracks.map(updateTrack);
  const remoteParticipants = state.remoteParticipants.map((participant) => {
    if (participant.participantId !== update.participantId) return participant;
    return { ...participant, tracks: participant.tracks.map(updateTrack) };
  });
  return changed ? { ...state, remoteTracks, remoteParticipants } : state;
}

export async function subscribeAudioTrackPublishInstructions(
  onInstruction: (instruction: AudioTrackPublishInstruction) => void,
): Promise<AudioStateUnsubscribe> {
  return listen<AudioTrackPublishInstruction>(AUDIO_TRACK_PUBLISH_INSTRUCTION_EVENT, (event) =>
    onInstruction(event.payload),
  );
}
