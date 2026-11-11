use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, PoisonError},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use thiserror::Error;

use crate::thumbnail_toolbar::{CallAction, ThumbnailToolbarSnapshot};

const SETTINGS_FILE_NAME: &str = "tray.json";
/// "Back in a bit" is offered in the menu bar menu only. The Windows tray keeps the
/// same items as its taskbar buttons.
const OFFERS_AWAY: bool = cfg!(target_os = "macos");
/// Windows cuts a notification-area tooltip at 127 characters; names are trimmed well
/// before that so the state after the name is never the part that is lost.
const MAX_NAME_CHARS: usize = 48;

const ID_STATUS: &str = "tray:status";
const ID_MIC: &str = "tray:mic";
const ID_DEAFEN: &str = "tray:deafen";
const ID_LEAVE: &str = "tray:leave";
const ID_AWAY: &str = "tray:away";
const ID_SETTINGS: &str = "tray:settings";
const ID_CHECK_UPDATES: &str = "tray:check-updates";
const ID_OPEN: &str = "tray:open";
const ID_QUIT: &str = "tray:quit";
const ID_PRESENCE_PREFIX: &str = "tray:presence:";
/// Passed by the sign-in entry that "Launch at Startup" registers, so that
/// launch leaves the window closed and Raven in the tray.
pub const AUTOSTART_FLAG: &str = "--hidden";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TraySettings {
    /// Closing the main window hides it and leaves Raven running.
    pub close_to_tray: bool,
    /// The one-time "Raven is still running" notification has been shown.
    pub hint_shown: bool,
}

impl Default for TraySettings {
    fn default() -> Self {
        Self {
            close_to_tray: true,
            hint_shown: false,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TraySettingsPatch {
    pub close_to_tray: Option<bool>,
    pub launch_at_startup: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraySettingsView {
    pub supported: bool,
    pub close_to_tray: bool,
    /// Raven starts in the tray when the user signs in to the computer. Off until the
    /// user turns it on; the operating system's sign-in list is the record of it.
    pub launch_at_startup: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrayCallStatus {
    #[default]
    Connected,
    Connecting,
    Reconnecting,
    Leaving,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TrayPresenceOption {
    pub id: String,
    pub label: String,
}

/// What the main window knows that the tray shows. The call fields are the ones the
/// taskbar thumbnail buttons already use, so both surfaces enable the same actions.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TraySnapshot {
    #[serde(flatten)]
    pub call: ThumbnailToolbarSnapshot,
    pub call_name: Option<String>,
    pub call_status: TrayCallStatus,
    pub presence: String,
    pub presences: Vec<TrayPresenceOption>,
    /// "Back in a bit" is set for everyone in the call.
    pub away: bool,
    /// The call is connected and its server shares "Back in a bit".
    pub away_supported: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MenuChoice {
    pub id: String,
    pub label: String,
    pub checked: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum MenuEntry {
    Separator,
    Item {
        id: &'static str,
        label: String,
        enabled: bool,
    },
    /// An item with a tick that follows the app's state.
    Toggle {
        id: &'static str,
        label: &'static str,
        checked: bool,
    },
    Choices {
        label: &'static str,
        choices: Vec<MenuChoice>,
    },
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum IconBadge {
    #[default]
    None,
    Muted,
    NotHearing,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct IconVariant {
    pub unread: bool,
    pub badge: IconBadge,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Rendered {
    menu: Vec<MenuEntry>,
    tooltip: String,
    icon: IconVariant,
}

#[derive(Default)]
struct TrayView {
    snapshot: TraySnapshot,
    unread: bool,
    /// What the native icon shows now, so an unchanged snapshot touches nothing.
    rendered: Option<Rendered>,
}

pub struct TrayState {
    settings: Mutex<TraySettings>,
    view: Mutex<TrayView>,
}

#[derive(Debug, Error, Serialize)]
#[serde(tag = "code", content = "detail", rename_all = "camelCase")]
pub enum TrayError {
    #[error("tray state is unavailable")]
    StatePoisoned,
    #[error("tray settings I/O failed: {message}")]
    Io { message: String },
    #[error("tray updates are only available to the main window")]
    NotMainWindow,
    #[error("start at sign-in could not be changed: {message}")]
    Autostart { message: String },
}

pub fn new_tray_state() -> TrayState {
    TrayState {
        settings: Mutex::new(TraySettings::default()),
        view: Mutex::new(TrayView::default()),
    }
}

/// Load the saved settings and put the icon in the notification area (the menu bar on
/// macOS). Returns whether the icon is there.
pub fn initialize(app: &AppHandle) -> Result<bool, TrayError> {
    let state = app.state::<TrayState>();
    *state.settings.lock().map_err(state_poisoned)? = load_settings_from_path(&settings_path(app)?);
    #[cfg(any(windows, target_os = "macos"))]
    let installed = match platform::install(app) {
        Ok(()) => true,
        Err(error) => {
            eprintln!("[raven] tray icon could not be created: {error}");
            false
        }
    };
    #[cfg(not(any(windows, target_os = "macos")))]
    let installed = false;
    refresh(app, &state)?;
    Ok(installed)
}

/// The main window starts hidden. Show it, unless the sign-in entry started Raven and
/// the tray icon is there to bring it back.
pub fn show_main_at_launch(app: &AppHandle, tray_ready: bool) {
    if !(tray_ready && launched_at_sign_in(std::env::args())) {
        show_main_window(app);
    }
}

fn launched_at_sign_in(mut args: impl Iterator<Item = String>) -> bool {
    args.any(|arg| arg == AUTOSTART_FLAG)
}

#[tauri::command]
pub fn tray_update(
    window: WebviewWindow,
    state: State<'_, TrayState>,
    snapshot: TraySnapshot,
) -> Result<(), TrayError> {
    require_main(&window)?;
    {
        let mut view = state.view.lock().map_err(state_poisoned)?;
        if is_stale(&view.snapshot.call, &snapshot.call) {
            return Ok(());
        }
        view.snapshot = snapshot;
    }
    refresh(window.app_handle(), &state)
}

#[tauri::command]
pub fn tray_set_unread(
    window: WebviewWindow,
    state: State<'_, TrayState>,
    unread: bool,
) -> Result<(), TrayError> {
    require_main(&window)?;
    state.view.lock().map_err(state_poisoned)?.unread = unread;
    refresh(window.app_handle(), &state)
}

#[tauri::command]
pub fn tray_get_settings(
    app: AppHandle,
    state: State<'_, TrayState>,
) -> Result<TraySettingsView, TrayError> {
    let settings = state.settings.lock().map_err(state_poisoned)?.clone();
    Ok(settings_view(&app, &settings))
}

#[tauri::command]
pub fn tray_update_settings(
    app: AppHandle,
    state: State<'_, TrayState>,
    patch: TraySettingsPatch,
) -> Result<TraySettingsView, TrayError> {
    if let Some(enabled) = patch.launch_at_startup {
        autostart::set(&app, enabled)?;
    }
    let next = {
        let mut settings = state.settings.lock().map_err(state_poisoned)?;
        if let Some(close_to_tray) = patch.close_to_tray {
            settings.close_to_tray = close_to_tray;
        }
        settings.clone()
    };
    save_settings_to_path(&settings_path(&app)?, &next)?;
    Ok(settings_view(&app, &next))
}

/// The main window's close button. On Windows and macOS it hides the window and leaves
/// Raven in the tray unless the user turned that off; elsewhere closing behaves as it
/// always did.
pub fn handle_main_close_requested(window: &tauri::Window, api: &tauri::CloseRequestApi) {
    #[cfg(any(windows, target_os = "macos"))]
    platform::handle_main_close_requested(window, api);
    #[cfg(not(any(windows, target_os = "macos")))]
    let _ = (window, api);
}

fn require_main(window: &WebviewWindow) -> Result<(), TrayError> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err(TrayError::NotMainWindow)
    }
}

/// A page keeps one generation and counts its updates, so an update that was overtaken
/// on its way here is dropped. A reloaded page starts a new generation and always wins.
fn is_stale(current: &ThumbnailToolbarSnapshot, next: &ThumbnailToolbarSnapshot) -> bool {
    next.generation == current.generation && next.revision <= current.revision
}

fn settings_view(app: &AppHandle, settings: &TraySettings) -> TraySettingsView {
    TraySettingsView {
        supported: cfg!(any(windows, target_os = "macos")),
        close_to_tray: settings.close_to_tray,
        launch_at_startup: autostart::is_enabled(app),
    }
}

/// The sign-in entry is kept by the operating system (the Run key on Windows, a
/// LaunchAgent on macOS), so it is read from there rather than from tray.json.
#[cfg(any(windows, target_os = "macos"))]
mod autostart {
    use tauri::AppHandle;
    use tauri_plugin_autostart::ManagerExt;

    use super::TrayError;

    pub(super) fn is_enabled(app: &AppHandle) -> bool {
        app.autolaunch().is_enabled().unwrap_or(false)
    }

    pub(super) fn set(app: &AppHandle, enabled: bool) -> Result<(), TrayError> {
        let launcher = app.autolaunch();
        // Removing an entry that is not there is an error on Windows.
        if launcher.is_enabled().unwrap_or(false) == enabled {
            return Ok(());
        }
        let result = if enabled { launcher.enable() } else { launcher.disable() };
        result.map_err(|error| TrayError::Autostart { message: error.to_string() })
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod autostart {
    use tauri::AppHandle;

    use super::TrayError;

    pub(super) fn is_enabled(_app: &AppHandle) -> bool {
        false
    }

    pub(super) fn set(_app: &AppHandle, _enabled: bool) -> Result<(), TrayError> {
        Ok(())
    }
}

fn refresh(app: &AppHandle, state: &TrayState) -> Result<(), TrayError> {
    let mut view = state.view.lock().map_err(state_poisoned)?;
    let next = Rendered {
        menu: menu_model(&view.snapshot),
        tooltip: tooltip(&view.snapshot),
        icon: icon_variant(&view.snapshot, view.unread),
    };
    if view.rendered.as_ref() == Some(&next) {
        return Ok(());
    }
    #[cfg(any(windows, target_os = "macos"))]
    if let Err(error) = platform::render(app, view.rendered.as_ref(), &next) {
        eprintln!("[raven] tray icon update failed: {error}");
        return Ok(());
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    let _ = app;
    view.rendered = Some(next);
    Ok(())
}

fn call_name(snapshot: &TraySnapshot) -> Option<String> {
    let name = snapshot.call_name.as_deref()?.trim();
    if name.is_empty() {
        return None;
    }
    if name.chars().count() <= MAX_NAME_CHARS {
        return Some(name.to_string());
    }
    let mut short: String = name.chars().take(MAX_NAME_CHARS - 1).collect();
    short.push('…');
    Some(short)
}

/// One line saying where the user is, or `None` outside a call.
fn call_status_line(snapshot: &TraySnapshot) -> Option<String> {
    if !snapshot.call.signed_in || !snapshot.call.has_media_session {
        return None;
    }
    let name = call_name(snapshot).unwrap_or_else(|| "a call".into());
    Some(match snapshot.call_status {
        TrayCallStatus::Connected => format!("In {name}"),
        TrayCallStatus::Connecting => format!("Connecting to {name}…"),
        TrayCallStatus::Reconnecting => format!("Reconnecting to {name}…"),
        TrayCallStatus::Leaving => format!("Leaving {name}…"),
    })
}

pub(crate) fn menu_model(snapshot: &TraySnapshot) -> Vec<MenuEntry> {
    menu_model_for(snapshot, OFFERS_AWAY)
}

fn menu_model_for(snapshot: &TraySnapshot, offers_away: bool) -> Vec<MenuEntry> {
    let item = |id: &'static str, label: &str, enabled: bool| MenuEntry::Item {
        id,
        label: label.to_string(),
        enabled,
    };
    let app_items = [
        item(ID_OPEN, "Open Raven", true),
        item(ID_QUIT, "Quit Raven", true),
    ];
    let call = &snapshot.call;
    if !call.signed_in {
        return app_items.into();
    }

    let mut entries = vec![
        item(
            ID_STATUS,
            &call_status_line(snapshot).unwrap_or_else(|| "Not in a call".into()),
            false,
        ),
        MenuEntry::Separator,
        item(
            ID_MIC,
            if call.mic_enabled { "Mute" } else { "Unmute" },
            call.allows(CallAction::Mic),
        ),
        item(
            ID_DEAFEN,
            if call.deafened {
                "Hear people again"
            } else {
                "Stop hearing people"
            },
            call.allows(CallAction::Deafen),
        ),
    ];
    if call.has_media_session {
        let label = match call_name(snapshot) {
            Some(name) => format!("Leave {name}"),
            None => "Leave call".into(),
        };
        entries.push(item(ID_LEAVE, &label, call.allows(CallAction::Leave)));
        if offers_away && snapshot.away_supported {
            entries.push(MenuEntry::Toggle {
                id: ID_AWAY,
                label: "Back in a bit",
                checked: snapshot.away,
            });
        }
    }
    if !snapshot.presences.is_empty() {
        entries.push(MenuEntry::Separator);
        entries.push(MenuEntry::Choices {
            label: "How you appear",
            choices: snapshot
                .presences
                .iter()
                .map(|option| MenuChoice {
                    id: format!("{ID_PRESENCE_PREFIX}{}", option.id),
                    label: option.label.clone(),
                    checked: option.id == snapshot.presence,
                })
                .collect(),
        });
    }
    entries.push(MenuEntry::Separator);
    entries.push(item(ID_SETTINGS, "Settings", true));
    entries.push(item(ID_CHECK_UPDATES, "Check for updates", true));
    entries.push(MenuEntry::Separator);
    entries.extend(app_items);
    entries
}

pub(crate) fn tooltip(snapshot: &TraySnapshot) -> String {
    let Some(status) = call_status_line(snapshot) else {
        return "Raven".into();
    };
    let audibility = if snapshot.call.deafened {
        ", not hearing anyone"
    } else if !snapshot.call.mic_enabled {
        ", muted"
    } else {
        ""
    };
    format!("Raven — {status}{audibility}")
}

pub(crate) fn icon_variant(snapshot: &TraySnapshot, unread: bool) -> IconVariant {
    let call = &snapshot.call;
    let badge = if !call.signed_in || !call.has_media_session {
        IconBadge::None
    } else if call.deafened {
        IconBadge::NotHearing
    } else if !call.mic_enabled {
        IconBadge::Muted
    } else {
        IconBadge::None
    };
    IconVariant {
        unread: unread && call.signed_in,
        badge,
    }
}

/// What a click on a menu item asks the main window to do.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub(crate) enum TrayAction {
    Mic,
    Deafen,
    Leave,
    Away { away: bool },
    Settings,
    CheckUpdates,
    Presence { presence: String },
}

impl TrayAction {
    /// Settings and updates are pages, so the window has to come forward for them.
    fn needs_window(&self) -> bool {
        matches!(self, Self::Settings | Self::CheckUpdates)
    }
}

pub(crate) fn action_for(snapshot: &TraySnapshot, id: &str) -> Option<TrayAction> {
    action_for_with(snapshot, id, OFFERS_AWAY)
}

fn action_for_with(snapshot: &TraySnapshot, id: &str, offers_away: bool) -> Option<TrayAction> {
    let call = &snapshot.call;
    if !call.signed_in {
        return None;
    }
    match id {
        ID_MIC => call.allows(CallAction::Mic).then_some(TrayAction::Mic),
        ID_DEAFEN => call
            .allows(CallAction::Deafen)
            .then_some(TrayAction::Deafen),
        ID_LEAVE => call.allows(CallAction::Leave).then_some(TrayAction::Leave),
        ID_AWAY => (offers_away && call.has_media_session && snapshot.away_supported).then_some(
            TrayAction::Away {
                away: !snapshot.away,
            },
        ),
        ID_SETTINGS => Some(TrayAction::Settings),
        ID_CHECK_UPDATES => Some(TrayAction::CheckUpdates),
        _ => {
            let presence = id.strip_prefix(ID_PRESENCE_PREFIX)?;
            snapshot
                .presences
                .iter()
                .any(|option| option.id == presence)
                .then(|| TrayAction::Presence {
                    presence: presence.to_string(),
                })
        }
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, TrayError> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(SETTINGS_FILE_NAME))
        .map_err(|error| TrayError::Io {
            message: error.to_string(),
        })
}

fn load_settings_from_path(path: &Path) -> TraySettings {
    fs::read_to_string(path)
        .ok()
        .and_then(|contents| serde_json::from_str(&contents).ok())
        .unwrap_or_default()
}

fn save_settings_to_path(path: &Path, settings: &TraySettings) -> Result<(), TrayError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    let contents = serde_json::to_string_pretty(settings).map_err(|error| TrayError::Io {
        message: error.to_string(),
    })?;
    fs::write(path, contents).map_err(io_error)
}

fn state_poisoned<T>(_error: PoisonError<T>) -> TrayError {
    TrayError::StatePoisoned
}

fn io_error(error: std::io::Error) -> TrayError {
    TrayError::Io {
        message: error.to_string(),
    }
}

/// The tray pictures: Raven's icon, with a dot for something unread and a slashed
/// microphone or headphones while a call is muted or silenced.
mod icon {
    use super::{IconBadge, IconVariant};

    #[cfg(any(windows, test))]
    pub(super) const SIZE: usize = 32;
    #[cfg(any(windows, test))]
    const DOT_SIZE: usize = 16;
    #[cfg(any(windows, test))]
    const BADGE_SIZE: usize = 20;
    #[cfg(any(windows, test))]
    const GLYPH_SIZE: usize = 16;
    #[cfg(any(windows, test))]
    const EDGE: [u8; 3] = [20, 19, 18];
    #[cfg(any(windows, test))]
    /// The interface's `destructive-fill`: a channel that is cut.
    const CUT: [u8; 3] = [183, 60, 52];

    #[cfg(any(windows, test))]
    pub(super) fn compose(variant: IconVariant) -> Result<Vec<u8>, String> {
        let mut pixels = decode(include_bytes!("../icons/32x32.png"), SIZE)?;
        if variant.unread {
            // Top right, clear of the call badge.
            draw_dot(&mut pixels, SIZE - DOT_SIZE, 0);
        }
        let glyph = match variant.badge {
            IconBadge::None => None,
            IconBadge::Muted => Some(ico_png(include_bytes!("../icons/taskbar/mic-off.ico"))?),
            IconBadge::NotHearing => Some(ico_png(include_bytes!(
                "../icons/taskbar/headphones-off.ico"
            ))?),
        };
        if let Some(glyph) = glyph {
            draw_badge(&mut pixels, &decode(glyph, SIZE)?);
        }
        Ok(pixels)
    }

    #[cfg(any(windows, test))]
    /// The taskbar icons are single-image ICO files that wrap a PNG.
    fn ico_png(ico: &[u8]) -> Result<&[u8], String> {
        const HEADER: usize = 22;
        let truncated = || "an embedded tray icon is truncated".to_string();
        let size = ico.get(14..18).ok_or_else(truncated)?;
        let size = u32::from_le_bytes(size.try_into().expect("ICO image size")) as usize;
        ico.get(HEADER..HEADER + size).ok_or_else(truncated)
    }

    fn decode(bytes: &[u8], size: usize) -> Result<Vec<u8>, String> {
        let mut decoder = png::Decoder::new(bytes);
        decoder.set_transformations(png::Transformations::normalize_to_color8());
        let mut reader = decoder.read_info().map_err(|error| error.to_string())?;
        let mut buffer = vec![0; reader.output_buffer_size()];
        let info = reader
            .next_frame(&mut buffer)
            .map_err(|error| error.to_string())?;
        if info.width as usize != size || info.height as usize != size {
            return Err(format!(
                "tray icons must be {size}×{size}, found {}×{}",
                info.width, info.height
            ));
        }
        let channels = match info.color_type {
            png::ColorType::Rgba => 4,
            png::ColorType::Rgb => 3,
            other => return Err(format!("unsupported tray icon colour type {other:?}")),
        };
        let mut pixels = Vec::with_capacity(size * size * 4);
        for pixel in buffer[..size * size * channels].chunks_exact(channels) {
            pixels.extend_from_slice(&pixel[..3]);
            pixels.push(if channels == 4 { pixel[3] } else { 255 });
        }
        Ok(pixels)
    }

    #[cfg(any(windows, test))]
    /// Source-over blend of one straight-alpha colour onto a pixel.
    fn blend(pixels: &mut [u8], x: usize, y: usize, colour: [u8; 3], alpha: f32) {
        if alpha <= 0.0 {
            return;
        }
        let offset = (y * SIZE + x) * 4;
        let under = pixels[offset + 3] as f32 / 255.0;
        let out = alpha + under * (1.0 - alpha);
        for channel in 0..3 {
            let over = colour[channel] as f32 * alpha;
            let below = pixels[offset + channel] as f32 * under * (1.0 - alpha);
            pixels[offset + channel] = ((over + below) / out).round() as u8;
        }
        pixels[offset + 3] = (out * 255.0).round() as u8;
    }

    #[cfg(any(windows, test))]
    /// A filled circle with a softened edge. `inset` shrinks it from its box.
    fn draw_disc(
        pixels: &mut [u8],
        left: usize,
        top: usize,
        size: usize,
        inset: f32,
        colour: [u8; 3],
    ) {
        let centre = (size as f32 - 1.0) / 2.0;
        let radius = size as f32 / 2.0 - inset;
        for y in 0..size {
            for x in 0..size {
                let distance = (x as f32 - centre).hypot(y as f32 - centre);
                blend(
                    pixels,
                    left + x,
                    top + y,
                    colour,
                    (radius - distance + 0.5).clamp(0.0, 1.0),
                );
            }
        }
    }

    #[cfg(any(windows, test))]
    /// The taskbar's unread dot: light with a dark edge. The edge is heavier here because
    /// the tray draws the icon at half this size, on the icon's own white ground.
    fn draw_dot(pixels: &mut [u8], left: usize, top: usize) {
        draw_disc(pixels, left, top, DOT_SIZE, 0.0, EDGE);
        draw_disc(pixels, left, top, DOT_SIZE, 3.0, [241, 239, 234]);
    }

    #[cfg(any(windows, test))]
    /// A red disc in the bottom right corner carrying the glyph's shape in white. The
    /// taskbar glyphs are red line drawings; at tray size only a solid disc with a bold
    /// white shape stays readable, so their outline is used as a mask.
    fn draw_badge(pixels: &mut [u8], glyph: &[u8]) {
        let origin = SIZE - BADGE_SIZE;
        draw_disc(pixels, origin, origin, BADGE_SIZE, 0.0, EDGE);
        draw_disc(pixels, origin, origin, BADGE_SIZE, 1.5, CUT);
        let margin = (BADGE_SIZE - GLYPH_SIZE) / 2;
        let scale = SIZE / GLYPH_SIZE;
        for y in 0..GLYPH_SIZE {
            for x in 0..GLYPH_SIZE {
                let mut coverage = 0.0f32;
                for sy in 0..scale {
                    for sx in 0..scale {
                        let offset = ((y * scale + sy) * SIZE + x * scale + sx) * 4;
                        coverage += glyph[offset + 3] as f32 / 255.0;
                    }
                }
                blend(
                    pixels,
                    origin + margin + x,
                    origin + margin + y,
                    [255, 255, 255],
                    coverage / (scale * scale) as f32,
                );
            }
        }
    }

    /// The macOS menu bar icon. Menu bar icons are templates: macOS reads only their alpha
    /// and colours them for the menu bar, light or dark, so nothing here can be red. The
    /// same signals as the Windows icon are cut into the mark instead: a solid dot for
    /// something unread, and a solid disc with the slashed glyph cut out of it for a muted
    /// or silenced call, each set apart from the mark by a clear ring. The discs are drawn
    /// from the Lucide glyphs by scripts/generate-thumbnail-icons.mjs.
    #[cfg(any(target_os = "macos", test))]
    pub(super) mod template {
        use super::{decode, IconBadge, IconVariant};

        /// The menu bar draws icons 18 pt tall; 36 px is that at 2x.
        pub(in super::super) const SIZE: usize = 36;
        const BADGE_SIZE: usize = 22;
        const DOT_RADIUS: f32 = 5.0;
        const GAP: f32 = 2.5;

        pub(in super::super) fn compose(variant: IconVariant) -> Result<Vec<u8>, String> {
            let mut alpha = alpha_of(&decode(
                include_bytes!("../icons/tray/macos-template.png"),
                SIZE,
            )?);
            let far = SIZE as f32;
            if variant.unread {
                // Top right, above the beak and clear of the call badge.
                let centre = (far - DOT_RADIUS, DOT_RADIUS);
                disc(&mut alpha, centre, DOT_RADIUS + GAP, Paint::Clear);
                disc(&mut alpha, centre, DOT_RADIUS, Paint::Fill);
            }
            let badge = match variant.badge {
                IconBadge::None => None,
                IconBadge::Muted => {
                    Some(&include_bytes!("../icons/tray/macos-badge-mic-off.png")[..])
                }
                IconBadge::NotHearing => {
                    Some(&include_bytes!("../icons/tray/macos-badge-headphones-off.png")[..])
                }
            };
            if let Some(badge) = badge {
                // Bottom right, over the body of the mark.
                let origin = SIZE - BADGE_SIZE;
                let half = BADGE_SIZE as f32 / 2.0;
                disc(
                    &mut alpha,
                    (far - half, far - half),
                    half + GAP,
                    Paint::Clear,
                );
                let badge = alpha_of(&decode(badge, BADGE_SIZE)?);
                for y in 0..BADGE_SIZE {
                    for x in 0..BADGE_SIZE {
                        let over = badge[y * BADGE_SIZE + x];
                        let a = &mut alpha[(origin + y) * SIZE + origin + x];
                        *a = over + *a * (1.0 - over);
                    }
                }
            }
            Ok(alpha
                .into_iter()
                .flat_map(|a| [0, 0, 0, (a.clamp(0.0, 1.0) * 255.0).round() as u8])
                .collect())
        }

        fn alpha_of(pixels: &[u8]) -> Vec<f32> {
            pixels
                .chunks_exact(4)
                .map(|pixel| pixel[3] as f32 / 255.0)
                .collect()
        }

        #[derive(Clone, Copy)]
        enum Paint {
            Fill,
            Clear,
        }

        /// A circle with a softened edge, filled in or cleared out of the mask.
        fn disc(alpha: &mut [f32], centre: (f32, f32), radius: f32, paint: Paint) {
            for y in 0..SIZE {
                for x in 0..SIZE {
                    let distance = (x as f32 + 0.5 - centre.0).hypot(y as f32 + 0.5 - centre.1);
                    let coverage = (radius - distance + 0.5).clamp(0.0, 1.0);
                    let a = &mut alpha[y * SIZE + x];
                    *a = match paint {
                        Paint::Fill => coverage + *a * (1.0 - coverage),
                        Paint::Clear => *a * (1.0 - coverage),
                    };
                }
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn every_template_variant_composes_and_differs() {
            let plain =
                template::compose(IconVariant::default()).expect("the template should decode");
            assert_eq!(plain.len(), template::SIZE * template::SIZE * 4);
            assert!(
                plain.chunks_exact(4).all(|pixel| pixel[..3] == [0, 0, 0]),
                "a template image is black; macOS reads only its alpha"
            );
            let mut seen = Vec::new();
            for badge in [IconBadge::None, IconBadge::Muted, IconBadge::NotHearing] {
                for unread in [false, true] {
                    let pixels = template::compose(IconVariant { unread, badge })
                        .expect("every template variant should compose");
                    assert_eq!(pixels.len(), plain.len());
                    assert!(!seen.contains(&pixels), "each variant must look different");
                    seen.push(pixels);
                }
            }
        }

        #[test]
        fn every_variant_composes_to_a_full_icon() {
            let plain = compose(IconVariant::default()).expect("the base icon should decode");
            assert_eq!(plain.len(), SIZE * SIZE * 4);
            for badge in [IconBadge::None, IconBadge::Muted, IconBadge::NotHearing] {
                for unread in [false, true] {
                    let variant = IconVariant { unread, badge };
                    let pixels = compose(variant).expect("every tray icon should compose");
                    assert_eq!(pixels.len(), SIZE * SIZE * 4);
                    assert_eq!(pixels == plain, variant == IconVariant::default());
                }
            }
        }
    }
}

#[cfg(any(windows, target_os = "macos"))]
mod platform {
    #[cfg(windows)]
    use super::state_poisoned;
    use super::{
        action_for, icon, show_main_window, IconVariant, MenuEntry, Rendered, TrayAction,
        TrayState, ID_OPEN, ID_QUIT,
    };
    use tauri::{
        image::Image,
        menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
        AppHandle, Emitter, Manager, Wry,
    };
    #[cfg(windows)]
    use tauri_plugin_notification::NotificationExt;

    const TRAY_ID: &str = "raven";
    const EVENT_NAME: &str = "tray-action";

    /// Windows opens the window on a left click and the menu on a right click. A macOS
    /// menu bar icon opens its menu on any click; "Open Raven" is the first item.
    pub(super) fn install(app: &AppHandle) -> Result<(), String> {
        TrayIconBuilder::with_id(TRAY_ID)
            .icon(image(IconVariant::default())?)
            .icon_as_template(cfg!(target_os = "macos"))
            .tooltip("Raven")
            .show_menu_on_left_click(cfg!(target_os = "macos"))
            .on_menu_event(handle_menu_event)
            .on_tray_icon_event(|tray, event| {
                if cfg!(target_os = "macos") {
                    return;
                }
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    show_main_window(tray.app_handle());
                }
            })
            .build(app)
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    pub(super) fn render(
        app: &AppHandle,
        current: Option<&Rendered>,
        next: &Rendered,
    ) -> Result<(), String> {
        let tray = app
            .tray_by_id(TRAY_ID)
            .ok_or_else(|| "the tray icon is not installed".to_string())?;
        if current.map(|rendered| &rendered.menu) != Some(&next.menu) {
            tray.set_menu(Some(build_menu(app, &next.menu)?))
                .map_err(|error| error.to_string())?;
        }
        if current.map(|rendered| &rendered.tooltip) != Some(&next.tooltip) {
            tray.set_tooltip(Some(&next.tooltip))
                .map_err(|error| error.to_string())?;
        }
        if current.map(|rendered| rendered.icon) != Some(next.icon) {
            // Plain `set_icon` drops the template flag on macOS, which would draw the
            // black template as is instead of in the menu bar's colour.
            tray.set_icon_with_as_template(Some(image(next.icon)?), cfg!(target_os = "macos"))
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    #[cfg(windows)]
    fn image(variant: IconVariant) -> Result<Image<'static>, String> {
        Ok(Image::new_owned(
            icon::compose(variant)?,
            icon::SIZE as u32,
            icon::SIZE as u32,
        ))
    }

    #[cfg(target_os = "macos")]
    fn image(variant: IconVariant) -> Result<Image<'static>, String> {
        Ok(Image::new_owned(
            icon::template::compose(variant)?,
            icon::template::SIZE as u32,
            icon::template::SIZE as u32,
        ))
    }

    /// Windows reads `&` in a menu label as "underline the next letter", and macOS strips
    /// it the same way, so a literal one is doubled on both.
    fn menu_label(label: &str) -> String {
        label.replace('&', "&&")
    }

    fn build_menu(app: &AppHandle, entries: &[MenuEntry]) -> Result<Menu<Wry>, String> {
        let menu = Menu::new(app).map_err(|error| error.to_string())?;
        for entry in entries {
            match entry {
                MenuEntry::Separator => menu.append(
                    &PredefinedMenuItem::separator(app).map_err(|error| error.to_string())?,
                ),
                MenuEntry::Item { id, label, enabled } => menu.append(
                    &MenuItem::with_id(app, *id, menu_label(label), *enabled, None::<&str>)
                        .map_err(|error| error.to_string())?,
                ),
                MenuEntry::Toggle { id, label, checked } => menu.append(
                    &CheckMenuItem::with_id(
                        app,
                        *id,
                        menu_label(label),
                        true,
                        *checked,
                        None::<&str>,
                    )
                    .map_err(|error| error.to_string())?,
                ),
                MenuEntry::Choices { label, choices } => {
                    let submenu = Submenu::new(app, menu_label(label), true)
                        .map_err(|error| error.to_string())?;
                    for choice in choices {
                        submenu
                            .append(
                                &CheckMenuItem::with_id(
                                    app,
                                    &choice.id,
                                    menu_label(&choice.label),
                                    true,
                                    choice.checked,
                                    None::<&str>,
                                )
                                .map_err(|error| error.to_string())?,
                            )
                            .map_err(|error| error.to_string())?;
                    }
                    menu.append(&submenu)
                }
            }
            .map_err(|error| error.to_string())?;
        }
        Ok(menu)
    }

    fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
        let id = event.id().as_ref();
        match id {
            ID_OPEN => show_main_window(app),
            ID_QUIT => app.exit(0),
            _ => {
                let state = app.state::<TrayState>();
                let (action, ticked) = {
                    let Ok(mut view) = state.view.lock() else {
                        return;
                    };
                    // Windows and macOS tick a clicked choice by themselves. The tick has to follow the
                    // state the app reports instead, so the menu is drawn again.
                    let action = action_for(&view.snapshot, id);
                    let ticked = matches!(
                        action,
                        Some(TrayAction::Presence { .. } | TrayAction::Away { .. })
                    );
                    if ticked {
                        view.rendered = None;
                    }
                    (action, ticked)
                };
                if ticked {
                    let _ = super::refresh(app, &state);
                }
                let Some(action) = action else {
                    return;
                };
                if action.needs_window() {
                    show_main_window(app);
                }
                let _ = app.emit_to("main", EVENT_NAME, action);
            }
        }
    }

    pub(super) fn handle_main_close_requested(
        window: &tauri::Window,
        api: &tauri::CloseRequestApi,
    ) {
        let app = window.app_handle();
        let state = app.state::<TrayState>();
        let close_to_tray = state
            .settings
            .lock()
            .map(|settings| settings.close_to_tray)
            .unwrap_or(false);
        if !close_to_tray || app.tray_by_id(TRAY_ID).is_none() {
            // Other windows (a hidden overlay, a popped-out call) must not keep Raven alive.
            app.exit(0);
            return;
        }
        api.prevent_close();
        #[cfg(target_os = "macos")]
        full_screen::hide(window);
        #[cfg(windows)]
        let _ = window.hide();
        // A Mac app that stays in the menu bar after its window closes is the norm there,
        // and the Dock icon still brings the window back, so no notice is needed.
        #[cfg(windows)]
        if let Err(error) = show_hint_once(app, &state) {
            eprintln!("[raven] tray hint could not be shown: {error}");
        }
    }

    /// Hiding a window that is in native full screen takes it off its full-screen Space
    /// but leaves the Space behind, empty and black, and hiding the app does not move it
    /// either. macOS only lets it go by leaving full screen. So the window turns invisible,
    /// leaves full screen (what shows is the Space sliding away, as when any full-screen
    /// window closes), hides once AppKit says it is out, and goes back to full screen
    /// when it is shown again.
    #[cfg(target_os = "macos")]
    pub(super) mod full_screen {
        use std::{
            cell::RefCell,
            ptr::NonNull,
            rc::Rc,
            sync::atomic::{AtomicBool, Ordering},
        };

        use block2::RcBlock;
        use objc2::{
            rc::Retained,
            runtime::{AnyObject, ProtocolObject},
        };
        use objc2_app_kit::{NSWindow, NSWindowDidExitFullScreenNotification};
        use objc2_foundation::{NSNotification, NSNotificationCenter, NSObjectProtocol};

        type Observer = Retained<ProtocolObject<dyn NSObjectProtocol>>;

        /// Set while the window is on its way out of full screen to be hidden, so a second
        /// close in the meantime does not hide it mid-animation.
        static LEAVING: AtomicBool = AtomicBool::new(false);
        /// The window was closed from full screen and goes back to it when shown.
        static RESTORE: AtomicBool = AtomicBool::new(false);

        /// Runs on the main thread: close requests arrive from the event loop.
        pub(in super::super) fn hide(window: &tauri::Window) {
            if LEAVING.load(Ordering::Acquire) {
                return;
            }
            if !window.is_fullscreen().unwrap_or(false) {
                let _ = window.hide();
                return;
            }
            let Some(ns_window) = window
                .ns_window()
                .ok()
                .and_then(|pointer| NonNull::new(pointer.cast::<NSWindow>()))
            else {
                let _ = window.hide();
                return;
            };
            // SAFETY: Tauri hands out the live NSWindow of `window`, which outlives this
            // call, and this runs on the main thread.
            let ns_window: &NSWindow = unsafe { ns_window.as_ref() };
            LEAVING.store(true, Ordering::Release);

            let center = NSNotificationCenter::defaultCenter();
            let observer: Rc<RefCell<Option<Observer>>> = Rc::new(RefCell::new(None));
            let finish = {
                let window = window.clone();
                let observer = Rc::clone(&observer);
                let center = center.clone();
                move |restore: bool| {
                    if let Some(token) = observer.borrow_mut().take() {
                        // SAFETY: the token is the observer added below.
                        unsafe { center.removeObserver(token.as_ref()) };
                    }
                    let _ = window.hide();
                    // Visible again for the next show, now that it is ordered out.
                    if let Some(ns_window) = window
                        .ns_window()
                        .ok()
                        .and_then(|pointer| NonNull::new(pointer.cast::<NSWindow>()))
                    {
                        // SAFETY: as above.
                        unsafe { ns_window.as_ref() }.setAlphaValue(1.0);
                    }
                    RESTORE.store(restore, Ordering::Release);
                    LEAVING.store(false, Ordering::Release);
                }
            };
            let finish = Rc::new(finish);
            let block = {
                let finish = Rc::clone(&finish);
                RcBlock::new(move |_: NonNull<NSNotification>| finish(true))
            };
            // SAFETY: the object only filters the notification's sender. A nil queue runs
            // the block on the posting (main) thread, the only thread it is touched on.
            let token = unsafe {
                center.addObserverForName_object_queue_usingBlock(
                    Some(NSWindowDidExitFullScreenNotification),
                    Some(AsRef::<AnyObject>::as_ref(ns_window)),
                    None,
                    &block,
                )
            };
            *observer.borrow_mut() = Some(token);

            ns_window.setAlphaValue(0.0);
            if window.set_fullscreen(false).is_err() {
                finish(false);
            }
        }

        /// Puts a window closed from full screen back into full screen. Call after showing it.
        pub(in super::super) fn restore(window: &tauri::WebviewWindow) {
            if RESTORE.swap(false, Ordering::AcqRel) {
                let _ = window.set_fullscreen(true);
            }
        }
    }

    /// Say once that closing the window did not quit Raven, and where it went.
    #[cfg(windows)]
    fn show_hint_once(app: &AppHandle, state: &TrayState) -> Result<(), String> {
        let settings = {
            let mut settings = state
                .settings
                .lock()
                .map_err(state_poisoned)
                .map_err(|error| error.to_string())?;
            if settings.hint_shown {
                return Ok(());
            }
            settings.hint_shown = true;
            settings.clone()
        };
        app.notification()
            .builder()
            .title("Raven is still running")
            .body("It is in the tray, next to the clock. Right-click its icon to quit.")
            .show()
            .map_err(|error| error.to_string())?;
        let path = super::settings_path(app).map_err(|error| error.to_string())?;
        super::save_settings_to_path(&path, &settings).map_err(|error| error.to_string())
    }
}

/// Bring the main window back from the tray, from minimised, or from behind.
pub(crate) fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        #[cfg(target_os = "macos")]
        platform::full_screen::restore(&window);
    }
}

/// "Back to the call" on a picture-in-picture window.
#[tauri::command]
pub fn window_show_main(app: AppHandle) {
    show_main_window(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn idle() -> TraySnapshot {
        TraySnapshot {
            call: ThumbnailToolbarSnapshot {
                generation: "page".into(),
                revision: 1,
                signed_in: true,
                mic_enabled: true,
                mic_supported: true,
                deafen_supported: true,
                ..Default::default()
            },
            presence: "open".into(),
            presences: vec![
                TrayPresenceOption {
                    id: "open".into(),
                    label: "Open to talk".into(),
                },
                TrayPresenceOption {
                    id: "dnd".into(),
                    label: "Do not disturb".into(),
                },
            ],
            ..Default::default()
        }
    }

    fn in_call() -> TraySnapshot {
        let mut snapshot = idle();
        snapshot.call.has_media_session = true;
        snapshot.call_name = Some("Lounge".into());
        snapshot
    }

    fn labels(entries: &[MenuEntry]) -> Vec<String> {
        entries
            .iter()
            .map(|entry| match entry {
                MenuEntry::Separator => "-".into(),
                MenuEntry::Item { label, .. } => label.clone(),
                MenuEntry::Toggle { label, checked, .. } => {
                    format!("{}{label}", if *checked { "✓ " } else { "" })
                }
                MenuEntry::Choices { label, .. } => format!("{label} >"),
            })
            .collect()
    }

    fn enabled(entries: &[MenuEntry], wanted: &str) -> bool {
        entries.iter().any(|entry| {
            matches!(entry, MenuEntry::Item { id, enabled: true, .. } if *id == wanted)
        })
    }

    #[test]
    fn only_the_sign_in_entry_starts_hidden() {
        let args = |list: &[&str]| list.iter().map(|arg| arg.to_string()).collect::<Vec<_>>().into_iter();
        assert!(launched_at_sign_in(args(&["raven.exe", AUTOSTART_FLAG])));
        assert!(!launched_at_sign_in(args(&["raven.exe"])));
        assert!(!launched_at_sign_in(args(&["raven.exe", "--hidden-extra"])));
    }

    #[test]
    fn signed_out_menu_only_opens_and_quits() {
        let mut snapshot = in_call();
        snapshot.call.signed_in = false;
        assert_eq!(
            labels(&menu_model(&snapshot)),
            ["Open Raven", "Quit Raven"]
        );
        assert_eq!(tooltip(&snapshot), "Raven");
        assert_eq!(icon_variant(&snapshot, true), IconVariant::default());
        assert_eq!(action_for(&snapshot, ID_SETTINGS), None);
    }

    #[test]
    fn idle_menu_has_no_leave_and_says_so() {
        let menu = menu_model(&idle());
        assert_eq!(
            labels(&menu),
            [
                "Not in a call",
                "-",
                "Mute",
                "Stop hearing people",
                "-",
                "How you appear >",
                "-",
                "Settings",
                "Check for updates",
                "-",
                "Open Raven",
                "Quit Raven",
            ]
        );
        assert!(!enabled(&menu, ID_STATUS));
        assert!(enabled(&menu, ID_MIC));
        assert_eq!(tooltip(&idle()), "Raven");
    }

    #[test]
    fn call_menu_names_the_call_and_follows_mute_and_deafen() {
        let mut snapshot = in_call();
        let menu = labels(&menu_model(&snapshot));
        assert_eq!(menu[0], "In Lounge");
        assert_eq!(menu[4], "Leave Lounge");
        assert_eq!(tooltip(&snapshot), "Raven — In Lounge");
        assert_eq!(icon_variant(&snapshot, false).badge, IconBadge::None);

        snapshot.call.mic_enabled = false;
        assert_eq!(labels(&menu_model(&snapshot))[2], "Unmute");
        assert_eq!(tooltip(&snapshot), "Raven — In Lounge, muted");
        assert_eq!(icon_variant(&snapshot, false).badge, IconBadge::Muted);

        snapshot.call.deafened = true;
        assert_eq!(labels(&menu_model(&snapshot))[3], "Hear people again");
        assert_eq!(tooltip(&snapshot), "Raven — In Lounge, not hearing anyone");
        assert_eq!(icon_variant(&snapshot, true).badge, IconBadge::NotHearing);
        assert!(icon_variant(&snapshot, true).unread);
    }

    #[test]
    fn status_line_follows_the_connection() {
        let mut snapshot = in_call();
        snapshot.call_status = TrayCallStatus::Connecting;
        assert_eq!(labels(&menu_model(&snapshot))[0], "Connecting to Lounge…");
        snapshot.call_status = TrayCallStatus::Reconnecting;
        assert_eq!(labels(&menu_model(&snapshot))[0], "Reconnecting to Lounge…");
        snapshot.call_name = None;
        snapshot.call_status = TrayCallStatus::Connected;
        let menu = labels(&menu_model(&snapshot));
        assert_eq!(menu[0], "In a call");
        assert_eq!(menu[4], "Leave call");
    }

    #[test]
    fn long_call_names_are_shortened() {
        let mut snapshot = in_call();
        snapshot.call_name = Some("n".repeat(200));
        let line = tooltip(&snapshot);
        assert!(line.chars().count() < 100);
        assert!(line.contains('…'));
    }

    #[test]
    fn muting_outside_a_call_does_not_badge_the_icon() {
        let mut snapshot = idle();
        snapshot.call.mic_enabled = false;
        assert_eq!(icon_variant(&snapshot, false), IconVariant::default());
    }

    #[test]
    fn busy_and_pending_controls_are_disabled_and_ignored() {
        let mut snapshot = in_call();
        snapshot.call.busy = true;
        snapshot.call.leave_pending = true;
        let menu = menu_model(&snapshot);
        assert!(!enabled(&menu, ID_MIC));
        assert!(!enabled(&menu, ID_DEAFEN));
        assert!(!enabled(&menu, ID_LEAVE));
        assert_eq!(action_for(&snapshot, ID_MIC), None);
        assert_eq!(action_for(&snapshot, ID_LEAVE), None);
        assert_eq!(action_for(&snapshot, ID_SETTINGS), Some(TrayAction::Settings));
    }

    #[test]
    fn presence_choices_tick_the_current_one_and_reject_unknown_ids() {
        let snapshot = idle();
        let choices = menu_model(&snapshot)
            .into_iter()
            .find_map(|entry| match entry {
                MenuEntry::Choices { choices, .. } => Some(choices),
                _ => None,
            })
            .expect("the presence submenu");
        assert_eq!(
            choices
                .iter()
                .map(|choice| (choice.label.as_str(), choice.checked))
                .collect::<Vec<_>>(),
            [("Open to talk", true), ("Do not disturb", false)]
        );
        assert_eq!(
            action_for(&snapshot, "tray:presence:dnd"),
            Some(TrayAction::Presence {
                presence: "dnd".into()
            })
        );
        assert_eq!(action_for(&snapshot, "tray:presence:everywhere"), None);
        assert_eq!(action_for(&snapshot, ID_OPEN), None);
    }

    #[test]
    fn actions_serialise_the_way_the_window_reads_them() {
        assert_eq!(
            serde_json::to_string(&TrayAction::CheckUpdates).unwrap(),
            r#"{"action":"checkUpdates"}"#
        );
        assert_eq!(
            serde_json::to_string(&TrayAction::Presence {
                presence: "dnd".into()
            })
            .unwrap(),
            r#"{"action":"presence","presence":"dnd"}"#
        );
    }

    #[test]
    fn back_in_a_bit_is_offered_in_a_connected_call_on_the_menu_bar_only() {
        let mut snapshot = in_call();
        snapshot.away_supported = true;
        let menu = labels(&menu_model_for(&snapshot, true));
        assert_eq!(menu[4..6], ["Leave Lounge", "Back in a bit"]);
        assert_eq!(
            action_for_with(&snapshot, ID_AWAY, true),
            Some(TrayAction::Away { away: true })
        );

        snapshot.away = true;
        assert_eq!(
            labels(&menu_model_for(&snapshot, true))[5],
            "✓ Back in a bit"
        );
        assert_eq!(
            action_for_with(&snapshot, ID_AWAY, true),
            Some(TrayAction::Away { away: false })
        );

        let offered = |snapshot: &TraySnapshot, offers_away: bool| {
            menu_model_for(snapshot, offers_away)
                .iter()
                .any(|entry| matches!(entry, MenuEntry::Toggle { id, .. } if *id == ID_AWAY))
        };
        // Windows keeps its menu as it was.
        assert!(!offered(&snapshot, false));
        assert_eq!(action_for_with(&snapshot, ID_AWAY, false), None);

        // Not offered when the server cannot share it, or outside a call.
        snapshot.away_supported = false;
        assert!(!offered(&snapshot, true));
        assert_eq!(action_for_with(&snapshot, ID_AWAY, true), None);
        let mut idle = idle();
        idle.away_supported = true;
        assert!(!offered(&idle, true));
        assert_eq!(action_for_with(&idle, ID_AWAY, true), None);

        assert_eq!(
            serde_json::to_string(&TrayAction::Away { away: true }).unwrap(),
            r#"{"action":"away","away":true}"#
        );
    }

    #[test]
    fn snapshots_arrive_flat_and_overtaken_ones_are_dropped() {
        let snapshot: TraySnapshot = serde_json::from_str(
            r#"{"generation":"page","revision":4,"signedIn":true,"micEnabled":true,
                "hasMediaSession":true,"callName":"Lounge","callStatus":"reconnecting",
                "presence":"open","presences":[{"id":"open","label":"Open to talk"}]}"#,
        )
        .expect("the window's snapshot should parse");
        assert!(snapshot.call.signed_in && snapshot.call.has_media_session);
        assert_eq!(snapshot.call_status, TrayCallStatus::Reconnecting);
        assert_eq!(snapshot.presences[0].label, "Open to talk");

        let mut older = snapshot.clone();
        older.call.revision = 3;
        assert!(is_stale(&snapshot.call, &older.call));
        assert!(is_stale(&snapshot.call, &snapshot.call));
        let mut reloaded = older.clone();
        reloaded.call.generation = "next page".into();
        assert!(!is_stale(&snapshot.call, &reloaded.call));
    }

    #[test]
    fn settings_default_to_staying_in_the_tray_and_survive_a_bad_file() {
        let path = std::env::temp_dir().join(format!("raven-tray-{}.json", uuid::Uuid::new_v4()));
        assert_eq!(load_settings_from_path(&path), TraySettings::default());
        assert!(TraySettings::default().close_to_tray);

        let saved = TraySettings {
            close_to_tray: false,
            hint_shown: true,
        };
        save_settings_to_path(&path, &saved).expect("settings should save");
        assert_eq!(load_settings_from_path(&path), saved);

        fs::write(&path, "{ not json").expect("the test file should be writable");
        assert_eq!(load_settings_from_path(&path), TraySettings::default());
        let _ = fs::remove_file(&path);
    }
}
