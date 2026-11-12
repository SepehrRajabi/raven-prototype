//! Native audio media engine.
//!
//! This owns the LiveKit room connection for a user's **audio sidecar** participant
//! (`<userId>#audio`). It is the single place audio crosses the network:
//!
//! - **Send:** the capture pipeline pushes already-DSP-processed PCM into a per-source
//!   [`PublishSink`]; a drain task forwards it to a LiveKit [`NativeAudioSource`] whose
//!   track is published as `raven-audio-<trackId>`. Because the *processed* samples are
//!   what we publish, faders / mute / the processor chain affect transmitted audio in
//!   real time.
//! - **Receive:** every remote `raven-audio-*` track is subscribed, read via
//!   [`NativeAudioStream`], run through the receiver's *local* gain/mute, mixed, and
//!   played to the default output device. Each peer manages incoming tracks without
//!   affecting anyone else.
//!
//! Video has its own native engine ([`crate::video::engine`]); this one never touches
//! it. `docs/architecture.md` ("Desktop media engines") describes the full topology.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use livekit::options::{AudioEncoding, TrackPublishOptions};
use livekit::prelude::{
    ConnectionQuality, LocalAudioTrack, LocalParticipant, LocalTrack, Participant,
    RemoteParticipant, RemoteTrack, RemoteTrackPublication, Room, RoomEvent, RoomOptions,
    TrackKind, TrackPublication, TrackSid, TrackSource,
};
use livekit::webrtc::audio_frame::AudioFrame;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_source::{AudioSourceOptions, RtcAudioSource};
use livekit::webrtc::audio_stream::native::NativeAudioStream;
use livekit::webrtc::stats::{IceCandidatePairState, RtcStats};
use livekit::DisconnectReason;
use tauri::{AppHandle, Emitter};
use tokio::runtime::{Handle, Runtime};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::audio::capture::ProcessedSampleSink;
use crate::audio::cues::{PresenceCues, LEAVE_GRACE};
use crate::audio::domain::{
    AudioConnectionLoss, AudioConnectionStatus, AudioMeterUpdate, AudioOutputDevice, AudioSourceId,
    AudioSourceState, AudioSourceType, AudioSubscriptionStatus, GainDb, MeterState,
    NoiseSuppressionDepth, NoiseSuppressionMode, ParticipantId, ProcessorChainState,
    PublishedTrackId, PublishedTrackMetadata,
};
use crate::audio::leveler::SpeechLoudnessMeter;
pub use crate::audio::playback::{OutputMixer, RenderCursor, RenderReference, UiSound};
use crate::audio::processor::{
    linear_to_db, meter_samples, AudioBuffer, AudioProcessorPrepareConfig, ProcessorChainRuntime,
};
use crate::audio::publisher::stable_webrtc_track_id;
use crate::audio::resample::StereoResampler;
use crate::audio::state::{
    save_remembered_volumes, SharedAudioEngineState, AUDIO_METER_CHANGED_EVENT,
    AUDIO_STATE_CHANGED_EVENT,
};
use crate::audio::suppression::{new_suppressor, SuppressorStage};
use crate::audio::voice::VoiceDetector;
use serde::{Deserialize, Serialize};

/// Per-track metadata the publisher shares with subscribers via LiveKit participant
/// metadata (a JSON map of `trackId` → this). It lets each incoming track show what the
/// owner is actually sharing — the precise source type and a human name (the mic, the app).
#[derive(Serialize, Deserialize)]
struct SharedTrackMeta {
    #[serde(rename = "sourceType")]
    source_type: AudioSourceType,
    #[serde(rename = "displayName", default)]
    display_name: String,
    #[serde(rename = "deviceName", default)]
    device_name: Option<String>,
    #[serde(rename = "appName", default)]
    app_name: Option<String>,
    #[serde(rename = "appExeName", default)]
    app_exe_name: Option<String>,
    #[serde(rename = "appIconDataUrl", default)]
    app_icon_data_url: Option<String>,
}

/// Largest app icon (as a data URL) shared with peers. Raven's icons are 32 px PNGs of a
/// few KB; anything bigger is not one of them and is left out.
const MAX_SHARED_ICON_BYTES: usize = 16 * 1024;
/// Ceiling for the whole metadata JSON. LiveKit v1.13 accepts up to 512 KiB, but every
/// change is broadcast to each peer, so icons are dropped before it gets near that.
const MAX_SHARED_META_BYTES: usize = 64 * 1024;

/// What we tell peers about each published track, keyed by track id.
fn shared_track_meta(sources: &[AudioSourceState]) -> HashMap<String, SharedTrackMeta> {
    sources
        .iter()
        .filter(|source| source.publishing)
        .filter_map(|source| {
            let track = source.published_track.as_ref()?;
            let is_app = source.source_type == AudioSourceType::AppAudio;
            Some((
                track.track_id.to_string(),
                SharedTrackMeta {
                    source_type: source.source_type.clone(),
                    display_name: source.display_name.clone(),
                    device_name: source.runtime.device_name.clone(),
                    app_name: is_app.then(|| source.display_name.clone()),
                    app_exe_name: source.app_exe_name.clone().filter(|_| is_app),
                    app_icon_data_url: source
                        .app_icon_data_url
                        .clone()
                        .filter(|icon| is_app && icon.len() <= MAX_SHARED_ICON_BYTES),
                },
            ))
        })
        .collect()
}

/// Serialises the shared metadata, leaving the icons out if they would push it over
/// [`MAX_SHARED_META_BYTES`]. Names always go; icons are a nicety.
fn encode_shared_meta(mut meta: HashMap<String, SharedTrackMeta>) -> Option<String> {
    let json = serde_json::to_string(&meta).ok()?;
    if json.len() <= MAX_SHARED_META_BYTES {
        return Some(json);
    }
    for entry in meta.values_mut() {
        entry.app_icon_data_url = None;
    }
    serde_json::to_string(&meta).ok()
}

fn parse_shared_meta(metadata: &str) -> HashMap<String, SharedTrackMeta> {
    if metadata.is_empty() {
        return HashMap::new();
    }
    let mut meta: HashMap<String, SharedTrackMeta> =
        serde_json::from_str(metadata).unwrap_or_default();
    // Peer-controlled and shown as an <img src>: only an inline PNG, never a URL that
    // would make every listener fetch from a host the peer chose.
    for entry in meta.values_mut() {
        if entry
            .app_icon_data_url
            .as_deref()
            .is_some_and(|url| !url.starts_with("data:image/png;base64,"))
        {
            entry.app_icon_data_url = None;
        }
    }
    meta
}

/// Channel layout we publish and play at. libwebrtc resamples to/from its internal
/// 48 kHz pipeline, so a fixed stereo contract keeps the mixer trivial.
const PUBLISH_CHANNELS: usize = 2;
/// Every source is published at WebRTC's native rate, whatever the capture device or the
/// speaker runs at.
const PUBLISH_SAMPLE_RATE: u32 = 48_000;
/// Interleaved samples in one 10 ms publish frame.
const PUBLISH_FRAME_SAMPLES: usize = (PUBLISH_SAMPLE_RATE as usize / 100) * PUBLISH_CHANNELS;
/// LiveKit-side buffering for published audio, in milliseconds. Zero selects the direct
/// path: each 10 ms frame goes straight to the encoder, paced by the capture device, so
/// no latency can accumulate between capture and send. (A non-zero queue is drained by a
/// wall-clock timer and never shrinks once a burst has filled it.)
const PUBLISH_QUEUE_MS: u32 = 0;
/// Frames waiting between the capture thread and the encoder before new ones are dropped.
const PUBLISH_BACKLOG_FRAMES: usize = 12;
/// A source that has produced nothing for this long (loopback capture of a silent system,
/// a stalled device) is padded with silence so the RTP stream stays continuous.
const PUBLISH_IDLE_AFTER: Duration = Duration::from_millis(60);
/// Bitrate for shared system / application audio, which is usually music or video sound.
const SHARED_AUDIO_BITRATE_BPS: u64 = 128_000;
/// How often each remote reader publishes a meter update for its Incoming Tracks strip.
const METER_INTERVAL: Duration = Duration::from_millis(120);
/// How often a remote reader refreshes receiver-local controls from mixer state.
/// Reading them for every audio frame lets active remote playback starve local publish
/// mutations on some machines.
const RECEIVER_CONTROL_REFRESH_INTERVAL: Duration = Duration::from_millis(40);
/// Upper bound on the per-block frame count fed to a receiver processor chain. LiveKit
/// audio frames are ~10 ms, well under this.
const RECEIVER_MAX_BLOCK: usize = 4096;
/// Fastest a receiver fader / mute may move, in gain units per millisecond, so muting or
/// dragging someone's volume never clicks.
const RECEIVER_GAIN_SLEW_PER_MS: f32 = 0.25;
/// How often Auto-level moves faders. Its glides are slow; this only keeps them smooth.
const AUTO_LEVEL_STEP_INTERVAL: Duration = Duration::from_millis(250);
const RECOVERY_DELAYS: [Duration; 3] = [
    Duration::from_millis(250),
    Duration::from_secs(1),
    Duration::from_secs(3),
];

/// Run a synchronous LiveKit operation with the audio engine's Tokio reactor installed.
///
/// Some LiveKit methods, including `RemoteTrackPublication::set_subscribed`, spawn async
/// work internally even though their public API is synchronous. Tauri invokes synchronous
/// commands from WebView threads that do not have a Tokio reactor, so those methods must be
/// called from this context or they will panic instead of returning an error.
fn within_runtime_context<T>(runtime: &Runtime, operation: impl FnOnce() -> T) -> T {
    let _guard = runtime.enter();
    operation()
}

#[cfg(test)]
mod runtime_context_tests {
    use super::*;

    #[test]
    fn synchronous_media_operations_can_spawn_on_the_audio_runtime() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build test runtime");

        let task = within_runtime_context(&runtime, || tokio::spawn(async { 42 }));

        assert_eq!(runtime.block_on(task).expect("spawned task"), 42);
    }
}

#[cfg(test)]
mod publish_framer_tests {
    use super::*;

    #[test]
    fn a_poisoned_publish_sink_keeps_publishing() {
        let (sender, mut receiver) = mpsc::channel::<Vec<i16>>(PUBLISH_BACKLOG_FRAMES);
        let sink = PublishSink::new(sender);
        let _ = std::panic::catch_unwind(|| {
            let _framer = sink.framer.lock().unwrap();
            panic!("poison the framer");
        });

        sink.push_samples(&vec![0.25; 480 * 2], 2, 48_000);

        let frame = receiver
            .try_recv()
            .expect("a frame after the poisoned lock");
        assert_eq!(frame.len(), PUBLISH_FRAME_SAMPLES);
    }

    #[test]
    fn capture_blocks_become_exact_ten_millisecond_frames() {
        let mut framer = PublishFramer::new();
        // 7 ms of 48 kHz stereo: not a whole frame yet.
        assert!(framer.push(&vec![0.25; 336 * 2], 2, 48_000).is_empty());
        // Another 7 ms completes one frame and keeps the 4 ms remainder.
        let frames = framer.push(&vec![0.25; 336 * 2], 2, 48_000);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].len(), PUBLISH_FRAME_SAMPLES);
        assert_eq!(framer.pending.len(), (672 - 480) * 2);
    }

    #[test]
    fn a_large_block_yields_every_frame_in_order() {
        let mut framer = PublishFramer::new();
        let block: Vec<f32> = (0..480 * 3)
            .flat_map(|frame| [frame as f32 / 4800.0; 2])
            .collect();
        let frames = framer.push(&block, 2, 48_000);
        assert_eq!(frames.len(), 3);
        assert!(frames[0][0] < frames[1][0] && frames[1][0] < frames[2][0]);
        assert!(framer.pending.is_empty());
    }

    #[test]
    fn mono_and_non_native_rates_are_normalized_before_framing() {
        let mut framer = PublishFramer::new();
        // 100 ms of 44.1 kHz mono is ~100 ms of 48 kHz stereo: about ten frames.
        let frames = framer.push(&vec![0.5; 4_410], 1, 44_100);
        assert!((9..=10).contains(&frames.len()));
        assert!(frames
            .iter()
            .all(|frame| frame.len() == PUBLISH_FRAME_SAMPLES));
        assert!(frames[1].chunks(2).all(|pair| pair[0] == pair[1]));
    }
}

#[cfg(test)]
mod disconnect_reason_tests {
    use super::*;

    #[test]
    fn only_transport_failures_are_retried_automatically() {
        for reason in [
            DisconnectReason::UnknownReason,
            DisconnectReason::ServerShutdown,
            DisconnectReason::SignalClose,
            DisconnectReason::ConnectionTimeout,
            DisconnectReason::MediaFailure,
        ] {
            assert!(
                describe_disconnect(reason).2,
                "{reason:?} should be retried"
            );
        }
        // Rejoining after any of these would fight the server (or another device).
        for reason in [
            DisconnectReason::DuplicateIdentity,
            DisconnectReason::ParticipantRemoved,
            DisconnectReason::RoomDeleted,
            DisconnectReason::RoomClosed,
        ] {
            assert!(
                !describe_disconnect(reason).2,
                "{reason:?} must not be retried"
            );
        }
    }
}

#[cfg(test)]
mod subscription_policy_tests {
    use super::*;

    #[test]
    fn late_join_snapshot_subscribes_existing_remote_raven_audio() {
        assert!(desired_remote_audio_subscription(
            "11111111-1111-4111-8111-111111111111",
            "22222222-2222-4222-8222-222222222222#audio",
            "raven-audio-33333333-3333-4333-8333-333333333333",
            TrackKind::Audio,
            true,
        ));
    }

    #[test]
    fn subscription_policy_excludes_self_sidecars_non_raven_tracks_and_deafen() {
        let local = "11111111-1111-4111-8111-111111111111";
        assert!(!desired_remote_audio_subscription(
            local,
            "11111111-1111-4111-8111-111111111111#video",
            "raven-audio-33333333-3333-4333-8333-333333333333",
            TrackKind::Audio,
            true,
        ));
        assert!(!desired_remote_audio_subscription(
            local,
            "22222222-2222-4222-8222-222222222222#audio",
            "browser-microphone",
            TrackKind::Audio,
            true,
        ));
        assert!(!desired_remote_audio_subscription(
            local,
            "22222222-2222-4222-8222-222222222222#audio",
            "raven-audio-33333333-3333-4333-8333-333333333333",
            TrackKind::Audio,
            false,
        ));
    }

    #[test]
    fn recovery_backoff_is_bounded_and_ordered() {
        assert_eq!(
            RECOVERY_DELAYS,
            [
                Duration::from_millis(250),
                Duration::from_secs(1),
                Duration::from_secs(3),
            ]
        );
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioNetworkTotals {
    pub sent_bytes: u64,
    pub received_bytes: u64,
    /// Packets of this peer's own audio sent so far, and how many of them the server
    /// reported missing. Together they say how choppy this peer sounds to everyone else.
    pub sent_packets: u64,
    pub sent_packets_lost: u64,
    /// The worst round trip and jitter the server reports for this peer's audio.
    pub sent_round_trip_ms: Option<f64>,
    pub sent_jitter_ms: Option<f64>,
    /// Round trip to the server in milliseconds: the active ICE pair's, else the server's
    /// receiver reports for this peer's audio.
    pub round_trip_ms: Option<f64>,
    /// LiveKit's own verdict on this connection: excellent, good, poor or lost.
    pub connection_quality: Option<&'static str>,
}

/// The round trip, in milliseconds, of the first in-use candidate pair that has a
/// measurement. Publisher stats come first: that connection is the one carrying the mic.
pub fn active_pair_round_trip_ms<'a>(stats: impl IntoIterator<Item = &'a RtcStats>) -> Option<f64> {
    stats.into_iter().find_map(|stat| match stat {
        RtcStats::CandidatePair(pair)
            if pair.candidate_pair.nominated
                && pair.candidate_pair.state == Some(IceCandidatePairState::Succeeded)
                && pair.candidate_pair.current_round_trip_time > 0.0 =>
        {
            Some(pair.candidate_pair.current_round_trip_time * 1_000.0)
        }
        _ => None,
    })
}

fn quality_word(quality: ConnectionQuality) -> &'static str {
    match quality {
        ConnectionQuality::Excellent => "excellent",
        ConnectionQuality::Good => "good",
        ConnectionQuality::Poor => "poor",
        ConnectionQuality::Lost => "lost",
    }
}

pub async fn measure_audio_network_totals(room: Arc<Room>) -> Result<AudioNetworkTotals, String> {
    let stats = room.get_stats().await.map_err(|error| error.to_string())?;
    let mut totals = AudioNetworkTotals::default();
    for stat in &stats.publisher_stats {
        match stat {
            RtcStats::OutboundRtp(outbound) => {
                totals.sent_bytes += outbound.sent.bytes_sent;
                totals.sent_packets += outbound.sent.packets_sent;
            }
            RtcStats::RemoteInboundRtp(remote) => {
                totals.sent_packets_lost += remote.received.packets_lost.max(0) as u64;
                if remote.remote_inbound.round_trip_time_measurements > 0 {
                    let round_trip_ms = remote.remote_inbound.round_trip_time * 1_000.0;
                    totals.sent_round_trip_ms =
                        Some(totals.sent_round_trip_ms.unwrap_or(0.0).max(round_trip_ms));
                }
                let jitter_ms = remote.received.jitter * 1_000.0;
                totals.sent_jitter_ms = Some(totals.sent_jitter_ms.unwrap_or(0.0).max(jitter_ms));
            }
            _ => {}
        }
    }
    // The ICE pair's own measurement when libwebrtc reports a nominated one. On this SDK
    // against a LiveKit server it often reports only an unanswered pair (measured
    // 2026-10-25), so the server's RTCP receiver reports for our audio stand in for it.
    totals.round_trip_ms =
        active_pair_round_trip_ms(stats.publisher_stats.iter().chain(&stats.subscriber_stats))
            .or(totals.sent_round_trip_ms);
    totals.connection_quality = Some(quality_word(room.local_participant().connection_quality()));
    totals.received_bytes = stats
        .subscriber_stats
        .iter()
        .filter_map(|stat| match stat {
            RtcStats::InboundRtp(inbound) => Some(inbound.inbound.bytes_received),
            _ => None,
        })
        .sum();
    Ok(totals)
}

fn db_to_linear(db: GainDb) -> f32 {
    10.0_f32.powf(db.0 / 20.0)
}

fn lk_track_source(source_type: &AudioSourceType) -> TrackSource {
    match source_type {
        AudioSourceType::Microphone => TrackSource::Microphone,
        AudioSourceType::ScreenAudio | AudioSourceType::SystemAudio | AudioSourceType::AppAudio => {
            TrackSource::ScreenshareAudio
        }
        _ => TrackSource::Unknown,
    }
}

fn audio_source_from_lk(source: TrackSource) -> AudioSourceType {
    match source {
        TrackSource::Microphone => AudioSourceType::Microphone,
        TrackSource::ScreenshareAudio => AudioSourceType::ScreenAudio,
        _ => AudioSourceType::Unknown,
    }
}

fn base_participant_identity(identity: &str) -> &str {
    identity
        .strip_suffix("#audio")
        .or_else(|| identity.strip_suffix("#video"))
        .unwrap_or(identity)
}

/// The user behind another person's audio sidecar. A person's arrival is their audio
/// sidecar connecting: their video publisher and viewer join the same room separately,
/// and our own other sidecars (or another device of ours) are not someone arriving.
fn audio_peer_identity(identity: &str, local_identity: &str) -> Option<String> {
    identity
        .strip_suffix("#audio")
        .filter(|base| *base != local_identity && ParticipantId::parse(base).is_some())
        .map(str::to_string)
}

fn audio_peers(identities: impl IntoIterator<Item = String>, local_identity: &str) -> Vec<String> {
    identities
        .into_iter()
        .filter_map(|identity| audio_peer_identity(&identity, local_identity))
        .collect()
}

/// Announce a departure once its grace period passes without the person coming back.
fn schedule_leave_cue(
    runtime: &Handle,
    presence: &Arc<Mutex<PresenceCues>>,
    output: &Arc<OutputMixer>,
    active: &Arc<AtomicBool>,
    identity: String,
    token: u64,
) {
    let presence = Arc::clone(presence);
    let output = Arc::clone(output);
    let active = Arc::clone(active);
    runtime.spawn(async move {
        tokio::time::sleep(LEAVE_GRACE).await;
        if !active.load(Ordering::SeqCst) {
            return;
        }
        let cue = presence
            .lock()
            .ok()
            .and_then(|mut presence| presence.confirm_leave(&identity, token, Instant::now()));
        if let Some(cue) = cue {
            let _ = output.play_cue(cue);
        }
    });
}

// ---------------------------------------------------------------------------
// Send path: streaming resampler + per-source publish sink
// ---------------------------------------------------------------------------

/// Capture-side sink for one published source. Receives processed f32 PCM on the audio
/// thread, normalizes it to stereo i16 at the publish rate, cuts it into exact 10 ms
/// frames, and hands those to the drain task.
pub struct PublishSink {
    sender: mpsc::Sender<Vec<i16>>,
    framer: Mutex<PublishFramer>,
}

/// Resampler plus the remainder that did not fill a whole 10 ms frame yet.
struct PublishFramer {
    resampler: StereoResampler,
    pending: Vec<i16>,
}

impl PublishFramer {
    fn new() -> Self {
        Self {
            resampler: StereoResampler::new(PUBLISH_SAMPLE_RATE),
            pending: Vec::with_capacity(PUBLISH_FRAME_SAMPLES * 4),
        }
    }

    /// Append a capture block and return every complete 10 ms frame now available.
    fn push(&mut self, samples: &[f32], channels: usize, sample_rate: u32) -> Vec<Vec<i16>> {
        self.resampler
            .process(samples, channels, sample_rate, &mut self.pending);
        let complete = self.pending.len() / PUBLISH_FRAME_SAMPLES;
        let mut frames = Vec::with_capacity(complete);
        for index in 0..complete {
            let start = index * PUBLISH_FRAME_SAMPLES;
            frames.push(self.pending[start..start + PUBLISH_FRAME_SAMPLES].to_vec());
        }
        self.pending.drain(..complete * PUBLISH_FRAME_SAMPLES);
        frames
    }
}

impl PublishSink {
    fn new(sender: mpsc::Sender<Vec<i16>>) -> Self {
        Self {
            sender,
            framer: Mutex::new(PublishFramer::new()),
        }
    }
}

impl std::fmt::Debug for PublishSink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PublishSink").finish_non_exhaustive()
    }
}

impl ProcessedSampleSink for PublishSink {
    fn push_samples(&self, samples: &[f32], channels: usize, sample_rate: u32) {
        let frames = match self.framer.lock() {
            Ok(mut framer) => framer.push(samples, channels, sample_rate),
            // A panic mid-push (caught by capture) left the framer half-updated: start it
            // over rather than dropping this track's audio for the rest of the call.
            Err(poisoned) => {
                self.framer.clear_poison();
                let mut framer = poisoned.into_inner();
                *framer = PublishFramer::new();
                framer.push(samples, channels, sample_rate)
            }
        };
        for frame in frames {
            // Drop on backpressure rather than block the audio thread; bounds latency.
            let _ = self.sender.try_send(frame);
        }
    }
}

struct PublishEntry {
    /// LiveKit track name (`raven-audio-<trackId>`). The server-issued SID changes when
    /// the SDK republishes after a full reconnect, so the publication is always looked up
    /// by name rather than by a SID captured at publish time.
    track_name: String,
    track: LocalAudioTrack,
    muted: bool,
    sink: Arc<PublishSink>,
    drain: JoinHandle<()>,
}

/// Find the live publication for one of our tracks, whatever SID it currently has.
fn local_publication_sid(room: &Room, track_name: &str) -> Option<TrackSid> {
    room.local_participant()
        .track_publications()
        .values()
        .find(|publication| publication.name() == track_name)
        .map(|publication| publication.sid())
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

struct RoomConnection {
    room: Arc<Room>,
    event_loop: JoinHandle<()>,
    readers: Arc<Mutex<HashMap<String, JoinHandle<()>>>>,
    active: Arc<AtomicBool>,
    /// Steps Auto-level while the room is up.
    auto_level: JoinHandle<()>,
}

/// Received frames queued for a track's DSP thread: 80 ms. More means the thread is
/// behind, and holding more would only add latency.
const RECEIVE_QUEUE_FRAMES: usize = 8;

const READER_RUNNING: u8 = 0;
/// The stream ended by itself: the DSP thread finishes the queue, then cleans up.
const READER_ENDED: u8 = 1;
/// The async reader was aborted: the DSP thread stops at once and touches nothing.
const READER_CANCELLED: u8 = 2;

/// One decoded 10 ms frame for a track's DSP thread, at the rate it was requested at.
struct ReceivedFrame {
    rate: u32,
    data: Vec<i16>,
}

/// Marks a reader cancelled when its async task is dropped before the stream ended.
struct ReaderCancelGuard(Arc<AtomicU8>);

impl Drop for ReaderCancelGuard {
    fn drop(&mut self) {
        let _ = self.0.compare_exchange(
            READER_RUNNING,
            READER_CANCELLED,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
    }
}

#[derive(Clone, Debug)]
struct ReaderEnded {
    participant_id: ParticipantId,
    track_id: PublishedTrackId,
    key: String,
}

/// The audio media engine. Stored inside `AudioEngineState` next to the capture manager.
pub struct AudioEngine {
    runtime: Option<Runtime>,
    connection: Option<RoomConnection>,
    publications: HashMap<AudioSourceId, PublishEntry>,
    output: Arc<OutputMixer>,
    /// Whether remote audio is received: the user's choice, unless a moderator deafened them.
    receive_remote_audio: Arc<AtomicBool>,
    receive_wanted: bool,
    subscribe_revoked: bool,
    /// Last participant-metadata JSON we pushed, so we only re-send on change.
    published_meta: String,
}

impl std::fmt::Debug for AudioEngine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AudioEngine")
            .field("connected", &self.connection.is_some())
            .field("publications", &self.publications.len())
            .finish_non_exhaustive()
    }
}

impl Default for AudioEngine {
    fn default() -> Self {
        Self {
            runtime: None,
            connection: None,
            publications: HashMap::new(),
            output: OutputMixer::new(),
            receive_remote_audio: Arc::new(AtomicBool::new(true)),
            receive_wanted: true,
            subscribe_revoked: false,
            published_meta: String::new(),
        }
    }
}

impl AudioEngine {
    fn runtime(&mut self) -> &Runtime {
        if self.runtime.is_none() {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(4)
                .thread_name("raven-audio-engine")
                .enable_all()
                .build()
                .expect("failed to build audio engine tokio runtime");
            self.runtime = Some(runtime);
        }
        self.runtime.as_ref().unwrap()
    }

    /// Handle to the engine runtime. Every LiveKit call is spawned here so the SDK's
    /// internal tasks stay on the engine's own workers regardless of which runtime the
    /// calling command is polled on.
    fn handle(&mut self) -> Handle {
        self.runtime().handle().clone()
    }

    pub fn is_connected(&self) -> bool {
        self.connection.is_some()
    }

    pub fn connected_room(&self) -> Option<Arc<Room>> {
        self.connection
            .as_ref()
            .map(|connection| Arc::clone(&connection.room))
    }

    /// Connect the audio sidecar to a LiveKit room. Awaits the network handshake; callers
    /// must not hold the mixer state lock across this call.
    pub async fn connect(
        &mut self,
        app: &AppHandle,
        shared: &SharedAudioEngineState,
        url: &str,
        token: &str,
    ) -> Result<(), String> {
        if self.connection.is_some() {
            self.disconnect().await;
        }
        self.published_meta.clear();
        // Playback comes up on its own worker and keeps retrying; a missing or busy
        // speaker must not stop the user from joining and being heard.
        self.output.start(app, shared);

        let mut options = RoomOptions::default();
        // Subscribe selectively in the event loop. The audio sidecar must never receive
        // video tracks or another sidecar belonging to the same user.
        options.auto_subscribe = false;
        let handle = self.handle();
        let (url, token) = (url.to_string(), token.to_string());
        let connected = handle
            .spawn(async move { Room::connect(&url, &token, options).await })
            .await
            .map_err(|error| error.to_string())
            .and_then(|result| result.map_err(|error| error.to_string()));
        let (room, events) = match connected {
            Ok(connected) => connected,
            Err(error) => {
                let output = Arc::clone(&self.output);
                tokio::task::block_in_place(|| output.stop());
                return Err(error);
            }
        };
        let room = Arc::new(room);
        let local_identity =
            base_participant_identity(&room.local_participant().identity().0).to_string();

        let readers: Arc<Mutex<HashMap<String, JoinHandle<()>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let retrying_subscriptions = Arc::new(Mutex::new(HashSet::new()));
        let active = Arc::new(AtomicBool::new(true));
        let event_loop = self.spawn_event_loop(
            app,
            shared,
            Arc::clone(&room),
            events,
            &readers,
            &retrying_subscriptions,
            Arc::clone(&active),
            local_identity,
        );

        let auto_level = self
            .handle()
            .spawn(run_auto_level(app.clone(), Arc::clone(shared)));

        self.connection = Some(RoomConnection {
            room,
            event_loop,
            readers,
            active,
            auto_level,
        });
        Ok(())
    }

    pub async fn disconnect(&mut self) {
        // Stop publishing.
        for (_, entry) in self.publications.drain() {
            entry.drain.abort();
        }
        if let Some(connection) = self.connection.take() {
            connection.active.store(false, Ordering::SeqCst);
            connection.event_loop.abort();
            connection.auto_level.abort();
            for (_, reader) in connection.readers.lock().unwrap().drain() {
                reader.abort();
            }
            let room = connection.room.clone();
            let handle = self.handle();
            let _ = handle.spawn(async move { room.close().await }).await;
        }
        let output = Arc::clone(&self.output);
        tokio::task::block_in_place(|| output.stop());
    }

    pub fn render_reference(&self) -> Arc<RenderReference> {
        self.output.render_reference()
    }

    /// The playback mixer, shared so device queries and test tones do not have to wait
    /// behind a long-running engine operation.
    pub fn output_mixer(&self) -> Arc<OutputMixer> {
        Arc::clone(&self.output)
    }

    pub fn set_output_device(
        &mut self,
        app: &AppHandle,
        shared: &SharedAudioEngineState,
        device_id: Option<String>,
    ) -> Result<Option<AudioOutputDevice>, String> {
        let selected = self.output.set_device(device_id)?;
        if self.connection.is_some() && !self.output.is_running() {
            self.output.start(app, shared);
        }
        Ok(selected)
    }

    pub fn selected_output_device(&self) -> Option<AudioOutputDevice> {
        self.output.selected_device()
    }

    pub fn play_test_tone(&self, device_id: Option<String>) -> Result<(), String> {
        self.output.play_test_tone(device_id)
    }

    pub fn set_remote_audio_receiving(&mut self, enabled: bool) {
        self.receive_wanted = enabled;
        self.apply_remote_receiving();
    }

    /// A moderator's deafen. Kept apart from the user's own choice, which it returns to.
    pub fn set_subscribe_revoked(&mut self, revoked: bool) {
        self.subscribe_revoked = revoked;
        self.apply_remote_receiving();
    }

    fn apply_remote_receiving(&mut self) {
        let enabled = self.receive_wanted && !self.subscribe_revoked;
        self.receive_remote_audio.store(enabled, Ordering::SeqCst);
        let subscription_updates = if let Some(connection) = self.connection.as_ref() {
            let local_identity =
                base_participant_identity(&connection.room.local_participant().identity().0)
                    .to_string();
            let mut updates = Vec::new();
            for participant in connection.room.remote_participants().values() {
                for publication in participant.track_publications().values() {
                    let should_subscribe = enabled
                        && is_eligible_remote_publication(
                            publication,
                            participant,
                            &local_identity,
                        );
                    if publication.is_desired() != should_subscribe {
                        updates.push((publication.clone(), should_subscribe));
                    }
                }
            }
            updates
        } else {
            Vec::new()
        };

        if subscription_updates.is_empty() {
            return;
        }

        within_runtime_context(self.runtime(), || {
            for (publication, should_subscribe) in subscription_updates {
                publication.set_subscribed(should_subscribe);
            }
        });
    }

    /// Sink map handed to the capture manager so it knows where to push processed PCM.
    pub fn sink_map(&self) -> HashMap<AudioSourceId, Arc<dyn ProcessedSampleSink>> {
        self.publications
            .iter()
            .map(|(id, entry)| (*id, Arc::clone(&entry.sink) as Arc<dyn ProcessedSampleSink>))
            .collect()
    }

    /// Reconcile published LiveKit tracks against which local sources are marked
    /// `publishing`. Called with the ops lock held and the mixer state lock released,
    /// because publishing awaits signalling round trips.
    pub async fn reconcile_publications(
        &mut self,
        sources: &[AudioSourceState],
    ) -> Result<(), String> {
        let Some(connection) = self.connection.as_ref() else {
            // Not connected: nothing can be published.
            for (_, entry) in self.publications.drain() {
                entry.drain.abort();
            }
            return Ok(());
        };
        let room = Arc::clone(&connection.room);
        let handle = self.handle();

        let desired: HashMap<AudioSourceId, &AudioSourceState> = sources
            .iter()
            .filter(|source| source.publishing)
            .map(|source| (source.id, source))
            .collect();

        // Forget publications LiveKit no longer has (the SDK's automatic republish after a
        // full reconnect can fail); they are published again below.
        let lost: Vec<AudioSourceId> = self
            .publications
            .iter()
            .filter(|(_, entry)| local_publication_sid(&room, &entry.track_name).is_none())
            .map(|(id, _)| *id)
            .collect();
        for id in lost {
            if let Some(entry) = self.publications.remove(&id) {
                entry.drain.abort();
            }
        }

        // Unpublish sources that are no longer publishing.
        let stale: Vec<AudioSourceId> = self
            .publications
            .keys()
            .copied()
            .filter(|id| !desired.contains_key(id))
            .collect();
        for id in stale {
            if let Some(entry) = self.publications.remove(&id) {
                entry.drain.abort();
                let Some(sid) = local_publication_sid(&room, &entry.track_name) else {
                    continue;
                };
                let room = Arc::clone(&room);
                let _ = handle
                    .spawn(async move { room.local_participant().unpublish_track(&sid).await })
                    .await;
            }
        }

        // Publish newly-publishing sources.
        let to_publish: Vec<AudioSourceState> = desired
            .values()
            .filter(|source| !self.publications.contains_key(&source.id))
            .map(|source| (*source).clone())
            .collect();
        let mut first_error = None;
        for source in to_publish {
            if let Err(error) = self.publish_source(&room, &source).await {
                eprintln!("[audio-engine] publish failed for {}: {error}", source.id);
                first_error.get_or_insert_with(|| {
                    format!("could not publish audio source {}: {error}", source.id)
                });
            }
        }

        // Mirror each strip's mute onto its LiveKit track. The track stays published while
        // muted, so unmuting is instant, peers keep one stable track per source, and
        // everyone still sees the muted state. (The capture path also zeroes the samples,
        // so nothing is transmitted regardless of the signalling.)
        {
            let _context = handle.enter();
            for (id, entry) in self.publications.iter_mut() {
                let Some(source) = desired.get(id) else {
                    continue;
                };
                let should_mute = source.channel_strip.mute.muted;
                if entry.muted != should_mute {
                    if should_mute {
                        entry.track.mute();
                    } else {
                        entry.track.unmute();
                    }
                    entry.muted = should_mute;
                }
            }
        }

        // Share each published track's source type + human name with peers via participant
        // metadata, so their Incoming Tracks show what we're actually sending. Only re-send
        // when it changes (this runs on every mixer mutation, incl. fader ticks).
        if let Some(json) = encode_shared_meta(shared_track_meta(sources)) {
            if json != self.published_meta {
                let metadata_room = Arc::clone(&room);
                let metadata = json.clone();
                let result = handle
                    .spawn(async move {
                        metadata_room
                            .local_participant()
                            .set_metadata(metadata)
                            .await
                    })
                    .await;
                match result {
                    Ok(Ok(())) => {
                        self.published_meta = json;
                    }
                    Ok(Err(error)) => {
                        eprintln!("[audio-engine] failed to publish track metadata: {error}");
                    }
                    Err(error) => {
                        eprintln!("[audio-engine] track metadata task failed: {error}");
                    }
                }
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    async fn publish_source(
        &mut self,
        room: &Arc<Room>,
        source: &AudioSourceState,
    ) -> Result<(), String> {
        let track_id = source
            .published_track
            .as_ref()
            .map(|track| track.track_id)
            .unwrap_or_else(|| PublishedTrackId::for_source(source.id));
        let webrtc_track_id = stable_webrtc_track_id(track_id);

        // Noise suppression, echo cancellation and gain control already ran in the capture
        // path (the samples pushed here are final), so WebRTC's own stages stay off.
        let options = AudioSourceOptions {
            echo_cancellation: false,
            noise_suppression: false,
            auto_gain_control: false,
        };
        let native = NativeAudioSource::new(
            options,
            PUBLISH_SAMPLE_RATE,
            PUBLISH_CHANNELS as u32,
            PUBLISH_QUEUE_MS,
        );
        let track = LocalAudioTrack::create_audio_track(
            &webrtc_track_id,
            RtcAudioSource::Native(native.clone()),
        );

        let shared_audio = !matches!(source.source_type, AudioSourceType::Microphone);
        let publish_options = TrackPublishOptions {
            source: lk_track_source(&source.source_type),
            stream: format!("raven-source-{}", source.id),
            // Shared system / app audio is programme material: give it a music bitrate
            // and keep it continuous. Voice keeps the SDK default with DTX.
            audio_encoding: shared_audio.then_some(AudioEncoding {
                max_bitrate: SHARED_AUDIO_BITRATE_BPS,
            }),
            dtx: !shared_audio,
            ..Default::default()
        };

        let (sender, receiver) = mpsc::channel::<Vec<i16>>(PUBLISH_BACKLOG_FRAMES);
        let sink = Arc::new(PublishSink::new(sender));

        let handle = self.handle();
        let publish_room = Arc::clone(room);
        let publish_track = track.clone();
        handle
            .spawn(async move {
                publish_room
                    .local_participant()
                    .publish_track(LocalTrack::Audio(publish_track), publish_options)
                    .await
            })
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| error.to_string())?;

        let muted = source.channel_strip.mute.muted;
        if muted {
            let _context = handle.enter();
            track.mute();
        }

        let drain = handle.spawn(drain_published_audio(native, receiver));

        self.publications.insert(
            source.id,
            PublishEntry {
                track_name: webrtc_track_id,
                track,
                muted,
                sink,
                drain,
            },
        );
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn spawn_event_loop(
        &mut self,
        app: &AppHandle,
        shared: &SharedAudioEngineState,
        room: Arc<Room>,
        mut events: mpsc::UnboundedReceiver<RoomEvent>,
        readers: &Arc<Mutex<HashMap<String, JoinHandle<()>>>>,
        retrying_subscriptions: &Arc<Mutex<HashSet<String>>>,
        active: Arc<AtomicBool>,
        local_identity: String,
    ) -> JoinHandle<()> {
        let app = app.clone();
        let shared = Arc::clone(shared);
        let readers = Arc::clone(readers);
        let retrying_subscriptions = Arc::clone(retrying_subscriptions);
        let output = Arc::clone(&self.output);
        let receive_remote_audio = Arc::clone(&self.receive_remote_audio);
        let runtime_handle = self.runtime().handle().clone();
        // Who is in the room, for the joined and left sound cues.
        let presence = Arc::new(Mutex::new(PresenceCues::default()));

        let (reader_ended_sender, mut reader_ended_receiver) = mpsc::unbounded_channel();

        self.runtime().spawn(async move {
            loop {
                let event = tokio::select! {
                    event = events.recv() => event,
                    ended = reader_ended_receiver.recv() => {
                        if let Some(ended) = ended {
                            handle_reader_ended(
                                &app,
                                &shared,
                                &room,
                                &readers,
                                &retrying_subscriptions,
                                &receive_remote_audio,
                                &active,
                                &local_identity,
                                ended,
                            );
                            continue;
                        }
                        None
                    }
                };
                let Some(event) = event else { break };
                match event {
                    RoomEvent::Connected {
                        participants_with_tracks,
                    } => {
                        // Everyone in this snapshot was here before us: no cue for them.
                        let present = audio_peers(
                            participants_with_tracks
                                .iter()
                                .map(|(participant, _)| participant.identity().0),
                            &local_identity,
                        );
                        if let Ok(mut presence) = presence.lock() {
                            presence.connected(present, Instant::now());
                        }
                        // LiveKit emits `Connected` while it is still completing its initial
                        // participant/track dispatch. Calling `set_subscribed` inline can make
                        // the subscription callback re-enter that dispatch, leaving callback
                        // work on the stack while the initial room event is still active.
                        //
                        // Move the initial subscription pass onto the next runtime turn. Later
                        // `TrackPublished` events remain idempotent, so racing a publication
                        // with this snapshot is safe.
                        let subscription_app = app.clone();
                        let subscription_shared = Arc::clone(&shared);
                        let subscription_room = Arc::clone(&room);
                        let subscription_readers = Arc::clone(&readers);
                        let subscription_receive_remote_audio = Arc::clone(&receive_remote_audio);
                        let subscription_local_identity = local_identity.clone();
                        runtime_handle.spawn(async move {
                            tokio::task::yield_now().await;
                            let receiving =
                                subscription_receive_remote_audio.load(Ordering::SeqCst);
                            for (participant, publications) in participants_with_tracks {
                                for publication in publications {
                                    reconcile_remote_publication(
                                        &publication,
                                        &participant,
                                        &subscription_local_identity,
                                        receiving,
                                    );
                                }
                            }
                            update_receive_health(
                                &subscription_app,
                                &subscription_shared,
                                &subscription_room,
                                &subscription_readers,
                                &subscription_local_identity,
                                receiving,
                                None,
                            );
                        });
                    }
                    RoomEvent::TrackPublished {
                        publication,
                        participant,
                    } => {
                        reconcile_remote_publication(
                            &publication,
                            &participant,
                            &local_identity,
                            receive_remote_audio.load(Ordering::SeqCst),
                        );
                        update_receive_health(
                            &app,
                            &shared,
                            &room,
                            &readers,
                            &local_identity,
                            receive_remote_audio.load(Ordering::SeqCst),
                            None,
                        );
                    }
                    RoomEvent::TrackMuted {
                        participant,
                        publication,
                    } => {
                        update_remote_track_mute_state(
                            &app,
                            &shared,
                            &participant,
                            &publication,
                            true,
                        );
                    }
                    RoomEvent::TrackUnmuted {
                        participant,
                        publication,
                    } => {
                        update_remote_track_mute_state(
                            &app,
                            &shared,
                            &participant,
                            &publication,
                            false,
                        );
                    }
                    RoomEvent::TrackSubscribed {
                        track,
                        publication,
                        participant,
                    } => {
                        let RemoteTrack::Audio(audio_track) = track else {
                            continue;
                        };
                        if !receive_remote_audio.load(Ordering::SeqCst) {
                            publication.set_subscribed(false);
                            continue;
                        }
                        let name = publication.name();
                        let Some(uuid) = name.strip_prefix("raven-audio-") else {
                            continue; // not a Raven-managed audio track
                        };
                        let identity = participant.identity().0;
                        let base = identity
                            .strip_suffix("#audio")
                            .unwrap_or(&identity)
                            .to_string();
                        let (Some(participant_id), Some(track_id), Some(source_id)) = (
                            ParticipantId::parse(&base),
                            PublishedTrackId::parse(uuid),
                            AudioSourceId::parse(uuid),
                        ) else {
                            continue;
                        };
                        // Prefer the owner-shared metadata (precise type + human name);
                        // fall back to the coarse LiveKit source + the participant name.
                        let shared_meta = parse_shared_meta(&participant.metadata());
                        let track_meta = shared_meta.get(uuid);
                        let owner_name = participant.name();
                        let source_type = track_meta
                            .map(|meta| meta.source_type.clone())
                            .unwrap_or_else(|| audio_source_from_lk(publication.source()));
                        let display_name = track_meta
                            .map(|meta| meta.display_name.clone())
                            .filter(|name| !name.is_empty())
                            .unwrap_or_else(|| {
                                if owner_name.is_empty() {
                                    base.clone()
                                } else {
                                    owner_name.clone()
                                }
                            });
                        let device_name = track_meta.and_then(|meta| meta.device_name.clone());
                        let app_name = track_meta.and_then(|meta| meta.app_name.clone());
                        let app_exe_name = track_meta.and_then(|meta| meta.app_exe_name.clone());
                        let app_icon_data_url =
                            track_meta.and_then(|meta| meta.app_icon_data_url.clone());

                        let microphone = source_type == AudioSourceType::Microphone;
                        register_remote_track(
                            &app,
                            &shared,
                            source_id,
                            participant_id,
                            track_id,
                            source_type,
                            display_name,
                            device_name,
                            app_name,
                            app_exe_name,
                            app_icon_data_url,
                            name.clone(),
                            publication.is_muted(),
                            owner_name,
                        );

                        let key = reader_key(&base, &track_id.to_string());
                        output.ensure_track(&key);
                        let rtc_track = audio_track.rtc_track();
                        let mut rate = output.sample_rate();
                        let mut stream = NativeAudioStream::new(
                            rtc_track.clone(),
                            rate as i32,
                            PUBLISH_CHANNELS as i32,
                        );
                        let reader_output = Arc::clone(&output);
                        let reader_shared = Arc::clone(&shared);
                        let reader_app = app.clone();
                        let reader_key_str = key.clone();
                        let reader_ended_sender = reader_ended_sender.clone();
                        // Decoding stays on the async runtime; the per-track DSP (cleanup, speech
                        // detection, the chain) runs on its own thread so it never occupies a tokio
                        // worker that LiveKit's event loops and video tasks also need.
                        let (frames_tx, frames_rx) =
                            std::sync::mpsc::sync_channel::<ReceivedFrame>(RECEIVE_QUEUE_FRAMES);
                        let reader_state = Arc::new(AtomicU8::new(READER_RUNNING));
                        let dsp_state = Arc::clone(&reader_state);
                        let dsp_spawned = std::thread::Builder::new()
                            .name(format!("raven-audio-rx-{key}"))
                            .spawn(move || {
                                let mut meter_accum: Vec<f32> = Vec::new();
                                let mut input_level = LevelAccumulator::default();
                                let mut last_meter = Instant::now();
                                let mut receiver_controls = ReceiverControls::default();
                                let mut last_control_refresh =
                                    Instant::now() - RECEIVER_CONTROL_REFRESH_INTERVAL;
                                // This peer's own processor chain for the incoming track. Setting
                                // edits are applied in place; only a different set of processors
                                // rebuilds it. Applied locally — it never affects other peers.
                                let mut chain: Option<ProcessorChainRuntime> = None;
                                let mut chain_def = ProcessorChainState::default();
                                // Set when a fresh snapshot arrives: the only time the chain
                                // definition can change, so it is not compared every frame.
                                let mut controls_refreshed = false;
                                // Reused for every frame instead of a new allocation.
                                let mut samples: Vec<f32> = Vec::new();
                                // Receiver gain actually applied to the previous sample.
                                let mut applied_gain: Option<f32> = None;
                                // Speech detection and noise cleanup are for microphones only:
                                // cleaning music or an app's sound would eat it. The cleanup
                                // stage does nothing until the listener turns it on, and
                                // switching it fades, so it never clicks.
                                let mut voice =
                                    microphone.then(|| VoiceDetector::new(rate, PUBLISH_CHANNELS));
                                // What Auto-level measures: speech loudness as sent, before
                                // this listener's fader.
                                let mut loudness = microphone
                                    .then(|| SpeechLoudnessMeter::new(rate, PUBLISH_CHANNELS));
                                let mut cleanup = microphone
                                    .then(|| SuppressorStage::new(None, rate, PUBLISH_CHANNELS));
                                let mut cleanup_on = false;
                                while let Ok(ReceivedFrame {
                                    rate: frame_rate,
                                    data,
                                }) = frames_rx.recv()
                                {
                                    if dsp_state.load(Ordering::Acquire) == READER_CANCELLED {
                                        // Replaced or torn down: the key may belong to a new
                                        // reader already, so push nothing more under it.
                                        return;
                                    }
                                    // Produced for the previous speaker rate; the bus moved on.
                                    if frame_rate != reader_output.sample_rate() {
                                        continue;
                                    }
                                    // The speaker was reopened at another sample rate (device
                                    // switch): the async side asked WebRTC for the new rate, so
                                    // start this track's state over at it.
                                    if frame_rate != rate {
                                        rate = frame_rate;
                                        reader_output.reset_track(&reader_key_str);
                                        chain = None;
                                        voice = microphone
                                            .then(|| VoiceDetector::new(rate, PUBLISH_CHANNELS));
                                        loudness = microphone.then(|| {
                                            SpeechLoudnessMeter::new(rate, PUBLISH_CHANNELS)
                                        });
                                        cleanup = microphone.then(|| {
                                            SuppressorStage::new(None, rate, PUBLISH_CHANNELS)
                                        });
                                        cleanup_on = false;
                                        meter_accum.clear();
                                    }
                                    if last_control_refresh.elapsed()
                                        >= RECEIVER_CONTROL_REFRESH_INTERVAL
                                    {
                                        if let Some(snapshot) = try_receiver_snapshot(
                                            &reader_shared,
                                            participant_id,
                                            track_id,
                                        ) {
                                            receiver_controls = snapshot;
                                            controls_refreshed = true;
                                        }
                                        last_control_refresh = Instant::now();
                                    }
                                    let ReceiverControls {
                                        gain,
                                        muted,
                                        noise_cleanup,
                                        noise_suppression_depth,
                                        ..
                                    } = receiver_controls;
                                    let target_gain = if muted { 0.0 } else { gain };
                                    let mut current_gain = applied_gain.unwrap_or(target_gain);
                                    let gain_step =
                                        RECEIVER_GAIN_SLEW_PER_MS * 1000.0 / rate.max(1) as f32;
                                    samples.clear();
                                    samples
                                        .extend(data.iter().map(|sample| *sample as f32 / 32768.0));
                                    for sample in &samples {
                                        input_level.add(*sample);
                                    }
                                    // Both look at what was received, before this listener's
                                    // gain and mute, so neither depends on them.
                                    if let Some(voice) = voice.as_mut() {
                                        voice.process(&samples);
                                    }
                                    if let Some(loudness) = loudness.as_mut() {
                                        loudness.process(&samples);
                                    }
                                    if let Some(stage) = cleanup.as_mut() {
                                        if noise_cleanup != cleanup_on && !stage.is_switching() {
                                            let suppressor = if noise_cleanup {
                                                new_suppressor(
                                                    NoiseSuppressionMode::Strong,
                                                    noise_suppression_depth,
                                                )
                                            } else {
                                                None
                                            };
                                            stage.switch(suppressor);
                                            cleanup_on = noise_cleanup;
                                        }
                                        stage.set_depth(noise_suppression_depth);
                                        if let Err(error) = stage.process(&mut samples) {
                                            // Better to hear this person as they come in than
                                            // to lose them.
                                            eprintln!(
                                                "[audio-engine] noise cleanup stopped: {error}"
                                            );
                                            stage.bypass();
                                        }
                                    }
                                    for stereo in samples.chunks_mut(PUBLISH_CHANNELS) {
                                        current_gain = if current_gain < target_gain {
                                            (current_gain + gain_step).min(target_gain)
                                        } else {
                                            (current_gain - gain_step).max(target_gain)
                                        };
                                        for sample in stereo {
                                            *sample *= current_gain;
                                        }
                                    }
                                    applied_gain = Some(current_gain);

                                    let chain_changed = std::mem::take(&mut controls_refreshed)
                                        && receiver_controls.chain != chain_def;
                                    if chain.is_none() || chain_changed {
                                        let def = &receiver_controls.chain;
                                        // A changed setting is applied in place so the filters
                                        // and envelopes carry on; only a different set of
                                        // processors builds a new chain.
                                        let synced = chain
                                            .as_mut()
                                            .is_some_and(|runtime| runtime.sync_state(def));
                                        if !synced {
                                            chain = ProcessorChainRuntime::from_state(def).ok();
                                            if let Some(runtime) = chain.as_mut() {
                                                let _ = runtime.prepare(
                                                    AudioProcessorPrepareConfig::new(
                                                        rate,
                                                        PUBLISH_CHANNELS,
                                                        RECEIVER_MAX_BLOCK,
                                                    ),
                                                );
                                            }
                                        }
                                        chain_def = def.clone();
                                    }
                                    if let Some(runtime) = chain.as_mut() {
                                        if let Ok(mut audio) = AudioBuffer::from_interleaved(
                                            PUBLISH_CHANNELS,
                                            std::mem::take(&mut samples),
                                        ) {
                                            let _ = runtime.process(&mut audio);
                                            samples = audio.into_samples();
                                        }
                                    }

                                    reader_output.push(&reader_key_str, &samples);
                                    // Meter exactly what we play out so the Incoming Tracks strip
                                    // tracks the received signal (post receiver gain / chain / mute).
                                    meter_accum.extend_from_slice(&samples);
                                    if last_meter.elapsed() >= METER_INTERVAL {
                                        let meter = meter_samples(&meter_accum);
                                        update_remote_meter(
                                            &reader_app,
                                            &reader_shared,
                                            participant_id,
                                            track_id,
                                            meter,
                                            input_level.take(),
                                            voice.as_mut().map(VoiceDetector::take_probability),
                                            loudness.as_mut().map(|meter| SpeechWindow {
                                                loudness_db: meter.take(),
                                                duration: last_meter.elapsed(),
                                            }),
                                        );
                                        meter_accum.clear();
                                        last_meter = Instant::now();
                                    }
                                }
                                if dsp_state.load(Ordering::Acquire) != READER_ENDED {
                                    return;
                                }
                                reader_output.remove_track(&reader_key_str);
                                let _ = reader_ended_sender.send(ReaderEnded {
                                    participant_id,
                                    track_id,
                                    key: reader_key_str,
                                });
                            });
                        if let Err(error) = dsp_spawned {
                            eprintln!("[audio-engine] receive thread could not start: {error}");
                        }
                        let stream_output = Arc::clone(&output);
                        let reader = runtime_handle.spawn(async move {
                            // Aborting this task (leave, replace, unsubscribe) drops the
                            // guard, which tells the DSP thread to stop without cleanup.
                            let _cancel = ReaderCancelGuard(Arc::clone(&reader_state));
                            let mut stream_rate = rate;
                            while let Some(frame) = stream.next().await {
                                // The speaker was reopened at another sample rate (device
                                // switch): ask WebRTC to resample this track to the new
                                // rate instead of playing it at the wrong pitch.
                                let bus_rate = stream_output.sample_rate();
                                if bus_rate != stream_rate {
                                    stream_rate = bus_rate;
                                    stream = NativeAudioStream::new(
                                        rtc_track.clone(),
                                        stream_rate as i32,
                                        PUBLISH_CHANNELS as i32,
                                    );
                                    continue;
                                }
                                // A DSP thread that falls behind loses frames rather than
                                // building latency (the playout buffer conceals the gap).
                                match frames_tx.try_send(ReceivedFrame {
                                    rate: stream_rate,
                                    data: frame.data.into_owned(),
                                }) {
                                    Ok(()) | Err(std::sync::mpsc::TrySendError::Full(_)) => {}
                                    Err(std::sync::mpsc::TrySendError::Disconnected(_)) => break,
                                }
                            }
                            reader_state.store(READER_ENDED, Ordering::Release);
                        });
                        if let Some(existing) = readers.lock().unwrap().insert(key.clone(), reader)
                        {
                            existing.abort();
                        }
                        retrying_subscriptions.lock().unwrap().remove(&key);
                        update_receive_health(
                            &app,
                            &shared,
                            &room,
                            &readers,
                            &local_identity,
                            receive_remote_audio.load(Ordering::SeqCst),
                            None,
                        );
                    }
                    RoomEvent::TrackUnsubscribed {
                        publication,
                        participant,
                        ..
                    } => {
                        let name = publication.name();
                        let Some(uuid) = name.strip_prefix("raven-audio-") else {
                            continue;
                        };
                        let identity = participant.identity().0;
                        let base = identity
                            .strip_suffix("#audio")
                            .unwrap_or(&identity)
                            .to_string();
                        if let (Some(participant_id), Some(track_id)) =
                            (ParticipantId::parse(&base), PublishedTrackId::parse(uuid))
                        {
                            let key = reader_key(&base, &track_id.to_string());
                            if let Some(reader) = readers.lock().unwrap().remove(&key) {
                                reader.abort();
                            }
                            output.remove_track(&key);
                            unregister_remote_track(&app, &shared, participant_id, track_id);
                            update_receive_health(
                                &app,
                                &shared,
                                &room,
                                &readers,
                                &local_identity,
                                receive_remote_audio.load(Ordering::SeqCst),
                                None,
                            );
                        }
                    }
                    RoomEvent::TrackSubscriptionFailed {
                        participant,
                        track_sid,
                        error,
                    } => {
                        if let Some(publication) = participant.track_publications().get(&track_sid)
                        {
                            schedule_subscription_retry(
                                &app,
                                &shared,
                                publication.clone(),
                                participant,
                                &retrying_subscriptions,
                                Arc::clone(&receive_remote_audio),
                                Arc::clone(&active),
                                local_identity.clone(),
                                format!("Incoming audio subscription failed: {error}"),
                            );
                        }
                    }
                    RoomEvent::ParticipantConnected(participant) => {
                        let identity = participant.identity().0;
                        if let Some(peer) = audio_peer_identity(&identity, &local_identity) {
                            let cue = presence
                                .lock()
                                .ok()
                                .and_then(|mut presence| presence.arrived(&peer, Instant::now()));
                            if let Some(cue) = cue {
                                let _ = output.play_cue(cue);
                            }
                        }
                    }
                    RoomEvent::ParticipantDisconnected(participant) => {
                        let identity = participant.identity().0;
                        if let Some(peer) = audio_peer_identity(&identity, &local_identity) {
                            let token = presence
                                .lock()
                                .ok()
                                .and_then(|mut presence| presence.departed(&peer));
                            if let Some(token) = token {
                                schedule_leave_cue(
                                    &runtime_handle,
                                    &presence,
                                    &output,
                                    &active,
                                    peer,
                                    token,
                                );
                            }
                        }
                        let base = identity
                            .strip_suffix("#audio")
                            .unwrap_or(&identity)
                            .to_string();
                        if let Some(participant_id) = ParticipantId::parse(&base) {
                            let prefix = format!("{base}|");
                            let removed: Vec<String> = readers
                                .lock()
                                .unwrap()
                                .keys()
                                .filter(|key| key.starts_with(&prefix))
                                .cloned()
                                .collect();
                            for key in removed {
                                if let Some(reader) = readers.lock().unwrap().remove(&key) {
                                    reader.abort();
                                }
                                output.remove_track(&key);
                            }
                            unregister_participant(&app, &shared, participant_id);
                            update_receive_health(
                                &app,
                                &shared,
                                &room,
                                &readers,
                                &local_identity,
                                receive_remote_audio.load(Ordering::SeqCst),
                                None,
                            );
                        }
                    }
                    RoomEvent::Reconnecting => {
                        if let Ok(mut presence) = presence.lock() {
                            presence.reconnecting();
                        }
                        update_connection_health(
                            &app,
                            &shared,
                            AudioConnectionStatus::Reconnecting,
                            None,
                        );
                    }
                    RoomEvent::Reconnected => {
                        let present = audio_peers(
                            room.remote_participants()
                                .values()
                                .map(|participant| participant.identity().0),
                            &local_identity,
                        );
                        if let Ok(mut presence) = presence.lock() {
                            presence.reconnected(present, Instant::now());
                        }
                        // A full reconnect republishes local tracks inside the SDK; if any
                        // of that failed, a reconcile pass publishes the missing ones.
                        let resync_app = app.clone();
                        let resync_shared = Arc::clone(&shared);
                        // A full reconnect joins again, so what LiveKit allows may have changed.
                        let limits = server_voice_limits(&room.local_participant());
                        runtime_handle.spawn(async move {
                            crate::audio::state::apply_server_voice_limits(
                                &resync_app,
                                &resync_shared,
                                limits,
                            )
                            .await;
                            crate::audio::state::resync_media(&resync_app, &resync_shared).await;
                        });
                        // A full reconnect rebuilds the peers from the join response, and the
                        // SDK sends their subscribe requests down the old session, which drops
                        // them. Each then reads as wanted with no track, so a reconcile alone
                        // would send nothing: ask again for those.
                        let receiving = receive_remote_audio.load(Ordering::SeqCst);
                        for participant in room.remote_participants().values() {
                            for publication in participant.track_publications().values() {
                                let wanted = reconcile_remote_publication(
                                    publication,
                                    participant,
                                    &local_identity,
                                    receiving,
                                );
                                if wanted && !publication.is_subscribed() {
                                    schedule_subscription_retry(
                                        &app,
                                        &shared,
                                        publication.clone(),
                                        participant.clone(),
                                        &retrying_subscriptions,
                                        Arc::clone(&receive_remote_audio),
                                        Arc::clone(&active),
                                        local_identity.clone(),
                                        "Restoring incoming audio after reconnecting.".to_string(),
                                    );
                                }
                            }
                        }
                        update_connection_health(
                            &app,
                            &shared,
                            AudioConnectionStatus::Connected,
                            None,
                        );
                        update_receive_health(
                            &app,
                            &shared,
                            &room,
                            &readers,
                            &local_identity,
                            receive_remote_audio.load(Ordering::SeqCst),
                            None,
                        );
                    }
                    RoomEvent::Disconnected { reason } => {
                        if reason == DisconnectReason::ClientInitiated {
                            // Our own leave; the command that asked resets the session.
                            break;
                        }
                        // LiveKit has exhausted its own reconnect attempts, or the server
                        // removed this participant. Nothing will arrive on these tracks
                        // again: stop the readers and report why, so the app can decide
                        // whether rejoining with a fresh token is appropriate.
                        for (key, reader) in readers.lock().unwrap().drain() {
                            reader.abort();
                            output.remove_track(&key);
                        }
                        report_connection_lost(&app, &shared, reason);
                        break;
                    }
                    RoomEvent::ParticipantPermissionChanged {
                        participant: Participant::Local(local),
                        ..
                    } => {
                        let limits_app = app.clone();
                        let limits_shared = Arc::clone(&shared);
                        let limits = server_voice_limits(&local);
                        runtime_handle.spawn(async move {
                            crate::audio::state::apply_server_voice_limits(
                                &limits_app,
                                &limits_shared,
                                limits,
                            )
                            .await;
                        });
                    }
                    RoomEvent::ParticipantMetadataChanged {
                        participant,
                        metadata,
                        ..
                    } => {
                        // A peer (re)published its shared track metadata; enrich any of their
                        // already-subscribed tracks and refresh the group's display name.
                        let identity = participant.identity().0;
                        let base = identity
                            .strip_suffix("#audio")
                            .unwrap_or(&identity)
                            .to_string();
                        if let Some(participant_id) = ParticipantId::parse(&base) {
                            apply_participant_metadata(
                                &app,
                                &shared,
                                participant_id,
                                participant.name(),
                                &parse_shared_meta(&metadata),
                            );
                        }
                    }
                    _ => {}
                }
            }
        })
    }
}

/// Forward 10 ms frames from the capture thread to the LiveKit source. While the source
/// is producing audio this adds no buffering; when it falls silent the gap is filled with
/// silence in step with the wall clock, so receivers see an unbroken stream instead of a
/// burst of "late" packets when audio resumes.
async fn drain_published_audio(native: NativeAudioSource, mut receiver: mpsc::Receiver<Vec<i16>>) {
    let frame_duration = Duration::from_millis(10);
    let mut last_frame_at = Instant::now();
    loop {
        match tokio::time::timeout(PUBLISH_IDLE_AFTER, receiver.recv()).await {
            Ok(Some(samples)) => {
                last_frame_at = Instant::now();
                if !capture_publish_frame(&native, samples).await {
                    break;
                }
            }
            Ok(None) => break,
            Err(_) => {
                // Catch up to "now", leaving a short margin so real audio that is about to
                // arrive is not pushed behind padding. Capped so a suspended machine does
                // not replay a long stretch of silence.
                let behind = last_frame_at.elapsed().saturating_sub(frame_duration * 2);
                let missing = (behind.as_millis() / frame_duration.as_millis()).min(10) as u32;
                for _ in 0..missing {
                    if !capture_publish_frame(&native, vec![0; PUBLISH_FRAME_SAMPLES]).await {
                        return;
                    }
                }
                last_frame_at += frame_duration * missing;
                if last_frame_at.elapsed() > Duration::from_millis(500) {
                    last_frame_at = Instant::now();
                }
            }
        }
    }
}

async fn capture_publish_frame(native: &NativeAudioSource, samples: Vec<i16>) -> bool {
    let frame = AudioFrame {
        samples_per_channel: (samples.len() / PUBLISH_CHANNELS) as u32,
        data: samples.into(),
        sample_rate: PUBLISH_SAMPLE_RATE,
        num_channels: PUBLISH_CHANNELS as u32,
    };
    native.capture_frame(&frame).await.is_ok()
}

fn is_eligible_remote_publication(
    publication: &RemoteTrackPublication,
    participant: &RemoteParticipant,
    local_identity: &str,
) -> bool {
    desired_remote_audio_subscription(
        local_identity,
        &participant.identity().0,
        &publication.name(),
        publication.kind(),
        true,
    )
}

fn desired_remote_audio_subscription(
    local_identity: &str,
    remote_identity: &str,
    track_name: &str,
    kind: TrackKind,
    receiving: bool,
) -> bool {
    receiving
        && kind == TrackKind::Audio
        && track_name.starts_with("raven-audio-")
        && base_participant_identity(remote_identity) != local_identity
}

/// What LiveKit has taken from this connection. LiveKit is the authority: this holds however
/// the limit arrived, in the token or as a live change. An unknown permission limits nothing.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ServerVoiceLimits {
    pub publish_revoked: bool,
    pub subscribe_revoked: bool,
}

impl ServerVoiceLimits {
    fn from_grants(can_publish: bool, can_subscribe: bool) -> Self {
        Self {
            publish_revoked: !can_publish,
            subscribe_revoked: !can_subscribe,
        }
    }
}

pub(crate) fn server_voice_limits(local: &LocalParticipant) -> ServerVoiceLimits {
    local
        .permission()
        .map(|permission| {
            ServerVoiceLimits::from_grants(permission.can_publish, permission.can_subscribe)
        })
        .unwrap_or_default()
}

fn reconcile_remote_publication(
    publication: &RemoteTrackPublication,
    participant: &RemoteParticipant,
    local_identity: &str,
    receive_remote_audio: bool,
) -> bool {
    let should_subscribe = receive_remote_audio
        && is_eligible_remote_publication(publication, participant, local_identity);
    if publication.is_desired() != should_subscribe {
        publication.set_subscribed(should_subscribe);
    }
    should_subscribe
}

fn remote_publication_ids(
    publication: &RemoteTrackPublication,
    participant: &RemoteParticipant,
) -> Option<(ParticipantId, PublishedTrackId, String)> {
    let publication_name = publication.name();
    let uuid = publication_name.strip_prefix("raven-audio-")?;
    let base = base_participant_identity(&participant.identity().0).to_string();
    Some((
        ParticipantId::parse(&base)?,
        PublishedTrackId::parse(uuid)?,
        reader_key(&base, uuid),
    ))
}

#[allow(clippy::too_many_arguments)]
fn schedule_subscription_retry(
    app: &AppHandle,
    shared: &SharedAudioEngineState,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
    retrying: &Arc<Mutex<HashSet<String>>>,
    receive_remote_audio: Arc<AtomicBool>,
    active: Arc<AtomicBool>,
    local_identity: String,
    initial_error: String,
) {
    let Some((participant_id, track_id, key)) = remote_publication_ids(&publication, &participant)
    else {
        return;
    };
    if !is_eligible_remote_publication(&publication, &participant, &local_identity) {
        return;
    }
    if !retrying.lock().unwrap().insert(key.clone()) {
        return;
    }
    update_remote_subscription_status(
        app,
        shared,
        participant_id,
        track_id,
        AudioSubscriptionStatus::Recovering,
        Some(initial_error),
    );

    let app = app.clone();
    let shared = Arc::clone(shared);
    let retrying = Arc::clone(retrying);
    tokio::spawn(async move {
        let mut last_error = "Incoming audio could not be restored.".to_string();
        for delay in RECOVERY_DELAYS {
            if !active.load(Ordering::SeqCst) || !receive_remote_audio.load(Ordering::SeqCst) {
                retrying.lock().unwrap().remove(&key);
                return;
            }
            if !retrying.lock().unwrap().contains(&key) {
                return;
            }
            if !participant
                .track_publications()
                .contains_key(&publication.sid())
            {
                retrying.lock().unwrap().remove(&key);
                return;
            }
            publication.set_subscribed(false);
            tokio::time::sleep(Duration::from_millis(50)).await;
            publication.set_subscribed(true);
            tokio::time::sleep(delay).await;
            if publication.is_subscribed() {
                retrying.lock().unwrap().remove(&key);
                return;
            }
            last_error = format!(
                "Incoming audio from {} is still unavailable.",
                participant.name()
            );
        }
        retrying.lock().unwrap().remove(&key);
        update_remote_subscription_status(
            &app,
            &shared,
            participant_id,
            track_id,
            AudioSubscriptionStatus::Failed,
            Some(last_error),
        );
    });
}

#[allow(clippy::too_many_arguments)]
fn handle_reader_ended(
    app: &AppHandle,
    shared: &SharedAudioEngineState,
    room: &Room,
    readers: &Arc<Mutex<HashMap<String, JoinHandle<()>>>>,
    retrying: &Arc<Mutex<HashSet<String>>>,
    receive_remote_audio: &Arc<AtomicBool>,
    active: &Arc<AtomicBool>,
    local_identity: &str,
    ended: ReaderEnded,
) {
    readers.lock().unwrap().remove(&ended.key);
    if !active.load(Ordering::SeqCst) || !receive_remote_audio.load(Ordering::SeqCst) {
        return;
    }
    update_remote_subscription_status(
        app,
        shared,
        ended.participant_id,
        ended.track_id,
        AudioSubscriptionStatus::Recovering,
        Some("Incoming audio stopped and Raven is restoring it.".to_string()),
    );
    let track_name = format!("raven-audio-{}", ended.track_id);
    for participant in room.remote_participants().values() {
        if base_participant_identity(&participant.identity().0) == local_identity {
            continue;
        }
        if let Some(publication) = participant
            .track_publications()
            .values()
            .find(|publication| publication.name() == track_name)
        {
            schedule_subscription_retry(
                app,
                shared,
                publication.clone(),
                participant.clone(),
                retrying,
                Arc::clone(receive_remote_audio),
                Arc::clone(active),
                local_identity.to_string(),
                "Incoming audio stream ended unexpectedly.".to_string(),
            );
            break;
        }
    }
}

fn update_remote_subscription_status(
    app: &AppHandle,
    shared: &SharedAudioEngineState,
    participant_id: ParticipantId,
    track_id: PublishedTrackId,
    status: AudioSubscriptionStatus,
    error: Option<String>,
) {
    let snapshot = {
        let Ok(mut guard) = shared.write() else {
            return;
        };
        let failed = status == AudioSubscriptionStatus::Failed;
        guard.set_remote_track_subscription_status(participant_id, track_id, status);
        if failed {
            guard.mixer.session.error = error;
        }
        guard.snapshot()
    };
    let _ = app.emit(AUDIO_STATE_CHANGED_EVENT, snapshot);
}

/// How a lost connection is described to the app, and whether rejoining may fix it.
pub(crate) fn describe_disconnect(reason: DisconnectReason) -> (&'static str, &'static str, bool) {
    match reason {
        DisconnectReason::DuplicateIdentity => (
            "duplicateIdentity",
            "You joined this room from another Raven app, so this one left it.",
            false,
        ),
        DisconnectReason::ParticipantRemoved => (
            "participantRemoved",
            "You were removed from this room.",
            false,
        ),
        DisconnectReason::RoomDeleted | DisconnectReason::RoomClosed => {
            ("roomClosed", "This room was closed.", false)
        }
        DisconnectReason::ServerShutdown => (
            "serverShutdown",
            "The realtime server restarted. Reconnecting…",
            true,
        ),
        _ => (
            "connectionLost",
            "Raven lost the realtime audio connection. Reconnecting…",
            true,
        ),
    }
}

fn report_connection_lost(
    app: &AppHandle,
    shared: &SharedAudioEngineState,
    reason: DisconnectReason,
) {
    let (code, message, recoverable) = describe_disconnect(reason);
    let snapshot = {
        let Ok(mut guard) = shared.write() else {
            return;
        };
        guard.clear_remote_tracks();
        let session = &mut guard.mixer.session;
        session.connection_status = AudioConnectionStatus::Error;
        session.error = Some(message.to_string());
        session.eligible_remote_track_count = 0;
        session.active_remote_track_count = 0;
        session.connection_lost = Some(AudioConnectionLoss {
            reason: code.to_string(),
            recoverable,
        });
        guard.snapshot()
    };
    let _ = app.emit(AUDIO_STATE_CHANGED_EVENT, snapshot);
}

fn update_connection_health(
    app: &AppHandle,
    shared: &SharedAudioEngineState,
    status: AudioConnectionStatus,
    error: Option<String>,
) {
    let snapshot = {
        let Ok(mut guard) = shared.write() else {
            return;
        };
        guard.mixer.session.connection_status = status;
        guard.mixer.session.error = error;
        guard.snapshot()
    };
    let _ = app.emit(AUDIO_STATE_CHANGED_EVENT, snapshot);
}

fn update_receive_health(
    app: &AppHandle,
    shared: &SharedAudioEngineState,
    room: &Room,
    readers: &Arc<Mutex<HashMap<String, JoinHandle<()>>>>,
    local_identity: &str,
    receive_remote_audio: bool,
    error: Option<String>,
) {
    let eligible = if receive_remote_audio {
        room.remote_participants()
            .values()
            .map(|participant| {
                participant
                    .track_publications()
                    .values()
                    .filter(|publication| {
                        is_eligible_remote_publication(publication, participant, local_identity)
                    })
                    .count()
            })
            .sum()
    } else {
        0
    };
    let active = readers.lock().map(|readers| readers.len()).unwrap_or(0);
    let snapshot = {
        let Ok(mut guard) = shared.write() else {
            return;
        };
        guard.mixer.session.eligible_remote_track_count = eligible;
        guard.mixer.session.active_remote_track_count = active;
        if let Some(error) = error {
            guard.mixer.session.error = Some(error);
        } else if eligible == active
            && guard.mixer.session.connection_status == AudioConnectionStatus::Connected
        {
            guard.mixer.session.error = None;
        }
        guard.snapshot()
    };
    let _ = app.emit(AUDIO_STATE_CHANGED_EVENT, snapshot);
}

fn apply_participant_metadata(
    app: &AppHandle,
    shared: &SharedAudioEngineState,
    participant_id: ParticipantId,
    owner_name: String,
    meta: &HashMap<String, SharedTrackMeta>,
) {
    let snapshot = {
        let Ok(mut guard) = shared.write() else {
            return;
        };
        guard.set_remote_owner_name(participant_id, owner_name);
        for (uuid, track_meta) in meta {
            if let Some(track_id) = PublishedTrackId::parse(uuid) {
                guard.update_remote_track_meta(
                    participant_id,
                    track_id,
                    track_meta.source_type.clone(),
                    track_meta.display_name.clone(),
                    track_meta.device_name.clone(),
                    track_meta.app_name.clone(),
                    track_meta.app_exe_name.clone(),
                    track_meta.app_icon_data_url.clone(),
                );
            }
        }
        guard.snapshot()
    };
    let _ = app.emit(AUDIO_STATE_CHANGED_EVENT, snapshot);
}

fn reader_key(base_identity: &str, track_id: &str) -> String {
    format!("{base_identity}|{track_id}")
}

/// The receiver's local settings for a remote track, local only to this peer.
#[derive(Clone)]
struct ReceiverControls {
    /// Linear gain.
    gain: f32,
    muted: bool,
    noise_cleanup: bool,
    /// How deep the cleanup goes: the depth chosen for this listener's own microphone.
    noise_suppression_depth: NoiseSuppressionDepth,
    chain: ProcessorChainState,
}

impl Default for ReceiverControls {
    fn default() -> Self {
        Self {
            gain: 1.0,
            muted: false,
            noise_cleanup: false,
            noise_suppression_depth: NoiseSuppressionDepth::default(),
            chain: ProcessorChainState::default(),
        }
    }
}

/// Snapshot the receiver's local settings for a remote track — each peer's own gain, mute,
/// noise cleanup and processor chain, applied *after* the publisher's chain and local only
/// to this peer.
fn try_receiver_snapshot(
    shared: &SharedAudioEngineState,
    participant_id: ParticipantId,
    track_id: PublishedTrackId,
) -> Option<ReceiverControls> {
    let Ok(guard) = shared.try_read() else {
        return None;
    };
    for track in &guard.mixer.remote_tracks {
        if track.track.participant_id == participant_id && track.track.track_id == track_id {
            let strip = &track.receiver_channel_strip;
            let noise_suppression_depth = guard
                .mixer
                .local_sources
                .iter()
                .find(|source| source.source_type == AudioSourceType::Microphone)
                .map(|source| {
                    source
                        .channel_strip
                        .webrtc_processing
                        .noise_suppression_depth
                })
                .unwrap_or_default();
            return Some(ReceiverControls {
                gain: db_to_linear(strip.gain_db),
                muted: strip.mute.muted,
                noise_cleanup: strip.noise_cleanup,
                noise_suppression_depth,
                chain: strip.processor_chain.clone(),
            });
        }
    }
    None
}

#[allow(clippy::too_many_arguments)]
fn register_remote_track(
    app: &AppHandle,
    shared: &SharedAudioEngineState,
    source_id: AudioSourceId,
    participant_id: ParticipantId,
    track_id: PublishedTrackId,
    source_type: AudioSourceType,
    display_name: String,
    device_name: Option<String>,
    app_name: Option<String>,
    app_exe_name: Option<String>,
    app_icon_data_url: Option<String>,
    webrtc_track_id: String,
    muted: bool,
    owner_name: String,
) {
    let snapshot = {
        let Ok(mut guard) = shared.write() else {
            return;
        };
        guard.set_remote_owner_name(participant_id, owner_name);
        let mut metadata =
            PublishedTrackMetadata::new(source_id, participant_id, source_type, display_name);
        metadata.track_id = track_id;
        metadata.device_name = device_name;
        metadata.app_name = app_name;
        metadata.app_exe_name = app_exe_name;
        metadata.app_icon_data_url = app_icon_data_url;
        metadata.webrtc_track_id = Some(webrtc_track_id);
        metadata.muted = muted;
        guard.add_or_update_remote_track(metadata);
        guard.snapshot()
    };
    let _ = app.emit(AUDIO_STATE_CHANGED_EVENT, snapshot);
}

fn unregister_remote_track(
    app: &AppHandle,
    shared: &SharedAudioEngineState,
    participant_id: ParticipantId,
    track_id: PublishedTrackId,
) {
    let snapshot = {
        let Ok(mut guard) = shared.write() else {
            return;
        };
        let _ = guard.remove_remote_track(participant_id, track_id);
        guard.snapshot()
    };
    let _ = app.emit(AUDIO_STATE_CHANGED_EVENT, snapshot);
}

fn unregister_participant(
    app: &AppHandle,
    shared: &SharedAudioEngineState,
    participant_id: ParticipantId,
) {
    let snapshot = {
        let Ok(mut guard) = shared.write() else {
            return;
        };
        guard.remove_remote_participant(participant_id);
        guard.snapshot()
    };
    let _ = app.emit(AUDIO_STATE_CHANGED_EVENT, snapshot);
}

#[allow(clippy::too_many_arguments)]
fn update_remote_meter(
    app: &AppHandle,
    shared: &SharedAudioEngineState,
    participant_id: ParticipantId,
    track_id: PublishedTrackId,
    meter: MeterState,
    input_meter: MeterState,
    voice_probability: Option<f32>,
    speech: Option<SpeechWindow>,
) {
    // The strip in the snapshot is best-effort; the event below is what drives the live
    // meters and speaking rings, so it is sent even if the state lock is busy. Auto-level
    // is statistics, so a window lost to a busy lock costs nothing.
    if let Ok(mut guard) = shared.try_write() {
        guard.set_remote_track_meter(participant_id, track_id, meter.clone());
        if let (Some(speech), Some(probability)) = (speech, voice_probability) {
            guard.observe_auto_level(
                participant_id,
                track_id,
                speech.loudness_db,
                probability,
                speech.duration,
                Instant::now(),
            );
        }
    }
    let mut update = AudioMeterUpdate::remote(participant_id, track_id, meter, input_meter);
    update.voice_probability = voice_probability;
    let _ = app.emit(AUDIO_METER_CHANGED_EVENT, update);
}

/// One meter window of a microphone's speech loudness, for Auto-level.
struct SpeechWindow {
    loudness_db: f32,
    duration: Duration,
}

/// Step Auto-level for as long as the room is up: move the faders it wants moved, tell
/// the UI, and save the volumes once a glide settles. It takes no `ops` lock and runs
/// no reconcile: the readers pick a fader up on their own.
async fn run_auto_level(app: AppHandle, shared: SharedAudioEngineState) {
    let mut ticker = tokio::time::interval(AUTO_LEVEL_STEP_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        let (snapshot, volumes) = {
            let Ok(mut guard) = shared.try_write() else {
                continue;
            };
            let step = guard.step_auto_level(Instant::now());
            (step.changed.then(|| guard.snapshot()), step.volumes_to_save)
        };
        if let Some(snapshot) = snapshot {
            let _ = app.emit(AUDIO_STATE_CHANGED_EVENT, snapshot);
        }
        if let Some(volumes) = volumes {
            let app = app.clone();
            tokio::task::spawn_blocking(move || save_remembered_volumes(&app, &volumes));
        }
    }
}

/// Running peak / RMS of a stream, read out once per meter interval without keeping the
/// samples.
#[derive(Default)]
struct LevelAccumulator {
    peak: f32,
    sum_squares: f64,
    count: usize,
}

impl LevelAccumulator {
    fn add(&mut self, sample: f32) {
        self.peak = self.peak.max(sample.abs());
        self.sum_squares += f64::from(sample) * f64::from(sample);
        self.count += 1;
    }

    fn take(&mut self) -> MeterState {
        let meter = if self.count == 0 {
            MeterState::default()
        } else {
            let rms = (self.sum_squares / self.count as f64).sqrt() as f32;
            MeterState {
                peak_db: linear_to_db(self.peak),
                rms_db: linear_to_db(rms),
                clipping: self.peak >= 1.0,
            }
        };
        *self = Self::default();
        meter
    }
}

fn update_remote_track_mute_state(
    app: &AppHandle,
    shared: &SharedAudioEngineState,
    participant: &Participant,
    publication: &TrackPublication,
    muted: bool,
) {
    if publication.kind() != TrackKind::Audio {
        return;
    }
    let publication_name = publication.name();
    let Some(uuid) = publication_name.strip_prefix("raven-audio-") else {
        return;
    };
    let identity = participant.identity();
    let base = base_participant_identity(&identity.0);
    let (Some(participant_id), Some(track_id)) =
        (ParticipantId::parse(base), PublishedTrackId::parse(uuid))
    else {
        return;
    };

    let snapshot = {
        let Ok(mut guard) = shared.write() else {
            return;
        };
        guard.set_remote_track_muted(participant_id, track_id, muted);
        guard.snapshot()
    };
    let _ = app.emit(AUDIO_STATE_CHANGED_EVENT, snapshot);
}

#[cfg(test)]
mod shared_meta_tests {
    use super::*;
    use crate::audio::domain::PublishedTrackMetadata;

    fn published(
        source_type: AudioSourceType,
        name: &str,
        icon: Option<String>,
    ) -> AudioSourceState {
        let mut source = AudioSourceState::new(ParticipantId::new(), source_type.clone(), name);
        source.publishing = true;
        source.app_exe_name = Some("EXCEL".to_string());
        source.app_icon_data_url = icon;
        source.published_track = Some(PublishedTrackMetadata::new(
            source.id,
            source.owner_id,
            source_type,
            name,
        ));
        source
    }

    fn icon(len: usize) -> String {
        let prefix = "data:image/png;base64,";
        format!("{prefix}{}", "A".repeat(len - prefix.len()))
    }

    #[test]
    fn app_tracks_share_name_exe_and_icon() {
        let source = published(AudioSourceType::AppAudio, "EXCEL", Some(icon(4_000)));
        let meta = shared_track_meta(std::slice::from_ref(&source));
        let json = encode_shared_meta(meta).expect("encode");
        let parsed = parse_shared_meta(&json);
        let entry = parsed.values().next().expect("one track");
        assert_eq!(entry.app_name.as_deref(), Some("EXCEL"));
        assert_eq!(entry.app_exe_name.as_deref(), Some("EXCEL"));
        assert_eq!(
            entry.app_icon_data_url.as_ref().map(String::len),
            Some(4_000)
        );
        // The wire keys stay camelCase.
        assert!(json.contains("\"appExeName\"") && json.contains("\"appIconDataUrl\""));
    }

    #[test]
    fn other_tracks_share_no_app_identity() {
        let source = published(AudioSourceType::Microphone, "Mic", Some(icon(100)));
        let meta = shared_track_meta(std::slice::from_ref(&source));
        let entry = meta.values().next().expect("one track");
        assert_eq!(entry.app_name, None);
        assert_eq!(entry.app_exe_name, None);
        assert_eq!(entry.app_icon_data_url, None);
    }

    #[test]
    fn oversized_icon_is_left_out() {
        let source = published(
            AudioSourceType::AppAudio,
            "EXCEL",
            Some(icon(MAX_SHARED_ICON_BYTES + 1)),
        );
        let meta = shared_track_meta(std::slice::from_ref(&source));
        let entry = meta.values().next().expect("one track");
        assert_eq!(entry.app_icon_data_url, None);
        assert_eq!(entry.app_exe_name.as_deref(), Some("EXCEL"));
    }

    #[test]
    fn icons_are_dropped_when_the_whole_metadata_is_too_big() {
        let sources: Vec<_> = (0..6)
            .map(|_| {
                published(
                    AudioSourceType::AppAudio,
                    "EXCEL",
                    Some(icon(MAX_SHARED_ICON_BYTES)),
                )
            })
            .collect();
        let json = encode_shared_meta(shared_track_meta(&sources)).expect("encode");
        assert!(json.len() <= MAX_SHARED_META_BYTES);
        let parsed = parse_shared_meta(&json);
        assert_eq!(parsed.len(), 6);
        assert!(parsed
            .values()
            .all(|entry| entry.app_icon_data_url.is_none()
                && entry.app_name.as_deref() == Some("EXCEL")));
    }
}

#[cfg(test)]
mod round_trip_tests {
    use super::*;
    use livekit::webrtc::stats::CandidatePairStats;

    #[test]
    fn server_limits_follow_the_grants() {
        assert_eq!(
            ServerVoiceLimits::from_grants(true, true),
            ServerVoiceLimits::default()
        );
        let muted = ServerVoiceLimits::from_grants(false, true);
        assert!(muted.publish_revoked && !muted.subscribe_revoked);
        let deafened = ServerVoiceLimits::from_grants(false, false);
        assert!(deafened.publish_revoked && deafened.subscribe_revoked);
    }

    fn pair(nominated: bool, state: IceCandidatePairState, seconds: f64) -> RtcStats {
        let mut stats = CandidatePairStats::default();
        stats.candidate_pair.nominated = nominated;
        stats.candidate_pair.state = Some(state);
        stats.candidate_pair.current_round_trip_time = seconds;
        RtcStats::CandidatePair(stats)
    }

    #[test]
    fn round_trip_comes_from_the_active_pair_only() {
        let stats = [
            pair(false, IceCandidatePairState::Succeeded, 0.5),
            pair(true, IceCandidatePairState::Failed, 0.4),
            pair(true, IceCandidatePairState::Succeeded, 0.0),
            pair(true, IceCandidatePairState::Succeeded, 0.042),
        ];
        let rtt = active_pair_round_trip_ms(&stats).expect("an active pair");
        assert!((rtt - 42.0).abs() < 1e-9);
        assert_eq!(active_pair_round_trip_ms(&stats[..3]), None);
        assert_eq!(active_pair_round_trip_ms(&[]), None);
    }

    #[test]
    fn quality_words_are_stable() {
        assert_eq!(quality_word(ConnectionQuality::Excellent), "excellent");
        assert_eq!(quality_word(ConnectionQuality::Lost), "lost");
    }
}
