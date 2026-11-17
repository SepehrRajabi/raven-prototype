//! Whether the OS currently lets Raven run call media. Engines ask here instead of
//! checking the platform. Desktop always allows. MobileNative ties media to the
//! call (audio continues in the background, the camera is foreground-only), audio focus and OS permissions owned by `crate::mobile_native`.
//! On desktop every check is a constant, so the engines' guards compile away.

pub use platform::*;

#[cfg(not(mobile))]
mod platform {
    use tauri::AppHandle;

    /// Connecting or activating a call needs an open call. Desktop always has one.
    pub fn require_call(_app: &AppHandle) -> Result<(), String> {
        Ok(())
    }

    pub fn audio_allowed(_app: &AppHandle) -> bool {
        true
    }

    pub fn microphone_permitted(_app: &AppHandle) -> bool {
        true
    }

    pub fn require_camera(_app: &AppHandle) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(mobile)]
mod platform {
    use raven_mobile_native::PermissionStatus;
    use tauri::AppHandle;

    use crate::mobile_native::media as host;

    /// The active call (it keeps running in the background), or an error when none is
    /// open, so a reconnect after the call ended cannot open one.
    pub fn require_call(app: &AppHandle) -> Result<(), String> {
        host::require_call(app).map(|_| ())
    }

    /// In a call (foreground or not) and holding communication audio focus.
    pub fn audio_allowed(app: &AppHandle) -> bool {
        host::audio_allowed(app)
    }

    /// The OS microphone permission alone. Querying it never prompts.
    pub fn microphone_permitted(app: &AppHandle) -> bool {
        host::microphone_permission(app) == PermissionStatus::Granted
    }

    /// Foreground, in the current call, with the OS camera permission; the error says which is missing.
    pub fn require_camera(app: &AppHandle) -> Result<(), String> {
        host::require_camera(app).map(|_| ())
    }
}
