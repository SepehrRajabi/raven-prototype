use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, PoisonError},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use thiserror::Error;

pub const MEDIA_HOTKEY_EVENT: &str = "media-hotkey-pressed";
const SETTINGS_FILE_NAME: &str = "media-hotkeys.json";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MediaHotkeySettings {
    pub mic: String,
    pub camera: String,
    pub deafen: String,
    pub screen_share: String,
    /// "I'd like to speak". It works whether or not the bar shows its button.
    pub hand: String,
}

impl Default for MediaHotkeySettings {
    fn default() -> Self {
        let primary_modifier = if cfg!(target_os = "macos") {
            "Command"
        } else {
            "Control"
        };
        Self {
            mic: format!("{primary_modifier}+Shift+M"),
            camera: format!("{primary_modifier}+Shift+V"),
            deafen: format!("{primary_modifier}+Shift+D"),
            screen_share: format!("{primary_modifier}+Shift+S"),
            hand: format!("{primary_modifier}+Shift+H"),
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MediaHotkeySettingsPatch {
    pub mic: Option<String>,
    pub camera: Option<String>,
    pub deafen: Option<String>,
    pub screen_share: Option<String>,
    pub hand: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaHotkeySettingsView {
    pub supported: bool,
    /// Why hotkeys are unavailable in this session, when `supported` is false.
    pub unsupported_reason: Option<String>,
    pub mic: String,
    pub camera: String,
    pub deafen: String,
    pub screen_share: String,
    pub hand: String,
    pub registration_error: Option<String>,
}

#[derive(Debug)]
pub struct MediaHotkeyState {
    settings: Mutex<MediaHotkeySettings>,
    registered: Mutex<Vec<(String, String)>>,
    registration_error: Mutex<Option<String>>,
}

#[derive(Debug, Error, Serialize)]
#[serde(tag = "code", content = "detail", rename_all = "camelCase")]
pub enum MediaHotkeyError {
    #[error("media hotkey state is unavailable")]
    StatePoisoned,
    #[error("media hotkey settings I/O failed: {message}")]
    Io { message: String },
    #[error("each media action needs a different hotkey")]
    Duplicate,
    #[error("{message}")]
    Shortcut { message: String },
}

pub fn new_media_hotkey_state() -> MediaHotkeyState {
    MediaHotkeyState {
        settings: Mutex::new(MediaHotkeySettings::default()),
        registered: Mutex::new(Vec::new()),
        registration_error: Mutex::new(None),
    }
}

pub fn initialize(app: &AppHandle) -> Result<(), MediaHotkeyError> {
    let state = app.state::<MediaHotkeyState>();
    let settings = load_settings_from_path(&settings_path(app)?);
    *state.settings.lock().map_err(state_poisoned)? = settings.clone();
    if let Err(error) = reconcile_registration(app, &state, &settings) {
        set_registration_error(&state, Some(error.to_string()))?;
        eprintln!("[raven] media hotkey registration failed: {error}");
    }
    Ok(())
}

#[tauri::command]
pub fn media_hotkeys_get_settings(
    state: State<'_, MediaHotkeyState>,
) -> Result<MediaHotkeySettingsView, MediaHotkeyError> {
    let settings = state.settings.lock().map_err(state_poisoned)?.clone();
    settings_view(&state, &settings)
}

#[tauri::command]
pub fn media_hotkeys_update_settings(
    app: AppHandle,
    state: State<'_, MediaHotkeyState>,
    patch: MediaHotkeySettingsPatch,
) -> Result<MediaHotkeySettingsView, MediaHotkeyError> {
    let current = state.settings.lock().map_err(state_poisoned)?.clone();
    let next = apply_patch(&current, patch);
    validate_unique(&next)?;
    reconcile_registration(&app, &state, &next)?;
    *state.settings.lock().map_err(state_poisoned)? = next.clone();
    save_settings_to_path(&settings_path(&app)?, &next)?;
    settings_view(&state, &next)
}

/// The shortcuts in use, so push to talk does not take one of them.
pub(crate) fn bound_hotkeys(app: &AppHandle) -> Vec<String> {
    let state = app.state::<MediaHotkeyState>();
    let Ok(settings) = state.settings.lock() else {
        return Vec::new();
    };
    bindings(&settings)
        .into_iter()
        .map(|(hotkey, _)| hotkey)
        .collect()
}

fn apply_patch(
    current: &MediaHotkeySettings,
    patch: MediaHotkeySettingsPatch,
) -> MediaHotkeySettings {
    let defaults = MediaHotkeySettings::default();
    let mut next = current.clone();
    if let Some(value) = patch.mic {
        next.mic = normalized(value, defaults.mic);
    }
    if let Some(value) = patch.camera {
        next.camera = normalized(value, defaults.camera);
    }
    if let Some(value) = patch.deafen {
        next.deafen = normalized(value, defaults.deafen);
    }
    if let Some(value) = patch.screen_share {
        next.screen_share = normalized(value, defaults.screen_share);
    }
    if let Some(value) = patch.hand {
        next.hand = normalized(value, defaults.hand);
    }
    next
}

fn normalized(value: String, fallback: String) -> String {
    let value = value.trim();
    if value.is_empty() {
        fallback
    } else {
        value.to_string()
    }
}

fn bindings(settings: &MediaHotkeySettings) -> Vec<(String, String)> {
    vec![
        (settings.mic.clone(), "mic".into()),
        (settings.camera.clone(), "camera".into()),
        (settings.deafen.clone(), "deafen".into()),
        (settings.screen_share.clone(), "screenShare".into()),
        (settings.hand.clone(), "hand".into()),
    ]
}

fn validate_unique(settings: &MediaHotkeySettings) -> Result<(), MediaHotkeyError> {
    let mut seen = HashSet::new();
    if bindings(settings)
        .into_iter()
        .all(|(hotkey, _)| seen.insert(hotkey.to_ascii_lowercase()))
    {
        Ok(())
    } else {
        Err(MediaHotkeyError::Duplicate)
    }
}

fn settings_view(
    state: &MediaHotkeyState,
    settings: &MediaHotkeySettings,
) -> Result<MediaHotkeySettingsView, MediaHotkeyError> {
    let support = platform_support();
    Ok(MediaHotkeySettingsView {
        supported: support.is_ok(),
        unsupported_reason: support.err().map(str::to_string),
        mic: settings.mic.clone(),
        camera: settings.camera.clone(),
        deafen: settings.deafen.clone(),
        screen_share: settings.screen_share.clone(),
        hand: settings.hand.clone(),
        registration_error: state
            .registration_error
            .lock()
            .map_err(state_poisoned)?
            .clone(),
    })
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, MediaHotkeyError> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(SETTINGS_FILE_NAME))
        .map_err(|error| MediaHotkeyError::Io {
            message: error.to_string(),
        })
}

fn load_settings_from_path(path: &Path) -> MediaHotkeySettings {
    let settings = fs::read_to_string(path)
        .ok()
        .and_then(|contents| serde_json::from_str(&contents).ok())
        .unwrap_or_default();
    platform_specific_settings(settings)
}

fn platform_specific_settings(mut settings: MediaHotkeySettings) -> MediaHotkeySettings {
    let modifier = if cfg!(target_os = "macos") {
        "Command"
    } else {
        "Control"
    };
    settings.mic = settings.mic.replace("CommandOrControl", modifier);
    settings.camera = settings.camera.replace("CommandOrControl", modifier);
    settings.deafen = settings.deafen.replace("CommandOrControl", modifier);
    settings.screen_share = settings.screen_share.replace("CommandOrControl", modifier);
    settings.hand = settings.hand.replace("CommandOrControl", modifier);
    settings
}

fn save_settings_to_path(
    path: &Path,
    settings: &MediaHotkeySettings,
) -> Result<(), MediaHotkeyError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    let contents =
        serde_json::to_string_pretty(settings).map_err(|error| MediaHotkeyError::Io {
            message: error.to_string(),
        })?;
    fs::write(path, contents).map_err(io_error)
}

/// Whether global media hotkeys can work in this session, and if not, why.
///
/// Hotkeys must fire while Raven is in the background. Windows provides that directly.
/// On Linux the backend grabs keys through X11, which works on X11 desktops; a Wayland
/// compositor does not let an application listen for keys it does not have focus for, so
/// registering there would appear to succeed and then never fire.
pub(crate) fn platform_support() -> Result<(), &'static str> {
    #[cfg(windows)]
    {
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        linux_session_support(
            std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
            std::env::var_os("WAYLAND_DISPLAY").is_some(),
            std::env::var_os("DISPLAY").is_some(),
        )
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        Err("Global media hotkeys are not available on this platform yet.")
    }
}

/// Decide Linux hotkey support from the desktop session's environment.
#[cfg(any(target_os = "linux", test))]
fn linux_session_support(
    session_type: Option<&str>,
    wayland_display: bool,
    x11_display: bool,
) -> Result<(), &'static str> {
    let wayland = wayland_display
        || session_type.is_some_and(|value| value.trim().eq_ignore_ascii_case("wayland"));
    if wayland {
        return Err(
            "Global media hotkeys need an X11 session. Wayland does not let apps listen for keys in the background yet.",
        );
    }
    if !x11_display {
        return Err("Global media hotkeys need a graphical X11 session.");
    }
    Ok(())
}

#[cfg(any(windows, target_os = "linux"))]
fn reconcile_registration(
    app: &AppHandle,
    state: &MediaHotkeyState,
    settings: &MediaHotkeySettings,
) -> Result<(), MediaHotkeyError> {
    validate_unique(settings)?;
    if platform_support().is_err() {
        // Nothing can be registered in this session; the settings are still saved.
        *state.registered.lock().map_err(state_poisoned)? = Vec::new();
        return set_registration_error(state, None);
    }
    let current = state.registered.lock().map_err(state_poisoned)?.clone();
    let desired = bindings(settings);
    if current == desired {
        return set_registration_error(state, None);
    }

    for (hotkey, _) in &current {
        unregister(app, hotkey)?;
    }

    let mut newly_registered: Vec<(String, String)> = Vec::new();
    for (hotkey, action) in &desired {
        if let Err(error) = register(app, hotkey, action) {
            for (registered, _) in &newly_registered {
                let _ = unregister(app, registered);
            }
            for (old_hotkey, old_action) in &current {
                let _ = register(app, old_hotkey, old_action);
            }
            *state.registered.lock().map_err(state_poisoned)? = current;
            return Err(error);
        }
        newly_registered.push((hotkey.clone(), action.clone()));
    }

    *state.registered.lock().map_err(state_poisoned)? = desired;
    set_registration_error(state, None)
}

#[cfg(not(any(windows, target_os = "linux")))]
fn reconcile_registration(
    _app: &AppHandle,
    state: &MediaHotkeyState,
    _settings: &MediaHotkeySettings,
) -> Result<(), MediaHotkeyError> {
    *state.registered.lock().map_err(state_poisoned)? = Vec::new();
    set_registration_error(state, None)
}

#[cfg(any(windows, target_os = "linux"))]
fn register(app: &AppHandle, hotkey: &str, action: &str) -> Result<(), MediaHotkeyError> {
    use tauri::Emitter;
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
    let action = action.to_string();
    app.global_shortcut()
        .on_shortcut(hotkey, move |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                let _ = app.emit(MEDIA_HOTKEY_EVENT, action.clone());
            }
        })
        .map_err(|error| MediaHotkeyError::Shortcut {
            message: refused_hotkey_message(hotkey, &error.to_string()),
        })
}

/// Say why the system refused a shortcut, in words the person can act on.
///
/// Windows holds F12 and Shift+F12 for the debugger, and reports them as already
/// registered. The shortcut plugin only hands us the error as text, so a key held by
/// another app can only be recognised from that text.
#[cfg(any(windows, target_os = "linux", test))]
pub(crate) fn refused_hotkey_message(hotkey: &str, error: &str) -> String {
    let reserved = ["F12", "Shift+F12"]
        .iter()
        .any(|key| key.eq_ignore_ascii_case(hotkey));
    if cfg!(windows) && reserved {
        format!("Windows reserves {hotkey}, so Raven can't use it. Try another shortcut, like Control+F12.")
    } else if error.contains("already registered") {
        format!("{hotkey} is already in use, possibly by another app. Try a different shortcut.")
    } else {
        error.to_string()
    }
}

#[cfg(any(windows, target_os = "linux"))]
fn unregister(app: &AppHandle, hotkey: &str) -> Result<(), MediaHotkeyError> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    app.global_shortcut()
        .unregister(hotkey)
        .map_err(shortcut_error)
}

fn set_registration_error(
    state: &MediaHotkeyState,
    error: Option<String>,
) -> Result<(), MediaHotkeyError> {
    *state.registration_error.lock().map_err(state_poisoned)? = error;
    Ok(())
}

fn state_poisoned<T>(_error: PoisonError<T>) -> MediaHotkeyError {
    MediaHotkeyError::StatePoisoned
}

fn io_error(error: std::io::Error) -> MediaHotkeyError {
    MediaHotkeyError::Io {
        message: error.to_string(),
    }
}

#[cfg(any(windows, target_os = "linux"))]
fn shortcut_error(error: tauri_plugin_global_shortcut::Error) -> MediaHotkeyError {
    MediaHotkeyError::Shortcut {
        message: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linux_hotkeys_are_offered_on_x11_and_explained_on_wayland() {
        assert!(linux_session_support(Some("x11"), false, true).is_ok());
        // Some X11 desktops do not set the session type at all.
        assert!(linux_session_support(None, false, true).is_ok());

        let wayland = linux_session_support(Some("wayland"), true, true);
        assert!(wayland.is_err_and(|reason| reason.contains("Wayland")));
        // XWayland provides DISPLAY, but its key grabs only work for focused X11 windows.
        assert!(linux_session_support(None, true, true).is_err());
        assert!(linux_session_support(Some("Wayland"), false, true).is_err());

        assert!(linux_session_support(Some("tty"), false, false).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn explains_keys_windows_reserves() {
        let raw = "HotKey already registered: HotKey { mods: Modifiers(0x0), key: F12, id: 171 }";
        for hotkey in ["F12", "Shift+F12", "shift+f12"] {
            let message = refused_hotkey_message(hotkey, raw);
            assert!(message.starts_with(&format!("Windows reserves {hotkey},")));
        }
    }

    #[test]
    fn explains_a_key_already_in_use_without_the_raw_error() {
        let raw = "HotKey already registered: HotKey { mods: Modifiers(0x0), key: F9, id: 7 }";
        let message = refused_hotkey_message("F9", raw);
        assert!(message.starts_with("F9 is already in use"));
        assert!(!message.contains("Modifiers"));
        // Modifiers make F12 an ordinary key, which Windows does not reserve.
        assert!(refused_hotkey_message("Control+F12", raw).starts_with("Control+F12 is already"));
    }

    #[test]
    fn keeps_other_refusals_as_they_are() {
        assert_eq!(refused_hotkey_message("Nope", "bad key"), "bad key");
    }

    #[test]
    fn rejects_duplicate_bindings() {
        let mut settings = MediaHotkeySettings::default();
        settings.camera = settings.mic.clone();
        assert!(matches!(
            validate_unique(&settings),
            Err(MediaHotkeyError::Duplicate)
        ));
    }

    #[test]
    fn blank_patch_restores_default() {
        let current = MediaHotkeySettings::default();
        let next = apply_patch(
            &current,
            MediaHotkeySettingsPatch {
                mic: Some("  ".into()),
                ..Default::default()
            },
        );
        assert_eq!(next.mic, MediaHotkeySettings::default().mic);
    }

    #[test]
    fn migrates_legacy_platform_agnostic_modifiers() {
        let mut settings = MediaHotkeySettings::default();
        settings.camera = "CommandOrControl+Shift+V".into();
        let migrated = platform_specific_settings(settings);
        assert!(!migrated.camera.contains("CommandOrControl"));
        assert!(migrated.camera.starts_with(if cfg!(target_os = "macos") {
            "Command+"
        } else {
            "Control+"
        }));
    }
}
