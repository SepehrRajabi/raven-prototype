//! Audio device hot-plug watcher.
//!
//! The capture and playback workers follow device changes on their own; this watcher only
//! tells the UI that its device lists are stale, so the pickers update when a headset is
//! plugged in or the system default moves — without the user reopening a menu.
//!
//! It enumerates only while someone can see a picker or a call is running: with the window
//! hidden in the tray or minimised and no call, it does nothing, so an idle Raven does not
//! probe devices (each ALSA PCM on Linux) every few seconds. When the window comes back, the
//! first check compares against the last list it saw and reports any change made meanwhile.
//! Following devices during a call is done by the capture and playback workers themselves
//! and does not depend on this watcher.

use std::thread;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait};
use tauri::{AppHandle, Emitter, Manager};

use crate::audio::state::SharedAudioEngineState;

pub const AUDIO_DEVICES_CHANGED_EVENT: &str = "audio-devices-changed";

/// Enumerating ALSA devices probes each PCM, so Linux polls less often than the other
/// platforms, where listing endpoints is cheap.
pub(crate) const POLL_INTERVAL: Duration = if cfg!(target_os = "linux") {
    Duration::from_secs(6)
} else {
    Duration::from_secs(2)
};

/// Names only: enough to notice plug/unplug and default-device changes without opening
/// any device.
#[derive(Debug, Default, PartialEq, Eq)]
struct DeviceFingerprint {
    inputs: Vec<String>,
    outputs: Vec<String>,
    default_input: Option<String>,
    default_output: Option<String>,
}

impl DeviceFingerprint {
    fn capture() -> Self {
        let host = cpal::default_host();
        let names = |devices: Option<Vec<cpal::Device>>| {
            let mut names: Vec<String> = devices
                .unwrap_or_default()
                .iter()
                .filter_map(|device| device.name().ok())
                .collect();
            names.sort();
            names
        };
        Self {
            inputs: names(host.input_devices().ok().map(Iterator::collect)),
            outputs: names(host.output_devices().ok().map(Iterator::collect)),
            default_input: host
                .default_input_device()
                .and_then(|device| device.name().ok()),
            default_output: host
                .default_output_device()
                .and_then(|device| device.name().ok()),
        }
    }
}

/// True while the main window is on screen or a call is running. When either cannot be
/// read, it polls, as it did before this check existed.
fn worth_polling(app: &AppHandle) -> bool {
    let in_call = app
        .try_state::<SharedAudioEngineState>()
        .and_then(|state| {
            state
                .read()
                .ok()
                .map(|engine| engine.capture_demand.wants_capture())
        })
        .unwrap_or(true);
    if in_call {
        return true;
    }
    let Some(window) = app.get_webview_window("main") else {
        return true;
    };
    let visible = window.is_visible().unwrap_or(true);
    let minimized = window.is_minimized().unwrap_or(false);
    visible && !minimized
}

pub fn spawn_device_watcher(app: AppHandle) {
    let spawned = thread::Builder::new()
        .name("raven-audio-devices".into())
        .spawn(move || {
            let mut last = DeviceFingerprint::capture();
            loop {
                thread::sleep(POLL_INTERVAL);
                if !worth_polling(&app) {
                    continue;
                }
                let next = DeviceFingerprint::capture();
                if next != last {
                    last = next;
                    let _ = app.emit(AUDIO_DEVICES_CHANGED_EVENT, ());
                }
            }
        });
    if let Err(error) = spawned {
        eprintln!("[raven] audio device watcher could not start: {error}");
    }
}
