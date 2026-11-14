//! Native video capture.
//!
//! Mirrors the audio [`crate::audio::capture::CaptureRuntimeManager`]: a manager owns a
//! per-source capture runtime, started/stopped by `reconcile()`. Each runtime produces
//! planar I420 frames on its own thread and pushes them into the engine's per-source
//! [`VideoFrameSink`]. There is no DSP / live-controls layer (video has no faders), so a
//! source captures iff it is enabled, publishing, and has a sink attached.
//!
//! Platform backends:
//! - **Camera** — `nokhwa` (MSMF / AVFoundation / V4L2), cross-platform.
//! - **Display / Window** — Windows.Graphics.Capture via `windows-capture` on Windows;
//!   ScreenCaptureKit on macOS; xdg-desktop-portal + PipeWire on Linux.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use thiserror::Error;

use crate::video::convert::{letterbox_i420, resize_i420_filtered, I420Frame};
use crate::video::domain::{
    CameraDevice, DisplayTarget, VideoQualityProfile, VideoSourceId, VideoSourceKind,
    VideoSourceRuntimeState, VideoSourceRuntimeStatus, VideoSourceState, WindowTarget,
};
use crate::video::pacing::{FramePacer, CAPTURE_TOLERANCE};

/// Destination for captured I420 frames. Implemented by the engine's publish sink. Called
/// from a capture thread, so implementations must be cheap and non-blocking.
pub trait VideoFrameSink: Send + Sync + std::fmt::Debug {
    fn push_frame(&self, frame: I420Frame);

    /// Asked by a capture backend before it reads back and converts a frame. `false` means
    /// the frame would be dropped anyway, so the backend can skip it for free; `true`
    /// reserves the slot for the frame the backend is about to push.
    fn frame_due(&self) -> bool {
        true
    }
}

pub trait VideoSourceRuntime: Send + Sync + std::fmt::Debug {
    fn source_id(&self) -> VideoSourceId;
    fn stop(&mut self);
    fn runtime_state(&self) -> VideoSourceRuntimeState;
    fn signature(&self) -> &VideoCaptureSignature;
}

/// Identity of a capture stream for deciding when to physically restart it.
#[derive(Clone, Debug, PartialEq)]
pub struct VideoCaptureSignature {
    source_id: VideoSourceId,
    kind: VideoSourceKind,
    target_id: String,
    profile: VideoQualityProfile,
}

impl VideoCaptureSignature {
    fn from_source(source: &VideoSourceState) -> Self {
        Self {
            source_id: source.id,
            kind: source.kind,
            target_id: source.target_id.clone(),
            profile: source.profile.clone(),
        }
    }
}

/// Frames a running capture has produced and passed on, for measuring where frame rate is
/// lost. Read by the quality report; written only by the capture thread.
#[derive(Debug, Default)]
pub struct VideoCaptureCounters {
    /// Frames the capture backend delivered.
    pub captured: AtomicU64,
    /// Frames the profile's frame-rate pacing passed on to the publish sink.
    pub forwarded: AtomicU64,
}

#[derive(Debug)]
struct ProfiledVideoFrameSink {
    inner: Arc<dyn VideoFrameSink>,
    profile: VideoQualityProfile,
    pacer: Mutex<FramePacer>,
    /// Set when [`VideoFrameSink::frame_due`] admitted the frame now being pushed.
    admitted: AtomicBool,
    counters: Arc<VideoCaptureCounters>,
    /// A recent sent frame, kept for window shares so a pause can go on showing it.
    held: Option<Arc<HeldFrame>>,
    /// Keep the picture's shape when it no longer matches the profile (a resized window,
    /// a display that changed resolution) instead of stretching it. Shares only.
    letterbox: bool,
}

impl ProfiledVideoFrameSink {
    fn new(
        inner: Arc<dyn VideoFrameSink>,
        profile: VideoQualityProfile,
        counters: Arc<VideoCaptureCounters>,
    ) -> Self {
        Self {
            inner,
            profile,
            pacer: Mutex::new(FramePacer::new()),
            admitted: AtomicBool::new(false),
            counters,
            held: None,
            letterbox: false,
        }
    }

    fn letterboxed(mut self) -> Self {
        self.letterbox = true;
        self
    }

    fn holding(mut self, held: Arc<HeldFrame>) -> Self {
        self.held = Some(held);
        self
    }

    /// Count a delivered frame and decide whether it goes on, at the profile's frame rate.
    fn admit(&self, now: Instant) -> bool {
        self.counters.captured.fetch_add(1, Ordering::Relaxed);
        let admitted = match self.pacer.lock() {
            Ok(mut pacer) => {
                let interval = FramePacer::interval_for(f64::from(self.profile.fps));
                pacer.admit(now, interval, CAPTURE_TOLERANCE)
            }
            Err(_) => true,
        };
        if admitted {
            self.counters.forwarded.fetch_add(1, Ordering::Relaxed);
        }
        admitted
    }
}

impl VideoFrameSink for ProfiledVideoFrameSink {
    fn frame_due(&self) -> bool {
        let admitted = self.admit(Instant::now());
        self.admitted.store(admitted, Ordering::Release);
        admitted
    }

    fn push_frame(&self, frame: I420Frame) {
        // Backends that do not ask `frame_due` first are paced here instead.
        if !self.admitted.swap(false, Ordering::AcqRel) && !self.admit(Instant::now()) {
            return;
        }
        let frame = scale_frame_to_profile(frame, &self.profile, self.letterbox);
        if let Some(held) = &self.held {
            held.offer(&frame, Instant::now());
        }
        self.inner.push_frame(frame);
    }
}

/// How often a running window share copies a sent frame aside (a 1080p I420 copy is about
/// 3 MB, so not every frame), and how often a paused share sends that copy again.
const HELD_FRAME_INTERVAL: Duration = Duration::from_millis(250);
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const PAUSED_FRAME_INTERVAL: Duration = Duration::from_millis(500);

/// The last picture of a window share. While the window is minimized nothing new arrives,
/// so the share keeps sending this one at a low rate: viewers keep a picture, and someone
/// who starts watching during the pause still gets a keyframe.
#[derive(Default)]
struct HeldFrame {
    slot: Mutex<Option<(Instant, I420Frame)>>,
}

impl std::fmt::Debug for HeldFrame {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HeldFrame").finish_non_exhaustive()
    }
}

impl HeldFrame {
    /// Keep a copy of `frame` unless one was kept less than [`HELD_FRAME_INTERVAL`] ago.
    fn offer(&self, frame: &I420Frame, now: Instant) {
        let Ok(mut slot) = self.slot.try_lock() else {
            return;
        };
        let due = slot
            .as_ref()
            .is_none_or(|(kept_at, _)| now.duration_since(*kept_at) >= HELD_FRAME_INTERVAL);
        if due {
            *slot = Some((now, frame.clone()));
        }
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    fn latest(&self) -> Option<I420Frame> {
        self.slot
            .lock()
            .ok()
            .and_then(|slot| slot.as_ref().map(|(_, frame)| frame.clone()))
    }
}

/// What a watched window share is doing, from one look at the window.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
enum WindowShareActivity {
    #[default]
    Live,
    /// Minimized: Windows draws nothing, so the share holds its last picture.
    Paused,
    /// The window is gone. Final: the share ends.
    Closed,
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
impl WindowShareActivity {
    fn next(self, window_exists: bool, minimized: bool) -> Self {
        match (self, window_exists, minimized) {
            (Self::Closed, _, _) | (_, false, _) => Self::Closed,
            (_, true, true) => Self::Paused,
            (_, true, false) => Self::Live,
        }
    }
}

/// Something a running capture noticed by itself, between reconciles.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CaptureEvent {
    /// The runtime's state changed (a share paused or resumed). Reconcile to pick it up.
    StateChanged,
    /// The captured window or screen is gone. The source should be stopped.
    TargetClosed,
}

/// Where a capture reports a [`CaptureEvent`]. Called from capture threads, so the handler
/// must not block.
#[derive(Clone)]
pub struct CaptureEvents(Arc<dyn Fn(VideoSourceId, CaptureEvent) + Send + Sync>);

impl CaptureEvents {
    pub fn new(handler: impl Fn(VideoSourceId, CaptureEvent) + Send + Sync + 'static) -> Self {
        Self(Arc::new(handler))
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    fn notify(&self, source_id: VideoSourceId, event: CaptureEvent) {
        (self.0)(source_id, event);
    }
}

impl std::fmt::Debug for CaptureEvents {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CaptureEvents")
    }
}

/// The size a window has when it is shown. For a minimized window `GetWindowRect` gives the
/// small title-bar box Windows parks off screen, so the size comes from its placement: the
/// normal (restored) rectangle, or the monitor's work area when it is restored maximized.
/// Rectangles are `(left, top, right, bottom)`.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn restored_window_size(
    normal: (i32, i32, i32, i32),
    restores_maximized: bool,
    work_area: Option<(i32, i32, i32, i32)>,
) -> Option<(u32, u32)> {
    let rect = match (restores_maximized, work_area) {
        (true, Some(work_area)) => work_area,
        _ => normal,
    };
    let width = rect.2.checked_sub(rect.0)?;
    let height = rect.3.checked_sub(rect.1)?;
    (width > 0 && height > 0).then_some((width as u32, height as u32))
}

#[cfg(test)]
mod window_share_tests {
    use super::*;

    #[test]
    fn a_minimized_window_reports_its_restored_size() {
        // Workspace coordinates: a 1280×760 window at (100, 80).
        let normal = (100, 80, 1380, 840);
        assert_eq!(restored_window_size(normal, false, None), Some((1280, 760)));
        // Not maximized: the work area does not matter.
        let work_area = (0, 0, 2560, 1392);
        assert_eq!(
            restored_window_size(normal, false, Some(work_area)),
            Some((1280, 760))
        );
    }

    #[test]
    fn a_window_minimized_from_maximized_reports_the_work_area() {
        let normal = (100, 80, 1380, 840);
        let work_area = (0, 0, 2560, 1392);
        assert_eq!(
            restored_window_size(normal, true, Some(work_area)),
            Some((2560, 1392))
        );
        // Without a monitor, the normal rectangle is the best there is.
        assert_eq!(restored_window_size(normal, true, None), Some((1280, 760)));
    }

    #[test]
    fn an_empty_placement_has_no_size() {
        assert_eq!(restored_window_size((0, 0, 0, 0), false, None), None);
        assert_eq!(restored_window_size((10, 10, 5, 40), false, None), None);
    }

    #[test]
    fn minimizing_pauses_restoring_resumes_and_closing_is_final() {
        use WindowShareActivity::*;
        assert_eq!(Live.next(true, false), Live);
        assert_eq!(Live.next(true, true), Paused);
        assert_eq!(Paused.next(true, true), Paused);
        assert_eq!(Paused.next(true, false), Live);
        assert_eq!(Paused.next(false, true), Closed);
        assert_eq!(Live.next(false, false), Closed);
        assert_eq!(Closed.next(true, false), Closed);
    }

    #[test]
    fn a_held_frame_is_copied_at_most_every_interval() {
        let held = HeldFrame::default();
        let frame = |luma| I420Frame {
            width: 2,
            height: 2,
            y: vec![luma; 4],
            u: vec![128],
            v: vec![128],
        };
        let start = Instant::now();
        held.offer(&frame(10), start);
        held.offer(&frame(20), start + Duration::from_millis(100));
        assert_eq!(held.latest().map(|f| f.y[0]), Some(10));
        held.offer(&frame(30), start + HELD_FRAME_INTERVAL);
        assert_eq!(held.latest().map(|f| f.y[0]), Some(30));
    }
}

#[cfg(test)]
mod profiled_sink_tests {
    use super::*;

    #[derive(Debug, Default)]
    struct CountingSink(AtomicU64);

    impl VideoFrameSink for CountingSink {
        fn push_frame(&self, _frame: I420Frame) {
            self.0.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn frame(profile: &VideoQualityProfile) -> I420Frame {
        let (w, h) = (profile.width as usize, profile.height as usize);
        I420Frame {
            width: profile.width,
            height: profile.height,
            y: vec![16; w * h],
            u: vec![128; w.div_ceil(2) * h.div_ceil(2)],
            v: vec![128; w.div_ceil(2) * h.div_ceil(2)],
        }
    }

    fn sink() -> (
        Arc<CountingSink>,
        ProfiledVideoFrameSink,
        VideoQualityProfile,
    ) {
        let profile = VideoQualityProfile {
            width: 64,
            height: 36,
            fps: 30.0,
            ..VideoQualityProfile::default()
        };
        let output = Arc::new(CountingSink::default());
        let profiled = ProfiledVideoFrameSink::new(
            Arc::clone(&output) as Arc<dyn VideoFrameSink>,
            profile.clone(),
            Arc::new(VideoCaptureCounters::default()),
        );
        (output, profiled, profile)
    }

    #[test]
    fn a_frame_admitted_by_frame_due_is_forwarded_and_the_next_is_skipped() {
        let (output, profiled, profile) = sink();
        assert!(profiled.frame_due());
        profiled.push_frame(frame(&profile));
        // Immediately after, the next display frame is not due and costs nothing.
        assert!(!profiled.frame_due());
        assert_eq!(output.0.load(Ordering::Relaxed), 1);
        assert_eq!(profiled.counters.captured.load(Ordering::Relaxed), 2);
        assert_eq!(profiled.counters.forwarded.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn backends_that_only_push_are_still_paced() {
        let (output, profiled, profile) = sink();
        profiled.push_frame(frame(&profile));
        profiled.push_frame(frame(&profile));
        assert_eq!(output.0.load(Ordering::Relaxed), 1);
        assert_eq!(profiled.counters.captured.load(Ordering::Relaxed), 2);
    }
}

fn scale_frame_to_profile(
    frame: I420Frame,
    profile: &VideoQualityProfile,
    letterbox: bool,
) -> I420Frame {
    let target_width = profile.width.max(2);
    let target_height = profile.height.max(2);
    if frame.width == target_width && frame.height == target_height {
        return frame;
    }
    if letterbox {
        return letterbox_i420(&frame, target_width, target_height);
    }
    resize_i420_filtered(&frame, target_width, target_height)
}

#[derive(Clone, Debug, Error, PartialEq, Serialize)]
#[serde(tag = "code", content = "detail", rename_all = "camelCase")]
pub enum VideoCaptureError {
    #[error("video capture is not implemented for this platform/source")]
    NotImplemented,
    #[error("capture target is invalid: {message}")]
    InvalidTarget { message: String },
    #[error("video capture device is unavailable: {message}")]
    DeviceUnavailable { message: String },
    #[error("video capture stream failed: {message}")]
    StreamFailed { message: String },
}

#[derive(Debug, Default)]
pub struct VideoCaptureManager {
    runtimes: HashMap<VideoSourceId, Box<dyn VideoSourceRuntime>>,
    /// The sink each running capture pushes into. A publication is recreated when the
    /// sidecar reconnects; pointing the relay at the new publish sink keeps the capture
    /// (and, on Linux, the portal session the user approved) running instead of
    /// restarting it or leaving it feeding a dead track.
    relays: HashMap<VideoSourceId, Arc<RelayVideoFrameSink>>,
    counters: HashMap<VideoSourceId, Arc<VideoCaptureCounters>>,
    /// Where running captures report pauses and closed targets.
    events: Option<CaptureEvents>,
}

/// A capture-side sink whose destination can be replaced while the capture runs.
#[derive(Debug)]
struct RelayVideoFrameSink {
    target: Mutex<Arc<dyn VideoFrameSink>>,
}

impl RelayVideoFrameSink {
    fn new(target: Arc<dyn VideoFrameSink>) -> Self {
        Self {
            target: Mutex::new(target),
        }
    }

    fn retarget(&self, target: &Arc<dyn VideoFrameSink>) {
        if let Ok(mut current) = self.target.lock() {
            if !Arc::ptr_eq(&*current, target) {
                *current = Arc::clone(target);
            }
        }
    }
}

impl VideoFrameSink for RelayVideoFrameSink {
    fn push_frame(&self, frame: I420Frame) {
        let target = match self.target.lock() {
            Ok(target) => Arc::clone(&*target),
            Err(_) => return,
        };
        target.push_frame(frame);
    }
}

fn should_capture(
    source: &VideoSourceState,
    sinks: &HashMap<VideoSourceId, Arc<dyn VideoFrameSink>>,
) -> bool {
    source.enabled && source.publishing && sinks.contains_key(&source.id)
}

fn inactive_runtime_state() -> VideoSourceRuntimeState {
    VideoSourceRuntimeState {
        status: VideoSourceRuntimeStatus::Inactive,
        ..VideoSourceRuntimeState::default()
    }
}

fn starting_runtime_state() -> VideoSourceRuntimeState {
    VideoSourceRuntimeState {
        status: VideoSourceRuntimeStatus::Starting,
        ..VideoSourceRuntimeState::default()
    }
}

fn errored_runtime_state(message: String) -> VideoSourceRuntimeState {
    VideoSourceRuntimeState {
        status: VideoSourceRuntimeStatus::Error,
        error: Some(message),
        ..VideoSourceRuntimeState::default()
    }
}

fn running_runtime_state(profile: &VideoQualityProfile) -> VideoSourceRuntimeState {
    VideoSourceRuntimeState {
        status: VideoSourceRuntimeStatus::Running,
        width: Some(profile.width),
        height: Some(profile.height),
        fps: Some(profile.fps),
        ..VideoSourceRuntimeState::default()
    }
}

impl VideoCaptureManager {
    /// Frame counters of a running capture, if it is running.
    pub fn counters(&self, source_id: VideoSourceId) -> Option<Arc<VideoCaptureCounters>> {
        self.counters.get(&source_id).cloned()
    }

    pub fn has_event_handler(&self) -> bool {
        self.events.is_some()
    }

    /// Set once; captures started afterwards report to it.
    pub fn set_event_handler(&mut self, events: CaptureEvents) {
        self.events = Some(events);
    }

    pub fn reconcile(
        &mut self,
        sources: &mut [VideoSourceState],
        sinks: &HashMap<VideoSourceId, Arc<dyn VideoFrameSink>>,
    ) -> Option<String> {
        let mut first_error = None;
        let desired_ids: HashSet<_> = sources
            .iter()
            .filter(|source| should_capture(source, sinks))
            .map(|source| source.id)
            .collect();

        // Stop runtimes no longer desired.
        let existing_ids: Vec<_> = self.runtimes.keys().copied().collect();
        for source_id in existing_ids {
            if !desired_ids.contains(&source_id) {
                if let Some(mut runtime) = self.runtimes.remove(&source_id) {
                    runtime.stop();
                }
                self.relays.remove(&source_id);
                self.counters.remove(&source_id);
            }
        }

        for source in sources {
            if !desired_ids.contains(&source.id) {
                if self.runtimes.remove(&source.id).is_some() {
                    // already stopped above
                }
                self.relays.remove(&source.id);
                self.counters.remove(&source.id);
                source.runtime = inactive_runtime_state();
                continue;
            }

            let signature = VideoCaptureSignature::from_source(source);
            let needs_restart = self
                .runtimes
                .get(&source.id)
                .map(|runtime| runtime.signature() != &signature)
                .unwrap_or(true);
            if !needs_restart {
                // Follow the publication: it may have been recreated since capture began.
                if let (Some(relay), Some(sink)) =
                    (self.relays.get(&source.id), sinks.get(&source.id))
                {
                    relay.retarget(sink);
                }
                // Keep reporting the live runtime state.
                if let Some(runtime) = self.runtimes.get(&source.id) {
                    source.runtime = runtime.runtime_state();
                }
                continue;
            }

            if let Some(mut runtime) = self.runtimes.remove(&source.id) {
                runtime.stop();
            }
            self.relays.remove(&source.id);
            self.counters.remove(&source.id);

            source.runtime = starting_runtime_state();
            let relay = sinks
                .get(&source.id)
                .map(|sink| Arc::new(RelayVideoFrameSink::new(Arc::clone(sink))));
            let sink = relay
                .as_ref()
                .map(|relay| Arc::clone(relay) as Arc<dyn VideoFrameSink>);
            let counters = Arc::new(VideoCaptureCounters::default());
            match start_capture(
                source,
                signature,
                sink,
                Arc::clone(&counters),
                self.events.clone(),
            ) {
                Ok(runtime) => {
                    source.runtime = runtime.runtime_state();
                    self.runtimes.insert(source.id, runtime);
                    self.counters.insert(source.id, counters);
                    if let Some(relay) = relay {
                        self.relays.insert(source.id, relay);
                    }
                }
                Err(error) => {
                    let message = error.to_string();
                    source.runtime = errored_runtime_state(message.clone());
                    first_error.get_or_insert(message);
                }
            }
        }
        first_error
    }
}

fn start_capture(
    source: &VideoSourceState,
    signature: VideoCaptureSignature,
    sink: Option<Arc<dyn VideoFrameSink>>,
    counters: Arc<VideoCaptureCounters>,
    events: Option<CaptureEvents>,
) -> Result<Box<dyn VideoSourceRuntime>, VideoCaptureError> {
    let Some(sink) = sink else {
        return Err(VideoCaptureError::StreamFailed {
            message: "no publish sink attached".to_string(),
        });
    };
    let profiled = ProfiledVideoFrameSink::new(Arc::clone(&sink), source.profile.clone(), counters);
    let profiled = if source.kind == VideoSourceKind::Camera {
        profiled
    } else {
        profiled.letterboxed()
    };
    match source.kind {
        VideoSourceKind::Camera => camera::start(source, signature, Arc::new(profiled)),
        VideoSourceKind::Display => screen::start(
            source,
            signature,
            Arc::new(profiled),
            ScreenExtras { events, held: None },
        ),
        VideoSourceKind::Window => {
            // A window can be minimized mid-share; keep a recent frame to go on sending.
            let held = Arc::new(HeldFrame::default());
            let profiled = profiled.holding(Arc::clone(&held));
            screen::start(
                source,
                signature,
                Arc::new(profiled),
                ScreenExtras {
                    events,
                    held: Some((held, sink)),
                },
            )
        }
    }
}

/// What a screen or window capture gets besides its sink.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
struct ScreenExtras {
    events: Option<CaptureEvents>,
    /// For a window share: its held frame, and the sink (after the profile) to send it to
    /// while the window is minimized.
    held: Option<(Arc<HeldFrame>, Arc<dyn VideoFrameSink>)>,
}

/// The size a window share should be resolved from: the window's own size, or the size it
/// is restored to when it is minimized. `None` when it cannot be read (or on platforms
/// whose picker gives no window handle).
pub fn window_share_size(target_id: &str) -> Option<(u32, u32)> {
    #[cfg(target_os = "windows")]
    {
        let hwnd: isize = target_id.parse().ok()?;
        screen::imaging::window_size(hwnd as *mut std::ffi::c_void).map(|(size, _)| size)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = target_id;
        None
    }
}

// ---------------------------------------------------------------------------
// Enumeration (for the picker dialogs)
// ---------------------------------------------------------------------------

pub fn list_cameras() -> Result<Vec<CameraDevice>, VideoCaptureError> {
    camera::list()
}

pub fn list_displays() -> Result<Vec<DisplayTarget>, VideoCaptureError> {
    screen::list_displays()
}

pub fn list_windows() -> Result<Vec<WindowTarget>, VideoCaptureError> {
    screen::list_windows()
}

pub fn screen_capture_runtime_readiness() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        screen::runtime_readiness()
    }
    #[cfg(not(target_os = "linux"))]
    {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Camera backend (nokhwa, cross-platform)
// ---------------------------------------------------------------------------

mod camera {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::sync_channel;
    use std::sync::Arc;
    use std::thread::{self, JoinHandle};
    use std::time::{Duration, Instant};

    use nokhwa::pixel_format::{FormatDecoder, RgbFormat};
    use nokhwa::utils::{
        ApiBackend, CameraFormat, CameraIndex, FrameFormat, RequestedFormat, RequestedFormatType,
    };
    use nokhwa::{Camera, NokhwaError};

    use crate::video::convert::{packed_to_i420, PackedFormat};
    use crate::video::domain::{CameraDevice, VideoSourceRuntimeState, VideoSourceState};

    use super::{
        VideoCaptureError, VideoCaptureSignature, VideoFrameSink, VideoSourceId, VideoSourceRuntime,
    };

    #[derive(Debug)]
    pub(super) struct CameraRuntime {
        source_id: VideoSourceId,
        signature: VideoCaptureSignature,
        runtime_state: VideoSourceRuntimeState,
        stop: Arc<AtomicBool>,
        handle: Option<JoinHandle<()>>,
    }

    impl VideoSourceRuntime for CameraRuntime {
        fn source_id(&self) -> VideoSourceId {
            self.source_id
        }
        fn stop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            if let Some(handle) = self.handle.take() {
                let _ = handle.join();
            }
        }
        fn runtime_state(&self) -> VideoSourceRuntimeState {
            self.runtime_state.clone()
        }
        fn signature(&self) -> &VideoCaptureSignature {
            &self.signature
        }
    }

    impl Drop for CameraRuntime {
        fn drop(&mut self) {
            self.stop();
        }
    }

    fn camera_index(target_id: &str) -> CameraIndex {
        match target_id.parse::<u32>() {
            Ok(index) => CameraIndex::Index(index),
            Err(_) => CameraIndex::String(target_id.to_string()),
        }
    }

    /// Keeps COM initialized for the lifetime of a camera worker thread. On Windows, Media
    /// Foundation device enumeration and capture require COM to be initialized on the calling
    /// thread in a consistent apartment. Tauri command/runtime threads may be uninitialized or
    /// MTA (which makes MSMF enumeration silently return nothing), so every nokhwa call runs on
    /// a thread that owns its COM init via this guard.
    #[cfg(target_os = "windows")]
    struct ComGuard;

    #[cfg(target_os = "windows")]
    impl ComGuard {
        fn new() -> Self {
            unsafe {
                use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
                // S_FALSE (already initialized on this thread) is fine — we only need COM up.
                let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            }
            ComGuard
        }
    }

    #[cfg(target_os = "windows")]
    impl Drop for ComGuard {
        fn drop(&mut self) {
            unsafe {
                use windows::Win32::System::Com::CoUninitialize;
                CoUninitialize();
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    struct ComGuard;

    #[cfg(not(target_os = "windows"))]
    impl ComGuard {
        fn new() -> Self {
            ComGuard
        }
    }

    pub(super) fn list() -> Result<Vec<CameraDevice>, VideoCaptureError> {
        // Enumerate on a dedicated COM-initialized thread (see `ComGuard`).
        thread::spawn(query_cameras).join().unwrap_or_else(|_| {
            Err(VideoCaptureError::DeviceUnavailable {
                message: "camera enumeration thread panicked".to_string(),
            })
        })
    }

    fn query_cameras() -> Result<Vec<CameraDevice>, VideoCaptureError> {
        let _com = ComGuard::new();
        let mut devices: Vec<CameraDevice> = Vec::new();

        // Media Foundation / AVFoundation / V4L via nokhwa (physical cams + MF virtual cams).
        // A failure here is non-fatal so DirectShow-only devices still surface on Windows.
        match nokhwa::query(ApiBackend::Auto) {
            Ok(infos) => devices.extend(infos.into_iter().map(|info| CameraDevice {
                id: format!("mf:{}", info.index()),
                name: info.human_name(),
            })),
            Err(error) => {
                eprintln!("[video-capture] media foundation camera query failed: {error}")
            }
        }

        // DirectShow devices supplement MF. OBS is deliberately rebound through DirectShow
        // even when MF can enumerate it: MF enumeration does not guarantee that nokhwa can
        // negotiate and decode frames from that virtual camera.
        #[cfg(target_os = "windows")]
        for (path, name) in crate::video::directshow::list() {
            let directshow = CameraDevice {
                id: format!("ds:{path}"),
                name: name.clone(),
            };
            if let Some(position) = devices
                .iter()
                .position(|device| device.name.eq_ignore_ascii_case(&name))
            {
                if prefers_directshow(&name) {
                    devices[position] = directshow;
                }
                continue;
            }
            devices.push(directshow);
        }

        Ok(devices)
    }

    fn prefers_directshow(name: &str) -> bool {
        let normalized = name.to_ascii_lowercase();
        normalized.contains("obs virtual camera") || normalized.contains("obs-camera")
    }

    fn requested_profile_format(
        profile: &crate::video::domain::VideoQualityProfile,
    ) -> CameraFormat {
        CameraFormat::new_from(
            profile.width,
            profile.height,
            FrameFormat::MJPEG,
            profile.fps.round().clamp(1.0, 120.0) as u32,
        )
    }

    fn open_profile_camera(
        index: CameraIndex,
        requested: CameraFormat,
    ) -> Result<Camera, NokhwaError> {
        let closest = RequestedFormat::new::<RgbFormat>(RequestedFormatType::Closest(requested));
        match Camera::new(index.clone(), closest) {
            Ok(camera) => Ok(camera),
            Err(primary_error) => {
                let mut camera = Camera::new(
                    index,
                    RequestedFormat::new::<RgbFormat>(RequestedFormatType::None),
                )?;
                let selected = camera
                    .compatible_camera_formats()
                    .ok()
                    .and_then(|formats| select_camera_format(&formats, requested));
                if let Some(selected) = selected {
                    camera.set_camera_requset(RequestedFormat::new::<RgbFormat>(
                        RequestedFormatType::Exact(selected),
                    ))?;
                    Ok(camera)
                } else {
                    Err(primary_error)
                }
            }
        }
    }

    fn select_camera_format(
        formats: &[CameraFormat],
        requested: CameraFormat,
    ) -> Option<CameraFormat> {
        formats
            .iter()
            .copied()
            .filter(|format| RgbFormat::FORMATS.contains(&format.format()))
            .min_by_key(|format| {
                let format_penalty = if format.format() == requested.format() {
                    0u64
                } else {
                    1_000_000_000
                };
                let dx = format.width().abs_diff(requested.width()) as u64;
                let dy = format.height().abs_diff(requested.height()) as u64;
                let resolution_distance = dx * dx + dy * dy;
                let fps_distance = format.frame_rate().abs_diff(requested.frame_rate()) as u64;

                (format_penalty, resolution_distance, fps_distance)
            })
    }

    /// How long an opened camera may go without a usable frame before it is reported as
    /// failed.
    const FIRST_FRAME_TIMEOUT: Duration = Duration::from_millis(4000);
    /// How long `start` waits for the worker to open the camera and see its first frame.
    const STARTUP_TIMEOUT: Duration = Duration::from_secs(8);

    pub(super) fn start(
        source: &VideoSourceState,
        signature: VideoCaptureSignature,
        sink: Arc<dyn VideoFrameSink>,
    ) -> Result<Box<dyn VideoSourceRuntime>, VideoCaptureError> {
        let source_id = source.id;
        let target = source.target_id.clone();
        let profile = source.profile.clone();
        let runtime_state = super::running_runtime_state(&profile);
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let (startup_sender, startup_receiver) = sync_channel::<Result<(), String>>(1);

        let handle = thread::spawn(move || {
            // Keep COM initialized on this worker thread for its whole lifetime (MSMF and
            // DirectShow both require it — see `ComGuard`).
            let _com = ComGuard::new();

            // DirectShow-only devices (e.g. OBS Virtual Camera) use the DirectShow backend.
            #[cfg(target_os = "windows")]
            if let Some(path) = target.strip_prefix("ds:") {
                crate::video::directshow::run_capture(
                    path,
                    &thread_stop,
                    sink.as_ref(),
                    move |result| {
                        let _ = startup_sender.send(result);
                    },
                );
                return;
            }

            // nokhwa (Media Foundation / AVFoundation / V4L). Ids are prefixed "mf:".
            let index = camera_index(target.strip_prefix("mf:").unwrap_or(&target));
            let requested = requested_profile_format(&profile);
            let mut camera = match open_profile_camera(index, requested) {
                Ok(camera) => camera,
                Err(error) => {
                    eprintln!("[video-capture] camera open failed: {error}");
                    let _ =
                        startup_sender.send(Err(format!("Camera could not be opened: {error}")));
                    return;
                }
            };
            if let Err(error) = camera.open_stream() {
                eprintln!("[video-capture] camera stream failed: {error}");
                let _ = startup_sender.send(Err(format!("Camera stream could not start: {error}")));
                return;
            }
            eprintln!(
                "[video-capture] camera opened as {:?}",
                camera.camera_format()
            );
            // Started means a picture arrived, not that the stream opened: a camera that
            // opens and then sends nothing (or nothing that decodes) is reported as failed
            // instead of publishing a track with no picture.
            let opened = Instant::now();
            let mut startup = Some(startup_sender);
            let mut last_error = String::new();
            while !thread_stop.load(Ordering::Relaxed) {
                let i420 = camera
                    .frame()
                    .map_err(|error| format!("Camera stopped sending frames: {error}"))
                    .and_then(|frame| {
                        frame.decode_image::<RgbFormat>().map_err(|error| {
                            format!(
                                "Camera frames could not be decoded ({:?}): {error}",
                                frame.source_frame_format()
                            )
                        })
                    })
                    .and_then(|decoded| {
                        let (width, height) = (decoded.width(), decoded.height());
                        packed_to_i420(
                            decoded.as_raw(),
                            width,
                            height,
                            (width as usize) * 3,
                            PackedFormat::Rgb,
                        )
                        .ok_or_else(|| {
                            format!("Camera frame has no usable size ({width}x{height})")
                        })
                    });
                match i420 {
                    Ok(i420) => {
                        if let Some(sender) = startup.take() {
                            let _ = sender.send(Ok(()));
                        }
                        sink.push_frame(i420);
                    }
                    Err(error) => {
                        if error != last_error {
                            eprintln!("[video-capture] {error}");
                            last_error = error;
                        }
                        if startup.is_some() && opened.elapsed() > FIRST_FRAME_TIMEOUT {
                            if let Some(sender) = startup.take() {
                                let _ = sender.send(Err(last_error.clone()));
                            }
                            break;
                        }
                        // Failing reads return at once; do not spin a core on them.
                        thread::sleep(Duration::from_millis(20));
                    }
                }
            }
            let _ = camera.stop_stream();
        });

        // Opening can take a few seconds on its own; the first frame then has its own limit.
        match startup_receiver.recv_timeout(STARTUP_TIMEOUT) {
            Ok(Ok(())) => {}
            Ok(Err(message)) => {
                stop.store(true, Ordering::Relaxed);
                let _ = handle.join();
                return Err(VideoCaptureError::StreamFailed { message });
            }
            Err(_) => {
                stop.store(true, Ordering::Relaxed);
                return Err(VideoCaptureError::StreamFailed {
                    message: format!(
                        "The camera did not send a picture within {} seconds",
                        STARTUP_TIMEOUT.as_secs()
                    ),
                });
            }
        }

        Ok(Box::new(CameraRuntime {
            source_id,
            signature,
            runtime_state,
            stop,
            handle: Some(handle),
        }))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn obs_virtual_camera_prefers_directshow_when_both_backends_enumerate_it() {
            assert!(prefers_directshow("OBS Virtual Camera"));
            assert!(prefers_directshow("OBS-Camera"));
            assert!(!prefers_directshow("Integrated Camera"));
        }

        #[derive(Debug, Default)]
        struct StatsSink(std::sync::Mutex<(usize, String)>);

        impl VideoFrameSink for StatsSink {
            fn push_frame(&self, frame: crate::video::convert::I420Frame) {
                let mean =
                    |p: &[u8]| p.iter().map(|&v| v as u64).sum::<u64>() / p.len().max(1) as u64;
                let mut s = self.0.lock().unwrap();
                s.0 += 1;
                s.1 = format!(
                    "{}x{} y={} u={} v={} (lens {} {} {})",
                    frame.width,
                    frame.height,
                    mean(&frame.y),
                    mean(&frame.u),
                    mean(&frame.v),
                    frame.y.len(),
                    frame.u.len(),
                    frame.v.len()
                );
            }
        }

        /// Opens every camera on this machine for three seconds and prints what it delivered.
        /// Run by hand: `cargo test --lib probe_cameras -- --ignored --nocapture`.
        #[test]
        #[ignore]
        fn probe_cameras() {
            let devices = list().unwrap();
            for device in devices {
                println!("== {} [{}]", device.name, device.id);
                let sink = Arc::new(StatsSink::default());
                let stop = Arc::new(AtomicBool::new(false));
                let thread_sink = Arc::clone(&sink);
                let thread_stop = Arc::clone(&stop);
                let id = device.id.clone();
                let handle = thread::spawn(move || {
                    let _com = ComGuard::new();
                    #[cfg(target_os = "windows")]
                    if let Some(path) = id.strip_prefix("ds:") {
                        crate::video::directshow::run_capture(
                            path,
                            &thread_stop,
                            thread_sink.as_ref(),
                            |r| println!("   start: {r:?}"),
                        );
                        return;
                    }
                    let index = camera_index(id.strip_prefix("mf:").unwrap_or(&id));
                    let requested = CameraFormat::new_from(1280, 720, FrameFormat::MJPEG, 30);
                    let mut camera = match open_profile_camera(index, requested) {
                        Ok(c) => c,
                        Err(e) => return println!("   open failed: {e}"),
                    };
                    println!("   format: {:?}", camera.camera_format());
                    if let Err(e) = camera.open_stream() {
                        return println!("   stream failed: {e}");
                    }
                    let (mut ok, mut frame_err, mut decode_err) = (0, 0, 0);
                    while !thread_stop.load(Ordering::Relaxed) {
                        let frame = match camera.frame() {
                            Ok(f) => f,
                            Err(e) => {
                                if frame_err == 0 {
                                    println!("   frame error: {e}");
                                }
                                frame_err += 1;
                                continue;
                            }
                        };
                        let raw_len = frame.buffer().len();
                        match frame.decode_image::<RgbFormat>() {
                            Ok(d) => {
                                ok += 1;
                                if let Some(i420) = packed_to_i420(
                                    d.as_raw(),
                                    d.width(),
                                    d.height(),
                                    d.width() as usize * 3,
                                    PackedFormat::Rgb,
                                ) {
                                    thread_sink.push_frame(i420);
                                }
                            }
                            Err(e) => {
                                if decode_err == 0 {
                                    println!(
                                        "   decode error ({raw_len} bytes, {:?}): {e}",
                                        frame.source_frame_format()
                                    );
                                }
                                decode_err += 1;
                            }
                        }
                    }
                    println!("   frames ok={ok} frame_err={frame_err} decode_err={decode_err}");
                    let _ = camera.stop_stream();
                });
                thread::sleep(Duration::from_secs(3));
                stop.store(true, Ordering::Relaxed);
                let _ = handle.join();
                let s = sink.0.lock().unwrap();
                println!("   pushed {} frames, last {}", s.0, s.1);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Screen backend
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
mod screen {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread::{self, JoinHandle};
    use std::time::{Duration, Instant};

    use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
    use windows_capture::frame::Frame;
    use windows_capture::graphics_capture_api::InternalCaptureControl;
    use windows_capture::monitor::Monitor;
    use windows_capture::settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
    };
    use windows_capture::window::Window;

    use crate::video::convert::{packed_to_i420, PackedFormat};
    use crate::video::domain::{
        DisplayTarget, VideoPauseReason, VideoSourceKind, VideoSourceRuntimeState,
        VideoSourceRuntimeStatus, VideoSourceState, WindowTarget,
    };

    use super::{
        CaptureEvent, CaptureEvents, HeldFrame, ScreenExtras, VideoCaptureError,
        VideoCaptureSignature, VideoFrameSink, VideoSourceId, VideoSourceRuntime,
        WindowShareActivity, PAUSED_FRAME_INTERVAL,
    };

    type BoxError = Box<dyn std::error::Error + Send + Sync>;

    /// How often a window share looks at whether its window is minimized or gone.
    const WINDOW_WATCH_INTERVAL: Duration = Duration::from_millis(250);

    /// Flags handed to the capture handler at construction.
    struct CaptureFlags {
        sink: Arc<dyn VideoFrameSink>,
        source_id: VideoSourceId,
        events: Option<CaptureEvents>,
        paused: Arc<AtomicBool>,
    }

    struct ScreenCapture {
        sink: Arc<dyn VideoFrameSink>,
        source_id: VideoSourceId,
        events: Option<CaptureEvents>,
        paused: Arc<AtomicBool>,
    }

    impl GraphicsCaptureApiHandler for ScreenCapture {
        type Flags = CaptureFlags;
        type Error = BoxError;

        fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
            Ok(Self {
                sink: ctx.flags.sink,
                source_id: ctx.flags.source_id,
                events: ctx.flags.events,
                paused: ctx.flags.paused,
            })
        }

        fn on_frame_arrived(
            &mut self,
            frame: &mut Frame,
            _control: InternalCaptureControl,
        ) -> Result<(), Self::Error> {
            // A minimized window has nothing real to show; the watcher sends the held frame.
            if self.paused.load(Ordering::Acquire) {
                return Ok(());
            }
            // Windows delivers at the display refresh rate. Reading a frame back from the
            // GPU and converting it costs several ms, so skip frames the profile's frame
            // rate would drop before paying for them.
            if !self.sink.frame_due() {
                return Ok(());
            }
            let width = frame.width();
            let height = frame.height();
            let mut buffer = frame.buffer()?;
            // BGRA8 as the GPU mapped it: rows are `row_pitch` bytes apart, often padded.
            // Converting straight from the mapping saves a full-frame copy that removing
            // the padding first would cost.
            let row_pitch = buffer.row_pitch() as usize;
            let raw = buffer.as_raw_buffer();
            if let Some(i420) = packed_to_i420(raw, width, height, row_pitch, PackedFormat::Bgra) {
                self.sink.push_frame(i420);
            }
            Ok(())
        }

        /// The captured window or monitor is gone (a window closed, a monitor unplugged).
        /// Not called when Raven stops the capture itself.
        fn on_closed(&mut self) -> Result<(), Self::Error> {
            if let Some(events) = &self.events {
                events.notify(self.source_id, CaptureEvent::TargetClosed);
            }
            Ok(())
        }
    }

    // The capture control handle returned by `start_free_threaded`. Boxed behind the
    // runtime so the manager can stop it uniformly.
    type Control = windows_capture::capture::CaptureControl<ScreenCapture, BoxError>;

    pub(super) struct ScreenRuntime {
        source_id: VideoSourceId,
        signature: VideoCaptureSignature,
        runtime_state: VideoSourceRuntimeState,
        control: Option<Control>,
        /// Set while the shared window is minimized.
        paused: Arc<AtomicBool>,
        watch: Option<WindowWatch>,
    }

    impl std::fmt::Debug for ScreenRuntime {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_struct("ScreenRuntime")
                .field("source_id", &self.source_id)
                .field("running", &self.control.is_some())
                .field("paused", &self.paused.load(Ordering::Relaxed))
                .finish()
        }
    }

    impl VideoSourceRuntime for ScreenRuntime {
        fn source_id(&self) -> VideoSourceId {
            self.source_id
        }
        fn stop(&mut self) {
            if let Some(mut watch) = self.watch.take() {
                watch.stop();
            }
            if let Some(control) = self.control.take() {
                let _ = control.stop();
            }
        }
        fn runtime_state(&self) -> VideoSourceRuntimeState {
            if self.paused.load(Ordering::Acquire) {
                return VideoSourceRuntimeState {
                    status: VideoSourceRuntimeStatus::Paused,
                    paused_reason: Some(VideoPauseReason::Minimized),
                    ..self.runtime_state.clone()
                };
            }
            self.runtime_state.clone()
        }
        fn signature(&self) -> &VideoCaptureSignature {
            &self.signature
        }
    }

    impl Drop for ScreenRuntime {
        fn drop(&mut self) {
            self.stop();
        }
    }

    /// Watches a shared window from its own thread: flags the share paused while the window
    /// is minimized and sends the held frame meanwhile, and reports when it is restored or
    /// closed. Never touches the frame callback's thread.
    struct WindowWatch {
        stop: Arc<AtomicBool>,
        thread: Option<JoinHandle<()>>,
    }

    impl WindowWatch {
        fn spawn(
            source_id: VideoSourceId,
            hwnd: isize,
            paused: Arc<AtomicBool>,
            held: Arc<HeldFrame>,
            output: Arc<dyn VideoFrameSink>,
            events: Option<CaptureEvents>,
        ) -> Self {
            let stop = Arc::new(AtomicBool::new(false));
            let thread_stop = Arc::clone(&stop);
            let thread = thread::Builder::new()
                .name("raven-window-watch".to_string())
                .spawn(move || {
                    let mut activity = WindowShareActivity::Live;
                    let mut last_sent: Option<Instant> = None;
                    loop {
                        // First look one interval in: the window was only just restored.
                        thread::park_timeout(WINDOW_WATCH_INTERVAL);
                        if thread_stop.load(Ordering::Acquire) {
                            break;
                        }
                        let (exists, minimized) = window_condition(hwnd);
                        let next = activity.next(exists, minimized);
                        if next != activity {
                            activity = next;
                            paused.store(next == WindowShareActivity::Paused, Ordering::Release);
                            last_sent = None;
                            if let Some(events) = &events {
                                events.notify(
                                    source_id,
                                    if next == WindowShareActivity::Closed {
                                        CaptureEvent::TargetClosed
                                    } else {
                                        CaptureEvent::StateChanged
                                    },
                                );
                            }
                            if next == WindowShareActivity::Closed {
                                break;
                            }
                        }
                        if activity == WindowShareActivity::Paused
                            && last_sent.is_none_or(|sent| sent.elapsed() >= PAUSED_FRAME_INTERVAL)
                        {
                            if let Some(frame) = held.latest() {
                                output.push_frame(frame);
                            }
                            last_sent = Some(Instant::now());
                        }
                    }
                })
                .ok();
            Self { stop, thread }
        }

        fn stop(&mut self) {
            self.stop.store(true, Ordering::Release);
            if let Some(thread) = self.thread.take() {
                thread.thread().unpark();
                let _ = thread.join();
            }
        }
    }

    /// Whether the window still exists, and whether it is minimized.
    fn window_condition(hwnd: isize) -> (bool, bool) {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{IsIconic, IsWindow};
        let hwnd = HWND(hwnd as *mut std::ffi::c_void);
        unsafe {
            let exists = IsWindow(hwnd).as_bool();
            (exists, exists && IsIconic(hwnd).as_bool())
        }
    }

    pub(super) fn start(
        source: &VideoSourceState,
        signature: VideoCaptureSignature,
        sink: Arc<dyn VideoFrameSink>,
        extras: ScreenExtras,
    ) -> Result<Box<dyn VideoSourceRuntime>, VideoCaptureError> {
        let paused = Arc::new(AtomicBool::new(false));
        let flags = CaptureFlags {
            sink,
            source_id: source.id,
            events: extras.events.clone(),
            paused: Arc::clone(&paused),
        };
        let runtime_state = super::running_runtime_state(&source.profile);
        // NOTE: the exact `Settings::new` argument list is sensitive to the resolved
        // `windows-capture` version; adjust here if the build flags a signature mismatch.
        let (control, watch) = match source.kind {
            VideoSourceKind::Display => {
                let monitor = monitor_from_target(&source.target_id)?;
                let settings = Settings::new(
                    monitor,
                    CursorCaptureSettings::Default,
                    DrawBorderSettings::WithoutBorder,
                    SecondaryWindowSettings::Default,
                    MinimumUpdateIntervalSettings::Default,
                    DirtyRegionSettings::Default,
                    ColorFormat::Bgra8,
                    flags,
                );
                let control = ScreenCapture::start_free_threaded(settings).map_err(|error| {
                    VideoCaptureError::StreamFailed {
                        message: error.to_string(),
                    }
                })?;
                (control, None)
            }
            VideoSourceKind::Window => {
                let window = window_from_target(&source.target_id)?;
                // Minimized windows aren't composited by the desktop, so WGC yields blank
                // frames until they're shown. Restore (without activating) so capture works
                // immediately instead of requiring the user to bring the window up manually.
                restore_window_if_minimized(&source.target_id);
                let settings = Settings::new(
                    window,
                    CursorCaptureSettings::Default,
                    DrawBorderSettings::WithoutBorder,
                    SecondaryWindowSettings::Default,
                    MinimumUpdateIntervalSettings::Default,
                    DirtyRegionSettings::Default,
                    ColorFormat::Bgra8,
                    flags,
                );
                let control = ScreenCapture::start_free_threaded(settings).map_err(|error| {
                    VideoCaptureError::StreamFailed {
                        message: error.to_string(),
                    }
                })?;
                let watch = match (extras.held, source.target_id.parse::<isize>()) {
                    (Some((held, output)), Ok(hwnd)) => Some(WindowWatch::spawn(
                        source.id,
                        hwnd,
                        Arc::clone(&paused),
                        held,
                        output,
                        extras.events,
                    )),
                    _ => None,
                };
                (control, watch)
            }
            VideoSourceKind::Camera => unreachable!("camera handled by camera backend"),
        };

        Ok(Box::new(ScreenRuntime {
            source_id: source.id,
            signature,
            runtime_state,
            control: Some(control),
            paused,
            watch,
        }))
    }

    fn monitor_from_target(target_id: &str) -> Result<Monitor, VideoCaptureError> {
        let index: usize = target_id
            .parse()
            .map_err(|_| VideoCaptureError::InvalidTarget {
                message: format!("invalid monitor index '{target_id}'"),
            })?;
        Monitor::from_index(index).map_err(|error| VideoCaptureError::InvalidTarget {
            message: error.to_string(),
        })
    }

    fn window_from_target(target_id: &str) -> Result<Window, VideoCaptureError> {
        let hwnd: isize = target_id
            .parse()
            .map_err(|_| VideoCaptureError::InvalidTarget {
                message: format!("invalid window handle '{target_id}'"),
            })?;
        Ok(Window::from_raw_hwnd(hwnd as *mut std::ffi::c_void))
    }

    /// Un-minimize a window (without activating/focus-stealing) so the desktop composites
    /// it and WGC can capture real pixels. No-op if the window isn't minimized.
    fn restore_window_if_minimized(target_id: &str) {
        let Ok(hwnd_val) = target_id.parse::<isize>() else {
            return;
        };
        unsafe {
            use windows::Win32::Foundation::HWND;
            use windows::Win32::UI::WindowsAndMessaging::{
                IsIconic, ShowWindow, SW_SHOWNOACTIVATE,
            };
            let hwnd = HWND(hwnd_val as *mut std::ffi::c_void);
            if IsIconic(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            }
        }
    }

    pub(super) fn list_displays() -> Result<Vec<DisplayTarget>, VideoCaptureError> {
        let monitors =
            Monitor::enumerate().map_err(|error| VideoCaptureError::DeviceUnavailable {
                message: error.to_string(),
            })?;
        let primary = Monitor::primary().ok();
        let mut out = Vec::new();
        for (offset, monitor) in monitors.into_iter().enumerate() {
            // windows-capture monitor indices are 1-based.
            let index = offset + 1;
            let name = monitor
                .name()
                .unwrap_or_else(|_| format!("Display {index}"));
            let width = monitor.width().unwrap_or(0);
            let height = monitor.height().unwrap_or(0);
            let is_primary = primary
                .as_ref()
                .and_then(|p| p.name().ok())
                .map(|pn| pn == name)
                .unwrap_or(index == 1);
            let thumbnail_data_url = imaging::monitor_thumbnail(monitor.as_raw_hmonitor());
            out.push(DisplayTarget {
                id: index.to_string(),
                name,
                width,
                height,
                is_primary,
                thumbnail_data_url,
            });
        }
        Ok(out)
    }

    /// The title `lib/pictureInPicture.ts` gives these windows.
    const PICTURE_IN_PICTURE_TITLE: &str = "Raven picture in picture";

    pub(super) fn list_windows() -> Result<Vec<WindowTarget>, VideoCaptureError> {
        let windows =
            Window::enumerate().map_err(|error| VideoCaptureError::DeviceUnavailable {
                message: error.to_string(),
            })?;
        let mut out = Vec::new();
        for window in windows {
            let Ok(title) = window.title() else { continue };
            if title.trim().is_empty() {
                continue;
            }
            // Picture-in-picture windows are hidden from capture; they would be black here.
            if title == PICTURE_IN_PICTURE_TITLE
                && window.process_id().ok() == Some(std::process::id())
            {
                continue;
            }
            let app_name = window
                .process_name()
                .ok()
                .map(|name| strip_exe(&name))
                .unwrap_or_default();
            let process_id = window.process_id().unwrap_or(0);
            let raw_hwnd = window.as_raw_hwnd();
            let id = raw_hwnd as isize;
            let ((width, height), minimized) =
                imaging::window_size(raw_hwnd).unwrap_or(((0, 0), false));
            let icon_data_url = if process_id != 0 {
                imaging::window_icon(process_id)
            } else {
                None
            };
            // A minimized window is not drawn: `PrintWindow` would give a stub or black.
            let thumbnail_data_url = if minimized {
                None
            } else {
                imaging::window_thumbnail(raw_hwnd)
            };
            out.push(WindowTarget {
                id: id.to_string(),
                title,
                app_name,
                process_id,
                width,
                height,
                minimized,
                icon_data_url,
                thumbnail_data_url,
            });
        }
        Ok(out)
    }

    fn strip_exe(name: &str) -> String {
        let stem = name.strip_suffix(".exe").unwrap_or(name);
        let mut chars = stem.chars();
        match chars.next() {
            Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
            None => stem.to_string(),
        }
    }

    /// Window icons + window/monitor preview thumbnails for the picker. Windows are captured
    /// with `PrintWindow` (their own pixels, even when occluded); monitors are grabbed from
    /// their on-screen region. Icons reuse the executable-icon extraction pattern from the
    /// audio module. All best-effort: any failure yields `None` and the picker shows a
    /// placeholder.
    pub(super) mod imaging {
        use base64::Engine as _;
        use windows::core::{PCWSTR, PWSTR};
        use windows::Win32::Foundation::{CloseHandle, HWND, RECT};
        use windows::Win32::Graphics::Gdi::{
            CreateCompatibleBitmap, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject,
            GetDC, GetMonitorInfoW, MonitorFromWindow, ReleaseDC, SelectObject, SetStretchBltMode,
            StretchBlt, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HALFTONE, HDC,
            HMONITOR, MONITORINFO, MONITOR_DEFAULTTONEAREST, SRCCOPY,
        };
        use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
        use windows::Win32::System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
        use windows::Win32::UI::WindowsAndMessaging::{
            DestroyIcon, DrawIconEx, GetWindowPlacement, GetWindowRect, IsIconic, DI_NORMAL, HICON,
            PW_RENDERFULLCONTENT, WINDOWPLACEMENT, WPF_RESTORETOMAXIMIZED,
        };

        const MAX_THUMB_WIDTH: i32 = 320;

        /// The window's size, and whether it is minimized. A minimized window reports the
        /// size it is restored to (see [`super::super::restored_window_size`]). Sizes are in
        /// physical pixels: Raven is per-monitor DPI aware, so both `GetWindowRect` and
        /// `GetWindowPlacement` answer unscaled.
        pub(in crate::video::capture) fn window_size(
            raw_hwnd: *mut std::ffi::c_void,
        ) -> Option<((u32, u32), bool)> {
            unsafe {
                let hwnd = HWND(raw_hwnd);
                if IsIconic(hwnd).as_bool() {
                    let mut placement = WINDOWPLACEMENT {
                        length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
                        ..Default::default()
                    };
                    GetWindowPlacement(hwnd, &mut placement).ok()?;
                    let restores_maximized = placement.flags.0 & WPF_RESTORETOMAXIMIZED.0 != 0;
                    let work_area = if restores_maximized {
                        let mut info = MONITORINFO {
                            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                            ..Default::default()
                        };
                        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
                        GetMonitorInfoW(monitor, &mut info)
                            .as_bool()
                            .then_some(info.rcWork)
                    } else {
                        None
                    };
                    let rect = |r: RECT| (r.left, r.top, r.right, r.bottom);
                    let size = super::super::restored_window_size(
                        rect(placement.rcNormalPosition),
                        restores_maximized,
                        work_area.map(rect),
                    )?;
                    return Some((size, true));
                }
                let mut rect = RECT::default();
                GetWindowRect(hwnd, &mut rect).ok()?;
                let width = rect.right - rect.left;
                let height = rect.bottom - rect.top;
                if width <= 0 || height <= 0 {
                    return None;
                }
                Some(((width as u32, height as u32), false))
            }
        }

        /// Capture a window's *own* pixels via `PrintWindow` (works even when the window is
        /// occluded or in the background), then downscale. A plain screen grab would just
        /// show whatever is on top at the window's location (e.g. Raven itself).
        pub(super) fn window_thumbnail(raw_hwnd: *mut std::ffi::c_void) -> Option<String> {
            unsafe {
                let hwnd = HWND(raw_hwnd);
                let mut rect = RECT::default();
                GetWindowRect(hwnd, &mut rect).ok()?;
                let w = rect.right - rect.left;
                let h = rect.bottom - rect.top;
                if w <= 0 || h <= 0 {
                    return None;
                }
                let screen = GetDC(None);
                if screen.is_invalid() {
                    return None;
                }
                let src = CreateCompatibleDC(screen);
                let full = CreateCompatibleBitmap(screen, w, h);
                let result = if src.is_invalid() || full.is_invalid() {
                    None
                } else {
                    let old = SelectObject(src, full);
                    let printed =
                        PrintWindow(hwnd, src, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT)).as_bool();
                    let out = if printed {
                        downscale_to_png(src, 0, 0, w, h)
                    } else {
                        None
                    };
                    let _ = SelectObject(src, old);
                    out
                };
                if !full.is_invalid() {
                    let _ = DeleteObject(full);
                }
                if !src.is_invalid() {
                    let _ = DeleteDC(src);
                }
                ReleaseDC(None, screen);
                result
            }
        }

        /// A monitor's thumbnail is just its on-screen region (the screen *is* its content).
        pub(super) fn monitor_thumbnail(raw_hmonitor: *mut std::ffi::c_void) -> Option<String> {
            unsafe {
                let hmonitor = HMONITOR(raw_hmonitor);
                let mut info = MONITORINFO {
                    cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                    ..Default::default()
                };
                if !GetMonitorInfoW(hmonitor, &mut info).as_bool() {
                    return None;
                }
                let rect = info.rcMonitor;
                let w = rect.right - rect.left;
                let h = rect.bottom - rect.top;
                if w <= 0 || h <= 0 {
                    return None;
                }
                let screen = GetDC(None);
                if screen.is_invalid() {
                    return None;
                }
                let result = downscale_to_png(screen, rect.left, rect.top, w, h);
                ReleaseDC(None, screen);
                result
            }
        }

        /// `StretchBlt` a region of `src` into a downscaled top-down 32bpp DIB and PNG-encode it.
        unsafe fn downscale_to_png(src: HDC, sx: i32, sy: i32, sw: i32, sh: i32) -> Option<String> {
            if sw <= 0 || sh <= 0 {
                return None;
            }
            let scale = (MAX_THUMB_WIDTH as f32 / sw as f32).min(1.0);
            let tw = ((sw as f32 * scale) as i32).max(1);
            let th = ((sh as f32 * scale) as i32).max(1);

            let dst = CreateCompatibleDC(src);
            if dst.is_invalid() {
                return None;
            }
            let bmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: tw,
                    biHeight: -th, // top-down
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bits: *mut std::ffi::c_void = std::ptr::null_mut();
            let bmp = match CreateDIBSection(dst, &bmi, DIB_RGB_COLORS, &mut bits, None, 0) {
                Ok(bmp) if !bmp.is_invalid() && !bits.is_null() => bmp,
                Ok(bmp) => {
                    if !bmp.is_invalid() {
                        let _ = DeleteObject(bmp);
                    }
                    let _ = DeleteDC(dst);
                    return None;
                }
                Err(_) => {
                    let _ = DeleteDC(dst);
                    return None;
                }
            };
            let old = SelectObject(dst, bmp);
            SetStretchBltMode(dst, HALFTONE);
            let ok = StretchBlt(dst, 0, 0, tw, th, src, sx, sy, sw, sh, SRCCOPY).as_bool();
            let pixel_len = (tw * th * 4) as usize;
            let pixels = if ok {
                std::slice::from_raw_parts(bits as *const u8, pixel_len).to_vec()
            } else {
                Vec::new()
            };
            let _ = SelectObject(dst, old);
            let _ = DeleteObject(bmp);
            let _ = DeleteDC(dst);
            if pixels.is_empty() {
                return None;
            }

            let mut rgba = Vec::with_capacity(pixel_len);
            for pixel in pixels.chunks_exact(4) {
                rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], 255]);
            }
            encode_png_rgba(&rgba, tw as u32, th as u32)
        }

        pub(super) fn window_icon(process_id: u32) -> Option<String> {
            unsafe {
                let path = process_image_path(process_id)?;
                if path.starts_with("\\Device\\") {
                    return None;
                }
                extract_icon_data_url(&path)
            }
        }

        unsafe fn process_image_path(process_id: u32) -> Option<String> {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id).ok()?;
            let mut path_buf = vec![0u16; 1024];
            let mut size = path_buf.len() as u32;
            let ok = QueryFullProcessImageNameW(
                handle,
                Default::default(),
                PWSTR(path_buf.as_mut_ptr()),
                &mut size,
            )
            .is_ok();
            let _ = CloseHandle(handle);
            if !ok || size == 0 {
                return None;
            }
            Some(String::from_utf16_lossy(&path_buf[..size as usize]))
        }

        unsafe fn extract_icon_data_url(exe_path: &str) -> Option<String> {
            let path_wide: Vec<u16> = exe_path.encode_utf16().chain(std::iter::once(0)).collect();
            let mut file_info: SHFILEINFOW = std::mem::zeroed();
            let result = SHGetFileInfoW(
                PCWSTR(path_wide.as_ptr()),
                Default::default(),
                Some(&mut file_info),
                std::mem::size_of::<SHFILEINFOW>() as u32,
                SHGFI_ICON | SHGFI_LARGEICON,
            );
            if result == 0 || file_info.hIcon.is_invalid() {
                return None;
            }
            let icon = file_info.hIcon;
            let data = icon_to_png_data_url(icon);
            let _ = DestroyIcon(icon);
            data
        }

        unsafe fn icon_to_png_data_url(icon: HICON) -> Option<String> {
            const SIZE: i32 = 32;
            let screen = CreateCompatibleDC(None);
            if screen.is_invalid() {
                return None;
            }
            let bmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: SIZE,
                    biHeight: -SIZE,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bits: *mut std::ffi::c_void = std::ptr::null_mut();
            let Ok(bmp) = CreateDIBSection(screen, &bmi, DIB_RGB_COLORS, &mut bits, None, 0) else {
                let _ = DeleteDC(screen);
                return None;
            };
            if bmp.is_invalid() || bits.is_null() {
                if !bmp.is_invalid() {
                    let _ = DeleteObject(bmp);
                }
                let _ = DeleteDC(screen);
                return None;
            }
            let pixel_len = (SIZE * SIZE * 4) as usize;
            std::ptr::write_bytes(bits, 0, pixel_len);
            let old = SelectObject(screen, bmp);
            let draw = DrawIconEx(screen, 0, 0, icon, SIZE, SIZE, 0, None, DI_NORMAL);
            let pixels = std::slice::from_raw_parts(bits as *const u8, pixel_len).to_vec();
            let _ = SelectObject(screen, old);
            let _ = DeleteObject(bmp);
            let _ = DeleteDC(screen);
            if draw.is_err() {
                return None;
            }
            let has_alpha = pixels.chunks_exact(4).any(|pixel| pixel[3] != 0);
            let mut rgba = Vec::with_capacity(pixel_len);
            for pixel in pixels.chunks_exact(4) {
                let (b, g, r) = (pixel[0], pixel[1], pixel[2]);
                let a = if has_alpha {
                    pixel[3]
                } else if r != 0 || g != 0 || b != 0 {
                    255
                } else {
                    0
                };
                rgba.extend_from_slice(&[r, g, b, a]);
            }
            encode_png_rgba(&rgba, SIZE as u32, SIZE as u32)
        }

        fn encode_png_rgba(rgba: &[u8], width: u32, height: u32) -> Option<String> {
            let mut out = Vec::new();
            {
                let mut encoder = png::Encoder::new(&mut out, width, height);
                encoder.set_color(png::ColorType::Rgba);
                encoder.set_depth(png::BitDepth::Eight);
                let mut writer = encoder.write_header().ok()?;
                writer.write_image_data(rgba).ok()?;
            }
            let encoded = base64::engine::general_purpose::STANDARD.encode(&out);
            Some(format!("data:image/png;base64,{encoded}"))
        }
    }
}

#[cfg(target_os = "linux")]
mod screen {
    use std::io::Read;
    use std::os::fd::{AsRawFd, OwnedFd, RawFd};
    use std::process::{Child, ChildStdout, Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread::{self, JoinHandle};

    use ashpd::desktop::screencast::{CursorMode, Screencast, SourceType, Stream};
    use ashpd::desktop::PersistMode;

    use crate::video::convert::GstI420Layout;
    use crate::video::domain::{
        DisplayTarget, VideoQualityProfile, VideoSourceKind, VideoSourceRuntimeState,
        VideoSourceState, WindowTarget,
    };

    use super::{
        running_runtime_state, VideoCaptureError, VideoCaptureSignature, VideoFrameSink,
        VideoSourceId, VideoSourceRuntime,
    };

    const PORTAL_DISPLAY_TARGET_ID: &str = "portal:display";
    const PORTAL_WINDOW_TARGET_ID: &str = "portal:window";

    pub(super) fn runtime_readiness() -> Result<(), String> {
        if std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_none()
            && std::env::var_os("XDG_RUNTIME_DIR").is_none()
        {
            return Err(
                "Screen sharing needs an active desktop session and xdg-desktop-portal."
                    .to_string(),
            );
        }
        let portal = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| format!("Screen sharing could not start its portal check: {error}"))?;
        portal.block_on(Screencast::new()).map_err(|error| {
            format!("Screen sharing needs a working xdg-desktop-portal ScreenCast service: {error}")
        })?;
        let pipewire_plugin = Command::new("gst-inspect-1.0")
            .arg("pipewiresrc")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        match pipewire_plugin {
            Ok(status) if status.success() => Ok(()),
            _ => Err(
                "Screen sharing needs GStreamer and its PipeWire plugin (`gstreamer1.0-pipewire`)."
                    .to_string(),
            ),
        }
    }

    #[derive(Debug)]
    pub(super) struct PortalScreenRuntime {
        source_id: VideoSourceId,
        signature: VideoCaptureSignature,
        runtime_state: VideoSourceRuntimeState,
        stop: Arc<AtomicBool>,
        child: Arc<Mutex<Option<Child>>>,
        handle: Option<JoinHandle<()>>,
        _pipewire_fd: OwnedFd,
    }

    impl VideoSourceRuntime for PortalScreenRuntime {
        fn source_id(&self) -> VideoSourceId {
            self.source_id
        }

        fn stop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            stop_child(&self.child);
            if let Some(handle) = self.handle.take() {
                let _ = handle.join();
            }
        }

        fn runtime_state(&self) -> VideoSourceRuntimeState {
            self.runtime_state.clone()
        }

        fn signature(&self) -> &VideoCaptureSignature {
            &self.signature
        }
    }

    impl Drop for PortalScreenRuntime {
        fn drop(&mut self) {
            self.stop();
        }
    }

    struct PortalSelection {
        stream: Stream,
        fd: OwnedFd,
    }

    pub(super) fn start(
        source: &VideoSourceState,
        signature: VideoCaptureSignature,
        sink: Arc<dyn VideoFrameSink>,
        _extras: super::ScreenExtras,
    ) -> Result<Box<dyn VideoSourceRuntime>, VideoCaptureError> {
        let profile = source.profile.clone();
        let selection = open_portal_selection(source.kind)?;
        let (child, stdout) = spawn_gstreamer_i420_pipeline(&selection, &profile)?;
        let stop = Arc::new(AtomicBool::new(false));
        let child = Arc::new(Mutex::new(Some(child)));
        let thread_stop = Arc::clone(&stop);
        let thread_child = Arc::clone(&child);
        let thread_profile = profile.clone();
        let handle = thread::spawn(move || {
            read_i420_frames(stdout, &thread_profile, sink, &thread_stop);
            thread_stop.store(true, Ordering::Relaxed);
            stop_child(&thread_child);
        });

        Ok(Box::new(PortalScreenRuntime {
            source_id: source.id,
            signature,
            runtime_state: running_runtime_state(&profile),
            stop,
            child,
            handle: Some(handle),
            _pipewire_fd: selection.fd,
        }))
    }

    pub(super) fn list_displays() -> Result<Vec<DisplayTarget>, VideoCaptureError> {
        Ok(vec![DisplayTarget {
            id: PORTAL_DISPLAY_TARGET_ID.to_string(),
            name: "Choose a display...".to_string(),
            width: 1920,
            height: 1080,
            is_primary: true,
            thumbnail_data_url: None,
        }])
    }

    pub(super) fn list_windows() -> Result<Vec<WindowTarget>, VideoCaptureError> {
        Ok(vec![WindowTarget {
            id: PORTAL_WINDOW_TARGET_ID.to_string(),
            title: "Choose a window...".to_string(),
            app_name: "Desktop portal".to_string(),
            process_id: 0,
            width: 1280,
            height: 720,
            minimized: false,
            icon_data_url: None,
            thumbnail_data_url: None,
        }])
    }

    fn open_portal_selection(kind: VideoSourceKind) -> Result<PortalSelection, VideoCaptureError> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| VideoCaptureError::StreamFailed {
                message: format!("failed to start portal runtime: {error}"),
            })?;
        runtime.block_on(open_portal_selection_async(kind))
    }

    async fn open_portal_selection_async(
        kind: VideoSourceKind,
    ) -> Result<PortalSelection, VideoCaptureError> {
        let source_type = match kind {
            VideoSourceKind::Display => SourceType::Monitor.into(),
            VideoSourceKind::Window => SourceType::Window.into(),
            VideoSourceKind::Camera => {
                return Err(VideoCaptureError::InvalidTarget {
                    message: "camera capture does not use the screen portal".to_string(),
                })
            }
        };
        let proxy = Screencast::new()
            .await
            .map_err(|error| portal_error("connect to xdg-desktop-portal ScreenCast", error))?;
        let session = proxy
            .create_session()
            .await
            .map_err(|error| portal_error("create screen-cast session", error))?;
        proxy
            .select_sources(
                &session,
                CursorMode::Embedded,
                source_type,
                false,
                None,
                PersistMode::DoNot,
            )
            .await
            .map_err(|error| portal_error("select screen-cast sources", error))?;
        let response = proxy
            .start(&session, None)
            .await
            .map_err(|error| portal_error("start screen-cast request", error))?
            .response()
            .map_err(|error| portal_error("read screen-cast selection", error))?;
        let stream = response.streams().first().cloned().ok_or_else(|| {
            VideoCaptureError::InvalidTarget {
                message: "no PipeWire stream was selected".to_string(),
            }
        })?;
        let fd = proxy
            .open_pipe_wire_remote(&session)
            .await
            .map_err(|error| portal_error("open PipeWire remote", error))?;
        Ok(PortalSelection { stream, fd })
    }

    fn portal_error(action: &str, error: ashpd::Error) -> VideoCaptureError {
        VideoCaptureError::StreamFailed {
            message: format!("failed to {action}: {error}"),
        }
    }

    fn spawn_gstreamer_i420_pipeline(
        selection: &PortalSelection,
        profile: &VideoQualityProfile,
    ) -> Result<(Child, ChildStdout), VideoCaptureError> {
        let fd = selection.fd.as_raw_fd();
        clear_cloexec(fd)?;
        let node_id = selection.stream.pipe_wire_node_id();
        let fps = profile.fps.round().clamp(1.0, 120.0) as u32;
        let caps = format!(
            "video/x-raw,format=I420,width={},height={},framerate={}/1",
            profile.width, profile.height, fps
        );
        let mut child = Command::new("gst-launch-1.0")
            .arg("-q")
            .arg("pipewiresrc")
            .arg(format!("fd={fd}"))
            .arg(format!("path={node_id}"))
            .arg("do-timestamp=true")
            .arg("!")
            .arg("videoconvert")
            .arg("!")
            .arg("videoscale")
            .arg("!")
            .arg(caps)
            .arg("!")
            .arg("fdsink")
            .arg("fd=1")
            .arg("sync=false")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| VideoCaptureError::StreamFailed {
                message: format!(
                    "failed to launch gst-launch-1.0 for PipeWire capture: {error}. \
                     Install GStreamer with the PipeWire plugin."
                ),
            })?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| VideoCaptureError::StreamFailed {
                message: "GStreamer capture pipeline did not expose stdout".to_string(),
            })?;
        Ok((child, stdout))
    }

    fn clear_cloexec(fd: RawFd) -> Result<(), VideoCaptureError> {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        if flags < 0 {
            return Err(VideoCaptureError::StreamFailed {
                message: "failed to inspect PipeWire file-descriptor flags".to_string(),
            });
        }
        let result = unsafe { libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) };
        if result < 0 {
            return Err(VideoCaptureError::StreamFailed {
                message: "failed to pass PipeWire file descriptor to GStreamer".to_string(),
            });
        }
        Ok(())
    }

    fn read_i420_frames(
        mut stdout: ChildStdout,
        profile: &VideoQualityProfile,
        sink: Arc<dyn VideoFrameSink>,
        stop: &AtomicBool,
    ) {
        // GStreamer pads rows; read whole wire frames and drop the padding.
        let layout = GstI420Layout::new(profile.width, profile.height);
        let frame_size = layout.size;
        if frame_size == 0 {
            return;
        }
        let mut pending = Vec::with_capacity(frame_size * 2);
        let mut chunk = vec![0u8; frame_size.min(256 * 1024).max(8192)];

        while !stop.load(Ordering::Relaxed) {
            let read = match stdout.read(&mut chunk) {
                Ok(0) => break,
                Ok(read) => read,
                Err(error) => {
                    eprintln!("[video-capture] Linux PipeWire stream read failed: {error}");
                    break;
                }
            };
            pending.extend_from_slice(&chunk[..read]);
            while pending.len() >= frame_size {
                let raw: Vec<u8> = pending.drain(..frame_size).collect();
                if let Some(frame) = layout.to_i420(profile.width, profile.height, &raw) {
                    sink.push_frame(frame);
                }
            }
        }
    }

    fn stop_child(child: &Arc<Mutex<Option<Child>>>) {
        let Ok(mut guard) = child.lock() else {
            return;
        };
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(target_os = "macos")]
mod screen {
    use std::sync::Arc;

    use screencapturekit::cv::CVPixelBufferLockFlags;
    use screencapturekit::prelude::*;

    use crate::video::convert::{packed_to_i420, I420Frame, PackedFormat};
    use crate::video::domain::{
        DisplayTarget, VideoSourceKind, VideoSourceRuntimeState, VideoSourceState, WindowTarget,
    };

    use super::{
        running_runtime_state, VideoCaptureError, VideoCaptureSignature, VideoFrameSink,
        VideoSourceId, VideoSourceRuntime,
    };

    #[derive(Debug)]
    pub(super) struct ScreenCaptureKitRuntime {
        source_id: VideoSourceId,
        signature: VideoCaptureSignature,
        runtime_state: VideoSourceRuntimeState,
        stream: Option<SCStream>,
    }

    impl VideoSourceRuntime for ScreenCaptureKitRuntime {
        fn source_id(&self) -> VideoSourceId {
            self.source_id
        }

        fn stop(&mut self) {
            if let Some(stream) = self.stream.take() {
                let _ = stream.stop_capture();
            }
        }

        fn runtime_state(&self) -> VideoSourceRuntimeState {
            self.runtime_state.clone()
        }

        fn signature(&self) -> &VideoCaptureSignature {
            &self.signature
        }
    }

    impl Drop for ScreenCaptureKitRuntime {
        fn drop(&mut self) {
            self.stop();
        }
    }

    struct VideoFrameHandler {
        sink: Arc<dyn VideoFrameSink>,
    }

    impl SCStreamOutputTrait for VideoFrameHandler {
        fn did_output_sample_buffer(
            &self,
            sample_buffer: CMSampleBuffer,
            of_type: SCStreamOutputType,
        ) {
            if of_type != SCStreamOutputType::Screen {
                return;
            }
            let Some(frame) = i420_frame_from_sample_buffer(&sample_buffer) else {
                return;
            };
            self.sink.push_frame(frame);
        }
    }

    pub(super) fn start(
        source: &VideoSourceState,
        signature: VideoCaptureSignature,
        sink: Arc<dyn VideoFrameSink>,
        _extras: super::ScreenExtras,
    ) -> Result<Box<dyn VideoSourceRuntime>, VideoCaptureError> {
        let profile = source.profile.clone();
        let filter = content_filter_for_source(source)?;
        let config = SCStreamConfiguration::new()
            .with_width(profile.width)
            .with_height(profile.height)
            .with_pixel_format(PixelFormat::BGRA)
            .with_queue_depth(3)
            .with_fps(profile.fps.round().clamp(1.0, 120.0) as u32)
            .with_shows_cursor(true)
            .with_scales_to_fit(true);
        let mut stream = SCStream::new(&filter, &config);
        if stream
            .add_output_handler(VideoFrameHandler { sink }, SCStreamOutputType::Screen)
            .is_none()
        {
            return Err(VideoCaptureError::StreamFailed {
                message: "ScreenCaptureKit rejected the screen output handler".to_string(),
            });
        }
        stream
            .start_capture()
            .map_err(|error| VideoCaptureError::StreamFailed {
                message: format!("failed to start macOS ScreenCaptureKit video capture: {error}"),
            })?;

        Ok(Box::new(ScreenCaptureKitRuntime {
            source_id: source.id,
            signature,
            runtime_state: running_runtime_state(&profile),
            stream: Some(stream),
        }))
    }

    pub(super) fn list_displays() -> Result<Vec<DisplayTarget>, VideoCaptureError> {
        let displays = shareable_content()?.displays();
        let primary_id = displays.first().map(SCDisplay::display_id);
        Ok(displays
            .into_iter()
            .enumerate()
            .map(|(index, display)| DisplayTarget {
                id: display.display_id().to_string(),
                name: format!("Display {}", index + 1),
                width: display.width(),
                height: display.height(),
                is_primary: primary_id == Some(display.display_id()),
                thumbnail_data_url: None,
            })
            .collect())
    }

    pub(super) fn list_windows() -> Result<Vec<WindowTarget>, VideoCaptureError> {
        let mut windows: Vec<WindowTarget> = shareable_content()?
            .windows()
            .into_iter()
            .filter(|window| window.is_on_screen())
            .filter_map(window_target)
            .collect();
        windows.sort_by(|a, b| {
            a.app_name
                .to_lowercase()
                .cmp(&b.app_name.to_lowercase())
                .then(a.title.to_lowercase().cmp(&b.title.to_lowercase()))
                .then(a.process_id.cmp(&b.process_id))
        });
        Ok(windows)
    }

    fn content_filter_for_source(
        source: &VideoSourceState,
    ) -> Result<SCContentFilter, VideoCaptureError> {
        match source.kind {
            VideoSourceKind::Display => {
                let display = display_from_target(&source.target_id)?.ok_or_else(|| {
                    VideoCaptureError::InvalidTarget {
                        message: format!(
                            "no ScreenCaptureKit display found for id {}",
                            source.target_id
                        ),
                    }
                })?;
                Ok(SCContentFilter::create()
                    .with_display(&display)
                    .with_excluding_windows(&[])
                    .build())
            }
            VideoSourceKind::Window => {
                let window = window_from_target(&source.target_id)?.ok_or_else(|| {
                    VideoCaptureError::InvalidTarget {
                        message: format!(
                            "no ScreenCaptureKit window found for id {}",
                            source.target_id
                        ),
                    }
                })?;
                Ok(SCContentFilter::create().with_window(&window).build())
            }
            VideoSourceKind::Camera => Err(VideoCaptureError::InvalidTarget {
                message: "camera capture does not use ScreenCaptureKit".to_string(),
            }),
        }
    }

    fn display_from_target(target_id: &str) -> Result<Option<SCDisplay>, VideoCaptureError> {
        let display_id =
            target_id
                .parse::<u32>()
                .map_err(|_| VideoCaptureError::InvalidTarget {
                    message: format!("invalid ScreenCaptureKit display id '{target_id}'"),
                })?;
        Ok(shareable_content()?
            .displays()
            .into_iter()
            .find(|display| display.display_id() == display_id))
    }

    fn window_from_target(target_id: &str) -> Result<Option<SCWindow>, VideoCaptureError> {
        let window_id = target_id
            .parse::<u32>()
            .map_err(|_| VideoCaptureError::InvalidTarget {
                message: format!("invalid ScreenCaptureKit window id '{target_id}'"),
            })?;
        Ok(shareable_content()?
            .windows()
            .into_iter()
            .find(|window| window.window_id() == window_id))
    }

    fn window_target(window: SCWindow) -> Option<WindowTarget> {
        let title = window.title()?;
        if title.trim().is_empty() {
            return None;
        }
        let frame = window.frame();
        let application = window.owning_application();
        let app_name = application
            .as_ref()
            .map(SCRunningApplication::application_name)
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| "Unknown application".to_string());
        let process_id = application
            .as_ref()
            .and_then(|app| u32::try_from(app.process_id()).ok())
            .unwrap_or(0);
        Some(WindowTarget {
            id: window.window_id().to_string(),
            title,
            app_name,
            process_id,
            width: positive_size_to_u32(frame.size.width),
            height: positive_size_to_u32(frame.size.height),
            minimized: false,
            icon_data_url: None,
            thumbnail_data_url: None,
        })
    }

    fn shareable_content() -> Result<SCShareableContent, VideoCaptureError> {
        SCShareableContent::create()
            .with_exclude_desktop_windows(true)
            .with_on_screen_windows_only(true)
            .get()
            .map_err(|error| VideoCaptureError::DeviceUnavailable {
                message: format!(
                    "ScreenCaptureKit shareable content is unavailable. Grant Screen & System Audio Recording permission and restart Raven: {error}"
                ),
            })
    }

    fn i420_frame_from_sample_buffer(sample: &CMSampleBuffer) -> Option<I420Frame> {
        let buffer = sample.image_buffer()?;
        let guard = buffer.lock(CVPixelBufferLockFlags::READ_ONLY).ok()?;
        let width = u32::try_from(guard.width()).ok()?;
        let height = u32::try_from(guard.height()).ok()?;
        if width < 2 || height < 2 {
            return None;
        }
        packed_to_i420(
            guard.as_slice(),
            width,
            height,
            guard.bytes_per_row(),
            PackedFormat::Bgra,
        )
    }

    fn positive_size_to_u32(value: f64) -> u32 {
        if value.is_finite() && value > 0.0 {
            value.round().min(u32::MAX as f64) as u32
        } else {
            0
        }
    }
}

#[cfg(all(
    not(target_os = "windows"),
    not(target_os = "linux"),
    not(target_os = "macos")
))]
mod screen {
    use std::sync::Arc;

    use crate::video::domain::{DisplayTarget, VideoSourceState, WindowTarget};

    use super::{VideoCaptureError, VideoCaptureSignature, VideoFrameSink, VideoSourceRuntime};

    pub(super) fn start(
        _source: &VideoSourceState,
        _signature: VideoCaptureSignature,
        _sink: Arc<dyn VideoFrameSink>,
        _extras: super::ScreenExtras,
    ) -> Result<Box<dyn VideoSourceRuntime>, VideoCaptureError> {
        Err(VideoCaptureError::NotImplemented)
    }

    pub(super) fn list_displays() -> Result<Vec<DisplayTarget>, VideoCaptureError> {
        Ok(Vec::new())
    }

    pub(super) fn list_windows() -> Result<Vec<WindowTarget>, VideoCaptureError> {
        Ok(Vec::new())
    }
}
