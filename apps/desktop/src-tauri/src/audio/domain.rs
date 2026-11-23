use std::fmt;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AudioSourceId(Uuid);

impl AudioSourceId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }

    /// Parse a canonical UUID string (e.g. extracted from a LiveKit track name).
    pub fn parse(value: &str) -> Option<Self> {
        Uuid::parse_str(value).ok().map(Self)
    }
}

impl Default for AudioSourceId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for AudioSourceId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PublishedTrackId(Uuid);

impl PublishedTrackId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }

    /// The track identity of a local source. It is derived from the source, so it stays
    /// the same every time that source is published and peers can keep their own strip
    /// settings (fader, mute, effects) attached to it.
    pub fn for_source(source_id: AudioSourceId) -> Self {
        Self(source_id.0)
    }

    /// Parse a canonical UUID string (e.g. the suffix of a `raven-audio-<uuid>` track name).
    pub fn parse(value: &str) -> Option<Self> {
        Uuid::parse_str(value).ok().map(Self)
    }
}

impl Default for PublishedTrackId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for PublishedTrackId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ParticipantId(Uuid);

impl ParticipantId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }

    /// Parse a canonical UUID string (e.g. a LiveKit participant identity with the
    /// `#audio` sidecar suffix already stripped).
    pub fn parse(value: &str) -> Option<Self> {
        Uuid::parse_str(value).ok().map(Self)
    }
}

impl Default for ParticipantId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for ParticipantId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AudioProcessorId(Uuid);

impl AudioProcessorId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for AudioProcessorId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for AudioProcessorId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct GainDb(pub f32);

impl GainDb {
    pub const UNITY: Self = Self(0.0);
    pub const MUTED_FLOOR: Self = Self(-90.0);

    pub fn new(value: f32) -> Self {
        Self(value)
    }
}

impl Default for GainDb {
    fn default() -> Self {
        Self::UNITY
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AudioSourceType {
    Microphone,
    ScreenAudio,
    SystemAudio,
    AppAudio,
    FileAudio,
    TestTone,
    Unknown,
}

impl Default for AudioSourceType {
    fn default() -> Self {
        Self::Unknown
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AudioSampleFormat {
    F32,
    I16,
    U16,
    Unknown,
}

impl Default for AudioSampleFormat {
    fn default() -> Self {
        Self::Unknown
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AudioSourceRuntimeStatus {
    Inactive,
    Starting,
    Running,
    Error,
}

impl Default for AudioSourceRuntimeStatus {
    fn default() -> Self {
        Self::Inactive
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AudioSourceRuntimeState {
    pub status: AudioSourceRuntimeStatus,
    pub sample_rate: Option<u32>,
    pub channel_count: Option<u16>,
    pub format: AudioSampleFormat,
    pub device_id: Option<String>,
    pub device_name: Option<String>,
    pub error: Option<String>,
    pub updated_at: Option<String>,
    /// True while the chosen capture device is unavailable and the system default is
    /// standing in for it. The saved choice is kept and used again when it returns.
    pub fallback_device: bool,
    /// Which noise suppression is really running on a microphone, as opposed to the one
    /// chosen in `webrtc_processing`. `None` until the capture reports it.
    pub noise_suppression: Option<NoiseSuppressionRuntime>,
}

impl Default for AudioSourceRuntimeState {
    fn default() -> Self {
        Self {
            status: AudioSourceRuntimeStatus::Inactive,
            sample_rate: None,
            channel_count: None,
            format: AudioSampleFormat::Unknown,
            device_id: None,
            device_name: None,
            error: None,
            updated_at: None,
            fallback_device: false,
            noise_suppression: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AudioInputDevice {
    pub device_id: String,
    pub name: String,
    pub is_default: bool,
    pub sample_rate: Option<u32>,
    pub channel_count: Option<u16>,
    pub format: AudioSampleFormat,
    /// A Bluetooth headset's microphone: opening it puts the headset in call mode. Known on
    /// macOS only; false elsewhere.
    pub bluetooth: bool,
    /// The microphone Raven uses instead of a Bluetooth one while headset call mode is off.
    pub headset_stand_in: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AudioOutputDevice {
    pub device_id: String,
    pub name: String,
    pub is_default: bool,
    pub sample_rate: Option<u32>,
    pub channel_count: Option<u16>,
    pub format: AudioSampleFormat,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppAudioSource {
    pub process_id: u32,
    pub exe_name: String,
    pub display_name: String,
    pub icon_data_url: Option<String>,
    pub has_audio_session: bool,
}

impl Default for AudioInputDevice {
    fn default() -> Self {
        Self {
            device_id: String::new(),
            name: String::new(),
            is_default: false,
            sample_rate: None,
            channel_count: None,
            format: AudioSampleFormat::Unknown,
            bluetooth: false,
            headset_stand_in: false,
        }
    }
}

impl Default for AudioOutputDevice {
    fn default() -> Self {
        Self {
            device_id: String::new(),
            name: String::new(),
            is_default: false,
            sample_rate: None,
            channel_count: None,
            format: AudioSampleFormat::Unknown,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrackKind {
    Audio,
    Video,
}

impl Default for TrackKind {
    fn default() -> Self {
        Self::Audio
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AudioProcessorKind {
    Gain,
    Mute,
    Eq,
    Compressor,
    Limiter,
    NoiseGate,
    HighPassFilter,
    LowPassFilter,
    Meter,
    Custom,
    Unknown,
}

impl Default for AudioProcessorKind {
    fn default() -> Self {
        Self::Unknown
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AudioPreset {
    Neutral,
    Voice,
    Music,
    ScreenShare,
    Custom,
}

impl Default for AudioPreset {
    fn default() -> Self {
        Self::Neutral
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AudioPresetTarget {
    LocalMicrophone,
    LocalScreenAudio,
    LocalMusic,
    RemoteVoice,
    RemoteMusic,
    AnyAudioChannel,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AudioPresetDefinition {
    pub preset_id: String,
    pub name: String,
    pub description: String,
    pub target: AudioPresetTarget,
    pub gain_db: GainDb,
    pub muted: bool,
    pub processor_chain: ProcessorChainState,
    pub built_in: bool,
    pub user_created: bool,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

impl Default for AudioPresetDefinition {
    fn default() -> Self {
        Self {
            preset_id: String::new(),
            name: String::new(),
            description: String::new(),
            target: AudioPresetTarget::AnyAudioChannel,
            gain_db: GainDb::UNITY,
            muted: false,
            processor_chain: ProcessorChainState::default(),
            built_in: false,
            user_created: true,
            created_at: None,
            updated_at: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MuteState {
    pub muted: bool,
    pub muted_by_user: bool,
}

impl Default for MuteState {
    fn default() -> Self {
        Self {
            muted: false,
            muted_by_user: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MeterState {
    pub peak_db: GainDb,
    pub rms_db: GainDb,
    pub clipping: bool,
}

impl Default for MeterState {
    fn default() -> Self {
        Self {
            peak_db: GainDb::MUTED_FLOOR,
            rms_db: GainDb::MUTED_FLOOR,
            clipping: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ChannelHealthState {
    pub clipping: bool,
    pub clipping_count: u64,
    pub recent_clipping: bool,
    pub too_quiet: bool,
    pub too_loud: bool,
    pub near_clipping: bool,
    pub silence_detected: bool,
    pub peak_db: GainDb,
    pub rms_db: GainDb,
    pub short_term_loudness_db: Option<GainDb>,
    pub latency_samples: u32,
    pub processor_cpu_estimate: Option<f32>,
    /// Microphones only: what the noise suppressor's 10 ms hop costs on average, measured
    /// on the audio thread, in milliseconds. `None` until measured or without a suppressor.
    pub suppressor_cost_ms: Option<f32>,
    /// The most one hop has cost since that suppressor started, in milliseconds.
    pub suppressor_worst_ms: Option<f32>,
    pub safety_limiter_active: bool,
    pub safety_limiter_ceiling_db: GainDb,
}

/// A compact high-frequency meter update. Metering runs several times per second, so it must
/// not reuse `audio-state-changed`, whose full mixer snapshot is reserved for structural and
/// control changes.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AudioMeterUpdate {
    pub source_id: Option<AudioSourceId>,
    pub participant_id: Option<ParticipantId>,
    pub track_id: Option<PublishedTrackId>,
    pub meter: MeterState,
    pub health: Option<ChannelHealthState>,
    /// Remote tracks: level as received, before this peer's fader, mute and chain. Voice
    /// activity uses it so a locally muted or deafened participant still shows as speaking.
    /// Local sources: present only while muted, the level before the mute, so the UI can
    /// say "you're talking while muted".
    pub input_meter: Option<MeterState>,
    /// Microphones: the highest chance, 0 to 1, that the last meter window held a human
    /// voice. It is computed on this machine from audio this machine already has and is
    /// never sent anywhere. It answers "is someone speaking", which the speaking ring
    /// already shows, so keyboards and coughs do not light it. It is not emotion or
    /// behaviour analysis.
    pub voice_probability: Option<f32>,
    /// True for the whole output bus (everything you hear, after the volume). It names no
    /// strip.
    pub output: bool,
}

impl AudioMeterUpdate {
    pub fn local(source_id: AudioSourceId, meter: MeterState, health: ChannelHealthState) -> Self {
        Self {
            source_id: Some(source_id),
            participant_id: None,
            track_id: None,
            meter,
            health: Some(health),
            input_meter: None,
            voice_probability: None,
            output: false,
        }
    }

    pub fn remote(
        participant_id: ParticipantId,
        track_id: PublishedTrackId,
        meter: MeterState,
        input_meter: MeterState,
    ) -> Self {
        Self {
            source_id: None,
            participant_id: Some(participant_id),
            track_id: Some(track_id),
            meter,
            health: None,
            input_meter: Some(input_meter),
            voice_probability: None,
            output: false,
        }
    }
}

impl Default for AudioMeterUpdate {
    fn default() -> Self {
        Self {
            source_id: None,
            participant_id: None,
            track_id: None,
            input_meter: None,
            voice_probability: None,
            meter: MeterState::default(),
            health: None,
            output: false,
        }
    }
}

impl Default for ChannelHealthState {
    fn default() -> Self {
        Self {
            clipping: false,
            clipping_count: 0,
            recent_clipping: false,
            too_quiet: false,
            too_loud: false,
            near_clipping: false,
            silence_detected: false,
            peak_db: GainDb::MUTED_FLOOR,
            rms_db: GainDb::MUTED_FLOOR,
            short_term_loudness_db: None,
            latency_samples: 0,
            processor_cpu_estimate: None,
            suppressor_cost_ms: None,
            suppressor_worst_ms: None,
            safety_limiter_active: true,
            safety_limiter_ceiling_db: GainDb::new(-1.0),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AudioProcessorParameters {
    pub gain_db: Option<GainDb>,
    pub muted: Option<bool>,
    pub cutoff_hz: Option<f32>,
    pub threshold_db: Option<GainDb>,
    pub ratio: Option<f32>,
    pub attack_ms: Option<f32>,
    pub release_ms: Option<f32>,
    pub eq_bands: Vec<EqBandParameters>,
}

impl AudioProcessorParameters {
    pub fn for_kind(kind: &AudioProcessorKind) -> Self {
        match kind {
            AudioProcessorKind::Gain => Self {
                gain_db: Some(GainDb::UNITY),
                ..Self::default()
            },
            AudioProcessorKind::Mute => Self {
                muted: Some(false),
                ..Self::default()
            },
            AudioProcessorKind::HighPassFilter => Self {
                cutoff_hz: Some(80.0),
                ..Self::default()
            },
            AudioProcessorKind::LowPassFilter => Self {
                // Open by default — a low cutoff would gut the signal the moment it's added.
                cutoff_hz: Some(12_000.0),
                ..Self::default()
            },
            AudioProcessorKind::Limiter => Self {
                threshold_db: Some(GainDb::new(-1.0)),
                release_ms: Some(50.0),
                ..Self::default()
            },
            AudioProcessorKind::NoiseGate => Self {
                threshold_db: Some(GainDb::new(-45.0)),
                attack_ms: Some(5.0),
                release_ms: Some(80.0),
                ..Self::default()
            },
            AudioProcessorKind::Compressor => Self {
                threshold_db: Some(GainDb::new(-18.0)),
                ratio: Some(3.0),
                attack_ms: Some(10.0),
                release_ms: Some(100.0),
                ..Self::default()
            },
            AudioProcessorKind::Eq => Self {
                eq_bands: EqBandParameters::default_bands(),
                ..Self::default()
            },
            AudioProcessorKind::Meter
            | AudioProcessorKind::Custom
            | AudioProcessorKind::Unknown => Self::default(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EqBandParameters {
    pub frequency_hz: f32,
    pub gain_db: GainDb,
    pub q: f32,
}

impl Default for EqBandParameters {
    fn default() -> Self {
        Self {
            frequency_hz: 1_000.0,
            gain_db: GainDb::UNITY,
            q: 1.0,
        }
    }
}

impl EqBandParameters {
    /// The bands a new EQ starts with: flat, spread across the range that matters for
    /// voice and programme audio (low, low-mid, presence, air).
    pub fn default_bands() -> Vec<Self> {
        [120.0, 500.0, 2_500.0, 8_000.0]
            .into_iter()
            .map(|frequency_hz| Self {
                frequency_hz,
                gain_db: GainDb::UNITY,
                q: 0.9,
            })
            .collect()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AudioProcessorState {
    pub id: AudioProcessorId,
    pub kind: AudioProcessorKind,
    #[serde(alias = "label")]
    pub display_name: String,
    pub enabled: bool,
    pub parameters: AudioProcessorParameters,
    pub latency_samples: Option<u32>,
}

impl AudioProcessorState {
    pub fn new(kind: AudioProcessorKind, display_name: impl Into<String>) -> Self {
        let parameters = AudioProcessorParameters::for_kind(&kind);
        Self::with_parameters(kind, display_name, parameters)
    }

    pub fn with_parameters(
        kind: AudioProcessorKind,
        display_name: impl Into<String>,
        parameters: AudioProcessorParameters,
    ) -> Self {
        Self {
            id: AudioProcessorId::new(),
            kind,
            display_name: display_name.into(),
            enabled: true,
            parameters,
            latency_samples: None,
        }
    }
}

impl Default for AudioProcessorState {
    fn default() -> Self {
        Self::new(AudioProcessorKind::Unknown, "Processor")
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProcessorChainState {
    pub processors: Vec<AudioProcessorState>,
}

/// How much of the room the microphone keeps out of the call.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NoiseSuppressionMode {
    Off,
    /// WebRTC's classic suppressor: steady noise such as fans and hum.
    Standard,
    /// RNNoise: also keyboards, clicks and room noise.
    #[default]
    Strong,
    /// DeepFilterNet 3: removes the most, with about 30 ms more delay and more CPU. Falls
    /// back to `Strong` when the build lacks it or the computer can't keep up.
    Studio,
}

/// How much a suppression mode takes out. Each mode maps the steps to its own control.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NoiseSuppressionDepth {
    Gentle,
    #[default]
    Balanced,
    /// No limit; silence between words may sound unnatural.
    Full,
}

/// What a microphone's noise suppression is actually doing. The strip keeps the user's
/// choice; this says what runs and, when it differs, why.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoiseSuppressionRuntime {
    pub active: NoiseSuppressionMode,
    pub fallback: Option<NoiseSuppressionFallback>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NoiseSuppressionFallback {
    /// This build cannot run the chosen mode.
    NotAvailable,
    /// The chosen mode stopped working, so a simpler one is running.
    FailedToStart,
    /// Studio's model is still loading; the previous mode runs until it arrives.
    Starting,
    /// Studio could not keep up on this computer, so Strong runs for the rest of this
    /// capture. The next one tries Studio again.
    TooSlow,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WebRtcAudioProcessingSettings {
    pub noise_suppression: NoiseSuppressionMode,
    pub noise_suppression_depth: NoiseSuppressionDepth,
    pub echo_cancellation: bool,
    pub auto_gain_control: bool,
}

impl Default for WebRtcAudioProcessingSettings {
    fn default() -> Self {
        Self {
            noise_suppression: NoiseSuppressionMode::default(),
            noise_suppression_depth: NoiseSuppressionDepth::default(),
            echo_cancellation: true,
            auto_gain_control: true,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LocalChannelStripState {
    pub gain_db: GainDb,
    pub pan: f32,
    pub mute: MuteState,
    pub solo: bool,
    pub monitor_enabled: bool,
    pub webrtc_processing: WebRtcAudioProcessingSettings,
    pub preset: AudioPreset,
    pub preset_id: Option<String>,
    pub safety_limiter_ceiling_db: GainDb,
    pub processor_chain: ProcessorChainState,
    pub meter: MeterState,
    pub health: ChannelHealthState,
}

impl Default for LocalChannelStripState {
    fn default() -> Self {
        Self {
            gain_db: GainDb::default(),
            pan: 0.0,
            mute: MuteState::default(),
            solo: false,
            monitor_enabled: false,
            webrtc_processing: WebRtcAudioProcessingSettings::default(),
            preset: AudioPreset::default(),
            preset_id: None,
            safety_limiter_ceiling_db: GainDb::new(-1.0),
            processor_chain: ProcessorChainState::default(),
            meter: MeterState::default(),
            health: ChannelHealthState::default(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RemoteChannelStripState {
    pub gain_db: GainDb,
    pub mute: MuteState,
    pub pinned: bool,
    /// Run noise suppression on this person's microphone, for this listener only.
    pub noise_cleanup: bool,
    /// What Auto-level is doing with this fader. Microphones only; `Off` otherwise.
    pub auto_level: RemoteAutoLevelState,
    pub preset: AudioPreset,
    pub preset_id: Option<String>,
    pub safety_limiter_ceiling_db: GainDb,
    pub processor_chain: ProcessorChainState,
    pub meter: MeterState,
    pub health: ChannelHealthState,
}

impl Default for RemoteChannelStripState {
    fn default() -> Self {
        Self {
            gain_db: GainDb::default(),
            mute: MuteState::default(),
            pinned: false,
            noise_cleanup: false,
            auto_level: RemoteAutoLevelState::default(),
            preset: AudioPreset::default(),
            preset_id: None,
            safety_limiter_ceiling_db: GainDb::new(-1.0),
            processor_chain: ProcessorChainState::default(),
            meter: MeterState::default(),
            health: ChannelHealthState::default(),
        }
    }
}

pub type RemoteTrackChannelStripState = RemoteChannelStripState;

/// What Auto-level is doing with one person's microphone fader.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AutoLevelStatus {
    /// Auto-level is off, or this is not a microphone.
    #[default]
    Off,
    /// Not enough of this person's speech heard yet.
    Listening,
    /// The fader is where it should be.
    Leveled,
    /// The fader is gliding toward where it should be.
    Adjusting,
    /// The fader is at the end of Auto-level's range and it would go further.
    AtLimit,
    /// The listener moved this fader by hand; Auto-level leaves it alone.
    Manual,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RemoteAutoLevelState {
    pub status: AutoLevelStatus,
    /// How loud this person's speech is, K-weighted, before the listener's fader.
    pub speech_loudness_db: Option<f32>,
}

/// Auto-level for the whole mixer: whether it moves the incoming microphones' faders.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AutoLevelState {
    pub enabled: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RemoteTrackPreference {
    pub remote_participant_id: ParticipantId,
    pub remote_track_id: PublishedTrackId,
    pub gain_db: GainDb,
    pub muted: bool,
    pub processor_chain: ProcessorChainState,
    pub local_display_alias: Option<String>,
}

impl RemoteTrackPreference {
    pub fn new(remote_participant_id: ParticipantId, remote_track_id: PublishedTrackId) -> Self {
        Self {
            remote_participant_id,
            remote_track_id,
            gain_db: GainDb::UNITY,
            muted: false,
            processor_chain: ProcessorChainState::default(),
            local_display_alias: None,
        }
    }
}

impl Default for RemoteTrackPreference {
    fn default() -> Self {
        Self::new(ParticipantId::new(), PublishedTrackId::new())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PublishedTrackMetadata {
    #[serde(alias = "id")]
    pub track_id: PublishedTrackId,
    pub source_id: AudioSourceId,
    #[serde(alias = "publisherId")]
    pub participant_id: ParticipantId,
    pub kind: TrackKind,
    pub source_type: AudioSourceType,
    pub display_name: String,
    pub device_name: Option<String>,
    pub app_name: Option<String>,
    pub app_exe_name: Option<String>,
    pub app_icon_data_url: Option<String>,
    pub controllable: bool,
    pub default_gain_db: GainDb,
    pub muted: bool,
    pub codec: Option<String>,
    pub encoding: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub webrtc_track_id: Option<String>,
}

impl PublishedTrackMetadata {
    pub fn new(
        source_id: AudioSourceId,
        publisher_id: ParticipantId,
        source_type: AudioSourceType,
        display_name: impl Into<String>,
    ) -> Self {
        Self {
            track_id: PublishedTrackId::new(),
            source_id,
            participant_id: publisher_id,
            kind: TrackKind::Audio,
            source_type,
            display_name: display_name.into(),
            device_name: None,
            app_name: None,
            app_exe_name: None,
            app_icon_data_url: None,
            controllable: true,
            default_gain_db: GainDb::UNITY,
            muted: false,
            codec: None,
            encoding: None,
            created_at: None,
            updated_at: None,
            webrtc_track_id: None,
        }
    }
}

impl Default for PublishedTrackMetadata {
    fn default() -> Self {
        Self::new(
            AudioSourceId::new(),
            ParticipantId::new(),
            AudioSourceType::Unknown,
            "Unknown source",
        )
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AudioSourceState {
    pub id: AudioSourceId,
    pub owner_id: ParticipantId,
    pub source_type: AudioSourceType,
    pub display_name: String,
    pub capture_device_id: Option<String>,
    /// For app audio: the captured process's executable and icon, resolved when the
    /// process is chosen. Shared with peers so they can show which app it is.
    pub app_exe_name: Option<String>,
    pub app_icon_data_url: Option<String>,
    pub enabled: bool,
    pub publishing: bool,
    pub runtime: AudioSourceRuntimeState,
    pub channel_strip: LocalChannelStripState,
    pub published_track: Option<PublishedTrackMetadata>,
}

impl AudioSourceState {
    pub fn new(
        owner_id: ParticipantId,
        source_type: AudioSourceType,
        display_name: impl Into<String>,
    ) -> Self {
        Self {
            id: AudioSourceId::new(),
            owner_id,
            source_type,
            display_name: display_name.into(),
            capture_device_id: None,
            app_exe_name: None,
            app_icon_data_url: None,
            enabled: true,
            publishing: false,
            runtime: AudioSourceRuntimeState::default(),
            channel_strip: LocalChannelStripState::default(),
            published_track: None,
        }
    }
}

impl Default for AudioSourceState {
    fn default() -> Self {
        Self::new(
            ParticipantId::new(),
            AudioSourceType::Unknown,
            "Unknown source",
        )
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RemoteAudioTrackState {
    pub track: PublishedTrackMetadata,
    pub receiver_channel_strip: RemoteTrackChannelStripState,
    pub preference: RemoteTrackPreference,
    pub subscribed: bool,
    pub subscription_status: AudioSubscriptionStatus,
}

impl RemoteAudioTrackState {
    pub fn new(track: PublishedTrackMetadata) -> Self {
        let preference = RemoteTrackPreference::new(track.participant_id, track.track_id);
        Self {
            track,
            receiver_channel_strip: RemoteChannelStripState::default(),
            preference,
            subscribed: true,
            subscription_status: AudioSubscriptionStatus::Subscribed,
        }
    }
}

impl Default for RemoteAudioTrackState {
    fn default() -> Self {
        Self::new(PublishedTrackMetadata::default())
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RemoteParticipantAudioState {
    pub participant_id: ParticipantId,
    pub display_name: Option<String>,
    pub tracks: Vec<RemoteAudioTrackState>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AudioConnectionStatus {
    #[default]
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
    Error,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AudioPlaybackStatus {
    #[default]
    Stopped,
    Starting,
    Running,
    Recovering,
    Error,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AudioSubscriptionStatus {
    #[default]
    Pending,
    Subscribed,
    Recovering,
    Failed,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AudioSessionHealth {
    pub connection_status: AudioConnectionStatus,
    pub playback_status: AudioPlaybackStatus,
    pub eligible_remote_track_count: usize,
    pub active_remote_track_count: usize,
    pub error: Option<String>,
    /// Why the speaker is not (yet) playing. Kept apart from `error` so a playback
    /// recovery does not erase a connection or subscription error, and vice versa.
    pub playback_error: Option<String>,
    /// Name of the speaker actually in use.
    pub output_device_name: Option<String>,
    /// True while the chosen speaker is unavailable and the system default stands in.
    pub output_fallback: bool,
    /// Master output mute (deafen).
    pub output_muted: bool,
    /// While deafened, others' shared system and app audio (satellites) keeps playing and,
    /// in Bandwidth saver, stays subscribed. Voices are silent either way.
    pub deafen_keeps_satellites: bool,
    /// The one volume for everything Raven plays, in dB (0 is unchanged). Applied on the
    /// output bus after deafen; it never moves a strip fader or Auto-level.
    pub output_volume_db: f32,
    /// True once the engine has a saved volume on disk (read at start or written on a
    /// commit). The UI uses it to move a volume an older version kept in the WebView.
    pub output_volume_saved: bool,
    /// What the whole bus played, after the volume and before the limiter.
    pub output_meter: MeterState,
    /// Set when the sidecar lost the room for good: whether rejoining can fix it. A
    /// duplicate sign-in or a removal must not be retried automatically.
    pub connection_lost: Option<AudioConnectionLoss>,
    /// LiveKit will not take audio from this connection: a moderator muted or deafened them.
    pub publish_revoked: bool,
    /// LiveKit will not send audio to this connection: a moderator deafened them.
    pub subscribe_revoked: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioConnectionLoss {
    /// Stable machine-readable cause (`connectionLost`, `duplicateIdentity`, ...).
    pub reason: String,
    pub recoverable: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AudioMixerState {
    pub local_participant_id: Option<ParticipantId>,
    pub local_sources: Vec<AudioSourceState>,
    pub remote_tracks: Vec<RemoteAudioTrackState>,
    pub remote_participants: Vec<RemoteParticipantAudioState>,
    pub track_events: Vec<TrackLifecycleEvent>,
    pub session: AudioSessionHealth,
    pub auto_level: AutoLevelState,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PublishedTrackMetadataPatch {
    pub display_name: Option<String>,
    pub device_name: Option<String>,
    pub app_name: Option<String>,
    pub app_exe_name: Option<String>,
    pub app_icon_data_url: Option<String>,
    pub controllable: Option<bool>,
    pub default_gain_db: Option<GainDb>,
    pub muted: Option<bool>,
    pub codec: Option<String>,
    pub encoding: Option<String>,
    pub webrtc_track_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "event", content = "payload", rename_all = "snake_case")]
pub enum TrackLifecycleEvent {
    TrackPublished {
        track: PublishedTrackMetadata,
    },
    TrackUnpublished {
        track: PublishedTrackMetadata,
    },
    TrackMuted {
        #[serde(rename = "trackId")]
        track_id: PublishedTrackId,
    },
    TrackUnmuted {
        #[serde(rename = "trackId")]
        track_id: PublishedTrackId,
    },
    TrackMetadataUpdated {
        track: PublishedTrackMetadata,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn local_audio_source_defaults_to_independent_channel_strip() {
        let source = AudioSourceState::new(
            ParticipantId::new(),
            AudioSourceType::Microphone,
            "Main mic",
        );

        assert_eq!(source.source_type, AudioSourceType::Microphone);
        assert!(source.enabled);
        assert!(!source.publishing);
        assert!(source.published_track.is_none());
        assert_eq!(source.channel_strip.gain_db, GainDb::UNITY);
        assert!(!source.channel_strip.mute.muted);
        assert!(source.channel_strip.processor_chain.processors.is_empty());
    }

    #[test]
    fn remote_audio_track_defaults_to_receiver_channel_strip() {
        let track = PublishedTrackMetadata::new(
            AudioSourceId::new(),
            ParticipantId::new(),
            AudioSourceType::ScreenAudio,
            "Screen audio",
        );
        let remote_track = RemoteAudioTrackState::new(track.clone());

        assert_eq!(remote_track.track, track);
        assert!(remote_track.subscribed);
        assert_eq!(remote_track.receiver_channel_strip.gain_db, GainDb::UNITY);
        assert!(!remote_track.receiver_channel_strip.mute.muted);
        assert_eq!(remote_track.preference.remote_track_id, track.track_id);
        assert_eq!(
            remote_track.preference.remote_participant_id,
            track.participant_id
        );
    }

    #[test]
    fn mixer_state_round_trips_through_json() {
        let participant_id = ParticipantId::new();
        let source =
            AudioSourceState::new(participant_id, AudioSourceType::FileAudio, "Backing track");
        let published_track = PublishedTrackMetadata::new(
            source.id,
            participant_id,
            source.source_type.clone(),
            source.display_name.clone(),
        );
        let state = AudioMixerState {
            local_participant_id: Some(participant_id),
            local_sources: vec![source],
            remote_tracks: vec![RemoteAudioTrackState::new(published_track)],
            remote_participants: Vec::new(),
            track_events: Vec::new(),
            session: AudioSessionHealth::default(),
            auto_level: Default::default(),
        };

        let serialized = serde_json::to_string(&state).expect("serialize mixer state");
        let deserialized: AudioMixerState =
            serde_json::from_str(&serialized).expect("deserialize mixer state");

        assert_eq!(deserialized, state);
    }

    #[test]
    fn json_shape_is_frontend_friendly() {
        let source = AudioSourceState::new(
            ParticipantId::new(),
            AudioSourceType::SystemAudio,
            "System audio",
        );

        let value = serde_json::to_value(source).expect("serialize source");

        assert_eq!(value["sourceType"], json!("systemAudio"));
        assert_eq!(value["displayName"], json!("System audio"));
        assert!(value["id"].as_str().is_some());
        assert!(value["ownerId"].as_str().is_some());
        assert_eq!(value["channelStrip"]["gainDb"], json!(0.0));
        assert_eq!(value["channelStrip"]["mute"]["muted"], json!(false));
    }

    #[test]
    fn published_track_metadata_serializes_with_track_identity() {
        let participant_id = ParticipantId::new();
        let source_id = AudioSourceId::new();
        let mut track = PublishedTrackMetadata::new(
            source_id,
            participant_id,
            AudioSourceType::AppAudio,
            "Browser audio",
        );
        track.default_gain_db = GainDb::new(-3.0);
        track.muted = true;
        track.codec = Some("opus".to_string());

        let value = serde_json::to_value(&track).expect("serialize published track");

        assert!(value["trackId"].as_str().is_some());
        assert_eq!(value["sourceId"], json!(source_id));
        assert_eq!(value["participantId"], json!(participant_id));
        assert_eq!(value["kind"], json!("audio"));
        assert_eq!(value["sourceType"], json!("appAudio"));
        assert_eq!(value["displayName"], json!("Browser audio"));
        assert_eq!(value["deviceName"], json!(null));
        assert_eq!(value["appName"], json!(null));
        assert_eq!(value["controllable"], json!(true));
        assert_eq!(value["defaultGainDb"], json!(-3.0));
        assert_eq!(value["muted"], json!(true));
        assert_eq!(value["codec"], json!("opus"));

        let deserialized: PublishedTrackMetadata =
            serde_json::from_value(value).expect("deserialize published track");
        assert_eq!(deserialized, track);
    }

    #[test]
    fn track_lifecycle_event_shape_is_frontend_friendly() {
        let track_id = PublishedTrackId::new();
        let event = TrackLifecycleEvent::TrackMuted { track_id };

        let value = serde_json::to_value(event).expect("serialize track lifecycle event");

        assert_eq!(value["event"], json!("track_muted"));
        assert_eq!(value["payload"]["trackId"], json!(track_id));
    }

    #[test]
    fn meter_update_is_compact_and_frontend_friendly() {
        let source_id = AudioSourceId::new();
        let update = AudioMeterUpdate::local(
            source_id,
            MeterState {
                peak_db: GainDb::new(-3.0),
                rms_db: GainDb::new(-12.0),
                clipping: false,
            },
            ChannelHealthState::default(),
        );

        let value = serde_json::to_value(update).expect("serialize meter update");

        assert_eq!(value["sourceId"], json!(source_id));
        assert_eq!(value["participantId"], json!(null));
        assert_eq!(value["trackId"], json!(null));
        assert_eq!(value["meter"]["peakDb"], json!(-3.0));
        assert!(value["health"].is_object());
    }
}
