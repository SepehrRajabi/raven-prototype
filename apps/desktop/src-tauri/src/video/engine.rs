//! Native video media engine.
//!
//! Owns both native video roles: the `<userId>#video` publisher and the base-identity
//! viewer that selectively receives remote video plus RTC self-preview. JavaScript never
//! opens a LiveKit room; it only presents bounded native frame streams.
//!
//! Capture backends push planar I420 frames into a per-source [`VideoPublishSink`], which
//! forwards them straight to a LiveKit [`NativeVideoSource`]. The published track is named
//! `raven-video-<trackId>` so peers can recognise it; Raven may also subscribe to it
//! when the user explicitly selects RTC-based self preview.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use livekit::options::{TrackPublishOptions, VideoEncoding};
use livekit::prelude::{
    ConnectionQuality, LocalTrack, LocalVideoTrack, RemoteTrack, Room, RoomEvent, RoomOptions,
    TrackDimension, TrackKind, TrackSource,
};
use livekit::webrtc::prelude::VideoBuffer;
use livekit::webrtc::stats::RtcStats;
use livekit::webrtc::video_frame::{I420Buffer, VideoFrame, VideoRotation};
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_source::{RtcVideoSource, VideoResolution};
use livekit::webrtc::video_stream::native::NativeVideoStream;
use livekit::{ConnectionState, DisconnectReason};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::runtime::{Handle, Runtime};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::video::capture::{VideoCaptureCounters, VideoFrameSink};
use crate::video::convert::I420Frame;
use crate::video::domain::{
    decode_watching, encode_watching, PublishedVideoTrackId, RemoteVideoTrackState,
    SelfPreviewMode, VideoConnectionQuality, VideoParticipantState, VideoPauseReason,
    VideoPresentationSettings, VideoQualityProfile, VideoSourceId, VideoSourceRuntimeStatus,
    VideoSourceState, VideoTrackSource, SHARE_PAUSED_ATTRIBUTE, WATCHING_ATTRIBUTE,
};
use crate::video::state::{SharedVideoEngineState, VIDEO_STATE_CHANGED_EVENT};
use crate::video::stream::{PresentationCounters, VideoFrameHub, VideoFramePublisher};

/// How long to wait after each repeat of a subscribe request lost in a full reconnect.
const SUBSCRIPTION_RESEND_DELAYS: [Duration; 3] = [
    Duration::from_millis(500),
    Duration::from_secs(2),
    Duration::from_secs(5),
];

fn lk_track_source(source: VideoTrackSource) -> TrackSource {
    match source {
        VideoTrackSource::Camera => TrackSource::Camera,
        VideoTrackSource::Screenshare => TrackSource::Screenshare,
    }
}

/// Stable LiveKit/WebRTC track name for a published video track.
pub fn stable_video_track_id(track_id: PublishedVideoTrackId) -> String {
    format!("raven-video-{track_id}")
}

/// Capture-side sink for one published source: receives I420 frames on the capture thread
/// and forwards them to the LiveKit native source. Frame copies respect the destination
/// buffer's plane strides (which may be padded for alignment).
pub struct VideoPublishSink {
    source: NativeVideoSource,
    started: Instant,
}

impl VideoPublishSink {
    fn new(source: NativeVideoSource) -> Self {
        Self {
            source,
            started: Instant::now(),
        }
    }
}

impl std::fmt::Debug for VideoPublishSink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VideoPublishSink").finish_non_exhaustive()
    }
}

impl VideoFrameSink for VideoPublishSink {
    fn push_frame(&self, frame: I420Frame) {
        let mut buffer = I420Buffer::new(frame.width, frame.height);
        let (stride_y, stride_u, stride_v) = buffer.strides();
        let (dst_y, dst_u, dst_v) = buffer.data_mut();

        copy_plane(
            &frame.y,
            frame.width as usize,
            dst_y,
            stride_y as usize,
            frame.height as usize,
        );
        let cw = frame.chroma_width() as usize;
        let ch = frame.chroma_height() as usize;
        copy_plane(&frame.u, cw, dst_u, stride_u as usize, ch);
        copy_plane(&frame.v, cw, dst_v, stride_v as usize, ch);

        let timestamp_us = self.started.elapsed().as_micros() as i64;
        let vframe = VideoFrame {
            rotation: VideoRotation::VideoRotation0,
            timestamp_us,
            frame_metadata: None,
            buffer,
        };
        self.source.capture_frame(&vframe);
    }
}

/// Copy a tightly-packed source plane into a (possibly padded) destination plane.
fn copy_plane(src: &[u8], src_width: usize, dst: &mut [u8], dst_stride: usize, rows: usize) {
    // Unpadded destination (the usual case): one copy for the whole plane.
    let total = src_width * rows;
    if dst_stride == src_width && total <= src.len() && total <= dst.len() {
        dst[..total].copy_from_slice(&src[..total]);
        return;
    }
    for row in 0..rows {
        let s = row * src_width;
        let d = row * dst_stride;
        let n = src_width.min(dst_stride);
        if s + n <= src.len() && d + n <= dst.len() {
            dst[d..d + n].copy_from_slice(&src[s..s + n]);
        }
    }
}

struct RoomConnection {
    room: Arc<Room>,
    event_loop: JoinHandle<()>,
}

/// A running remote video reader and what its presentation stream has shown.
struct RemoteReader {
    task: JoinHandle<()>,
    presentation: Arc<PresentationCounters>,
}

impl RemoteReader {
    fn abort(&self) {
        self.task.abort();
    }
}

type RemoteReaders = Arc<Mutex<HashMap<String, RemoteReader>>>;

struct ViewerConnection {
    room: Arc<Room>,
    event_loop: JoinHandle<()>,
    readers: RemoteReaders,
    watching: Arc<WatchingSync>,
}

/// What the viewer last told the room it is watching ([`WATCHING_ATTRIBUTE`]); `None` when
/// that is unknown (a failed send, a reconnect), which forces the next sync to send.
/// A new connection starts without attributes, which is the same as "".
struct WatchingSync {
    sent: tokio::sync::Mutex<Option<String>>,
    /// Set by the event loop when `sent` stopped being true (a reconnect) without waiting
    /// for the lock a send in flight holds; the next sync clears it and forces a send.
    invalidated: AtomicBool,
}

impl WatchingSync {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            sent: tokio::sync::Mutex::new(Some(String::new())),
            invalidated: AtomicBool::new(false),
        })
    }
}

/// A full reconnect rebuilds the peers from the join response, and the SDK sends their
/// subscribe requests down the old session, which drops them. Each then reads as wanted with
/// no track, so comparing against `is_desired` would send nothing: ask again for those.
fn resend_lost_subscriptions(handle: &Handle, room: &Room) {
    for participant in room.remote_participants().values() {
        for publication in participant.track_publications().into_values() {
            if !publication.is_desired() || publication.is_subscribed() {
                continue;
            }
            handle.spawn(async move {
                for delay in SUBSCRIPTION_RESEND_DELAYS {
                    if !publication.is_desired() || publication.is_subscribed() {
                        return;
                    }
                    publication.set_subscribed(true);
                    tokio::time::sleep(delay).await;
                }
            });
        }
    }
}

/// Make the viewer's [`WATCHING_ATTRIBUTE`] match the screen shares it is set to receive.
/// Cheap to call on every room event: it sends only on a change, and sends are serialized
/// so the last one always reflects the room as it is then. Best effort: a failure just
/// leaves others without the avatar until the next event.
fn sync_watching(handle: &Handle, room: &Arc<Room>, watching: &Arc<WatchingSync>) {
    let desired = encode_watching(&watched_share_owners(room));
    if !watching.invalidated.load(Ordering::Acquire) {
        if let Ok(sent) = watching.sent.try_lock() {
            if sent.as_deref() == Some(desired.as_str()) {
                return;
            }
        }
    }
    let room = Arc::clone(room);
    let watching = Arc::clone(watching);
    handle.spawn(async move {
        let mut sent = watching.sent.lock().await;
        if watching.invalidated.swap(false, Ordering::AcqRel) {
            *sent = None;
        }
        let desired = encode_watching(&watched_share_owners(&room));
        if sent.as_deref() == Some(desired.as_str()) {
            return;
        }
        let attributes = HashMap::from([(WATCHING_ATTRIBUTE.to_string(), desired.clone())]);
        *sent = room
            .local_participant()
            .set_attributes(attributes)
            .await
            .ok()
            .map(|()| desired);
    });
}

/// Whose screen shares `room` is set to receive (other people only; the self preview is
/// not watching).
fn watched_share_owners(room: &Room) -> Vec<String> {
    let local = room.local_participant().identity().0;
    watched_owners(
        &local,
        room.remote_participants().values().map(|participant| {
            let watching_share = participant
                .track_publications()
                .values()
                .any(|publication| {
                    publication.kind() == TrackKind::Video
                        && video_track_source(publication.source())
                            == Some(VideoTrackSource::Screenshare)
                        && publication.is_desired()
                });
            (participant.identity().0, watching_share)
        }),
    )
}

/// The pure half of [`watched_share_owners`]: `(identity, has a watched share)` pairs to
/// the sorted, unique base ids of the owners, minus the local user.
fn watched_owners(
    local_identity: &str,
    shares: impl Iterator<Item = (String, bool)>,
) -> Vec<String> {
    let local = base_participant_identity(local_identity);
    let mut owners: Vec<String> = shares
        .filter(|(_, watched)| *watched)
        .map(|(identity, _)| base_participant_identity(&identity).to_string())
        .filter(|id| id != local)
        .collect();
    owners.sort_unstable();
    owners.dedup();
    owners
}

/// Connection flags shared with the state snapshot, so reading "are we connected" never
/// has to wait behind a long-running engine operation.
#[derive(Clone, Debug, Default)]
pub struct VideoLinkFlags {
    pub connected: Arc<AtomicBool>,
    pub viewer_connected: Arc<AtomicBool>,
}

struct PublishEntry {
    track: LocalTrack,
    source: VideoTrackSource,
    sink: Arc<VideoPublishSink>,
    profile: VideoQualityProfile,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoNetworkTotals {
    pub camera_sent_bytes: u64,
    pub screen_share_sent_bytes: u64,
    pub camera_received_bytes: u64,
    pub screen_share_received_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoQualityDimensions {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoScreenShareTransmitQuality {
    pub configured: VideoQualityDimensions,
    pub max_bitrate_bps: u64,
    pub outbound: Option<VideoOutboundQuality>,
    pub remote_loss_fraction: Option<f64>,
    pub round_trip_time_ms: Option<f64>,
    pub capture: Option<VideoCaptureFrameCounts>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoOutboundQuality {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub target_bitrate_bps: f64,
    pub limitation: String,
    /// libwebrtc's name for the encoder in use, for example "libvpx".
    pub encoder_implementation: String,
    /// True only for a hardware encoder.
    pub power_efficient_encoder: bool,
    /// Frames that entered WebRTC's video source (before its own frame-rate limiter and
    /// the encoder's frame dropping), then frames encoded and sent.
    pub source_frames: u32,
    pub frames_encoded: u32,
    pub frames_sent: u32,
    pub total_encode_time_seconds: f64,
}

/// Cumulative frame counts of a running capture.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoCaptureFrameCounts {
    pub captured: u64,
    pub forwarded: u64,
}

impl From<&VideoCaptureCounters> for VideoCaptureFrameCounts {
    fn from(counters: &VideoCaptureCounters) -> Self {
        Self {
            captured: counters.captured.load(Ordering::Relaxed),
            forwarded: counters.forwarded.load(Ordering::Relaxed),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoScreenShareReceiveQuality {
    pub inbound: Option<VideoQualityDimensions>,
    pub loss_fraction: Option<f64>,
    pub decoder_implementation: Option<String>,
    pub power_efficient_decoder: Option<bool>,
}

/// Receive measurements for one subscribed remote video track. Rates are measured between
/// calls (see [`VideoStreamStatsCache`]).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoStreamStats {
    pub stream_id: String,
    pub participant_id: String,
    pub source: VideoTrackSource,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub received_fps: Option<f64>,
    pub decoded_fps: Option<f64>,
    pub shown_fps: Option<f64>,
    pub bitrate_bps: Option<f64>,
    pub packets_lost: i64,
    pub packet_loss_fraction: Option<f64>,
    pub jitter_ms: Option<f64>,
    pub frames_dropped: u32,
    pub codec: Option<String>,
    pub decoder_implementation: Option<String>,
    pub power_efficient_decoder: Option<bool>,
    /// The size the sender published. LiveKit does not signal the sender's frame rate.
    pub published_width: Option<u32>,
    pub published_height: Option<u32>,
    pub present_encode_ms: Option<f64>,
}

/// What the stats command needs to measure one subscribed stream, gathered under the ops
/// lock and measured after it is released.
pub struct RemoteStreamHandle {
    stream_id: String,
    participant_id: String,
    source: VideoTrackSource,
    track: RemoteTrack,
    published: TrackDimension,
    presentation: Option<Arc<PresentationCounters>>,
}

/// Cumulative counters from the previous stats call per stream, so rates can be derived.
#[derive(Clone, Default)]
pub struct VideoStreamStatsCache(Arc<Mutex<HashMap<String, StreamSample>>>);

#[derive(Clone, Copy)]
struct StreamSample {
    at: Instant,
    frames_received: u64,
    frames_decoded: u64,
    shown: u64,
    bytes_received: u64,
    packets_received: u64,
    packets_lost: i64,
    encoded: u64,
    encode_micros: u64,
    rates: StreamRates,
}

#[derive(Clone, Copy, Default)]
struct StreamRates {
    received_fps: Option<f64>,
    decoded_fps: Option<f64>,
    shown_fps: Option<f64>,
    bitrate_bps: Option<f64>,
    loss_fraction: Option<f64>,
    encode_ms: Option<f64>,
}

/// Rates are only recomputed when at least this long has passed since the previous
/// sample; a second caller polling in between reuses the last rates instead of measuring
/// a window too short to mean anything.
const STREAM_STATS_MIN_WINDOW: Duration = Duration::from_millis(500);

impl StreamSample {
    fn rates_since(&self, previous: &StreamSample) -> StreamRates {
        let seconds = self.at.duration_since(previous.at).as_secs_f64().max(0.001);
        let per_second = |now: u64, before: u64| now.saturating_sub(before) as f64 / seconds;
        let received = self
            .packets_received
            .saturating_sub(previous.packets_received);
        let lost = (self.packets_lost - previous.packets_lost).max(0) as u64;
        let encoded = self.encoded.saturating_sub(previous.encoded);
        StreamRates {
            received_fps: Some(per_second(self.frames_received, previous.frames_received)),
            decoded_fps: Some(per_second(self.frames_decoded, previous.frames_decoded)),
            shown_fps: Some(per_second(self.shown, previous.shown)),
            bitrate_bps: Some(per_second(self.bytes_received, previous.bytes_received) * 8.0),
            loss_fraction: (received + lost > 0).then(|| lost as f64 / (received + lost) as f64),
            encode_ms: (encoded > 0).then(|| {
                self.encode_micros.saturating_sub(previous.encode_micros) as f64
                    / encoded as f64
                    / 1_000.0
            }),
        }
    }
}

impl VideoStreamStatsCache {
    /// Record a new sample and return the rates to report for it.
    fn rates_for(&self, stream_id: &str, mut sample: StreamSample) -> StreamRates {
        let Ok(mut samples) = self.0.lock() else {
            return StreamRates::default();
        };
        match samples.get(stream_id) {
            Some(previous) if sample.at.duration_since(previous.at) < STREAM_STATS_MIN_WINDOW => {
                previous.rates
            }
            Some(previous) => {
                sample.rates = sample.rates_since(previous);
                samples.insert(stream_id.to_string(), sample);
                sample.rates
            }
            None => {
                samples.insert(stream_id.to_string(), sample);
                StreamRates::default()
            }
        }
    }

    /// Forget streams that are no longer subscribed.
    fn retain(&self, live: &HashSet<String>) {
        if let Ok(mut samples) = self.0.lock() {
            samples.retain(|stream_id, _| live.contains(stream_id));
        }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoQualityReport {
    pub screen_share_transmit: Option<VideoScreenShareTransmitQuality>,
    pub screen_share_receive: Option<VideoScreenShareReceiveQuality>,
}

pub async fn measure_video_network_totals(
    published_tracks: Vec<(VideoTrackSource, LocalTrack)>,
    subscribed_tracks: Vec<(VideoTrackSource, RemoteTrack)>,
) -> Result<VideoNetworkTotals, String> {
    let mut totals = VideoNetworkTotals::default();
    for (source, track) in published_tracks {
        let stats = track.get_stats().await.map_err(|error| error.to_string())?;
        let sent_bytes: u64 = stats
            .iter()
            .filter_map(|stat| match stat {
                RtcStats::OutboundRtp(outbound) => Some(outbound.sent.bytes_sent),
                _ => None,
            })
            .sum();
        match source {
            VideoTrackSource::Camera => totals.camera_sent_bytes += sent_bytes,
            VideoTrackSource::Screenshare => totals.screen_share_sent_bytes += sent_bytes,
        }
    }
    for (source, track) in subscribed_tracks {
        let stats = track.get_stats().await.map_err(|error| error.to_string())?;
        let received_bytes: u64 = stats
            .iter()
            .filter_map(|stat| match stat {
                RtcStats::InboundRtp(inbound) => Some(inbound.inbound.bytes_received),
                _ => None,
            })
            .sum();
        match source {
            VideoTrackSource::Camera => totals.camera_received_bytes += received_bytes,
            VideoTrackSource::Screenshare => totals.screen_share_received_bytes += received_bytes,
        }
    }
    Ok(totals)
}

pub async fn measure_video_quality_report(
    published_screen_shares: Vec<(
        LocalTrack,
        VideoQualityProfile,
        Option<VideoCaptureFrameCounts>,
    )>,
    subscribed_screen_shares: Vec<RemoteTrack>,
) -> Result<VideoQualityReport, String> {
    let screen_share_transmit =
        if let Some((track, profile, capture)) = published_screen_shares.into_iter().next() {
            let tuning = profile.publish_tuning(VideoTrackSource::Screenshare);
            let stats = track.get_stats().await.map_err(|error| error.to_string())?;
            let source_frames = stats
                .iter()
                .find_map(|stat| match stat {
                    RtcStats::MediaSource(value) if value.source.kind == "video" => {
                        Some(value.video.frames)
                    }
                    _ => None,
                })
                .unwrap_or_default();
            let outbound = stats.iter().find_map(|stat| match stat {
                RtcStats::OutboundRtp(value) => Some(VideoOutboundQuality {
                    width: value.outbound.frame_width,
                    height: value.outbound.frame_height,
                    fps: value.outbound.frames_per_second,
                    target_bitrate_bps: value.outbound.target_bitrate,
                    limitation: format!("{:?}", value.outbound.quality_limitation_reason)
                        .to_lowercase(),
                    encoder_implementation: value.outbound.encoder_implementation.clone(),
                    power_efficient_encoder: value.outbound.power_efficient_encoder,
                    source_frames,
                    frames_encoded: value.outbound.frames_encoded,
                    frames_sent: value.outbound.frames_sent,
                    total_encode_time_seconds: value.outbound.total_encode_time,
                }),
                _ => None,
            });
            let remote_feedback = stats.iter().find_map(|stat| match stat {
                RtcStats::RemoteInboundRtp(value) => Some((
                    value.remote_inbound.fraction_lost,
                    value.remote_inbound.round_trip_time * 1_000.0,
                )),
                _ => None,
            });
            Some(VideoScreenShareTransmitQuality {
                configured: VideoQualityDimensions {
                    width: tuning.width,
                    height: tuning.height,
                    fps: tuning.frame_rate,
                },
                max_bitrate_bps: tuning.max_bitrate_bps,
                outbound,
                remote_loss_fraction: remote_feedback.map(|(loss, _)| loss),
                round_trip_time_ms: remote_feedback.map(|(_, rtt)| rtt),
                capture,
            })
        } else {
            None
        };

    let mut inbound = None;
    let mut decoder = None;
    let mut packets_received = 0_u64;
    let mut packets_lost = 0_i64;
    for track in subscribed_screen_shares {
        let stats = track.get_stats().await.map_err(|error| error.to_string())?;
        for stat in stats {
            if let RtcStats::InboundRtp(value) = stat {
                packets_received += value.received.packets_received;
                packets_lost += value.received.packets_lost.max(0);
                let next = VideoQualityDimensions {
                    width: value.inbound.frame_width,
                    height: value.inbound.frame_height,
                    fps: value.inbound.frames_per_second,
                };
                if inbound
                    .as_ref()
                    .map(|current: &VideoQualityDimensions| {
                        next.width.saturating_mul(next.height)
                            > current.width.saturating_mul(current.height)
                    })
                    .unwrap_or(true)
                {
                    inbound = Some(next);
                    decoder = Some((
                        value.inbound.decoder_implementation.clone(),
                        value.inbound.power_efficient_decoder,
                    ));
                }
            }
        }
    }
    let received_or_lost = packets_received + packets_lost.max(0) as u64;
    let screen_share_receive = inbound.map(|inbound| VideoScreenShareReceiveQuality {
        inbound: Some(inbound),
        loss_fraction: (received_or_lost > 0)
            .then_some(packets_lost.max(0) as f64 / received_or_lost as f64),
        decoder_implementation: decoder
            .as_ref()
            .map(|(name, _)| name.clone())
            .filter(|name| !name.is_empty()),
        power_efficient_decoder: decoder.map(|(_, efficient)| efficient),
    });

    Ok(VideoQualityReport {
        screen_share_transmit,
        screen_share_receive,
    })
}

/// Measure every given remote stream. Each `get_stats` call is answered by libwebrtc's own
/// threads, so this never touches the reader tasks that move frames.
pub async fn measure_video_stream_stats(
    handles: Vec<RemoteStreamHandle>,
    live_stream_ids: HashSet<String>,
    cache: VideoStreamStatsCache,
) -> Result<Vec<VideoStreamStats>, String> {
    cache.retain(&live_stream_ids);
    let mut report = Vec::with_capacity(handles.len());
    for handle in handles {
        let stats = handle
            .track
            .get_stats()
            .await
            .map_err(|error| error.to_string())?;
        let at = Instant::now();
        let inbound = stats.iter().find_map(|stat| match stat {
            RtcStats::InboundRtp(value) => Some(value),
            _ => None,
        });
        let codec = inbound.and_then(|inbound| {
            stats.iter().find_map(|stat| match stat {
                RtcStats::Codec(codec) if codec.rtc.id == inbound.stream.codec_id => {
                    Some(codec.codec.mime_type.clone())
                }
                _ => None,
            })
        });
        let (shown, encoded, encode_micros) = handle
            .presentation
            .as_ref()
            .map(|counters| {
                (
                    counters.shown.load(Ordering::Relaxed),
                    counters.encoded.load(Ordering::Relaxed),
                    counters.encode_micros.load(Ordering::Relaxed),
                )
            })
            .unwrap_or_default();
        let sample = StreamSample {
            at,
            frames_received: inbound.map_or(0, |value| value.inbound.frames_received),
            frames_decoded: inbound.map_or(0, |value| u64::from(value.inbound.frames_decoded)),
            shown,
            bytes_received: inbound.map_or(0, |value| value.inbound.bytes_received),
            packets_received: inbound.map_or(0, |value| value.received.packets_received),
            packets_lost: inbound.map_or(0, |value| value.received.packets_lost),
            encoded,
            encode_micros,
            rates: StreamRates::default(),
        };
        let rates = cache.rates_for(&handle.stream_id, sample);
        let non_zero = |value: u32| (value > 0).then_some(value);
        report.push(VideoStreamStats {
            stream_id: handle.stream_id,
            participant_id: handle.participant_id,
            source: handle.source,
            width: inbound.and_then(|value| non_zero(value.inbound.frame_width)),
            height: inbound.and_then(|value| non_zero(value.inbound.frame_height)),
            received_fps: rates.received_fps,
            decoded_fps: rates.decoded_fps,
            shown_fps: rates.shown_fps,
            bitrate_bps: rates.bitrate_bps,
            packets_lost: inbound.map_or(0, |value| value.received.packets_lost.max(0)),
            packet_loss_fraction: rates.loss_fraction,
            jitter_ms: inbound.map(|value| value.received.jitter * 1_000.0),
            frames_dropped: inbound.map_or(0, |value| value.inbound.frames_dropped),
            codec: codec.filter(|name| !name.is_empty()),
            decoder_implementation: inbound
                .map(|value| value.inbound.decoder_implementation.clone())
                .filter(|name| !name.is_empty()),
            power_efficient_decoder: inbound.map(|value| value.inbound.power_efficient_decoder),
            published_width: non_zero(handle.published.0),
            published_height: non_zero(handle.published.1),
            present_encode_ms: rates.encode_ms,
        });
    }
    Ok(report)
}

/// The native video media engine. Stored inside `VideoEngineState`.
pub struct VideoEngine {
    runtime: Option<Runtime>,
    connection: Option<RoomConnection>,
    viewer: Option<ViewerConnection>,
    publications: HashMap<VideoSourceId, PublishEntry>,
    link: VideoLinkFlags,
    hub: VideoFrameHub,
    presentation: Arc<RwLock<VideoPresentationSettings>>,
    stream_stats: VideoStreamStatsCache,
    /// The [`SHARE_PAUSED_ATTRIBUTE`] value the publisher last set ("" when live). A new
    /// connection starts without attributes.
    share_paused_attribute: String,
}

impl std::fmt::Debug for VideoEngine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VideoEngine")
            .field("connected", &self.connection.is_some())
            .field("viewer_connected", &self.viewer.is_some())
            .field("publications", &self.publications.len())
            .finish_non_exhaustive()
    }
}

impl VideoEngine {
    pub fn new(hub: VideoFrameHub, presentation: Arc<RwLock<VideoPresentationSettings>>) -> Self {
        Self {
            runtime: None,
            connection: None,
            viewer: None,
            publications: HashMap::new(),
            link: VideoLinkFlags::default(),
            hub,
            presentation,
            stream_stats: VideoStreamStatsCache::default(),
            share_paused_attribute: String::new(),
        }
    }

    fn runtime(&mut self) -> &Runtime {
        if self.runtime.is_none() {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(4)
                .thread_name("raven-video-engine")
                .enable_all()
                .build()
                .expect("failed to build video engine tokio runtime");
            self.runtime = Some(runtime);
        }
        self.runtime.as_ref().unwrap()
    }

    /// Handle to the engine runtime; LiveKit calls are spawned here so the SDK's tasks stay
    /// on the engine's own workers whichever runtime polls the calling command.
    fn handle(&mut self) -> Handle {
        self.runtime().handle().clone()
    }

    pub fn link_flags(&self) -> VideoLinkFlags {
        self.link.clone()
    }

    pub fn is_connected(&self) -> bool {
        self.connection.is_some()
    }

    pub fn is_viewer_connected(&self) -> bool {
        self.viewer.is_some() && self.link.viewer_connected.load(Ordering::Acquire)
    }

    pub fn published_tracks(&self) -> Vec<(VideoTrackSource, LocalTrack)> {
        self.publications
            .values()
            .map(|entry| (entry.source, entry.track.clone()))
            .collect()
    }

    pub fn subscribed_tracks(&self) -> Vec<(VideoTrackSource, RemoteTrack)> {
        let Some(viewer) = self.viewer.as_ref() else {
            return Vec::new();
        };
        viewer
            .room
            .remote_participants()
            .values()
            .flat_map(|participant| participant.track_publications().into_values())
            .filter_map(|publication| {
                let source = video_track_source(publication.source())?;
                let track = publication.track()?;
                matches!(track, RemoteTrack::Video(_)).then_some((source, track))
            })
            .collect()
    }

    pub fn published_screen_share_tracks(
        &self,
    ) -> Vec<(VideoSourceId, LocalTrack, VideoQualityProfile)> {
        self.publications
            .iter()
            .filter(|(_, entry)| matches!(entry.source, VideoTrackSource::Screenshare))
            .map(|(id, entry)| (*id, entry.track.clone(), entry.profile.clone()))
            .collect()
    }

    pub fn stream_stats_cache(&self) -> VideoStreamStatsCache {
        self.stream_stats.clone()
    }

    /// Every subscribed remote video stream (`only` narrows the handles returned, not the
    /// set of live ids, which the stats cache is pruned against).
    pub fn remote_stream_handles(
        &self,
        only: Option<&HashSet<String>>,
    ) -> (Vec<RemoteStreamHandle>, HashSet<String>) {
        let Some(viewer) = self.viewer.as_ref() else {
            return (Vec::new(), HashSet::new());
        };
        let readers = viewer.readers.lock().ok();
        let mut handles = Vec::new();
        let mut live = HashSet::new();
        for participant in viewer.room.remote_participants().values() {
            let participant_id = base_participant_identity(&participant.identity().0).to_string();
            for publication in participant.track_publications().into_values() {
                let Some(source) = video_track_source(publication.source()) else {
                    continue;
                };
                let Some(track @ RemoteTrack::Video(_)) = publication.track() else {
                    continue;
                };
                let stream_id = remote_stream_id(&publication.sid().to_string());
                live.insert(stream_id.clone());
                if only.is_some_and(|wanted| !wanted.contains(&stream_id)) {
                    continue;
                }
                let presentation = readers
                    .as_ref()
                    .and_then(|readers| readers.get(&stream_id))
                    .map(|reader| Arc::clone(&reader.presentation));
                handles.push(RemoteStreamHandle {
                    stream_id,
                    participant_id: participant_id.clone(),
                    source,
                    track,
                    published: publication.dimension(),
                    presentation,
                });
            }
        }
        (handles, live)
    }

    pub fn subscribed_screen_share_tracks(&self) -> Vec<RemoteTrack> {
        self.subscribed_tracks()
            .into_iter()
            .filter_map(|(source, track)| {
                matches!(source, VideoTrackSource::Screenshare).then_some(track)
            })
            .collect()
    }

    /// Connect the video sidecar to a LiveKit room. Awaits both network handshakes;
    /// callers must not hold the video state lock across this call.
    #[allow(clippy::too_many_arguments)]
    pub async fn connect(
        &mut self,
        app: &AppHandle,
        shared: &SharedVideoEngineState,
        url: &str,
        publisher_token: &str,
        viewer_token: &str,
        remote_preferences: &HashMap<String, bool>,
        rejoin: bool,
    ) -> Result<(), String> {
        // A rejoin keeps a role whose room is still up, so a lost viewer does not restart
        // a healthy screen share (and the reverse). A fresh join starts both over.
        let healthy = |room: &Room, event_loop: &JoinHandle<()>| {
            rejoin
                && room.connection_state() == ConnectionState::Connected
                && !event_loop.is_finished()
        };
        let keep_publisher = self
            .connection
            .as_ref()
            .is_some_and(|connection| healthy(&connection.room, &connection.event_loop));
        let keep_viewer = self
            .viewer
            .as_ref()
            .is_some_and(|viewer| healthy(&viewer.room, &viewer.event_loop));
        if !keep_publisher {
            self.disconnect_publisher().await;
        }
        if !keep_viewer {
            self.disconnect_viewer().await;
        }
        if !keep_publisher {
            self.connect_publisher(app, shared, url, publisher_token)
                .await?;
        }
        if !keep_viewer {
            if let Err(error) = self
                .connect_viewer(app, shared, url, viewer_token, remote_preferences)
                .await
            {
                // A fresh join is all or nothing; a rejoin keeps what did come back.
                if !rejoin {
                    self.disconnect().await;
                }
                return Err(error);
            }
        }
        Ok(())
    }

    async fn connect_publisher(
        &mut self,
        app: &AppHandle,
        shared: &SharedVideoEngineState,
        url: &str,
        publisher_token: &str,
    ) -> Result<(), String> {
        let handle = self.handle();
        let mut options = RoomOptions::default();
        // The publisher role never subscribes; the separate native viewer below owns receive.
        options.auto_subscribe = false;
        let (publisher_url, publisher_token) = (url.to_string(), publisher_token.to_string());
        let (room, events) = handle
            .spawn(async move { Room::connect(&publisher_url, &publisher_token, options).await })
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| error.to_string())?;
        let room = Arc::new(room);
        let event_loop = self.spawn_event_loop(app, shared, events);

        self.connection = Some(RoomConnection { room, event_loop });
        self.share_paused_attribute.clear();
        self.link.connected.store(true, Ordering::Release);
        Ok(())
    }

    async fn connect_viewer(
        &mut self,
        app: &AppHandle,
        shared: &SharedVideoEngineState,
        url: &str,
        viewer_token: &str,
        remote_preferences: &HashMap<String, bool>,
    ) -> Result<(), String> {
        let handle = self.handle();
        let mut viewer_options = RoomOptions::default();
        viewer_options.auto_subscribe = false;
        let (viewer_url, viewer_token) = (url.to_string(), viewer_token.to_string());
        let viewer = handle
            .spawn(async move { Room::connect(&viewer_url, &viewer_token, viewer_options).await })
            .await
            .map_err(|error| error.to_string())
            .and_then(|result| result.map_err(|error| error.to_string()));
        let (viewer_room, viewer_events) = viewer?;
        let viewer_room = Arc::new(viewer_room);
        let readers = Arc::new(Mutex::new(HashMap::new()));
        let viewer_connected = Arc::clone(&self.link.viewer_connected);
        viewer_connected.store(true, Ordering::Release);
        let watching = WatchingSync::new();
        let viewer_event_loop = self.spawn_viewer_event_loop(
            app,
            shared,
            Arc::clone(&viewer_room),
            viewer_events,
            &readers,
            &viewer_connected,
            &watching,
        );
        self.viewer = Some(ViewerConnection {
            room: Arc::clone(&viewer_room),
            event_loop: viewer_event_loop,
            readers,
            watching,
        });
        self.apply_viewer_subscriptions(SelfPreviewMode::Local, remote_preferences);
        Ok(())
    }

    pub async fn disconnect(&mut self) {
        self.disconnect_publisher().await;
        self.disconnect_viewer().await;
    }

    async fn disconnect_publisher(&mut self) {
        self.publications.clear();
        self.share_paused_attribute.clear();
        self.link.connected.store(false, Ordering::Release);
        let handle = self.handle();
        if let Some(connection) = self.connection.take() {
            connection.event_loop.abort();
            let room = connection.room.clone();
            let _ = handle.spawn(async move { room.close().await }).await;
        }
    }

    async fn disconnect_viewer(&mut self) {
        self.link.viewer_connected.store(false, Ordering::Release);
        let handle = self.handle();
        if let Some(viewer) = self.viewer.take() {
            viewer.event_loop.abort();
            for (stream_id, reader) in viewer.readers.lock().unwrap().drain() {
                reader.abort();
                self.hub.remove_stream(&stream_id);
            }
            let room = viewer.room;
            let _ = handle.spawn(async move { room.close().await }).await;
        }
    }

    /// Re-evaluate which remote video publications the viewer should receive, given the
    /// self-preview mode and the per-participant receive preferences held in video state.
    pub fn apply_viewer_subscriptions(
        &mut self,
        self_preview_mode: SelfPreviewMode,
        preferences: &HashMap<String, bool>,
    ) {
        let Some(viewer) = self.viewer.as_ref() else {
            return;
        };
        let room = Arc::clone(&viewer.room);
        let watching = Arc::clone(&viewer.watching);
        let local_identity =
            base_participant_identity(&room.local_participant().identity().0).to_string();
        let updates: Vec<_> = room
            .remote_participants()
            .values()
            .flat_map(|participant| {
                let identity = participant.identity().0;
                let participant_id = base_participant_identity(&identity).to_string();
                let local_identity = &local_identity;
                let preferences = &preferences;
                participant
                    .track_publications()
                    .values()
                    .filter_map(move |publication| {
                        let source = video_track_source(publication.source())?;
                        let desired = should_receive_video(
                            local_identity,
                            &identity,
                            publication.kind(),
                            Some(source),
                            self_preview_mode,
                            preferences
                                .get(&subscription_key(&participant_id, source))
                                .copied(),
                        );
                        (publication.is_desired() != desired)
                            .then_some((publication.clone(), desired))
                    })
                    .collect::<Vec<_>>()
            })
            .collect();
        if updates.is_empty() {
            return;
        }
        let runtime = self.runtime();
        let _guard = runtime.enter();
        for (publication, desired) in updates {
            publication.set_subscribed(desired);
        }
        // Tell the room at once, instead of when the track arrives.
        sync_watching(runtime.handle(), &room, &watching);
    }

    /// Sink map handed to the capture manager so it knows where to push captured frames.
    pub fn sink_map(&self) -> HashMap<VideoSourceId, Arc<dyn VideoFrameSink>> {
        self.publications
            .iter()
            .map(|(id, entry)| (*id, Arc::clone(&entry.sink) as Arc<dyn VideoFrameSink>))
            .collect()
    }

    /// Reconcile published LiveKit tracks against which local sources are marked
    /// `publishing`. Called with the ops lock held and the video state lock released,
    /// because publishing awaits signalling round trips.
    pub async fn reconcile_publications(
        &mut self,
        sources: &[VideoSourceState],
    ) -> Result<(), String> {
        let Some(connection) = self.connection.as_ref() else {
            self.publications.clear();
            return Ok(());
        };
        let room = Arc::clone(&connection.room);
        if room.connection_state() != ConnectionState::Connected {
            // LiveKit is resuming the session and republishes our tracks itself; a track
            // looks lost until it has. The resync after `Reconnected` reconciles the rest.
            return Ok(());
        }
        let handle = self.handle();

        let desired: HashMap<VideoSourceId, &VideoSourceState> = sources
            .iter()
            .filter(|source| source.publishing)
            .map(|source| (source.id, source))
            .collect();

        // Forget publications LiveKit no longer has (the automatic republish after a full
        // reconnect can fail); they are published again below.
        let published = room.local_participant().track_publications();
        self.publications
            .retain(|_, entry| published.contains_key(&entry.track.sid()));

        // Unpublish sources that are no longer publishing.
        let stale: Vec<VideoSourceId> = self
            .publications
            .iter()
            .filter_map(|(id, entry)| {
                let desired_source = desired.get(id)?;
                if entry.profile != desired_source.profile {
                    Some(*id)
                } else {
                    None
                }
            })
            .chain(
                self.publications
                    .keys()
                    .copied()
                    .filter(|id| !desired.contains_key(id)),
            )
            .collect();
        for id in stale {
            if let Some(entry) = self.publications.remove(&id) {
                let room = Arc::clone(&room);
                // The SID is re-issued when the track is republished after a reconnect;
                // the track always knows its current one.
                let sid = entry.track.sid();
                let _ = handle
                    .spawn(async move { room.local_participant().unpublish_track(&sid).await })
                    .await;
            }
        }

        // Publish newly-publishing sources.
        let to_publish: Vec<VideoSourceState> = desired
            .values()
            .filter(|source| !self.publications.contains_key(&source.id))
            .map(|source| (*source).clone())
            .collect();
        let mut first_error = None;
        for source in to_publish {
            if let Err(error) = self.publish_source(&room, &source).await {
                eprintln!("[video-engine] publish failed for {}: {error}", source.id);
                first_error.get_or_insert_with(|| {
                    format!("could not publish video source {}: {error}", source.id)
                });
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    /// Make the publisher's [`SHARE_PAUSED_ATTRIBUTE`] say whether a published screen share
    /// is paused. Sends only on a change; LiveKit merges attributes, and an empty value
    /// deletes one.
    pub async fn reconcile_share_attributes(
        &mut self,
        sources: &[VideoSourceState],
    ) -> Result<(), String> {
        let Some(connection) = self.connection.as_ref() else {
            return Ok(());
        };
        let desired = share_paused_attribute(sources);
        if desired == self.share_paused_attribute {
            return Ok(());
        }
        let room = Arc::clone(&connection.room);
        let attributes = HashMap::from([(SHARE_PAUSED_ATTRIBUTE.to_string(), desired.clone())]);
        self.handle()
            .spawn(async move { room.local_participant().set_attributes(attributes).await })
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| error.to_string())?;
        self.share_paused_attribute = desired;
        Ok(())
    }

    async fn publish_source(
        &mut self,
        room: &Arc<Room>,
        source: &VideoSourceState,
    ) -> Result<(), String> {
        let track_id = source
            .published_track
            .as_ref()
            .map(|track| track.track_id)
            .unwrap_or_default();
        let webrtc_track_id = stable_video_track_id(track_id);

        let profile = source.profile.clone();
        let track_source = VideoTrackSource::from_kind(source.kind);
        let publish_tuning = profile.publish_tuning(track_source);
        let width = publish_tuning.width.max(2);
        let height = publish_tuning.height.max(2);
        let is_screencast = matches!(track_source, VideoTrackSource::Screenshare);

        let publish_options = TrackPublishOptions {
            source: lk_track_source(publish_tuning.source),
            stream: format!("raven-video-source-{}", source.id),
            video_encoding: Some(VideoEncoding {
                max_bitrate: publish_tuning.max_bitrate_bps,
                max_framerate: publish_tuning.frame_rate,
            }),
            simulcast: publish_tuning.simulcast,
            ..Default::default()
        };

        // `NativeVideoSource::new` spawns an internal keep-alive task via the LiveKit
        // runtime, so the source is created inside the engine runtime alongside the
        // publish handshake.
        let publish_room = Arc::clone(room);
        let (native, local_track) = self
            .handle()
            .spawn(async move {
                let native =
                    NativeVideoSource::new(VideoResolution { width, height }, is_screencast);
                let track = LocalVideoTrack::create_video_track(
                    &webrtc_track_id,
                    RtcVideoSource::Native(native.clone()),
                );
                let local_track = LocalTrack::Video(track);
                publish_room
                    .local_participant()
                    .publish_track(local_track.clone(), publish_options)
                    .await
                    .map_err(|error| error.to_string())?;
                Ok::<_, String>((native, local_track))
            })
            .await
            .map_err(|error| error.to_string())??;

        let sink = Arc::new(VideoPublishSink::new(native));
        self.publications.insert(
            source.id,
            PublishEntry {
                track: local_track,
                source: track_source,
                sink,
                profile,
            },
        );
        Ok(())
    }

    fn spawn_viewer_event_loop(
        &mut self,
        app: &AppHandle,
        shared: &SharedVideoEngineState,
        room: Arc<Room>,
        mut events: mpsc::UnboundedReceiver<RoomEvent>,
        readers: &RemoteReaders,
        connected: &Arc<AtomicBool>,
        watching: &Arc<WatchingSync>,
    ) -> JoinHandle<()> {
        let app = app.clone();
        let watching = Arc::clone(watching);
        // A weak state reference prevents `state -> engine -> task -> state` from
        // forming a cycle if the app shuts down without an explicit leave command.
        let shared = Arc::downgrade(shared);
        let readers = Arc::clone(readers);
        let connected = Arc::clone(connected);
        let hub = self.hub.clone();
        let presentation = Arc::clone(&self.presentation);
        let runtime = self.runtime().handle().clone();
        self.runtime().spawn(async move {
            let Some(initial_state) = shared.upgrade() else {
                return;
            };
            reflect_viewer_state(&app, &initial_state, &room);
            drop(initial_state);
            while let Some(event) = events.recv().await {
                let Some(shared_state) = shared.upgrade() else {
                    break;
                };
                match event {
                    RoomEvent::TrackPublished {
                        publication,
                        participant,
                    } => {
                        let desired = desired_viewer_subscription(
                            &shared_state,
                            &room,
                            &participant.identity().0,
                            publication.kind(),
                            publication.source(),
                        );
                        if publication.is_desired() != desired {
                            publication.set_subscribed(desired);
                        }
                    }
                    RoomEvent::TrackSubscribed {
                        track, publication, ..
                    } => {
                        let RemoteTrack::Video(video_track) = track else {
                            publication.set_subscribed(false);
                            continue;
                        };
                        let stream_id = remote_stream_id(&publication.sid().to_string());
                        let source = video_track_source(publication.source())
                            .unwrap_or(VideoTrackSource::Camera);
                        let publisher = VideoFramePublisher::new(
                            stream_id.clone(),
                            hub.clone(),
                            Arc::clone(&presentation),
                            source,
                        );
                        let presentation_counters = publisher.counters();
                        let mut stream = NativeVideoStream::new(video_track.rtc_track());
                        let task = runtime.spawn(async move {
                            while let Some(frame) = stream.next().await {
                                if !publisher.wants_frame() {
                                    continue;
                                }
                                let buffer = frame.buffer.to_i420();
                                publisher
                                    .submit_reusing(|recycled| tight_i420_frame(&buffer, recycled));
                            }
                        });
                        let reader = RemoteReader {
                            task,
                            presentation: presentation_counters,
                        };
                        if let Some(previous) = readers.lock().unwrap().insert(stream_id, reader) {
                            previous.abort();
                        }
                    }
                    RoomEvent::TrackUnsubscribed { publication, .. }
                    | RoomEvent::TrackUnpublished { publication, .. } => {
                        let stream_id = remote_stream_id(&publication.sid().to_string());
                        if let Some(reader) = readers.lock().unwrap().remove(&stream_id) {
                            reader.abort();
                        }
                        hub.remove_stream(&stream_id);
                    }
                    RoomEvent::ParticipantDisconnected(participant) => {
                        let track_ids: Vec<String> = participant
                            .track_publications()
                            .values()
                            .filter(|publication| publication.kind() == TrackKind::Video)
                            .map(|publication| remote_stream_id(&publication.sid().to_string()))
                            .collect();
                        let mut active_readers = readers.lock().unwrap();
                        for stream_id in track_ids {
                            if let Some(reader) = active_readers.remove(&stream_id) {
                                reader.abort();
                            }
                            hub.remove_stream(&stream_id);
                        }
                    }
                    RoomEvent::Reconnecting => {
                        connected.store(false, Ordering::Release);
                    }
                    RoomEvent::Reconnected => {
                        connected.store(true, Ordering::Release);
                        // A full reconnect is a new participant with no attributes. Flagged,
                        // not locked: a send stuck on the dead connection holds the lock.
                        watching.invalidated.store(true, Ordering::Release);
                        resend_lost_subscriptions(&runtime, &room);
                    }
                    RoomEvent::Disconnected { reason } => {
                        connected.store(false, Ordering::Release);
                        for (stream_id, reader) in readers.lock().unwrap().drain() {
                            reader.abort();
                            hub.remove_stream(&stream_id);
                        }
                        clear_viewer_state(&app, &shared_state);
                        if reason != DisconnectReason::ClientInitiated {
                            mark_session_lost(&app, &shared_state, reason);
                        }
                        break;
                    }
                    _ => {}
                }
                reflect_viewer_state(&app, &shared_state, &room);
                sync_watching(&runtime, &room, &watching);
            }
            connected.store(false, Ordering::Release);
            if let Some(shared_state) = shared.upgrade() {
                clear_viewer_state(&app, &shared_state);
            }
        })
    }

    fn spawn_event_loop(
        &mut self,
        app: &AppHandle,
        shared: &SharedVideoEngineState,
        mut events: mpsc::UnboundedReceiver<RoomEvent>,
    ) -> JoinHandle<()> {
        // The publisher never subscribes, so most events are simply drained (the receiver
        // is unbounded). Only the connection lifecycle matters here.
        let app = app.clone();
        let shared = Arc::downgrade(shared);
        let connected = Arc::clone(&self.link.connected);
        let handle = self.handle();
        let resync_handle = handle.clone();
        handle.spawn(async move {
            while let Some(event) = events.recv().await {
                match event {
                    RoomEvent::Reconnected => {
                        // A full reconnect republishes inside the SDK; reconcile restores
                        // anything that did not come back.
                        if let Some(shared) = shared.upgrade() {
                            let app = app.clone();
                            resync_handle.spawn(async move {
                                crate::video::state::resync_video(&app, &shared).await;
                            });
                        }
                    }
                    RoomEvent::Disconnected { reason } => {
                        connected.store(false, Ordering::Release);
                        if reason != DisconnectReason::ClientInitiated {
                            if let Some(shared) = shared.upgrade() {
                                mark_session_lost(&app, &shared, reason);
                            }
                        }
                        break;
                    }
                    _ => {}
                }
            }
        })
    }
}

/// The attribute value for the user's shares: the pause reason of a published, paused
/// screen share, or "" when none is paused.
fn share_paused_attribute(sources: &[VideoSourceState]) -> String {
    sources
        .iter()
        .filter(|source| {
            source.publishing
                && VideoTrackSource::from_kind(source.kind) == VideoTrackSource::Screenshare
                && source.runtime.status == VideoSourceRuntimeStatus::Paused
        })
        .find_map(|source| source.runtime.paused_reason)
        .map(|reason| reason.attribute_value().to_string())
        .unwrap_or_default()
}

/// Record that a video role lost the room for good, so the app can rejoin.
fn mark_session_lost(app: &AppHandle, shared: &SharedVideoEngineState, reason: DisconnectReason) {
    let (_, _, recoverable) = crate::audio::engine::describe_disconnect(reason);
    let snapshot = {
        let Ok(mut state) = shared.write() else {
            return;
        };
        state.mixer.session_lost = true;
        state.mixer.session_lost_fatal |= !recoverable;
        state.snapshot()
    };
    let _ = app.emit(VIDEO_STATE_CHANGED_EVENT, snapshot);
}

fn clear_viewer_state(app: &AppHandle, shared: &SharedVideoEngineState) {
    let snapshot = {
        let Ok(mut state) = shared.write() else {
            return;
        };
        state.mixer.viewer_connected = false;
        state.mixer.participants.clear();
        state.mixer.remote_tracks.clear();
        state.snapshot()
    };
    let _ = app.emit(VIDEO_STATE_CHANGED_EVENT, snapshot);
}

fn desired_viewer_subscription(
    shared: &SharedVideoEngineState,
    room: &Room,
    participant_identity: &str,
    kind: TrackKind,
    source: TrackSource,
) -> bool {
    let source = video_track_source(source);
    let participant_id = base_participant_identity(participant_identity);
    let local_id = base_participant_identity(&room.local_participant().identity().0).to_string();
    let Ok(state) = shared.read() else {
        return false;
    };
    let preference = source.and_then(|source| {
        state
            .remote_preferences
            .get(&subscription_key(participant_id, source))
            .copied()
    });
    should_receive_video(
        &local_id,
        participant_identity,
        kind,
        source,
        state.mixer.self_preview_mode,
        preference,
    )
}

fn should_receive_video(
    local_id: &str,
    participant_identity: &str,
    kind: TrackKind,
    source: Option<VideoTrackSource>,
    self_preview_mode: SelfPreviewMode,
    remote_preference: Option<bool>,
) -> bool {
    if kind != TrackKind::Video || source.is_none() || participant_identity.ends_with("#audio") {
        return false;
    }
    if base_participant_identity(participant_identity) == base_participant_identity(local_id) {
        return self_preview_mode == SelfPreviewMode::Rtc;
    }
    // Cameras arrive unless someone hides them; screen shares are opt-in (Watch), so an
    // unwatched share costs neither download bandwidth nor a software decode.
    remote_preference.unwrap_or(source != Some(VideoTrackSource::Screenshare))
}

fn reflect_viewer_state(app: &AppHandle, shared: &SharedVideoEngineState, room: &Room) {
    let local_id = base_participant_identity(&room.local_participant().identity().0).to_string();
    let mut participants = BTreeMap::<String, VideoParticipantState>::new();
    participants.insert(
        local_id.clone(),
        VideoParticipantState {
            participant_id: local_id.clone(),
            display_name: room.local_participant().name(),
            is_local: true,
            audio_muted: true,
            speaking: room.local_participant().is_speaking(),
            connection_quality: connection_quality(room.local_participant().connection_quality()),
            watching: Vec::new(),
        },
    );
    let mut tracks = Vec::new();
    for participant in room.remote_participants().values() {
        let identity = participant.identity().0;
        let participant_id = base_participant_identity(&identity).to_string();
        let is_self = participant_id == local_id;
        let display_name = if participant.name().is_empty() {
            participant_id.clone()
        } else {
            participant.name()
        };
        let entry = participants
            .entry(participant_id.clone())
            .or_insert_with(|| VideoParticipantState {
                participant_id: participant_id.clone(),
                display_name: display_name.clone(),
                is_local: is_self,
                audio_muted: true,
                speaking: false,
                connection_quality: VideoConnectionQuality::Unknown,
                watching: Vec::new(),
            });
        if entry.display_name.is_empty() || entry.display_name == entry.participant_id {
            entry.display_name = display_name.clone();
        }
        entry.speaking |= participant.is_speaking();
        if let Some(value) = participant.attributes().get(WATCHING_ATTRIBUTE) {
            for sharer in decode_watching(value) {
                if sharer != participant_id && !entry.watching.contains(&sharer) {
                    entry.watching.push(sharer);
                }
            }
            entry.watching.sort_unstable();
        }
        let share_paused = participant
            .attributes()
            .get(SHARE_PAUSED_ATTRIBUTE)
            .and_then(|value| VideoPauseReason::from_attribute_value(value));
        entry.connection_quality = worse_quality(
            entry.connection_quality,
            connection_quality(participant.connection_quality()),
        );

        for publication in participant.track_publications().values() {
            if publication.kind() == TrackKind::Audio
                && publication.source() == TrackSource::Microphone
                && !publication.is_muted()
            {
                entry.audio_muted = false;
            }
            let Some(source) = video_track_source(publication.source()) else {
                continue;
            };
            if publication.kind() != TrackKind::Video {
                continue;
            }
            tracks.push(RemoteVideoTrackState {
                stream_id: remote_stream_id(&publication.sid().to_string()),
                participant_id: participant_id.clone(),
                display_name: display_name.clone(),
                source,
                muted: publication.is_muted(),
                subscribed: publication.is_subscribed(),
                desired: publication.is_desired(),
                is_self,
                paused_reason: if source == VideoTrackSource::Screenshare {
                    share_paused
                } else {
                    None
                },
            });
        }
    }
    tracks.sort_by(|left, right| {
        left.participant_id
            .cmp(&right.participant_id)
            .then_with(|| format!("{:?}", left.source).cmp(&format!("{:?}", right.source)))
    });
    let snapshot = {
        let participants: Vec<_> = participants.into_values().collect();
        let Ok(mut state) = shared.write() else {
            return;
        };
        // Runs after every room event (speaking changes many times a second): an unchanged
        // view is neither written nor sent to the WebView.
        if state.mixer.viewer_connected
            && state.mixer.participants == participants
            && state.mixer.remote_tracks == tracks
        {
            return;
        }
        state.mixer.viewer_connected = true;
        state.mixer.participants = participants;
        state.mixer.remote_tracks = tracks;
        state.snapshot()
    };
    let _ = app.emit(VIDEO_STATE_CHANGED_EVENT, snapshot);
}

fn tight_i420_frame(buffer: &I420Buffer, recycled: Option<I420Frame>) -> I420Frame {
    let width = buffer.width();
    let height = buffer.height();
    let chroma_width = buffer.chroma_width();
    let chroma_height = buffer.chroma_height();
    let (stride_y, stride_u, stride_v) = buffer.strides();
    let (source_y, source_u, source_v) = buffer.data();
    let mut output = recycled.unwrap_or(I420Frame {
        width,
        height,
        y: Vec::new(),
        u: Vec::new(),
        v: Vec::new(),
    });
    output.width = width;
    output.height = height;
    copy_tight_plane(source_y, stride_y, width, height, &mut output.y);
    copy_tight_plane(
        source_u,
        stride_u,
        chroma_width,
        chroma_height,
        &mut output.u,
    );
    copy_tight_plane(
        source_v,
        stride_v,
        chroma_width,
        chroma_height,
        &mut output.v,
    );
    output
}

fn copy_tight_plane(source: &[u8], stride: u32, width: u32, height: u32, output: &mut Vec<u8>) {
    output.resize((width * height) as usize, 0);
    for row in 0..height as usize {
        let source_start = row * stride as usize;
        let target_start = row * width as usize;
        let count = width as usize;
        if source_start + count <= source.len() {
            output[target_start..target_start + count]
                .copy_from_slice(&source[source_start..source_start + count]);
        }
    }
}

fn video_track_source(source: TrackSource) -> Option<VideoTrackSource> {
    match source {
        TrackSource::Camera => Some(VideoTrackSource::Camera),
        TrackSource::Screenshare => Some(VideoTrackSource::Screenshare),
        _ => None,
    }
}

fn base_participant_identity(identity: &str) -> &str {
    identity
        .strip_suffix("#audio")
        .or_else(|| identity.strip_suffix("#video"))
        .unwrap_or(identity)
}

pub fn subscription_key(participant_id: &str, source: VideoTrackSource) -> String {
    format!("{participant_id}:{source:?}")
}

fn remote_stream_id(track_sid: &str) -> String {
    format!("remote-{track_sid}")
}

fn connection_quality(quality: ConnectionQuality) -> VideoConnectionQuality {
    match quality {
        ConnectionQuality::Excellent => VideoConnectionQuality::Excellent,
        ConnectionQuality::Good => VideoConnectionQuality::Good,
        ConnectionQuality::Poor => VideoConnectionQuality::Poor,
        ConnectionQuality::Lost => VideoConnectionQuality::Lost,
    }
}

fn worse_quality(
    left: VideoConnectionQuality,
    right: VideoConnectionQuality,
) -> VideoConnectionQuality {
    fn rank(value: VideoConnectionQuality) -> u8 {
        match value {
            VideoConnectionQuality::Lost => 5,
            VideoConnectionQuality::Poor => 4,
            VideoConnectionQuality::Unknown => 3,
            VideoConnectionQuality::Good => 2,
            VideoConnectionQuality::Excellent => 1,
        }
    }
    if rank(right) > rank(left) {
        right
    } else {
        left
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::domain::{VideoSourceKind, VideoSourceRuntimeState};

    #[test]
    fn watched_owners_are_other_people_sorted_and_unique() {
        let shares = vec![
            ("bob".to_string(), true),
            ("alice#video".to_string(), true),
            ("alice".to_string(), true),
            ("carol".to_string(), false),
            ("me#video".to_string(), true),
        ];
        assert_eq!(
            watched_owners("me", shares.into_iter()),
            vec!["alice".to_string(), "bob".to_string()]
        );
        assert!(watched_owners("me", std::iter::empty()).is_empty());
    }

    fn share(kind: VideoSourceKind, status: VideoSourceRuntimeStatus) -> VideoSourceState {
        let mut source = VideoSourceState::new(kind, "Notepad", "1234");
        source.publishing = true;
        source.runtime = VideoSourceRuntimeState {
            status,
            paused_reason: (status == VideoSourceRuntimeStatus::Paused)
                .then_some(VideoPauseReason::Minimized),
            ..VideoSourceRuntimeState::default()
        };
        source
    }

    #[test]
    fn the_paused_attribute_follows_a_published_share_through_pause_and_resume() {
        use VideoSourceRuntimeStatus::*;
        let camera = share(VideoSourceKind::Camera, Running);
        let live = [camera.clone(), share(VideoSourceKind::Window, Running)];
        assert_eq!(share_paused_attribute(&live), "");
        let paused = [camera.clone(), share(VideoSourceKind::Window, Paused)];
        assert_eq!(share_paused_attribute(&paused), "minimized");
        // Stopping the share clears it.
        assert_eq!(share_paused_attribute(&[camera]), "");
        // A share that is no longer published says nothing.
        let mut unpublished = share(VideoSourceKind::Window, Paused);
        unpublished.publishing = false;
        assert_eq!(share_paused_attribute(&[unpublished]), "");
        assert_eq!(
            VideoPauseReason::from_attribute_value("minimized"),
            Some(VideoPauseReason::Minimized)
        );
        assert_eq!(VideoPauseReason::from_attribute_value(""), None);
    }

    fn sample(at: Instant, frames: u64, bytes: u64, received: u64, lost: i64) -> StreamSample {
        StreamSample {
            at,
            frames_received: frames,
            frames_decoded: frames,
            shown: frames / 2,
            bytes_received: bytes,
            packets_received: received,
            packets_lost: lost,
            encoded: frames / 2,
            encode_micros: frames / 2 * 4_000,
            rates: StreamRates::default(),
        }
    }

    #[test]
    fn stream_rates_come_from_deltas_and_short_windows_reuse_the_last_rates() {
        let cache = VideoStreamStatsCache::default();
        let start = Instant::now();
        let first = cache.rates_for("remote-a", sample(start, 0, 0, 0, 0));
        assert!(first.received_fps.is_none());

        let one_second = start + Duration::from_secs(1);
        let rates = cache.rates_for("remote-a", sample(one_second, 30, 250_000, 99, 1));
        assert_eq!(rates.received_fps, Some(30.0));
        assert_eq!(rates.shown_fps, Some(15.0));
        assert_eq!(rates.bitrate_bps, Some(2_000_000.0));
        assert_eq!(rates.loss_fraction, Some(0.01));
        assert_eq!(rates.encode_ms, Some(4.0));

        // A second poller 100 ms later sees the same rates, and the baseline is kept.
        let soon = one_second + Duration::from_millis(100);
        let repeated = cache.rates_for("remote-a", sample(soon, 33, 260_000, 105, 1));
        assert_eq!(repeated.received_fps, Some(30.0));
        let later = one_second + Duration::from_secs(1);
        let next = cache.rates_for("remote-a", sample(later, 90, 500_000, 199, 1));
        assert_eq!(next.received_fps, Some(60.0));

        cache.retain(&HashSet::new());
        assert!(cache
            .rates_for("remote-a", sample(later, 0, 0, 0, 0))
            .received_fps
            .is_none());
    }

    #[test]
    fn self_video_is_received_only_for_rtc_preview() {
        assert!(!should_receive_video(
            "person",
            "person#video",
            TrackKind::Video,
            Some(VideoTrackSource::Camera),
            SelfPreviewMode::Local,
            None,
        ));
        assert!(should_receive_video(
            "person",
            "person#video",
            TrackKind::Video,
            Some(VideoTrackSource::Camera),
            SelfPreviewMode::Rtc,
            None,
        ));
    }

    #[test]
    fn audio_and_audio_sidecars_never_enter_the_video_viewer() {
        assert!(!should_receive_video(
            "person",
            "other",
            TrackKind::Audio,
            Some(VideoTrackSource::Camera),
            SelfPreviewMode::Rtc,
            None,
        ));
        assert!(!should_receive_video(
            "person",
            "other#audio",
            TrackKind::Video,
            Some(VideoTrackSource::Camera),
            SelfPreviewMode::Rtc,
            None,
        ));
    }

    #[test]
    fn remote_cameras_default_on_and_respect_preferences() {
        let receive = |preference| {
            should_receive_video(
                "person",
                "other#video",
                TrackKind::Video,
                Some(VideoTrackSource::Camera),
                SelfPreviewMode::Local,
                preference,
            )
        };
        assert!(receive(None));
        assert!(!receive(Some(false)));
        assert!(receive(Some(true)));
    }

    #[test]
    fn remote_screen_shares_are_received_only_when_watched() {
        let receive = |preference| {
            should_receive_video(
                "person",
                "other#video",
                TrackKind::Video,
                Some(VideoTrackSource::Screenshare),
                SelfPreviewMode::Local,
                preference,
            )
        };
        assert!(!receive(None));
        assert!(receive(Some(true)));
        assert!(!receive(Some(false)));
    }

    #[test]
    fn own_screen_share_follows_self_preview_not_the_watch_default() {
        let receive = |mode| {
            should_receive_video(
                "person",
                "person#video",
                TrackKind::Video,
                Some(VideoTrackSource::Screenshare),
                mode,
                None,
            )
        };
        assert!(receive(SelfPreviewMode::Rtc));
        assert!(!receive(SelfPreviewMode::Local));
    }
}
