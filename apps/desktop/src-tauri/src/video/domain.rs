//! Serde types for the native video engine.
//!
//! Mirrors the shape of [`crate::audio::domain`] but for camera / screen-share capture.
//! Rust owns the complete video path: a `<userId>#video` publisher plus the base-identity
//! viewer used for remote media and optional RTC self-preview. The WebView receives only
//! reflected state and bounded presentation URLs; it never owns a WebRTC track or room.

use std::fmt;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::audio::domain::AudioSourceId;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct VideoSourceId(Uuid);

impl VideoSourceId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }

    pub fn parse(value: &str) -> Option<Self> {
        Uuid::parse_str(value).ok().map(Self)
    }
}

impl Default for VideoSourceId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for VideoSourceId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PublishedVideoTrackId(Uuid);

impl PublishedVideoTrackId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for PublishedVideoTrackId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for PublishedVideoTrackId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

/// What kind of visual source a local video track captures.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VideoSourceKind {
    /// A webcam / capture device.
    Camera,
    /// A whole monitor / display.
    Display,
    /// A single application window.
    Window,
}

impl Default for VideoSourceKind {
    fn default() -> Self {
        Self::Camera
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VideoSourceRuntimeStatus {
    Inactive,
    Starting,
    Running,
    /// Capture has nothing to show for now (a shared window is minimized). The share stays
    /// published and keeps sending its last picture until capture resumes by itself.
    Paused,
    Error,
}

impl Default for VideoSourceRuntimeStatus {
    fn default() -> Self {
        Self::Inactive
    }
}

/// Why a share is paused, for the sharer (runtime state) and viewers (participant attribute).
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VideoPauseReason {
    /// The shared window is minimized; Windows does not draw it, so nothing can capture it.
    Minimized,
}

impl VideoPauseReason {
    /// Value of [`SHARE_PAUSED_ATTRIBUTE`] on the publisher participant.
    pub fn attribute_value(self) -> &'static str {
        match self {
            Self::Minimized => "minimized",
        }
    }

    pub fn from_attribute_value(value: &str) -> Option<Self> {
        match value {
            "minimized" => Some(Self::Minimized),
            _ => None,
        }
    }
}

/// Participant attribute on `<userId>#video` telling viewers that its screen share is
/// paused, and why. An empty value (LiveKit's way of deleting an attribute) means live.
pub const SHARE_PAUSED_ATTRIBUTE: &str = "raven.share.paused";

/// Participant attribute on the native viewer (`<userId>`) listing whose screen shares the
/// user is watching, as a comma-separated list of user ids. It lives and dies with the
/// viewer's connection, so a closed app stops "watching" at once. An empty value means none.
pub const WATCHING_ATTRIBUTE: &str = "raven.watching";

const MAX_WATCHED_SHARES: usize = 32;
const MAX_WATCHED_ID_LEN: usize = 64;

/// The attribute value for a set of watched sharers: sorted, unique, comma-separated.
pub fn encode_watching<S: AsRef<str>>(sharers: &[S]) -> String {
    let mut ids: Vec<&str> = sharers
        .iter()
        .map(AsRef::as_ref)
        .filter(|id| is_watchable_id(id))
        .collect();
    ids.sort_unstable();
    ids.dedup();
    ids.truncate(MAX_WATCHED_SHARES);
    ids.join(",")
}

/// Read a [`WATCHING_ATTRIBUTE`] value from another client. Anything that is not a plain
/// user id is dropped, so a malformed or hostile value cannot grow or confuse the list.
pub fn decode_watching(value: &str) -> Vec<String> {
    let mut ids: Vec<String> = value
        .split(',')
        .map(str::trim)
        .filter(|id| is_watchable_id(id))
        .map(str::to_string)
        .collect();
    ids.sort_unstable();
    ids.dedup();
    ids.truncate(MAX_WATCHED_SHARES);
    ids
}

fn is_watchable_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_WATCHED_ID_LEN
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct VideoSourceRuntimeState {
    pub status: VideoSourceRuntimeStatus,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f32>,
    /// Set while `status` is `Paused`.
    pub paused_reason: Option<VideoPauseReason>,
    pub error: Option<String>,
    pub updated_at: Option<String>,
}

impl Default for VideoSourceRuntimeState {
    fn default() -> Self {
        Self {
            status: VideoSourceRuntimeStatus::Inactive,
            width: None,
            height: None,
            fps: None,
            paused_reason: None,
            error: None,
            updated_at: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VideoQualityProfileId {
    Presentation,
    High,
    HighMotion,
    Balanced,
    Low,
    Custom,
}

impl Default for VideoQualityProfileId {
    fn default() -> Self {
        Self::Balanced
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct VideoQualityProfile {
    pub profile_id: VideoQualityProfileId,
    pub max_pixels: u32,
    pub width: u32,
    pub height: u32,
    pub fps: f32,
}

impl VideoQualityProfile {
    pub fn presentation() -> Self {
        Self {
            profile_id: VideoQualityProfileId::Presentation,
            max_pixels: 1920 * 1080,
            width: 1920,
            height: 1080,
            fps: 10.0,
        }
    }

    pub fn high() -> Self {
        Self {
            profile_id: VideoQualityProfileId::High,
            max_pixels: 1920 * 1080,
            width: 1920,
            height: 1080,
            fps: 30.0,
        }
    }

    pub fn high_motion() -> Self {
        Self {
            profile_id: VideoQualityProfileId::HighMotion,
            max_pixels: 1280 * 720,
            width: 1280,
            height: 720,
            fps: 60.0,
        }
    }

    pub fn balanced() -> Self {
        Self {
            profile_id: VideoQualityProfileId::Balanced,
            max_pixels: 1280 * 720,
            width: 1280,
            height: 720,
            fps: 30.0,
        }
    }

    pub fn low() -> Self {
        Self {
            profile_id: VideoQualityProfileId::Low,
            max_pixels: 854 * 480,
            width: 854,
            height: 480,
            fps: 15.0,
        }
    }

    pub fn custom(width: u32, height: u32, fps: f32) -> Self {
        Self {
            profile_id: VideoQualityProfileId::Custom,
            max_pixels: width.saturating_mul(height).max(2 * 2),
            width,
            height,
            fps,
        }
        .normalized()
    }

    pub fn normalized(self) -> Self {
        match self.profile_id {
            VideoQualityProfileId::Presentation => Self::presentation(),
            VideoQualityProfileId::High => Self::high(),
            VideoQualityProfileId::HighMotion => Self::high_motion(),
            VideoQualityProfileId::Balanced => Self::balanced(),
            VideoQualityProfileId::Low => Self::low(),
            VideoQualityProfileId::Custom => {
                let width = even_dimension(self.width.clamp(2, 7680));
                let height = even_dimension(self.height.clamp(2, 4320));
                Self {
                    profile_id: VideoQualityProfileId::Custom,
                    // Custom dimensions are the contract. Do not accept a detached pixel
                    // budget that can silently cause a different output resolution.
                    max_pixels: width.saturating_mul(height).max(2 * 2),
                    width,
                    height,
                    fps: if self.fps.is_finite() {
                        self.fps.clamp(1.0, 120.0)
                    } else {
                        30.0
                    },
                }
            }
        }
    }

    pub fn resolved_for_source(self, source_width: u32, source_height: u32) -> Self {
        let profile = self.normalized();
        if source_width == 0 || source_height == 0 {
            return profile;
        }
        let (width, height) =
            output_dimensions_for_budget(source_width, source_height, profile.max_pixels);
        Self {
            width,
            height,
            ..profile
        }
    }

    pub fn publish_tuning(&self, source: VideoTrackSource) -> VideoPublishTuning {
        // The source state has already been normalized at its command boundary and display /
        // window shares have additionally been resolved to their source aspect ratio. Re-running
        // preset normalization here would turn (for example) a 1366×768 share back into 1080p
        // and make the native source, scaler, and encoder disagree.
        VideoPublishTuning::from_profile(source, self.clone())
    }
}

fn even_dimension(value: u32) -> u32 {
    value.saturating_sub(value % 2).max(2)
}

pub fn output_dimensions_for_budget(
    source_width: u32,
    source_height: u32,
    max_pixels: u32,
) -> (u32, u32) {
    let source_pixels = source_width.saturating_mul(source_height).max(1) as f64;
    let scale = (max_pixels.max(2 * 2) as f64 / source_pixels)
        .sqrt()
        .min(1.0);
    let mut width = even_dimension((source_width as f64 * scale).round() as u32);
    let mut height = even_dimension((source_height as f64 * scale).round() as u32);
    while width.saturating_mul(height) > max_pixels.max(2 * 2) {
        if width >= height && width > 2 {
            width = width.saturating_sub(2);
        } else if height > 2 {
            height = height.saturating_sub(2);
        } else {
            break;
        }
    }
    (width, height)
}

impl Default for VideoQualityProfile {
    fn default() -> Self {
        Self::balanced()
    }
}

/// LiveKit-facing classification of a published video track. Camera maps to the Camera
/// source; both display and window maps to Screenshare so peers render them as a screen.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VideoTrackSource {
    Camera,
    Screenshare,
}

impl VideoTrackSource {
    pub fn from_kind(kind: VideoSourceKind) -> Self {
        match kind {
            VideoSourceKind::Camera => Self::Camera,
            VideoSourceKind::Display | VideoSourceKind::Window => Self::Screenshare,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoPublishTuning {
    pub source: VideoTrackSource,
    pub width: u32,
    pub height: u32,
    pub frame_rate: f64,
    pub max_bitrate_bps: u64,
    pub simulcast: bool,
}

impl VideoPublishTuning {
    fn from_profile(source: VideoTrackSource, profile: VideoQualityProfile) -> Self {
        // The installed LiveKit Rust SDK exposes bitrate, framerate, resolution, and
        // simulcast controls, but not WebRTC content hints or degradation preference.
        // Keep this tuning structure limited to settings that reach the published track.
        let max_bitrate_bps = match profile.profile_id {
            VideoQualityProfileId::Presentation => 4_000_000,
            VideoQualityProfileId::High => 6_000_000,
            VideoQualityProfileId::HighMotion => 6_000_000,
            VideoQualityProfileId::Balanced => 2_500_000,
            VideoQualityProfileId::Low => 750_000,
            VideoQualityProfileId::Custom => {
                estimate_custom_bitrate(profile.width, profile.height, profile.fps, source)
            }
        };
        let simulcast = matches!(source, VideoTrackSource::Camera)
            && !matches!(
                profile.profile_id,
                VideoQualityProfileId::Low | VideoQualityProfileId::Presentation
            )
            && profile.width.max(profile.height) >= 960;

        Self {
            source,
            width: profile.width,
            height: profile.height,
            frame_rate: f64::from(profile.fps),
            max_bitrate_bps,
            simulcast,
        }
    }
}

fn estimate_custom_bitrate(width: u32, height: u32, fps: f32, source: VideoTrackSource) -> u64 {
    let pixels = f64::from(width.max(2)) * f64::from(height.max(2));
    let frame_rate = f64::from(fps.clamp(1.0, 120.0));
    let bits_per_pixel = match source {
        VideoTrackSource::Camera => 0.10,
        VideoTrackSource::Screenshare => 0.12,
    };
    let bitrate = (pixels * frame_rate * bits_per_pixel) as u64;
    bitrate.clamp(300_000, 8_000_000)
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PublishedVideoTrack {
    pub track_id: PublishedVideoTrackId,
    pub webrtc_track_id: String,
    pub source: VideoTrackSource,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

impl Default for PublishedVideoTrack {
    fn default() -> Self {
        Self {
            track_id: PublishedVideoTrackId::new(),
            webrtc_track_id: String::new(),
            source: VideoTrackSource::Camera,
            created_at: None,
            updated_at: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct VideoSourceState {
    pub id: VideoSourceId,
    pub kind: VideoSourceKind,
    pub display_name: String,
    /// The capture target: camera device id, monitor id, or window handle (as a string).
    pub target_id: String,
    /// Owning process id, when known (window shares). Used to link the app's audio.
    pub process_id: Option<u32>,
    pub enabled: bool,
    pub publishing: bool,
    pub profile: VideoQualityProfile,
    pub runtime: VideoSourceRuntimeState,
    /// When this share also captures audio, the id of the audio mixer source it created.
    pub linked_audio_source_id: Option<AudioSourceId>,
    pub published_track: Option<PublishedVideoTrack>,
}

impl VideoSourceState {
    pub fn new(
        kind: VideoSourceKind,
        display_name: impl Into<String>,
        target_id: impl Into<String>,
    ) -> Self {
        Self {
            id: VideoSourceId::new(),
            kind,
            display_name: display_name.into(),
            target_id: target_id.into(),
            process_id: None,
            enabled: true,
            publishing: false,
            profile: VideoQualityProfile::default(),
            runtime: VideoSourceRuntimeState::default(),
            linked_audio_source_id: None,
            published_track: None,
        }
    }
}

impl Default for VideoSourceState {
    fn default() -> Self {
        Self::new(VideoSourceKind::Camera, "Camera", String::new())
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct VideoMixerState {
    pub connected: bool,
    pub local_sources: Vec<VideoSourceState>,
    pub viewer_connected: bool,
    pub self_preview_mode: SelfPreviewMode,
    pub presentation: VideoPresentationSettings,
    pub participants: Vec<VideoParticipantState>,
    pub remote_tracks: Vec<RemoteVideoTrackState>,
    /// True once either video role lost the room for good (not merely reconnecting), until
    /// the next connect. The app uses it to rejoin with fresh tokens.
    pub session_lost: bool,
    /// The loss can't be healed by rejoining (signed in elsewhere, removed, room closed).
    pub session_lost_fatal: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SelfPreviewMode {
    #[default]
    Local,
    Rtc,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VideoPresentationProfile {
    Efficiency,
    #[default]
    Balanced,
    Quality,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct VideoPresentationSettings {
    pub profile: VideoPresentationProfile,
}

impl Default for VideoPresentationSettings {
    fn default() -> Self {
        Self {
            profile: VideoPresentationProfile::Balanced,
        }
    }
}

impl VideoPresentationSettings {
    pub fn limits_for(&self, source: VideoTrackSource) -> (u32, u32, u32, f32) {
        // The frame service is only the local WebView presentation bridge. A share must not
        // inherit the lower camera-preview cap selected for a compact Raven UI: it always
        // gets full 1080p at high quality so text stays readable. Only its frame rate
        // follows the chosen presentation profile. The caps sit at or above what shares are
        // sent at (30 fps, 60 for High motion), so by default a share is shown at the rate
        // it arrives: a 1080p JPEG costs about 13 ms in an optimised build, so 30 fps is
        // under half a core and 60 fps under one.
        if matches!(source, VideoTrackSource::Screenshare) {
            let frame_rate = match self.profile {
                VideoPresentationProfile::Efficiency => 15,
                VideoPresentationProfile::Balanced => 30,
                VideoPresentationProfile::Quality => 60,
            };
            return (1920, 1080, frame_rate, 92.0);
        }
        match self.profile {
            VideoPresentationProfile::Efficiency => (640, 360, 10, 68.0),
            VideoPresentationProfile::Balanced => (960, 540, 15, 76.0),
            VideoPresentationProfile::Quality => (1280, 720, 30, 84.0),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VideoConnectionQuality {
    Excellent,
    Good,
    Poor,
    Lost,
    #[default]
    Unknown,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct VideoParticipantState {
    pub participant_id: String,
    pub display_name: String,
    pub is_local: bool,
    pub audio_muted: bool,
    pub speaking: bool,
    pub connection_quality: VideoConnectionQuality,
    /// Ids of the people whose screen shares this participant is watching, as they
    /// published it. Empty for you: your own choices are the `desired` flags on `remoteTracks`.
    pub watching: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RemoteVideoTrackState {
    pub stream_id: String,
    pub participant_id: String,
    pub display_name: String,
    pub source: VideoTrackSource,
    pub muted: bool,
    pub subscribed: bool,
    pub desired: bool,
    pub is_self: bool,
    /// The sender's share is paused (their shared window is minimized). The track stays
    /// unmuted and keeps its last picture.
    pub paused_reason: Option<VideoPauseReason>,
}

impl Default for RemoteVideoTrackState {
    fn default() -> Self {
        Self {
            stream_id: String::new(),
            participant_id: String::new(),
            display_name: String::new(),
            source: VideoTrackSource::Camera,
            muted: false,
            subscribed: false,
            desired: false,
            is_self: false,
            paused_reason: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Enumeration results for the picker dialogs
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CameraDevice {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DisplayTarget {
    /// Stable monitor identifier (device name on Windows).
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub is_primary: bool,
    pub thumbnail_data_url: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WindowTarget {
    /// Window handle as a string (HWND on Windows).
    pub id: String,
    pub title: String,
    pub app_name: String,
    pub process_id: u32,
    /// The window's own size; for a minimized window, the size it is restored to.
    pub width: u32,
    pub height: u32,
    /// Minimized windows are not drawn, so they have no thumbnail. Sharing one restores it.
    pub minimized: bool,
    pub icon_data_url: Option<String>,
    pub thumbnail_data_url: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watching_round_trips_sorted_and_unique() {
        let value = encode_watching(&["b2", "a1", "b2", "c3"]);
        assert_eq!(value, "a1,b2,c3");
        assert_eq!(decode_watching(&value), vec!["a1", "b2", "c3"]);
        assert_eq!(encode_watching::<&str>(&[]), "");
        assert!(decode_watching("").is_empty());
    }

    #[test]
    fn watching_drops_values_that_are_not_user_ids() {
        assert_eq!(
            decode_watching(" a1 ,,b 2,c3#video,<script>,d-4_x "),
            vec!["a1", "d-4_x"]
        );
        let long = "x".repeat(MAX_WATCHED_ID_LEN + 1);
        assert!(decode_watching(&long).is_empty());
        assert_eq!(encode_watching(&["ok", "not ok", ""]), "ok");
    }

    #[test]
    fn watching_is_capped() {
        let ids: Vec<String> = (0..100).map(|index| format!("u{index:03}")).collect();
        assert_eq!(decode_watching(&ids.join(",")).len(), MAX_WATCHED_SHARES);
        assert_eq!(
            encode_watching(&ids).split(',').count(),
            MAX_WATCHED_SHARES
        );
    }

    #[test]
    fn presentation_profile_reserves_a_text_readable_screen_share_budget() {
        let profile = VideoQualityProfile::presentation();
        let tuning = profile.publish_tuning(VideoTrackSource::Screenshare);
        assert_eq!(
            (profile.width, profile.height, profile.fps),
            (1920, 1080, 10.0)
        );
        assert_eq!(tuning.max_bitrate_bps, 4_000_000);
        assert!(!tuning.simulcast);
    }

    #[test]
    fn source_budget_preserves_aspect_ratio_without_exceeding_presentation_cap() {
        let resolved = VideoQualityProfile::presentation().resolved_for_source(3840, 2160);
        assert_eq!((resolved.width, resolved.height), (1920, 1080));
    }

    #[test]
    fn named_profiles_canonicalize_to_their_declared_contracts() {
        let cases = [
            (
                VideoQualityProfileId::Presentation,
                VideoQualityProfile::presentation(),
            ),
            (VideoQualityProfileId::High, VideoQualityProfile::high()),
            (
                VideoQualityProfileId::HighMotion,
                VideoQualityProfile::high_motion(),
            ),
            (
                VideoQualityProfileId::Balanced,
                VideoQualityProfile::balanced(),
            ),
            (VideoQualityProfileId::Low, VideoQualityProfile::low()),
        ];

        for (profile_id, expected) in cases {
            let supplied = VideoQualityProfile {
                profile_id,
                max_pixels: 4,
                width: 2,
                height: 2,
                fps: 1.0,
            };
            assert_eq!(supplied.normalized(), expected, "{profile_id:?}");
        }
    }

    #[test]
    fn custom_profile_canonicalizes_dimensions_fps_and_pixel_budget_together() {
        let profile = VideoQualityProfile {
            profile_id: VideoQualityProfileId::Custom,
            max_pixels: 4,
            width: 1281,
            height: 721,
            fps: 30.4,
        }
        .normalized();

        assert_eq!(
            (profile.width, profile.height, profile.fps),
            (1280, 720, 30.4)
        );
        assert_eq!(profile.max_pixels, 1280 * 720);
    }

    #[test]
    fn publish_tuning_keeps_a_resolved_share_dimensions_and_all_preset_budgets() {
        let resolved = VideoQualityProfile::high().resolved_for_source(1366, 768);
        let tuning = resolved.publish_tuning(VideoTrackSource::Screenshare);
        assert_eq!(
            (tuning.width, tuning.height, tuning.frame_rate),
            (1366, 768, 30.0)
        );

        let cases = [
            (VideoQualityProfile::presentation(), 4_000_000),
            (VideoQualityProfile::high(), 6_000_000),
            (VideoQualityProfile::high_motion(), 6_000_000),
            (VideoQualityProfile::balanced(), 2_500_000),
            (VideoQualityProfile::low(), 750_000),
        ];
        for (profile, bitrate) in cases {
            assert_eq!(
                profile
                    .publish_tuning(VideoTrackSource::Screenshare)
                    .max_bitrate_bps,
                bitrate
            );
        }
    }

    #[test]
    fn custom_share_bitrate_uses_the_same_dimensions_and_fps_as_its_publish_tuning() {
        let tuning = VideoQualityProfile::custom(1280, 720, 30.0)
            .publish_tuning(VideoTrackSource::Screenshare);
        assert_eq!(
            (tuning.width, tuning.height, tuning.frame_rate),
            (1280, 720, 30.0)
        );
        assert_eq!(tuning.max_bitrate_bps, 3_317_760);
    }
}
