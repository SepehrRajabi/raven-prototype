//! Audio device hot-plug watcher.
//!
//! The capture and playback workers follow device changes on their own; this watcher only
//! tells the UI that its device lists are stale, so the pickers update when a headset is
//! plugged in or the system default moves — without the user reopening a menu.

use std::thread;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait};
use tauri::{AppHandle, Emitter};

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

pub fn spawn_device_watcher(app: AppHandle) {
    let spawned = thread::Builder::new()
        .name("raven-audio-devices".into())
        .spawn(move || {
            let mut last = DeviceFingerprint::capture();
            loop {
                thread::sleep(POLL_INTERVAL);
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
