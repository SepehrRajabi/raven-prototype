//! The MobileNative camera backend. The raven-mobile-native plugin runs CameraX, which
//! delivers upright RGBA frames. Conversion to I420 with the shared converter runs inline
//! on CameraX's analyzer thread, which drops frames while it is busy, so memory and latency
//! stay bounded. Reporting is host-tested; capture compiles only for Android.

#[cfg(mobile)]
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Instant;

#[cfg(mobile)]
use raven_mobile_native::camera::CameraFrame;

use crate::video::domain::{VideoSourceRuntimeState, VideoSourceRuntimeStatus};
#[cfg(mobile)]
use crate::video::{
    capture::{
        CaptureEvent, CaptureEvents, VideoCaptureError, VideoCaptureSignature, VideoFrameSink,
        VideoSourceRuntime,
    },
    convert::{packed_to_i420, I420Frame, PackedFormat},
    domain::{CameraDevice, VideoSourceId, VideoSourceState},
};

/// The cameras CameraX reports, front-facing first.
#[cfg(mobile)]
pub fn list_cameras(app: &tauri::AppHandle) -> Result<Vec<CameraDevice>, String> {
    let mut cameras = raven_mobile_native::camera::list_cameras(app)?;
    cameras.sort_by_key(|camera| !camera.front_facing);
    Ok(cameras
        .into_iter()
        .map(|camera| CameraDevice {
            id: camera.id,
            name: camera.name,
        })
        .collect())
}

#[cfg(mobile)]
#[derive(Debug)]
struct CameraRuntime {
    source_id: VideoSourceId,
    signature: VideoCaptureSignature,
    report: Arc<Mutex<RuntimeReport>>,
    session: raven_mobile_native::camera::CameraSession<tauri::Wry>,
}

#[derive(Debug)]
struct RuntimeReport {
    state: VideoSourceRuntimeState,
    last_event_at: Option<Instant>,
}

impl RuntimeReport {
    fn starting() -> Self {
        Self {
            state: VideoSourceRuntimeState {
                status: VideoSourceRuntimeStatus::Starting,
                ..VideoSourceRuntimeState::default()
            },
            last_event_at: None,
        }
    }
}

/// The camera's own frame rate, smoothed from CameraX timestamps.
#[cfg(mobile)]
#[derive(Debug, Default)]
struct FrameTiming {
    last_timestamp_ns: Option<i64>,
    measured_fps: Option<f32>,
}

#[cfg(mobile)]
impl FrameTiming {
    fn observe(&mut self, timestamp_ns: i64) {
        let elapsed = self
            .last_timestamp_ns
            .and_then(|previous| timestamp_ns.checked_sub(previous))
            .filter(|elapsed| *elapsed > 0);
        if let Some(elapsed) = elapsed {
            let fps = 1_000_000_000.0 / elapsed as f32;
            // Ignore clock jumps and implausible intervals.
            if (1.0..=120.0).contains(&fps) {
                self.measured_fps = Some(
                    self.measured_fps
                        .map_or(fps, |current| current * 0.8 + fps * 0.2),
                );
            }
        }
        self.last_timestamp_ns = Some(timestamp_ns);
    }
}

#[cfg(mobile)]
impl VideoSourceRuntime for CameraRuntime {
    fn source_id(&self) -> VideoSourceId {
        self.source_id
    }

    fn stop(&mut self) {
        // Kotlin unbinds CameraX and joins its analyzer before this returns.
        if let Err(error) = self.session.stop() {
            eprintln!("[video] Android camera stop failed: {error}");
        }
        if let Ok(mut report) = self.report.lock() {
            report.state = VideoSourceRuntimeState::default();
        }
    }

    fn runtime_state(&self) -> VideoSourceRuntimeState {
        self.report
            .lock()
            .map(|report| report.state.clone())
            .unwrap_or_default()
    }

    fn signature(&self) -> &VideoCaptureSignature {
        &self.signature
    }
}

#[cfg(mobile)]
pub(crate) fn start(
    source: &VideoSourceState,
    signature: VideoCaptureSignature,
    sink: Arc<dyn VideoFrameSink>,
    app: tauri::AppHandle,
    events: Option<CaptureEvents>,
) -> Result<Box<dyn VideoSourceRuntime>, VideoCaptureError> {
    let epoch = crate::mobile_native::media::require_camera(&app)
        .map_err(|message| VideoCaptureError::StreamFailed { message })?;
    let report = Arc::new(Mutex::new(RuntimeReport::starting()));
    let timing = Mutex::new(FrameTiming::default());
    let source_id = source.id;
    let callback_app = app.clone();
    let callback_report = Arc::clone(&report);
    let callback: Arc<dyn for<'a> Fn(CameraFrame<'a>) + Send + Sync + 'static> =
        Arc::new(move |frame: CameraFrame<'_>| {
            // A leave, background or revoked permission ends delivery immediately.
            if !crate::mobile_native::media::camera_current(&callback_app, epoch) {
                return;
            }
            let fps = timing.lock().ok().and_then(|mut timing| {
                timing.observe(frame.timestamp_ns);
                timing.measured_fps
            });
            if !sink.frame_due() {
                return;
            }
            let Some(converted) = to_i420(&frame) else {
                return;
            };
            if report_frame(&callback_report, converted.width, converted.height, fps) {
                if let Some(events) = &events {
                    events.notify(source_id, CaptureEvent::StateChanged);
                }
            }
            sink.push_frame(converted);
        });
    let session = raven_mobile_native::camera::start_camera(
        &app,
        &source.target_id,
        source.profile.width,
        source.profile.height,
        callback,
    )
    .map_err(|message| VideoCaptureError::StreamFailed { message })?;
    Ok(Box::new(CameraRuntime {
        source_id,
        signature,
        report,
        session,
    }))
}

/// Record a converted frame. Returns whether the UI should hear about it: the first
/// frame, new dimensions, a first FPS reading, or FPS drift (at most once a second).
fn report_frame(
    report: &Mutex<RuntimeReport>,
    width: u32,
    height: u32,
    measured_fps: Option<f32>,
) -> bool {
    let Ok(mut report) = report.lock() else {
        return false;
    };
    let now = Instant::now();
    let state = &report.state;
    let changed = state.status != VideoSourceRuntimeStatus::Running
        || state.width != Some(width)
        || state.height != Some(height)
        || (state.fps.is_none() && measured_fps.is_some());
    let fps_drifted = matches!(
        (state.fps, measured_fps),
        (Some(previous), Some(current)) if (previous - current).abs() >= 2.0
    ) && report
        .last_event_at
        .is_none_or(|last| now.duration_since(last).as_secs_f32() >= 1.0);
    report.state.status = VideoSourceRuntimeStatus::Running;
    report.state.width = Some(width);
    report.state.height = Some(height);
    report.state.fps = measured_fps;
    let notify = changed || fps_drifted;
    if notify {
        report.last_event_at = Some(now);
    }
    notify
}

#[cfg(mobile)]
fn to_i420(frame: &CameraFrame<'_>) -> Option<I420Frame> {
    packed_to_i420(
        frame.rgba,
        frame.width,
        frame.height,
        frame.row_stride,
        PackedFormat::Rgba,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_reports_only_observed_dimensions_and_measured_fps() {
        let report = Mutex::new(RuntimeReport::starting());
        assert!(report_frame(&report, 640, 480, None));
        let state = report.lock().unwrap().state.clone();
        assert_eq!(state.status, VideoSourceRuntimeStatus::Running);
        assert_eq!((state.width, state.height), (Some(640), Some(480)));
        assert_eq!(state.fps, None);

        assert!(report_frame(&report, 640, 480, Some(29.97)));
        assert_eq!(report.lock().unwrap().state.fps, Some(29.97));
    }
}
