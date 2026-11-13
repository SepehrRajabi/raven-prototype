//! Tauri command surface + shared state for the native video engine.
//!
//! Mirrors [`crate::audio::state`] for native publish and receive ownership. Each mutation runs through
//! [`mutate_video_state`], which reconciles LiveKit publications and capture runtimes and
//! emits `video-state-changed` with the full [`VideoMixerState`] snapshot.
//!
//! Screen / window shares that opt to also capture audio reach into the **audio** engine
//! via [`crate::audio::state::add_and_publish_shared_audio_source`], so the shared audio
//! shows up as a normal mixer channel. The audio mutation is performed before the video
//! state lock is taken (never nested), keeping a single, deadlock-free lock order.
//!
//! As in the audio engine, network and device work lives behind a separate async `ops`
//! lock ([`VideoRuntime`]); the state lock only ever guards the data model and is never
//! held across a LiveKit handshake or a capture start.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::Ordering;
use std::sync::{Arc, RwLock};

use tokio::sync::Mutex as AsyncMutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use thiserror::Error;

use crate::audio::capture::system_audio_runtime_readiness;
use crate::audio::domain::{AudioSourceId, AudioSourceType};
use crate::audio::state::{
    add_and_publish_shared_audio_source, linked_app_audio_name, remove_shared_audio_source,
    resolve_app_identity, AudioStateError, SharedAudioEngineState,
};
use crate::video::capture::{
    list_cameras, list_displays, list_windows, screen_capture_runtime_readiness, window_share_size,
    CaptureEvent, CaptureEvents, VideoCaptureError, VideoCaptureManager,
};
use crate::video::domain::{
    CameraDevice, DisplayTarget, PublishedVideoTrack, PublishedVideoTrackId, SelfPreviewMode,
    VideoMixerState, VideoPresentationProfile, VideoPresentationSettings, VideoQualityProfile,
    VideoSourceId, VideoSourceKind, VideoSourceRuntimeStatus, VideoSourceState, VideoTrackSource,
    WindowTarget,
};
use crate::video::engine::{
    measure_video_network_totals, measure_video_quality_report, measure_video_stream_stats,
    stable_video_track_id, subscription_key, VideoCaptureFrameCounts, VideoEngine, VideoLinkFlags,
    VideoNetworkTotals, VideoQualityReport, VideoStreamStats,
};
use crate::video::preview::VideoPreviewController;
use crate::video::stream::{VideoFrameHub, VideoFrameService, VideoStreamEndpoint};

pub const VIDEO_STATE_CHANGED_EVENT: &str = "video-state-changed";

pub type SharedVideoEngineState = Arc<RwLock<VideoEngineState>>;

pub fn new_shared_video_engine_state(hub: VideoFrameHub) -> SharedVideoEngineState {
    Arc::new(RwLock::new(VideoEngineState::new(hub)))
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeVideoCapabilityReport {
    pub os: String,
    pub issues: Vec<String>,
    pub supported_source_kinds: Vec<VideoSourceKind>,
    pub supports_camera: bool,
    pub supports_display_capture: bool,
    pub supports_window_capture: bool,
    pub supports_display_audio: bool,
    pub supports_window_audio: bool,
}

/// The side-effecting half of the video engine (LiveKit rooms + capture runtimes), kept
/// behind its own async lock. Lock order: `ops` first, then the state lock.
pub struct VideoRuntime {
    ops: AsyncMutex<VideoOps>,
    link: VideoLinkFlags,
}

pub struct VideoOps {
    pub engine: VideoEngine,
    pub capture: VideoCaptureManager,
}

impl std::fmt::Debug for VideoRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VideoRuntime").finish_non_exhaustive()
    }
}

#[derive(Debug)]
pub struct VideoEngineState {
    pub mixer: VideoMixerState,
    pub runtime: Arc<VideoRuntime>,
    pub preview: VideoPreviewController,
    pub presentation: Arc<RwLock<VideoPresentationSettings>>,
    /// Per-participant receive choices (`participant:source` → receiving), read by the
    /// viewer event loop when a new publication appears.
    pub remote_preferences: HashMap<String, bool>,
}

impl VideoEngineState {
    pub fn new(hub: VideoFrameHub) -> Self {
        let presentation = Arc::new(RwLock::new(VideoPresentationSettings::default()));
        let mixer = VideoMixerState {
            presentation: presentation
                .read()
                .map(|settings| settings.clone())
                .unwrap_or_default(),
            ..VideoMixerState::default()
        };
        let engine = VideoEngine::new(hub.clone(), Arc::clone(&presentation));
        let link = engine.link_flags();
        Self {
            mixer,
            runtime: Arc::new(VideoRuntime {
                ops: AsyncMutex::new(VideoOps {
                    engine,
                    capture: VideoCaptureManager::default(),
                }),
                link,
            }),
            preview: VideoPreviewController::new(hub, Arc::clone(&presentation)),
            presentation,
            remote_preferences: HashMap::new(),
        }
    }

    pub fn snapshot(&self) -> VideoMixerState {
        let mut snapshot = self.mixer.clone();
        snapshot.connected = self.runtime.link.connected.load(Ordering::Acquire);
        snapshot.viewer_connected = self.runtime.link.viewer_connected.load(Ordering::Acquire);
        snapshot
    }

    /// Append a publishing video source, pre-populating its published-track identity so the
    /// engine publishes a stably-named `raven-video-<uuid>` track.
    fn add_publishing_source(
        &mut self,
        kind: VideoSourceKind,
        display_name: String,
        target_id: String,
        process_id: Option<u32>,
        linked_audio_source_id: Option<AudioSourceId>,
        profile: VideoQualityProfile,
    ) -> VideoSourceId {
        let mut source = VideoSourceState::new(kind, display_name, target_id);
        source.process_id = process_id;
        source.linked_audio_source_id = linked_audio_source_id;
        source.publishing = true;
        // The command boundary has already normalized camera/custom profiles and resolved
        // display/window profiles to their real source aspect ratio. Preserve that resolved
        // profile through capture and publishing.
        source.profile = profile;
        let track_id = PublishedVideoTrackId::new();
        source.published_track = Some(PublishedVideoTrack {
            track_id,
            webrtc_track_id: stable_video_track_id(track_id),
            source: VideoTrackSource::from_kind(kind),
            created_at: None,
            updated_at: None,
        });
        let id = source.id;
        self.mixer.local_sources.push(source);
        id
    }

    fn remove_source(&mut self, source_id: VideoSourceId) -> Option<VideoSourceState> {
        let index = self
            .mixer
            .local_sources
            .iter()
            .position(|source| source.id == source_id)?;
        Some(self.mixer.local_sources.remove(index))
    }
}

#[derive(Clone, Debug, Error, Serialize)]
#[serde(tag = "code", content = "detail", rename_all = "camelCase")]
pub enum VideoStateError {
    #[error("video engine state is poisoned")]
    StatePoisoned,
    #[error("video source not found")]
    SourceNotFound { source_id: VideoSourceId },
    #[error("video engine failed: {message}")]
    EngineFailed { message: String },
    #[error("video state event emit failed: {message}")]
    EventEmitFailed { message: String },
    #[error("video capture failed: {0}")]
    Capture(VideoCaptureError),
    #[error("linked audio failed: {message}")]
    Audio { message: String },
}

impl From<VideoCaptureError> for VideoStateError {
    fn from(error: VideoCaptureError) -> Self {
        VideoStateError::Capture(error)
    }
}

impl From<AudioStateError> for VideoStateError {
    fn from(error: AudioStateError) -> Self {
        VideoStateError::Audio {
            message: error.to_string(),
        }
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn video_get_state(
    state: State<'_, SharedVideoEngineState>,
) -> Result<VideoMixerState, VideoStateError> {
    let guard = state.read().map_err(|_| VideoStateError::StatePoisoned)?;
    Ok(guard.snapshot())
}

#[tauri::command]
pub async fn video_get_network_totals(
    state: State<'_, SharedVideoEngineState>,
) -> Result<VideoNetworkTotals, VideoStateError> {
    let runtime = video_runtime(&state)?;
    let (published_tracks, subscribed_tracks) = {
        let ops = runtime.ops.lock().await;
        (
            ops.engine.published_tracks(),
            ops.engine.subscribed_tracks(),
        )
    };
    measure_video_network_totals(published_tracks, subscribed_tracks)
        .await
        .map_err(|message| VideoStateError::EngineFailed { message })
}

#[tauri::command]
pub async fn video_get_quality_report(
    state: State<'_, SharedVideoEngineState>,
) -> Result<VideoQualityReport, VideoStateError> {
    let runtime = video_runtime(&state)?;
    let (published_screen_shares, subscribed_screen_shares) = {
        let ops = runtime.ops.lock().await;
        let published = ops
            .engine
            .published_screen_share_tracks()
            .into_iter()
            .map(|(source_id, track, profile)| {
                let capture = ops
                    .capture
                    .counters(source_id)
                    .map(|counters| VideoCaptureFrameCounts::from(&*counters));
                (track, profile, capture)
            })
            .collect();
        (published, ops.engine.subscribed_screen_share_tracks())
    };
    measure_video_quality_report(published_screen_shares, subscribed_screen_shares)
        .await
        .map_err(|message| VideoStateError::EngineFailed { message })
}

/// Receive stats for each subscribed remote video stream, or only the given stream ids.
/// The ops lock is held only to collect track handles; stats are gathered after it.
#[tauri::command]
pub async fn video_get_stream_stats(
    state: State<'_, SharedVideoEngineState>,
    stream_ids: Option<Vec<String>>,
) -> Result<Vec<VideoStreamStats>, VideoStateError> {
    let runtime = video_runtime(&state)?;
    let only = stream_ids.map(|ids| ids.into_iter().collect::<HashSet<_>>());
    let (handles, live, cache) = {
        let ops = runtime.ops.lock().await;
        let (handles, live) = ops.engine.remote_stream_handles(only.as_ref());
        (handles, live, ops.engine.stream_stats_cache())
    };
    measure_video_stream_stats(handles, live, cache)
        .await
        .map_err(|message| VideoStateError::EngineFailed { message })
}

#[tauri::command]
pub fn video_get_capabilities() -> NativeVideoCapabilityReport {
    let mut supported_source_kinds = vec![VideoSourceKind::Camera];
    let mut issues = Vec::new();

    let screen_capture_available = match screen_capture_runtime_readiness() {
        Ok(()) => cfg!(any(
            target_os = "windows",
            target_os = "linux",
            target_os = "macos"
        )),
        Err(issue) => {
            issues.push(issue);
            false
        }
    };
    let display_audio_available = system_audio_runtime_readiness().is_ok()
        && cfg!(any(
            target_os = "windows",
            target_os = "linux",
            target_os = "macos"
        ));

    if screen_capture_available {
        supported_source_kinds.push(VideoSourceKind::Display);
        supported_source_kinds.push(VideoSourceKind::Window);
    }

    NativeVideoCapabilityReport {
        os: std::env::consts::OS.to_string(),
        issues,
        supported_source_kinds,
        supports_camera: true,
        supports_display_capture: screen_capture_available,
        supports_window_capture: screen_capture_available,
        supports_display_audio: display_audio_available,
        supports_window_audio: cfg!(any(target_os = "windows", target_os = "macos")),
    }
}

#[tauri::command]
pub fn video_set_local_preview_enabled(
    state: State<'_, SharedVideoEngineState>,
    enabled: bool,
) -> Result<(), VideoStateError> {
    let guard = state.read().map_err(|_| VideoStateError::StatePoisoned)?;
    guard.preview.set_enabled(enabled);
    Ok(())
}

#[tauri::command]
pub fn video_get_stream_endpoint(service: State<'_, VideoFrameService>) -> VideoStreamEndpoint {
    service.endpoint()
}

#[tauri::command]
pub async fn video_set_self_preview_mode(
    app: AppHandle,
    state: State<'_, SharedVideoEngineState>,
    mode: SelfPreviewMode,
) -> Result<VideoMixerState, VideoStateError> {
    let runtime = video_runtime(&state)?;
    let mut ops = runtime.ops.lock().await;
    let preferences = {
        let mut guard = state.write().map_err(|_| VideoStateError::StatePoisoned)?;
        guard.mixer.self_preview_mode = mode;
        guard.remote_preferences.clone()
    };
    ops.engine.apply_viewer_subscriptions(mode, &preferences);
    finish_video_mutation(&app, &state, &mut ops).await
}

#[tauri::command]
pub async fn video_set_presentation_profile(
    app: AppHandle,
    state: State<'_, SharedVideoEngineState>,
    profile: VideoPresentationProfile,
) -> Result<VideoMixerState, VideoStateError> {
    mutate_video_state(&app, &state, |state| {
        let settings = VideoPresentationSettings { profile };
        *state
            .presentation
            .write()
            .map_err(|_| VideoStateError::StatePoisoned)? = settings.clone();
        state.mixer.presentation = settings;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn video_set_remote_video_receiving(
    app: AppHandle,
    state: State<'_, SharedVideoEngineState>,
    participant_id: String,
    source: VideoTrackSource,
    receiving: bool,
) -> Result<VideoMixerState, VideoStateError> {
    let runtime = video_runtime(&state)?;
    let mut ops = runtime.ops.lock().await;
    let (mode, preferences) = {
        let mut guard = state.write().map_err(|_| VideoStateError::StatePoisoned)?;
        guard
            .remote_preferences
            .insert(subscription_key(&participant_id, source), receiving);
        (
            guard.mixer.self_preview_mode,
            guard.remote_preferences.clone(),
        )
    };
    ops.engine.apply_viewer_subscriptions(mode, &preferences);
    finish_video_mutation(&app, &state, &mut ops).await
}

#[tauri::command]
pub fn video_list_cameras() -> Result<Vec<CameraDevice>, VideoStateError> {
    Ok(list_cameras()?)
}

#[tauri::command]
pub fn video_list_displays() -> Result<Vec<DisplayTarget>, VideoStateError> {
    Ok(list_displays()?)
}

#[tauri::command]
pub fn video_list_windows() -> Result<Vec<WindowTarget>, VideoStateError> {
    Ok(list_windows()?)
}

#[tauri::command]
pub async fn video_connect_room(
    app: AppHandle,
    state: State<'_, SharedVideoEngineState>,
    url: String,
    token: String,
    viewer_token: String,
    rejoin: Option<bool>,
) -> Result<VideoMixerState, VideoStateError> {
    let runtime = video_runtime(&state)?;
    let mut ops = runtime.ops.lock().await;
    let preferences = {
        let guard = state.read().map_err(|_| VideoStateError::StatePoisoned)?;
        guard.remote_preferences.clone()
    };
    ops.engine
        .connect(
            &app,
            state.inner(),
            &url,
            &token,
            &viewer_token,
            &preferences,
            rejoin.unwrap_or(false),
        )
        .await
        .map_err(|message| VideoStateError::EngineFailed { message })?;
    {
        let mut guard = state.write().map_err(|_| VideoStateError::StatePoisoned)?;
        guard.mixer.session_lost = false;
        guard.mixer.session_lost_fatal = false;
    }
    finish_video_mutation(&app, &state, &mut ops).await
}

#[tauri::command]
pub async fn video_disconnect_room(
    app: AppHandle,
    state: State<'_, SharedVideoEngineState>,
    audio_state: State<'_, SharedAudioEngineState>,
) -> Result<VideoMixerState, VideoStateError> {
    disconnect_video_room(&app, state.inner(), audio_state.inner()).await
}

/// Tear both video roles down and drop every local source. Shared by the leave command
/// and application shutdown.
pub async fn disconnect_video_room(
    app: &AppHandle,
    state: &SharedVideoEngineState,
    audio_state: &SharedAudioEngineState,
) -> Result<VideoMixerState, VideoStateError> {
    // Tear down any audio sources created by active shares, then drop all video sources.
    let linked: Vec<AudioSourceId> = {
        let guard = state.read().map_err(|_| VideoStateError::StatePoisoned)?;
        guard
            .mixer
            .local_sources
            .iter()
            .filter_map(|source| source.linked_audio_source_id)
            .collect()
    };
    for audio_id in linked {
        let _ = remove_shared_audio_source(app, audio_state, audio_id).await;
    }

    let runtime = video_runtime(state)?;
    let mut ops = runtime.ops.lock().await;
    ops.engine.disconnect().await;
    {
        let mut guard = state.write().map_err(|_| VideoStateError::StatePoisoned)?;
        guard.mixer.local_sources.clear();
        guard.mixer.participants.clear();
        guard.mixer.remote_tracks.clear();
        guard.mixer.viewer_connected = false;
        guard.mixer.session_lost = false;
        guard.mixer.session_lost_fatal = false;
        guard.remote_preferences.clear();
    }
    finish_video_mutation(app, state, &mut ops).await
}

#[tauri::command]
pub async fn video_start_camera(
    app: AppHandle,
    state: State<'_, SharedVideoEngineState>,
    audio_state: State<'_, SharedAudioEngineState>,
    camera_id: String,
    display_name: String,
    profile: VideoQualityProfile,
) -> Result<VideoMixerState, VideoStateError> {
    start_publishing_source(
        &app,
        state.inner(),
        audio_state.inner(),
        NewSource {
            kind: VideoSourceKind::Camera,
            display_name,
            target_id: camera_id,
            process_id: None,
            linked_audio: None,
            profile: profile.normalized(),
        },
    )
    .await
}

/// A source a start command adds to the model.
struct NewSource {
    kind: VideoSourceKind,
    display_name: String,
    target_id: String,
    process_id: Option<u32>,
    linked_audio: Option<AudioSourceId>,
    profile: VideoQualityProfile,
}

/// Add a publishing source and reconcile. When its capture cannot start (a camera that will
/// not open or sends no picture, a share target that is gone), the source is removed again,
/// with its linked audio, so no track stays published without a picture: libwebrtc fills
/// such a track with uninitialised frames, which viewers see as a green screen. A failed
/// publish keeps the source, because the next reconcile (or a rejoin) publishes it.
async fn start_publishing_source(
    app: &AppHandle,
    state: &SharedVideoEngineState,
    audio_state: &SharedAudioEngineState,
    source: NewSource,
) -> Result<VideoMixerState, VideoStateError> {
    let linked_audio = source.linked_audio;
    let mut added = None;
    let result = mutate_video_state(app, state, |engine| {
        added = Some(engine.add_publishing_source(
            source.kind,
            source.display_name,
            source.target_id,
            source.process_id,
            source.linked_audio,
            source.profile,
        ));
        Ok(())
    })
    .await;
    let Err(error) = result else {
        return result;
    };
    let capture_failed = added.is_some_and(|id| {
        state.read().is_ok_and(|guard| {
            guard.mixer.local_sources.iter().any(|source| {
                source.id == id && source.runtime.status == VideoSourceRuntimeStatus::Error
            })
        })
    });
    match added {
        Some(id) if capture_failed => {
            let _ = stop_video_source(app, state, audio_state, id).await;
        }
        Some(_) => {}
        None => {
            if let Some(audio_id) = linked_audio {
                let _ = remove_shared_audio_source(app, audio_state, audio_id).await;
            }
        }
    }
    Err(error)
}

#[tauri::command]
pub async fn video_start_display_share(
    app: AppHandle,
    state: State<'_, SharedVideoEngineState>,
    audio_state: State<'_, SharedAudioEngineState>,
    display_id: String,
    display_name: String,
    with_system_audio: bool,
    profile: VideoQualityProfile,
    source_width: u32,
    source_height: u32,
) -> Result<VideoMixerState, VideoStateError> {
    // Create the linked system-audio source first (outside the video lock).
    let linked_audio = if with_system_audio {
        Some(
            add_and_publish_shared_audio_source(
                &app,
                audio_state.inner(),
                AudioSourceType::SystemAudio,
                format!("{display_name} audio"),
                None,
                None,
            )
            .await?,
        )
    } else {
        None
    };

    start_publishing_source(
        &app,
        state.inner(),
        audio_state.inner(),
        NewSource {
            kind: VideoSourceKind::Display,
            display_name,
            target_id: display_id,
            process_id: None,
            linked_audio,
            profile: profile.resolved_for_source(source_width, source_height),
        },
    )
    .await
}

#[tauri::command]
pub async fn video_start_window_share(
    app: AppHandle,
    state: State<'_, SharedVideoEngineState>,
    audio_state: State<'_, SharedAudioEngineState>,
    window_id: String,
    process_id: u32,
    display_name: String,
    with_app_audio: bool,
    profile: VideoQualityProfile,
    source_width: u32,
    source_height: u32,
) -> Result<VideoMixerState, VideoStateError> {
    // Create the linked per-app audio source first (outside the video lock), capturing the
    // window's owning process via the platform app-audio backend. It is named after the
    // app, not the window: peers see this name, and a window title is private.
    let linked_audio = if with_app_audio {
        let identity = resolve_app_identity(process_id).await;
        Some(
            add_and_publish_shared_audio_source(
                &app,
                audio_state.inner(),
                AudioSourceType::AppAudio,
                linked_app_audio_name(identity.as_ref()),
                Some(process_id.to_string()),
                identity,
            )
            .await?,
        )
    } else {
        None
    };

    // The size the picker listed is only a hint: read the window as it is now. A minimized
    // window answers with the size it is restored to (capture restores it when it starts).
    let (source_width, source_height) =
        window_share_size(&window_id).unwrap_or((source_width, source_height));
    start_publishing_source(
        &app,
        state.inner(),
        audio_state.inner(),
        NewSource {
            kind: VideoSourceKind::Window,
            display_name,
            target_id: window_id,
            process_id: Some(process_id),
            linked_audio,
            profile: profile.resolved_for_source(source_width, source_height),
        },
    )
    .await
}

#[tauri::command]
pub async fn video_set_source_profile(
    app: AppHandle,
    state: State<'_, SharedVideoEngineState>,
    source_id: VideoSourceId,
    profile: VideoQualityProfile,
) -> Result<VideoMixerState, VideoStateError> {
    mutate_video_state(&app, &state, |engine| {
        let Some(source) = engine
            .mixer
            .local_sources
            .iter_mut()
            .find(|source| source.id == source_id)
        else {
            return Err(VideoStateError::SourceNotFound { source_id });
        };
        source.profile = profile.normalized();
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn video_stop_source(
    app: AppHandle,
    state: State<'_, SharedVideoEngineState>,
    audio_state: State<'_, SharedAudioEngineState>,
    source_id: VideoSourceId,
) -> Result<VideoMixerState, VideoStateError> {
    stop_video_source(&app, state.inner(), audio_state.inner(), source_id).await
}

async fn stop_video_source(
    app: &AppHandle,
    state: &SharedVideoEngineState,
    audio_state: &SharedAudioEngineState,
    source_id: VideoSourceId,
) -> Result<VideoMixerState, VideoStateError> {
    let removed = {
        let mut guard = state.write().map_err(|_| VideoStateError::StatePoisoned)?;
        guard.remove_source(source_id)
    };
    let Some(removed) = removed else {
        return Err(VideoStateError::SourceNotFound { source_id });
    };
    if let Some(audio_id) = removed.linked_audio_source_id {
        let _ = remove_shared_audio_source(app, audio_state, audio_id).await;
    }
    mutate_video_state(app, state, |_engine| Ok(())).await
}

/// Where running captures report what they notice by themselves. A pause or resume runs
/// the ordinary reconcile, which reads the runtime's new state and updates the share's
/// participant attribute; a closed window or screen ends its share like Stop sharing.
fn capture_events(app: &AppHandle, state: &SharedVideoEngineState) -> CaptureEvents {
    let app = app.clone();
    let state = Arc::downgrade(state);
    CaptureEvents::new(move |source_id, event| {
        let app = app.clone();
        let Some(state) = state.upgrade() else {
            return;
        };
        tauri::async_runtime::spawn(async move {
            match event {
                CaptureEvent::StateChanged => resync_video(&app, &state).await,
                CaptureEvent::TargetClosed => {
                    let audio_state = app.state::<SharedAudioEngineState>();
                    // Already stopped (the watcher and Windows can both report a close).
                    let _ = stop_video_source(&app, &state, audio_state.inner(), source_id).await;
                }
            }
        });
    })
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/// Re-run the publication / capture reconcile outside any user action. The engine calls
/// this after LiveKit reports a reconnect so tracks that were not restored are published
/// again.
pub(crate) async fn resync_video(app: &AppHandle, state: &SharedVideoEngineState) {
    let Ok(runtime) = video_runtime(state) else {
        return;
    };
    let mut ops = runtime.ops.lock().await;
    if let Err(error) = finish_video_mutation(app, state, &mut ops).await {
        eprintln!("[video-engine] media resync after reconnect failed: {error}");
    }
}

fn video_runtime(state: &SharedVideoEngineState) -> Result<Arc<VideoRuntime>, VideoStateError> {
    let guard = state.read().map_err(|_| VideoStateError::StatePoisoned)?;
    Ok(Arc::clone(&guard.runtime))
}

async fn mutate_video_state<F>(
    app: &AppHandle,
    state: &SharedVideoEngineState,
    mutation: F,
) -> Result<VideoMixerState, VideoStateError>
where
    F: FnOnce(&mut VideoEngineState) -> Result<(), VideoStateError> + Send,
{
    let runtime = video_runtime(state)?;
    let mut ops = runtime.ops.lock().await;
    {
        let mut guard = state.write().map_err(|_| VideoStateError::StatePoisoned)?;
        mutation(&mut guard)?;
    }
    finish_video_mutation(app, state, &mut ops).await
}

/// Reconcile publications + capture against the model (ops lock held, state lock released
/// during the network and device work), then emit the resulting snapshot.
async fn finish_video_mutation(
    app: &AppHandle,
    state: &SharedVideoEngineState,
    ops: &mut VideoOps,
) -> Result<VideoMixerState, VideoStateError> {
    let (mut sources, preview) = {
        let guard = state.read().map_err(|_| VideoStateError::StatePoisoned)?;
        (guard.mixer.local_sources.clone(), guard.preview.clone())
    };
    // Publish/unpublish LiveKit tracks first so the capture manager can attach the
    // matching publish sinks to the capture threads it starts.
    let publication_error = ops.engine.reconcile_publications(&sources).await.err();
    let source_types = sources
        .iter()
        .map(|source| (source.id, VideoTrackSource::from_kind(source.kind)))
        .collect();
    let sinks = preview.wrap_publish_sinks(ops.engine.sink_map(), &source_types);
    if !ops.capture.has_event_handler() {
        ops.capture.set_event_handler(capture_events(app, state));
    }
    let capture = &mut ops.capture;
    let capture_error = tokio::task::block_in_place(|| capture.reconcile(&mut sources, &sinks));
    // Viewers learn that a share is paused from the publisher's attributes. Best effort: a
    // failure leaves them with the held picture and no explanation, nothing worse.
    if let Err(error) = ops.engine.reconcile_share_attributes(&sources).await {
        eprintln!("[video-engine] could not update the share's paused attribute: {error}");
    }

    let updated = {
        let mut guard = state.write().map_err(|_| VideoStateError::StatePoisoned)?;
        for reconciled in sources {
            if let Some(source) = guard
                .mixer
                .local_sources
                .iter_mut()
                .find(|source| source.id == reconciled.id)
            {
                source.runtime = reconciled.runtime;
            }
        }
        guard.snapshot()
    };
    emit_video_state_changed(app, &updated)?;
    if let Some(message) = publication_error {
        return Err(VideoStateError::EngineFailed { message });
    }
    if let Some(message) = capture_error {
        return Err(VideoStateError::Capture(VideoCaptureError::StreamFailed {
            message,
        }));
    }
    Ok(updated)
}

fn emit_video_state_changed(
    app: &AppHandle,
    state: &VideoMixerState,
) -> Result<(), VideoStateError> {
    app.emit(VIDEO_STATE_CHANGED_EVENT, state.clone())
        .map_err(|error| VideoStateError::EventEmitFailed {
            message: error.to_string(),
        })
}
