use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, PoisonError,
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use thiserror::Error;

pub const VOICE_OVERLAY_LABEL: &str = "voice-overlay";
pub const VOICE_OVERLAY_EVENT: &str = "voice-overlay-state-changed";
pub const VOICE_OVERLAY_SETTINGS_EVENT: &str = "voice-overlay-settings-changed";
pub const VOICE_OVERLAY_INTERACTION_EVENT: &str = "voice-overlay-interaction-changed";
pub const VOICE_OVERLAY_LAYOUT_EVENT: &str = "voice-overlay-layout-changed";
/// Sent to the main window, which carries the action out (it owns the call and its guards).
pub const VOICE_OVERLAY_ACTION_EVENT: &str = "voice-overlay-action";
pub const DEFAULT_OVERLAY_HOTKEY: &str = "Alt+F8";

const SETTINGS_FILE_NAME: &str = "voice-overlay-settings.json";
const DEFAULT_MONITOR_OFFSET: i32 = 24;
/// An edge this close (physical px) when a drag ends pulls the overlay onto it.
const SNAP_DISTANCE: i32 = 24;
/// How far a snapped overlay sits from the edge, so the card never touches the bezel.
const SNAP_MARGIN: i32 = 12;
/// What the window holds before the overlay has measured its card (CSS px).
const INITIAL_CONTENT_SIZE: (f64, f64) = (220.0, 64.0);
/// The card never grows wider than this share of the work area; past it, it scrolls.
const MAX_CARD_WIDTH_SHARE: f64 = 0.9;
/// The pointer has to rest on the card this long before clicks land on it, so sweeping
/// a game's cursor across the overlay never steals a click (decided 2026-10-26).
#[cfg_attr(not(windows), allow(dead_code))]
const HOVER_ENTER_DELAY: Duration = Duration::from_millis(300);
/// Grace before clicks go back to the game, so moving between the card and its controls
/// or overshooting an edge doesn't drop the interaction.
#[cfg_attr(not(windows), allow(dead_code))]
const HOVER_LEAVE_DELAY: Duration = Duration::from_millis(400);
#[cfg_attr(not(windows), allow(dead_code))]
const HOVER_POLL_INTERVAL: Duration = Duration::from_millis(33);
#[cfg_attr(not(windows), allow(dead_code))]
const HOVER_IDLE_INTERVAL: Duration = Duration::from_millis(250);
/// A press of the overlay key shorter than this is a tap (show or hide); longer is a hold.
#[cfg_attr(not(windows), allow(dead_code))]
const HOLD_THRESHOLD: Duration = Duration::from_millis(250);
/// Longest a drag is followed before the overlay is anchored where it is.
#[cfg_attr(not(windows), allow(dead_code))]
const DRAG_RELEASE_TIMEOUT: Duration = Duration::from_secs(30);

/// Which buttons the card shows under your row while it is interactive. All on by default.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct VoiceOverlayButtons {
    pub mute: bool,
    pub deafen: bool,
    pub away: bool,
}

impl Default for VoiceOverlayButtons {
    fn default() -> Self {
        Self {
            mute: true,
            deafen: true,
            away: true,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(from = "StoredVoiceOverlaySettings", rename_all = "camelCase")]
pub struct VoiceOverlaySettings {
    pub enabled: bool,
    pub hotkey: String,
    pub shape: VoiceOverlayShape,
    pub size: VoiceOverlaySize,
    pub interact: VoiceOverlayInteract,
    pub names: VoiceOverlayNames,
    pub background: VoiceOverlayNameBackground,
    pub view: VoiceOverlayView,
    /// Seconds a name stays after someone stops talking: 0 (off), 3 or 6.
    pub linger_seconds: u8,
    pub quiet_fade: VoiceOverlayQuietFade,
    pub muted_hint: bool,
    pub show_weak_connections: bool,
    pub show_joins_and_leaves: bool,
    pub show_knocks: bool,
    pub show_messages: VoiceOverlayMessages,
    pub show_on_join: bool,
    pub overlay_buttons: VoiceOverlayButtons,
    /// Scroll on a person's row to change their volume while the card is interactive.
    pub scroll_volume: bool,
    pub anchor: Option<VoiceOverlayAnchor>,
    /// A top-left corner saved by builds before anchors. It becomes an anchor the first
    /// time the overlay is placed, once the monitors are known.
    #[serde(skip_serializing)]
    pub legacy_position: Option<VoiceOverlayPosition>,
}

impl Default for VoiceOverlaySettings {
    fn default() -> Self {
        Self {
            enabled: true,
            hotkey: DEFAULT_OVERLAY_HOTKEY.to_string(),
            shape: VoiceOverlayShape::default(),
            size: VoiceOverlaySize::default(),
            interact: VoiceOverlayInteract::default(),
            names: VoiceOverlayNames::default(),
            background: VoiceOverlayNameBackground::default(),
            view: VoiceOverlayView::default(),
            linger_seconds: DEFAULT_LINGER_SECONDS,
            quiet_fade: VoiceOverlayQuietFade::default(),
            muted_hint: true,
            show_weak_connections: true,
            show_joins_and_leaves: true,
            show_knocks: true,
            show_messages: VoiceOverlayMessages::default(),
            show_on_join: false,
            overlay_buttons: VoiceOverlayButtons::default(),
            scroll_volume: true,
            anchor: None,
            legacy_position: None,
        }
    }
}

/// The settings file as any build has written it. `layout` and `position` are the
/// pre-anchor fields; they only ever load.
#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct StoredVoiceOverlaySettings {
    enabled: Option<bool>,
    hotkey: Option<String>,
    shape: Option<VoiceOverlayShape>,
    layout: Option<VoiceOverlayLayout>,
    size: Option<VoiceOverlaySize>,
    interact: Option<VoiceOverlayInteract>,
    /// Replaced by `names`; loads as Always or Never.
    show_names: Option<bool>,
    names: Option<VoiceOverlayNames>,
    /// Renamed `background`.
    name_background: Option<VoiceOverlayNameBackground>,
    background: Option<VoiceOverlayNameBackground>,
    view: Option<VoiceOverlayView>,
    linger_seconds: Option<u8>,
    quiet_fade: Option<VoiceOverlayQuietFade>,
    muted_hint: Option<bool>,
    show_weak_connections: Option<bool>,
    show_joins_and_leaves: Option<bool>,
    show_knocks: Option<bool>,
    show_messages: Option<VoiceOverlayMessages>,
    show_on_join: Option<bool>,
    overlay_buttons: Option<VoiceOverlayButtons>,
    scroll_volume: Option<bool>,
    anchor: Option<VoiceOverlayAnchor>,
    position: Option<VoiceOverlayPosition>,
}

impl From<StoredVoiceOverlaySettings> for VoiceOverlaySettings {
    fn from(stored: StoredVoiceOverlaySettings) -> Self {
        let defaults = VoiceOverlaySettings::default();
        // Someone who picked the list or the strip keeps it; only new installs follow
        // the edge.
        let shape = stored.shape.unwrap_or(match stored.layout {
            Some(VoiceOverlayLayout::Vertical) => VoiceOverlayShape::Column,
            Some(VoiceOverlayLayout::Horizontal) => VoiceOverlayShape::Row,
            None => defaults.shape,
        });
        let legacy_position = if stored.anchor.is_none() {
            stored.position
        } else {
            None
        };
        Self {
            enabled: stored.enabled.unwrap_or(defaults.enabled),
            hotkey: stored.hotkey.unwrap_or(defaults.hotkey),
            shape,
            size: stored.size.unwrap_or(defaults.size),
            interact: stored.interact.unwrap_or(defaults.interact),
            names: stored.names.unwrap_or(match stored.show_names {
                Some(false) => VoiceOverlayNames::Never,
                _ => defaults.names,
            }),
            background: stored
                .background
                .or(stored.name_background)
                .unwrap_or(defaults.background),
            view: stored.view.unwrap_or(defaults.view),
            linger_seconds: normalize_linger(stored.linger_seconds.unwrap_or(defaults.linger_seconds)),
            quiet_fade: stored.quiet_fade.unwrap_or(defaults.quiet_fade),
            muted_hint: stored.muted_hint.unwrap_or(defaults.muted_hint),
            show_weak_connections: stored
                .show_weak_connections
                .unwrap_or(defaults.show_weak_connections),
            show_joins_and_leaves: stored
                .show_joins_and_leaves
                .unwrap_or(defaults.show_joins_and_leaves),
            show_knocks: stored.show_knocks.unwrap_or(defaults.show_knocks),
            show_messages: stored.show_messages.unwrap_or(defaults.show_messages),
            show_on_join: stored.show_on_join.unwrap_or(defaults.show_on_join),
            overlay_buttons: stored.overlay_buttons.unwrap_or(defaults.overlay_buttons),
            scroll_volume: stored.scroll_volume.unwrap_or(defaults.scroll_volume),
            anchor: stored.anchor,
            legacy_position,
        }
    }
}

/// The pre-anchor layout setting, read from old settings files only.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
enum VoiceOverlayLayout {
    Vertical,
    Horizontal,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VoiceOverlayShape {
    /// A row along the top or bottom edge, a column anywhere else.
    #[default]
    FollowEdge,
    Column,
    Row,
}

/// The shape the card is drawn in right now, after following the edge.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum VoiceOverlayResolvedShape {
    Column,
    Row,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VoiceOverlaySize {
    Small,
    #[default]
    Medium,
    Large,
}

/// How the user gets to click the overlay. Otherwise every click goes through to the
/// app underneath.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VoiceOverlayInteract {
    /// Rest the pointer on the card.
    #[default]
    Hover,
    /// Hold the show/hide key.
    Hold,
    Never,
}

/// How much of a fill sits behind each name so it stays readable over any game.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VoiceOverlayNameBackground {
    Off,
    #[default]
    Light,
    Strong,
}

/// Whether a row shows its name.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VoiceOverlayNames {
    #[default]
    Always,
    WhileTalking,
    Never,
}

/// Who the card lists.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VoiceOverlayView {
    #[default]
    Everyone,
    TalkersFirst,
    OnlyTalking,
}

/// How far the card fades after a few seconds with nobody talking.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VoiceOverlayQuietFade {
    #[default]
    None,
    Some,
    Lots,
}

/// Which text-room messages appear as a heads-up line.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VoiceOverlayMessages {
    #[default]
    Off,
    /// Text rooms in the tree of the nest you are calling in.
    Tree,
}

const DEFAULT_LINGER_SECONDS: u8 = 3;

/// Only the offered values are kept; anything else in a hand-edited file becomes the default.
fn normalize_linger(seconds: u8) -> u8 {
    match seconds {
        0 | 3 | 6 => seconds,
        _ => DEFAULT_LINGER_SECONDS,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceOverlayPosition {
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VoiceOverlayCorner {
    #[default]
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

impl VoiceOverlayCorner {
    fn from_sides(left: bool, top: bool) -> Self {
        match (left, top) {
            (true, true) => Self::TopLeft,
            (false, true) => Self::TopRight,
            (true, false) => Self::BottomLeft,
            (false, false) => Self::BottomRight,
        }
    }

    fn is_left(self) -> bool {
        matches!(self, Self::TopLeft | Self::BottomLeft)
    }

    fn is_top(self) -> bool {
        matches!(self, Self::TopLeft | Self::TopRight)
    }
}

/// Where the overlay sits: the distance from one corner of a monitor's work area to the
/// same corner of the window. The window grows away from that corner, so a card in the
/// bottom-right never walks off the screen when someone joins.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct VoiceOverlayAnchor {
    pub monitor: Option<String>,
    pub corner: VoiceOverlayCorner,
    pub dx: i32,
    pub dy: i32,
    /// Snapped to the left or right edge.
    pub snapped_side: bool,
    /// Snapped to the top or bottom edge.
    pub snapped_end: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct VoiceOverlaySnapshot {
    pub nest_id: Option<String>,
    pub nest_name: Option<String>,
    pub location_label: String,
    pub connected: bool,
    /// Your own connection is being re-made; the card always says so.
    pub reconnecting: bool,
    /// You are talking while muted (once per mute, for a few seconds).
    pub local_muted_hint: bool,
    /// False against a server that predates the shared call state.
    pub away_supported: bool,
    /// Knocks and messages that could still be on the card. The overlay decides how long each shows.
    pub heads_up: Vec<VoiceOverlayHeadsUp>,
    pub participants: Vec<VoiceOverlayParticipant>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VoiceOverlayHeadsUpKind {
    #[default]
    Knock,
    Message,
}

/// One line the card may show above or beside the people.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct VoiceOverlayHeadsUp {
    pub id: String,
    pub kind: VoiceOverlayHeadsUpKind,
    pub actor_name: String,
    pub avatar_url: Option<String>,
    pub text: String,
    /// When it happened (ISO 8601).
    pub at: String,
    /// A knock on this person rather than on a nest: it takes an answer.
    pub answerable: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VoiceOverlayConnectionQuality {
    Good,
    Poor,
    Lost,
    #[default]
    Unknown,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct VoiceOverlayParticipant {
    pub user_id: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub is_local: bool,
    pub speaking: bool,
    pub speaking_level: u8,
    pub muted: bool,
    pub deafened: bool,
    /// "Back in a bit": a marker with no time or duration.
    pub away: bool,
    pub screen_sharing: bool,
    /// Others watching this person's screen share, by user id.
    pub watchers: Vec<String>,
    pub camera_on: bool,
    pub connection_quality: VoiceOverlayConnectionQuality,
    /// When they joined the call (ISO 8601); the card keeps people in this order.
    pub joined_at: Option<String>,
    /// Their volume for you, 0–200. 100 when you have not changed it or it does not apply.
    #[serde(default = "full_volume_percent")]
    pub volume_percent: u16,
}

fn full_volume_percent() -> u16 {
    100
}

/// A button or scroll on the card, for the main window to carry out. The overlay never
/// runs media commands itself: the main window owns the call, its pending guards and the
/// error toasts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum VoiceOverlayAction {
    Mic,
    Deafen,
    Away {
        away: bool,
    },
    /// Open or dismiss a knock shown as a heads-up line.
    #[serde(rename_all = "camelCase")]
    Knock {
        knock_id: String,
        open: bool,
    },
    /// Answer a knock on this person from its line.
    #[serde(rename_all = "camelCase")]
    KnockReply {
        knock_id: String,
        reply: String,
        until: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Volume {
        user_id: String,
        percent: u16,
    },
}

/// What the overlay measured: the window it wants (the card plus the margin its ring
/// needs) and the card inside it, both in CSS px.
#[derive(Clone, Copy, Debug, Default, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct VoiceOverlayContentSize {
    pub width: f64,
    pub height: f64,
    pub card: VoiceOverlayCssRect,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct VoiceOverlayCssRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// What the overlay window needs to lay itself out.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceOverlayLayoutView {
    pub shape: VoiceOverlayResolvedShape,
    pub size: VoiceOverlaySize,
    pub interact: VoiceOverlayInteract,
    pub interactive: bool,
    /// The screen corner the card grows away from; heads-up lines go at the far end.
    pub anchor_corner: VoiceOverlayCorner,
    /// The largest card that fits the monitor it's on, in CSS px.
    pub max_card_width: f64,
    pub max_card_height: f64,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceOverlayInteraction {
    pub interactive: bool,
}

#[derive(Debug)]
pub struct VoiceOverlayState {
    settings: Mutex<VoiceOverlaySettings>,
    snapshot: Mutex<VoiceOverlaySnapshot>,
    registered_hotkey: Mutex<Option<String>>,
    registration_error: Mutex<Option<String>>,
    window: Mutex<OverlayWindowState>,
    /// The newest drag the card has seen the button come up for. The card numbers its
    /// drags, so a release that arrives before its drag starts still ends it.
    drag_released: Arc<AtomicU64>,
}

#[derive(Debug, Default)]
struct OverlayWindowState {
    /// The native handle, kept so the hover poller never has to go through the event loop.
    #[cfg_attr(not(windows), allow(dead_code))]
    hwnd: Option<isize>,
    content: Option<VoiceOverlayContentSize>,
    /// Scale factor of the monitor the window was last placed on.
    scale: f64,
    max_card: (f64, f64),
    interactive: bool,
    #[cfg_attr(not(windows), allow(dead_code))]
    hold: HoldState,
}

#[derive(Debug, Default)]
#[cfg_attr(not(windows), allow(dead_code))]
struct HoldState {
    generation: u64,
    pressed: bool,
    holding: bool,
    hide_after: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceOverlaySettingsView {
    pub supported: bool,
    pub enabled: bool,
    pub hotkey: String,
    pub shape: VoiceOverlayShape,
    pub effective_shape: VoiceOverlayResolvedShape,
    pub size: VoiceOverlaySize,
    pub interact: VoiceOverlayInteract,
    pub names: VoiceOverlayNames,
    pub background: VoiceOverlayNameBackground,
    pub view: VoiceOverlayView,
    pub linger_seconds: u8,
    pub quiet_fade: VoiceOverlayQuietFade,
    pub muted_hint: bool,
    pub show_weak_connections: bool,
    pub show_joins_and_leaves: bool,
    pub show_knocks: bool,
    pub show_messages: VoiceOverlayMessages,
    pub show_on_join: bool,
    pub overlay_buttons: VoiceOverlayButtons,
    pub scroll_volume: bool,
    pub registration_error: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct VoiceOverlaySettingsPatch {
    pub enabled: Option<bool>,
    pub hotkey: Option<String>,
    pub shape: Option<VoiceOverlayShape>,
    pub size: Option<VoiceOverlaySize>,
    pub interact: Option<VoiceOverlayInteract>,
    pub names: Option<VoiceOverlayNames>,
    pub background: Option<VoiceOverlayNameBackground>,
    pub view: Option<VoiceOverlayView>,
    pub linger_seconds: Option<u8>,
    pub quiet_fade: Option<VoiceOverlayQuietFade>,
    pub muted_hint: Option<bool>,
    pub show_weak_connections: Option<bool>,
    pub show_joins_and_leaves: Option<bool>,
    pub show_knocks: Option<bool>,
    pub show_messages: Option<VoiceOverlayMessages>,
    pub show_on_join: Option<bool>,
    pub overlay_buttons: Option<VoiceOverlayButtons>,
    pub scroll_volume: Option<bool>,
}

#[derive(Debug, Error, Serialize)]
#[serde(tag = "code", content = "detail", rename_all = "camelCase")]
pub enum VoiceOverlayError {
    #[error("voice overlay state is unavailable")]
    StatePoisoned,
    #[error("voice overlay settings I/O failed: {message}")]
    Io { message: String },
    #[error("voice overlay window failed: {message}")]
    Window { message: String },
    #[error("{message}")]
    Shortcut { message: String },
}

pub fn new_voice_overlay_state() -> VoiceOverlayState {
    VoiceOverlayState {
        settings: Mutex::new(VoiceOverlaySettings::default()),
        snapshot: Mutex::new(VoiceOverlaySnapshot::default()),
        registered_hotkey: Mutex::new(None),
        registration_error: Mutex::new(None),
        window: Mutex::new(OverlayWindowState {
            scale: 1.0,
            ..OverlayWindowState::default()
        }),
        drag_released: Arc::new(AtomicU64::new(0)),
    }
}

pub fn initialize_voice_overlay(app: &AppHandle) -> Result<(), VoiceOverlayError> {
    let state = app.state::<VoiceOverlayState>();
    let settings = load_settings_from_path(&settings_path(app)?);
    *state.settings.lock().map_err(state_poisoned)? = settings.clone();

    if !overlay_supported() {
        clear_registered_hotkey(&state)?;
        return Ok(());
    }

    if let Err(err) = reconcile_hotkey_registration(app, &state, &settings) {
        set_registration_error(&state, Some(err.to_string()))?;
        eprintln!("[raven] voice overlay hotkey registration failed: {err}");
    }
    start_hover_poller(app);
    Ok(())
}

#[tauri::command]
pub fn overlay_is_supported() -> bool {
    overlay_supported()
}

#[tauri::command]
pub fn overlay_get_settings(
    state: State<'_, VoiceOverlayState>,
) -> Result<VoiceOverlaySettingsView, VoiceOverlayError> {
    let settings = state.settings.lock().map_err(state_poisoned)?.clone();
    settings_view(&state, &settings)
}

// Commands that create, move or show the overlay window are async: a synchronous command
// runs on the main thread, and building a window there deadlocks on Windows.
#[tauri::command]
pub async fn overlay_update_settings(
    app: AppHandle,
    state: State<'_, VoiceOverlayState>,
    patch: VoiceOverlaySettingsPatch,
) -> Result<VoiceOverlaySettingsView, VoiceOverlayError> {
    let current = state.settings.lock().map_err(state_poisoned)?.clone();
    if !overlay_supported() {
        return settings_view(&state, &current);
    }

    let next = apply_settings_patch(&current, patch);
    reconcile_hotkey_registration(&app, &state, &next)?;

    *state.settings.lock().map_err(state_poisoned)? = next.clone();
    save_settings(&app, &next)?;
    if !next.enabled {
        hide_existing_overlay_window(&app)?;
    } else if next.interact != current.interact {
        // A new way in starts from click-through; the next hover or hold opens it again.
        set_interactive(&app, false)?;
    }
    if let Some(window) = app.get_webview_window(VOICE_OVERLAY_LABEL) {
        place_overlay_window(&app, &window)?;
    }
    let view = settings_view(&state, &next)?;
    emit_settings(&app, &view);
    emit_layout(&app);
    Ok(view)
}

#[tauri::command]
pub async fn overlay_toggle(
    app: AppHandle,
    state: State<'_, VoiceOverlayState>,
) -> Result<bool, VoiceOverlayError> {
    if !overlay_supported() || !state.settings.lock().map_err(state_poisoned)?.enabled {
        return Ok(false);
    }
    toggle_overlay_window(&app, None)
}

#[tauri::command]
pub async fn overlay_show(
    app: AppHandle,
    state: State<'_, VoiceOverlayState>,
) -> Result<bool, VoiceOverlayError> {
    if !overlay_supported() || !state.settings.lock().map_err(state_poisoned)?.enabled {
        return Ok(false);
    }
    // True when this call is what made it appear; Show when I join a call only hides
    // again what it showed.
    let was_visible = app
        .get_webview_window(VOICE_OVERLAY_LABEL)
        .is_some_and(|window| native::is_visible(&window));
    let _ = toggle_overlay_window(&app, Some(true))?;
    Ok(!was_visible)
}

#[tauri::command]
pub async fn overlay_hide(app: AppHandle) -> Result<(), VoiceOverlayError> {
    if !overlay_supported() {
        return Ok(());
    }
    hide_existing_overlay_window(&app)
}

/// The overlay measured its card. The window takes that size, keeping its anchor corner.
#[tauri::command]
pub async fn overlay_set_content_size(
    app: AppHandle,
    state: State<'_, VoiceOverlayState>,
    size: VoiceOverlayContentSize,
) -> Result<(), VoiceOverlayError> {
    if !overlay_supported() || !(size.width > 0.0 && size.height > 0.0) {
        return Ok(());
    }
    {
        let mut window_state = state.window.lock().map_err(state_poisoned)?;
        if window_state.content == Some(size) {
            return Ok(());
        }
        window_state.content = Some(size);
    }
    if let Some(window) = app.get_webview_window(VOICE_OVERLAY_LABEL) {
        place_overlay_window(&app, &window)?;
    }
    Ok(())
}

/// The primary button went down on the card: the window follows the cursor until it is
/// released, then snaps to a nearby edge, remembers the corner it's anchored to, and
/// works out the shape again. The window is moved by hand rather than with the system's
/// move loop, which activates the window and would take focus from the game.
#[tauri::command]
pub async fn overlay_drag(
    app: AppHandle,
    state: State<'_, VoiceOverlayState>,
    drag_id: u64,
) -> Result<VoiceOverlaySettingsView, VoiceOverlayError> {
    let current = state.settings.lock().map_err(state_poisoned)?.clone();
    let Some(window) = app.get_webview_window(VOICE_OVERLAY_LABEL) else {
        return settings_view(&state, &current);
    };
    if !overlay_supported() {
        return settings_view(&state, &current);
    }
    #[cfg(windows)]
    {
        let handle = state.window.lock().map_err(state_poisoned)?.hwnd;
        if let Some(handle) = handle {
            let released = state.drag_released.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || {
                native::follow_cursor_while_pressed(handle, DRAG_RELEASE_TIMEOUT, || {
                    released.load(Ordering::SeqCst) >= drag_id
                })
            })
            .await;
        }
    }
    let monitors = window.available_monitors().map_err(window_error)?;
    let Some(rect) = current_window_rect(&window) else {
        return settings_view(&state, &current);
    };
    let Some(monitor) = monitor_containing(&monitors, rect.center()) else {
        return settings_view(&state, &current);
    };
    let anchor = anchor_from_rect(rect, work_area(monitor), monitor.name().cloned());
    let next = {
        let mut settings = state.settings.lock().map_err(state_poisoned)?;
        settings.anchor = Some(anchor);
        settings.legacy_position = None;
        settings.clone()
    };
    save_settings(&app, &next)?;
    place_overlay_window(&app, &window)?;
    let view = settings_view(&state, &next)?;
    emit_settings(&app, &view);
    emit_layout(&app);
    Ok(view)
}

/// The button came up on the card (or the card lost the pointer): drag `drag_id` ends.
/// A game in front can hide the button's state from Raven, so the card says so itself.
#[tauri::command]
pub fn overlay_drag_release(state: State<'_, VoiceOverlayState>, drag_id: u64) {
    state.drag_released.fetch_max(drag_id, Ordering::SeqCst);
}

/// Back to the default corner, for when the overlay can't be dragged (Interact: never)
/// or ended up somewhere awkward.
#[tauri::command]
pub async fn overlay_reset_position(
    app: AppHandle,
    state: State<'_, VoiceOverlayState>,
) -> Result<VoiceOverlaySettingsView, VoiceOverlayError> {
    let next = {
        let mut settings = state.settings.lock().map_err(state_poisoned)?;
        settings.anchor = None;
        settings.legacy_position = None;
        settings.clone()
    };
    if !overlay_supported() {
        return settings_view(&state, &next);
    }
    save_settings(&app, &next)?;
    if let Some(window) = app.get_webview_window(VOICE_OVERLAY_LABEL) {
        place_overlay_window(&app, &window)?;
    }
    let view = settings_view(&state, &next)?;
    emit_settings(&app, &view);
    emit_layout(&app);
    Ok(view)
}

#[tauri::command]
pub fn overlay_get_layout(
    state: State<'_, VoiceOverlayState>,
) -> Result<VoiceOverlayLayoutView, VoiceOverlayError> {
    layout_view(&state)
}

#[tauri::command]
pub fn overlay_get_snapshot(
    state: State<'_, VoiceOverlayState>,
) -> Result<VoiceOverlaySnapshot, VoiceOverlayError> {
    Ok(state.snapshot.lock().map_err(state_poisoned)?.clone())
}

#[tauri::command]
pub fn overlay_update_snapshot(
    app: AppHandle,
    state: State<'_, VoiceOverlayState>,
    snapshot: VoiceOverlaySnapshot,
) -> Result<(), VoiceOverlayError> {
    let changed = replace_overlay_snapshot(&state, &snapshot)?;
    if changed {
        if let Some(window) = app.get_webview_window(VOICE_OVERLAY_LABEL) {
            let _ = window.emit(VOICE_OVERLAY_EVENT, snapshot);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn overlay_action(app: AppHandle, action: VoiceOverlayAction) -> Result<(), VoiceOverlayError> {
    app.emit_to("main", VOICE_OVERLAY_ACTION_EVENT, action)
        .map_err(|err| VoiceOverlayError::Window {
            message: err.to_string(),
        })
}

fn replace_overlay_snapshot(
    state: &VoiceOverlayState,
    snapshot: &VoiceOverlaySnapshot,
) -> Result<bool, VoiceOverlayError> {
    let mut current = state.snapshot.lock().map_err(state_poisoned)?;
    if *current == *snapshot {
        return Ok(false);
    }
    *current = snapshot.clone();
    Ok(true)
}

fn overlay_supported() -> bool {
    cfg!(windows)
}

fn apply_settings_patch(
    current: &VoiceOverlaySettings,
    patch: VoiceOverlaySettingsPatch,
) -> VoiceOverlaySettings {
    let mut next = current.clone();
    if let Some(enabled) = patch.enabled {
        next.enabled = enabled;
    }
    if let Some(hotkey) = patch.hotkey {
        let trimmed = hotkey.trim();
        next.hotkey = if trimmed.is_empty() {
            DEFAULT_OVERLAY_HOTKEY.to_string()
        } else {
            trimmed.to_string()
        };
    }
    if let Some(shape) = patch.shape {
        next.shape = shape;
    }
    if let Some(size) = patch.size {
        next.size = size;
    }
    if let Some(interact) = patch.interact {
        next.interact = interact;
    }
    if let Some(names) = patch.names {
        next.names = names;
    }
    if let Some(background) = patch.background {
        next.background = background;
    }
    if let Some(view) = patch.view {
        next.view = view;
    }
    if let Some(linger_seconds) = patch.linger_seconds {
        next.linger_seconds = normalize_linger(linger_seconds);
    }
    if let Some(quiet_fade) = patch.quiet_fade {
        next.quiet_fade = quiet_fade;
    }
    if let Some(muted_hint) = patch.muted_hint {
        next.muted_hint = muted_hint;
    }
    if let Some(value) = patch.show_weak_connections {
        next.show_weak_connections = value;
    }
    if let Some(value) = patch.show_joins_and_leaves {
        next.show_joins_and_leaves = value;
    }
    if let Some(value) = patch.show_knocks {
        next.show_knocks = value;
    }
    if let Some(value) = patch.show_messages {
        next.show_messages = value;
    }
    if let Some(value) = patch.show_on_join {
        next.show_on_join = value;
    }
    if let Some(buttons) = patch.overlay_buttons {
        next.overlay_buttons = buttons;
    }
    if let Some(value) = patch.scroll_volume {
        next.scroll_volume = value;
    }
    next
}

fn settings_view(
    state: &VoiceOverlayState,
    settings: &VoiceOverlaySettings,
) -> Result<VoiceOverlaySettingsView, VoiceOverlayError> {
    let supported = overlay_supported();
    Ok(VoiceOverlaySettingsView {
        supported,
        enabled: supported && settings.enabled,
        hotkey: settings.hotkey.clone(),
        shape: settings.shape,
        effective_shape: resolved_shape(settings.shape, settings.anchor.as_ref()),
        size: settings.size,
        interact: settings.interact,
        names: settings.names,
        background: settings.background,
        view: settings.view,
        linger_seconds: settings.linger_seconds,
        quiet_fade: settings.quiet_fade,
        muted_hint: settings.muted_hint,
        show_weak_connections: settings.show_weak_connections,
        show_joins_and_leaves: settings.show_joins_and_leaves,
        show_knocks: settings.show_knocks,
        show_messages: settings.show_messages,
        show_on_join: settings.show_on_join,
        overlay_buttons: settings.overlay_buttons,
        scroll_volume: settings.scroll_volume,
        registration_error: state
            .registration_error
            .lock()
            .map_err(state_poisoned)?
            .clone(),
    })
}

fn layout_view(state: &VoiceOverlayState) -> Result<VoiceOverlayLayoutView, VoiceOverlayError> {
    let settings = state.settings.lock().map_err(state_poisoned)?.clone();
    let window_state = state.window.lock().map_err(state_poisoned)?;
    let (max_card_width, max_card_height) = if window_state.max_card.0 > 0.0 {
        window_state.max_card
    } else {
        (640.0, 480.0)
    };
    Ok(VoiceOverlayLayoutView {
        shape: resolved_shape(settings.shape, settings.anchor.as_ref()),
        size: settings.size,
        interact: settings.interact,
        interactive: window_state.interactive,
        anchor_corner: settings
            .anchor
            .as_ref()
            .map(|anchor| anchor.corner)
            .unwrap_or_default(),
        max_card_width,
        max_card_height,
    })
}

/// Every window hears it: the main window stops sending snapshots while the overlay is
/// off, and the overlay window may not exist yet when it is turned on.
fn emit_settings(app: &AppHandle, view: &VoiceOverlaySettingsView) {
    let _ = app.emit(VOICE_OVERLAY_SETTINGS_EVENT, view.clone());
}

fn emit_layout(app: &AppHandle) {
    let state = app.state::<VoiceOverlayState>();
    let Ok(view) = layout_view(&state) else {
        return;
    };
    if let Some(window) = app.get_webview_window(VOICE_OVERLAY_LABEL) {
        let _ = window.emit(VOICE_OVERLAY_LAYOUT_EVENT, view);
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, VoiceOverlayError> {
    Ok(app.path().app_data_dir()?.join(SETTINGS_FILE_NAME))
}

fn save_settings(
    app: &AppHandle,
    settings: &VoiceOverlaySettings,
) -> Result<(), VoiceOverlayError> {
    let path = settings_path(app)?;
    save_settings_to_path(&path, settings)
}

fn load_settings_from_path(path: &Path) -> VoiceOverlaySettings {
    match fs::read_to_string(path) {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => VoiceOverlaySettings::default(),
        Err(_) => VoiceOverlaySettings::default(),
    }
}

fn save_settings_to_path(
    path: &Path,
    settings: &VoiceOverlaySettings,
) -> Result<(), VoiceOverlayError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    let contents = serde_json::to_string_pretty(settings).map_err(|err| VoiceOverlayError::Io {
        message: err.to_string(),
    })?;
    fs::write(path, contents).map_err(io_error)
}

fn toggle_overlay_window(
    app: &AppHandle,
    force_visible: Option<bool>,
) -> Result<bool, VoiceOverlayError> {
    let state = app.state::<VoiceOverlayState>();
    let settings = state.settings.lock().map_err(state_poisoned)?.clone();
    let window = ensure_overlay_window(app, &settings)?;
    let should_show = match force_visible {
        Some(visible) => visible,
        None => !native::is_visible(&window),
    };

    if should_show {
        place_overlay_window(app, &window)?;
        native::show(&window);
    } else {
        set_interactive(app, false)?;
        native::hide(&window);
    }

    Ok(should_show)
}

fn hide_existing_overlay_window(app: &AppHandle) -> Result<(), VoiceOverlayError> {
    if let Some(window) = app.get_webview_window(VOICE_OVERLAY_LABEL) {
        set_interactive(app, false)?;
        native::hide(&window);
    }
    Ok(())
}

fn ensure_overlay_window(
    app: &AppHandle,
    _settings: &VoiceOverlaySettings,
) -> Result<WebviewWindow, VoiceOverlayError> {
    if let Some(window) = app.get_webview_window(VOICE_OVERLAY_LABEL) {
        return Ok(window);
    }

    // Never focusable: clicking the overlay must leave the keyboard and mouse with the
    // game. Showing, hiding and click-through then go through `native`, because the
    // window library's own setters re-show the window in a way that can activate it.
    let window = WebviewWindowBuilder::new(
        app,
        VOICE_OVERLAY_LABEL,
        WebviewUrl::App("/#/overlay".into()),
    )
    .title("Raven Voice Overlay")
    .inner_size(INITIAL_CONTENT_SIZE.0, INITIAL_CONTENT_SIZE.1)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .shadow(false)
    .focusable(false)
    .focused(false)
    .visible(false)
    .build()
    .map_err(window_error)?;

    {
        let state = app.state::<VoiceOverlayState>();
        let mut window_state = state.window.lock().map_err(state_poisoned)?;
        window_state.hwnd = native::handle(&window);
        window_state.interactive = false;
    }
    native::set_click_through(&window, true);
    place_overlay_window(app, &window)?;
    Ok(window)
}

/// Size the window to the card and put it at its anchor.
fn place_overlay_window(app: &AppHandle, window: &WebviewWindow) -> Result<(), VoiceOverlayError> {
    let state = app.state::<VoiceOverlayState>();
    let mut settings = state.settings.lock().map_err(state_poisoned)?.clone();
    let monitors = window.available_monitors().map_err(window_error)?;
    if monitors.is_empty() {
        return Ok(());
    }

    // An overlay saved before anchors is anchored where it was, top-left.
    if settings.anchor.is_none() {
        if let Some(legacy) = settings.legacy_position {
            let point = (legacy.x, legacy.y);
            let monitor = monitor_containing(&monitors, point).unwrap_or(&monitors[0]);
            let area = work_area(monitor);
            let anchor = VoiceOverlayAnchor {
                monitor: monitor.name().cloned(),
                corner: VoiceOverlayCorner::TopLeft,
                dx: (legacy.x - area.left).max(0),
                dy: (legacy.y - area.top).max(0),
                snapped_side: false,
                snapped_end: false,
            };
            let mut stored = state.settings.lock().map_err(state_poisoned)?;
            stored.anchor = Some(anchor.clone());
            stored.legacy_position = None;
            settings = stored.clone();
            drop(stored);
            let _ = save_settings(app, &settings);
        }
    }

    let monitor = settings
        .anchor
        .as_ref()
        .and_then(|anchor| anchor.monitor.as_ref())
        .and_then(|name| monitors.iter().find(|monitor| monitor.name() == Some(name)))
        .or_else(|| primary_monitor(window, &monitors))
        .unwrap_or(&monitors[0]);
    let area = work_area(monitor);
    let scale = monitor.scale_factor().max(0.5);
    let anchor = settings.anchor.clone().unwrap_or(VoiceOverlayAnchor {
        monitor: None,
        corner: VoiceOverlayCorner::TopLeft,
        dx: DEFAULT_MONITOR_OFFSET,
        dy: DEFAULT_MONITOR_OFFSET,
        snapped_side: false,
        snapped_end: false,
    });

    let (max_card, content) = {
        let mut window_state = state.window.lock().map_err(state_poisoned)?;
        let max_card = max_card_size(settings.size, area, scale);
        let changed = window_state.max_card != max_card || window_state.scale != scale;
        window_state.max_card = max_card;
        window_state.scale = scale;
        (changed.then_some(max_card), window_state.content)
    };
    let (css_width, css_height) = content
        .map(|content| (content.width, content.height))
        .unwrap_or(INITIAL_CONTENT_SIZE);
    let width = ((css_width * scale).ceil() as i32).clamp(1, area.width().max(1));
    let height = ((css_height * scale).ceil() as i32).clamp(1, area.height().max(1));
    let rect = window_rect_for_anchor(&anchor, area, width, height);
    native::set_rect(window, rect);
    if max_card.is_some() {
        emit_layout(app);
    }
    Ok(())
}

fn primary_monitor<'a>(
    window: &WebviewWindow,
    monitors: &'a [tauri::Monitor],
) -> Option<&'a tauri::Monitor> {
    let primary = window.primary_monitor().ok().flatten()?;
    monitors
        .iter()
        .find(|monitor| monitor.name() == primary.name() && monitor.position() == primary.position())
}

fn current_window_rect(window: &WebviewWindow) -> Option<ScreenRect> {
    let position = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    Some(ScreenRect {
        left: position.x,
        top: position.y,
        right: position.x + size.width as i32,
        bottom: position.y + size.height as i32,
    })
}

fn monitor_containing(monitors: &[tauri::Monitor], point: (i32, i32)) -> Option<&tauri::Monitor> {
    monitors
        .iter()
        .find(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            point.0 >= position.x
                && point.0 < position.x + size.width as i32
                && point.1 >= position.y
                && point.1 < position.y + size.height as i32
        })
        .or_else(|| monitors.first())
}

fn work_area(monitor: &tauri::Monitor) -> ScreenRect {
    let area = monitor.work_area();
    ScreenRect {
        left: area.position.x,
        top: area.position.y,
        right: area.position.x + area.size.width as i32,
        bottom: area.position.y + area.size.height as i32,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ScreenRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

impl ScreenRect {
    fn width(self) -> i32 {
        self.right - self.left
    }

    fn height(self) -> i32 {
        self.bottom - self.top
    }

    fn center(self) -> (i32, i32) {
        (self.left + self.width() / 2, self.top + self.height() / 2)
    }

    #[cfg_attr(not(windows), allow(dead_code))]
    fn contains(self, point: (i32, i32)) -> bool {
        point.0 >= self.left && point.0 < self.right && point.1 >= self.top && point.1 < self.bottom
    }
}

/// The window's rectangle for a size, measured from its anchor corner and kept inside the
/// work area.
fn window_rect_for_anchor(
    anchor: &VoiceOverlayAnchor,
    area: ScreenRect,
    width: i32,
    height: i32,
) -> ScreenRect {
    let left = if anchor.corner.is_left() {
        area.left + anchor.dx
    } else {
        area.right - anchor.dx - width
    };
    let top = if anchor.corner.is_top() {
        area.top + anchor.dy
    } else {
        area.bottom - anchor.dy - height
    };
    let left = left.clamp(area.left, (area.right - width).max(area.left));
    let top = top.clamp(area.top, (area.bottom - height).max(area.top));
    ScreenRect {
        left,
        top,
        right: left + width,
        bottom: top + height,
    }
}

/// Where a window dropped at `rect` is anchored: the nearer side and end of the work
/// area, pulled onto an edge that's within `SNAP_DISTANCE`.
fn anchor_from_rect(rect: ScreenRect, area: ScreenRect, monitor: Option<String>) -> VoiceOverlayAnchor {
    let to_left = rect.left - area.left;
    let to_right = area.right - rect.right;
    let to_top = rect.top - area.top;
    let to_bottom = area.bottom - rect.bottom;
    let left = to_left <= to_right;
    let top = to_top <= to_bottom;
    let dx = if left { to_left } else { to_right };
    let dy = if top { to_top } else { to_bottom };
    let snapped_side = dx <= SNAP_DISTANCE;
    let snapped_end = dy <= SNAP_DISTANCE;
    VoiceOverlayAnchor {
        monitor,
        corner: VoiceOverlayCorner::from_sides(left, top),
        dx: if snapped_side { SNAP_MARGIN } else { dx.max(0) },
        dy: if snapped_end { SNAP_MARGIN } else { dy.max(0) },
        snapped_side,
        snapped_end,
    }
}

/// With Follow edge, a row along the top or bottom edge and a column everywhere else,
/// corners included.
fn resolved_shape(
    shape: VoiceOverlayShape,
    anchor: Option<&VoiceOverlayAnchor>,
) -> VoiceOverlayResolvedShape {
    match shape {
        VoiceOverlayShape::Column => VoiceOverlayResolvedShape::Column,
        VoiceOverlayShape::Row => VoiceOverlayResolvedShape::Row,
        VoiceOverlayShape::FollowEdge => match anchor {
            Some(anchor) if anchor.snapped_end && !anchor.snapped_side => {
                VoiceOverlayResolvedShape::Row
            }
            _ => VoiceOverlayResolvedShape::Column,
        },
    }
}

/// The largest card for a work area, in CSS px. Past it the card scrolls instead of
/// covering the game.
fn max_card_size(size: VoiceOverlaySize, area: ScreenRect, scale: f64) -> (f64, f64) {
    let height_share = match size {
        VoiceOverlaySize::Small => 0.4,
        VoiceOverlaySize::Medium => 0.5,
        VoiceOverlaySize::Large => 0.6,
    };
    let scale = scale.max(0.5);
    (
        (area.width() as f64 * MAX_CARD_WIDTH_SHARE / scale).floor(),
        (area.height() as f64 * height_share / scale).floor(),
    )
}

/// Turn click-through off (the user is pointing at or holding for the overlay) or back on.
fn set_interactive(app: &AppHandle, interactive: bool) -> Result<(), VoiceOverlayError> {
    let state = app.state::<VoiceOverlayState>();
    {
        let mut window_state = state.window.lock().map_err(state_poisoned)?;
        if window_state.interactive == interactive {
            return Ok(());
        }
        window_state.interactive = interactive;
    }
    if let Some(window) = app.get_webview_window(VOICE_OVERLAY_LABEL) {
        native::set_click_through(&window, !interactive);
        let _ = window.emit(VOICE_OVERLAY_INTERACTION_EVENT, VoiceOverlayInteraction { interactive });
    }
    Ok(())
}

#[cfg(windows)]
fn start_hover_poller(app: &AppHandle) {
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("raven-overlay-hover".into())
        .spawn(move || run_hover_poller(app));
    if let Err(err) = spawned {
        eprintln!("[raven] voice overlay hover watcher failed to start: {err}");
    }
}

#[cfg(not(windows))]
fn start_hover_poller(_app: &AppHandle) {}

/// A click-through window gets no mouse events, so "When I point at it" is watched from
/// here: the cursor's position against the card, a few dozen times a second while the
/// overlay is showing.
#[cfg(windows)]
fn run_hover_poller(app: AppHandle) {
    use std::time::Instant;

    let mut inside_since: Option<Instant> = None;
    let mut outside_since: Option<Instant> = None;
    loop {
        let state = app.state::<VoiceOverlayState>();
        let mode = state.settings.lock().map(|settings| settings.interact).ok();
        let window = state.window.lock().ok().map(|window_state| {
            (
                window_state.hwnd,
                window_state.content,
                window_state.scale,
                window_state.interactive,
                window_state.hold.holding,
            )
        });
        let Some((Some(hwnd), Some(content), scale, interactive, holding)) = window else {
            std::thread::sleep(HOVER_IDLE_INTERVAL);
            continue;
        };
        if mode != Some(VoiceOverlayInteract::Hover) || holding || !native::hwnd_visible(hwnd) {
            inside_since = None;
            outside_since = None;
            std::thread::sleep(HOVER_IDLE_INTERVAL);
            continue;
        }

        let card = native::window_rect(hwnd).map(|rect| ScreenRect {
            left: rect.left + (content.card.x * scale).floor() as i32,
            top: rect.top + (content.card.y * scale).floor() as i32,
            right: rect.left + ((content.card.x + content.card.width) * scale).ceil() as i32,
            bottom: rect.top + ((content.card.y + content.card.height) * scale).ceil() as i32,
        });
        let inside = match (card, native::cursor_position()) {
            (Some(card), Some(cursor)) => card.contains(cursor),
            _ => false,
        };
        let now = Instant::now();
        if inside {
            outside_since = None;
            // Never open in the middle of a press: a drag that started in the game (a
            // selection box, a camera pan) must end in the game.
            if native::mouse_button_down() && !interactive {
                inside_since = None;
            } else {
                let since = *inside_since.get_or_insert(now);
                if !interactive && now.duration_since(since) >= HOVER_ENTER_DELAY {
                    let _ = set_interactive(&app, true);
                }
            }
        } else {
            inside_since = None;
            if interactive {
                let since = *outside_since.get_or_insert(now);
                if now.duration_since(since) >= HOVER_LEAVE_DELAY && !native::mouse_button_down() {
                    let _ = set_interactive(&app, false);
                    outside_since = None;
                }
            } else {
                outside_since = None;
            }
        }
        std::thread::sleep(HOVER_POLL_INTERVAL);
    }
}

#[cfg(windows)]
fn handle_overlay_hotkey(app: &AppHandle, pressed: bool) {
    let state = app.state::<VoiceOverlayState>();
    let Ok(interact) = state.settings.lock().map(|settings| settings.interact) else {
        return;
    };

    if pressed {
        if interact != VoiceOverlayInteract::Hold {
            if let Err(err) = toggle_overlay_window(app, None) {
                eprintln!("[raven] voice overlay toggle failed: {err}");
            }
            return;
        }
        let generation = {
            let Ok(mut window_state) = state.window.lock() else {
                return;
            };
            window_state.hold.generation = window_state.hold.generation.wrapping_add(1);
            window_state.hold.pressed = true;
            window_state.hold.holding = false;
            window_state.hold.generation
        };
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(HOLD_THRESHOLD);
            begin_hold(&app, generation);
        });
        return;
    }

    let (was_pressed, was_holding, hide_after) = {
        let Ok(mut window_state) = state.window.lock() else {
            return;
        };
        let hold = &mut window_state.hold;
        let result = (hold.pressed, hold.holding, hold.hide_after);
        hold.pressed = false;
        hold.holding = false;
        hold.hide_after = false;
        result
    };
    if was_holding {
        let _ = set_interactive(app, false);
        if hide_after {
            if let Err(err) = hide_existing_overlay_window(app) {
                eprintln!("[raven] voice overlay hide failed: {err}");
            }
        }
    } else if was_pressed && interact == VoiceOverlayInteract::Hold {
        if let Err(err) = toggle_overlay_window(app, None) {
            eprintln!("[raven] voice overlay toggle failed: {err}");
        }
    }
}

/// The overlay key is still down after the tap threshold: show the overlay if needed and
/// let it take clicks until the key comes up.
#[cfg(windows)]
fn begin_hold(app: &AppHandle, generation: u64) {
    let state = app.state::<VoiceOverlayState>();
    let visible = app
        .get_webview_window(VOICE_OVERLAY_LABEL)
        .map(|window| native::is_visible(&window))
        .unwrap_or(false);
    {
        let Ok(mut window_state) = state.window.lock() else {
            return;
        };
        let hold = &mut window_state.hold;
        if hold.generation != generation || !hold.pressed {
            return;
        }
        hold.holding = true;
        hold.hide_after = !visible;
    }
    if !visible {
        if let Err(err) = toggle_overlay_window(app, Some(true)) {
            eprintln!("[raven] voice overlay show failed: {err}");
            return;
        }
    }
    let _ = set_interactive(app, true);
}

#[cfg(windows)]
fn reconcile_hotkey_registration(
    app: &AppHandle,
    state: &VoiceOverlayState,
    settings: &VoiceOverlaySettings,
) -> Result<(), VoiceOverlayError> {
    let current = state
        .registered_hotkey
        .lock()
        .map_err(state_poisoned)?
        .clone();
    let desired = settings.enabled.then(|| settings.hotkey.clone());
    if current == desired {
        set_registration_error(state, None)?;
        return Ok(());
    }

    if let Some(current_hotkey) = current.as_deref() {
        if let Err(err) = unregister_hotkey(app, current_hotkey) {
            set_registration_error(state, Some(err.to_string()))?;
            return Err(err);
        }
    }

    if let Some(desired_hotkey) = desired.as_deref() {
        if let Err(err) = register_hotkey(app, desired_hotkey) {
            if let Some(current_hotkey) = current.as_deref() {
                let _ = register_hotkey(app, current_hotkey);
            }
            *state.registered_hotkey.lock().map_err(state_poisoned)? = current;
            return Err(err);
        }
    }

    *state.registered_hotkey.lock().map_err(state_poisoned)? = desired;
    set_registration_error(state, None)
}

#[cfg(not(windows))]
fn reconcile_hotkey_registration(
    _app: &AppHandle,
    state: &VoiceOverlayState,
    _settings: &VoiceOverlaySettings,
) -> Result<(), VoiceOverlayError> {
    clear_registered_hotkey(state)
}

#[cfg(windows)]
fn register_hotkey(app: &AppHandle, hotkey: &str) -> Result<(), VoiceOverlayError> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    app.global_shortcut()
        .on_shortcut(hotkey, |app, _shortcut, event| {
            handle_overlay_hotkey(app, event.state == ShortcutState::Pressed);
        })
        .map_err(|err| VoiceOverlayError::Shortcut {
            message: crate::media_hotkeys::refused_hotkey_message(hotkey, &err.to_string()),
        })
}

#[cfg(windows)]
fn unregister_hotkey(app: &AppHandle, hotkey: &str) -> Result<(), VoiceOverlayError> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    app.global_shortcut()
        .unregister(hotkey)
        .map_err(shortcut_error)
}

fn clear_registered_hotkey(state: &VoiceOverlayState) -> Result<(), VoiceOverlayError> {
    *state.registered_hotkey.lock().map_err(state_poisoned)? = None;
    set_registration_error(state, None)
}

fn set_registration_error(
    state: &VoiceOverlayState,
    error: Option<String>,
) -> Result<(), VoiceOverlayError> {
    *state.registration_error.lock().map_err(state_poisoned)? = error;
    Ok(())
}

/// The overlay window's visibility, size and click-through, done directly so none of it
/// activates the window. The window library's setters re-show the window with
/// `SW_SHOW` whenever one of its flags changes, which can take focus from the game.
#[cfg(windows)]
mod native {
    use std::ffi::c_void;

    use tauri::WebviewWindow;
    use windows::Win32::{
        Foundation::{HWND, POINT, RECT},
        UI::{
            Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_MBUTTON, VK_RBUTTON},
            WindowsAndMessaging::{
                GetCursorPos, GetWindowLongPtrW, GetWindowRect, IsWindowVisible, SetWindowLongPtrW,
                SetWindowPos, ShowWindow, GWL_EXSTYLE, HWND_TOPMOST, SWP_FRAMECHANGED,
                SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SW_HIDE, SW_SHOWNOACTIVATE,
                WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TRANSPARENT,
            },
        },
    };

    use super::ScreenRect;

    pub fn handle(window: &WebviewWindow) -> Option<isize> {
        window.hwnd().ok().map(|hwnd| hwnd.0 as isize)
    }

    fn hwnd(window: &WebviewWindow) -> Option<HWND> {
        handle(window).map(from_handle)
    }

    fn from_handle(handle: isize) -> HWND {
        HWND(handle as *mut c_void)
    }

    pub fn show(window: &WebviewWindow) {
        let Some(hwnd) = hwnd(window) else {
            return;
        };
        unsafe {
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            let _ = SetWindowPos(
                hwnd,
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
        }
    }

    pub fn hide(window: &WebviewWindow) {
        if let Some(hwnd) = hwnd(window) {
            unsafe {
                let _ = ShowWindow(hwnd, SW_HIDE);
            }
        }
    }

    pub fn is_visible(window: &WebviewWindow) -> bool {
        hwnd(window).is_some_and(|hwnd| unsafe { IsWindowVisible(hwnd).as_bool() })
    }

    pub fn hwnd_visible(handle: isize) -> bool {
        unsafe { IsWindowVisible(from_handle(handle)).as_bool() }
    }

    pub fn set_click_through(window: &WebviewWindow, click_through: bool) {
        let Some(hwnd) = hwnd(window) else {
            return;
        };
        unsafe {
            let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let through = (WS_EX_TRANSPARENT.0 | WS_EX_LAYERED.0) as isize;
            let next = if click_through {
                style | through
            } else {
                style & !through
            } | WS_EX_NOACTIVATE.0 as isize;
            if next != style {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);
                let _ = SetWindowPos(
                    hwnd,
                    HWND::default(),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
                );
            }
        }
    }

    pub fn set_rect(window: &WebviewWindow, rect: ScreenRect) {
        let Some(hwnd) = hwnd(window) else {
            return;
        };
        unsafe {
            let _ = SetWindowPos(
                hwnd,
                HWND::default(),
                rect.left,
                rect.top,
                rect.width(),
                rect.height(),
                SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }
    }

    pub fn window_rect(handle: isize) -> Option<ScreenRect> {
        let mut rect = RECT::default();
        unsafe { GetWindowRect(from_handle(handle), &mut rect) }.ok()?;
        Some(ScreenRect {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
        })
    }

    pub fn cursor_position() -> Option<(i32, i32)> {
        let mut point = POINT::default();
        unsafe { GetCursorPos(&mut point) }.ok()?;
        Some((point.x, point.y))
    }

    /// Move the window with the cursor while the primary button is held. The button's state
    /// comes from two places: Windows, and the card's own `released`. A game running as
    /// administrator hides the button from `GetAsyncKeyState`, so that alone would end
    /// the drag before it starts; the card's pointer events still arrive.
    pub fn follow_cursor_while_pressed(
        handle: isize,
        timeout: std::time::Duration,
        released: impl Fn() -> bool,
    ) {
        let hwnd = from_handle(handle);
        let (Some(start_cursor), Some(start)) = (cursor_position(), window_rect(handle)) else {
            return;
        };
        let started = std::time::Instant::now();
        let mut last = start_cursor;
        let mut seen_down = false;
        while !released() && started.elapsed() < timeout {
            let down = unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) } < 0;
            if down {
                seen_down = true;
            } else if seen_down {
                break;
            }
            if let Some(cursor) = cursor_position() {
                if cursor != last {
                    last = cursor;
                    unsafe {
                        let _ = SetWindowPos(
                            hwnd,
                            HWND::default(),
                            start.left + cursor.0 - start_cursor.0,
                            start.top + cursor.1 - start_cursor.1,
                            0,
                            0,
                            SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
                        );
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(8));
        }
    }

    pub fn mouse_button_down() -> bool {
        [VK_LBUTTON, VK_RBUTTON, VK_MBUTTON]
            .iter()
            .any(|key| unsafe { GetAsyncKeyState(key.0 as i32) } < 0)
    }
}

/// The overlay only exists on Windows; elsewhere these keep the shared code compiling.
#[cfg(not(windows))]
mod native {
    use tauri::WebviewWindow;

    use super::ScreenRect;

    pub fn handle(_window: &WebviewWindow) -> Option<isize> {
        None
    }

    pub fn show(window: &WebviewWindow) {
        let _ = window.show();
    }

    pub fn hide(window: &WebviewWindow) {
        let _ = window.hide();
    }

    pub fn is_visible(window: &WebviewWindow) -> bool {
        window.is_visible().unwrap_or(false)
    }

    pub fn set_click_through(window: &WebviewWindow, click_through: bool) {
        let _ = window.set_ignore_cursor_events(click_through);
    }

    pub fn set_rect(window: &WebviewWindow, rect: ScreenRect) {
        let _ = window.set_position(tauri::PhysicalPosition::new(rect.left, rect.top));
        let _ = window.set_size(tauri::PhysicalSize::new(
            rect.width().max(1) as u32,
            rect.height().max(1) as u32,
        ));
    }
}

fn state_poisoned<T>(_err: PoisonError<T>) -> VoiceOverlayError {
    VoiceOverlayError::StatePoisoned
}

fn io_error(err: std::io::Error) -> VoiceOverlayError {
    VoiceOverlayError::Io {
        message: err.to_string(),
    }
}

fn window_error(err: tauri::Error) -> VoiceOverlayError {
    VoiceOverlayError::Window {
        message: err.to_string(),
    }
}

#[cfg(windows)]
fn shortcut_error(err: tauri_plugin_global_shortcut::Error) -> VoiceOverlayError {
    VoiceOverlayError::Shortcut {
        message: err.to_string(),
    }
}

impl From<tauri::Error> for VoiceOverlayError {
    fn from(value: tauri::Error) -> Self {
        VoiceOverlayError::Window {
            message: value.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    const AREA: ScreenRect = ScreenRect {
        left: 0,
        top: 0,
        right: 1920,
        bottom: 1040,
    };

    #[test]
    fn settings_defaults_when_missing() {
        let path = temp_settings_path("missing");
        let _ = fs::remove_file(&path);

        let settings = load_settings_from_path(&path);

        assert_eq!(settings, VoiceOverlaySettings::default());
        assert_eq!(settings.shape, VoiceOverlayShape::FollowEdge);
        assert_eq!(settings.interact, VoiceOverlayInteract::Hover);
        assert_eq!(settings.size, VoiceOverlaySize::Medium);
    }

    #[test]
    fn settings_round_trip() {
        let path = temp_settings_path("round-trip");
        let settings = VoiceOverlaySettings {
            enabled: false,
            hotkey: "Control+Alt+O".to_string(),
            shape: VoiceOverlayShape::Row,
            size: VoiceOverlaySize::Large,
            interact: VoiceOverlayInteract::Hold,
            names: VoiceOverlayNames::WhileTalking,
            background: VoiceOverlayNameBackground::Strong,
            view: VoiceOverlayView::TalkersFirst,
            linger_seconds: 6,
            quiet_fade: VoiceOverlayQuietFade::Lots,
            muted_hint: false,
            show_weak_connections: false,
            show_joins_and_leaves: false,
            show_knocks: false,
            show_messages: VoiceOverlayMessages::Tree,
            show_on_join: true,
            overlay_buttons: VoiceOverlayButtons {
                mute: true,
                deafen: false,
                away: true,
            },
            scroll_volume: false,
            anchor: Some(VoiceOverlayAnchor {
                monitor: Some("\\\\.\\DISPLAY2".to_string()),
                corner: VoiceOverlayCorner::BottomRight,
                dx: 12,
                dy: 40,
                snapped_side: true,
                snapped_end: false,
            }),
            legacy_position: None,
        };

        save_settings_to_path(&path, &settings).expect("settings should save");
        let written = fs::read_to_string(&path).expect("settings file");
        let loaded = load_settings_from_path(&path);

        assert_eq!(loaded, settings);
        assert!(!written.contains("\"layout\""));
        assert!(!written.contains("\"position\""));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn legacy_settings_receive_overlay_display_defaults() {
        let settings: VoiceOverlaySettings =
            serde_json::from_str(r#"{"enabled":false,"hotkey":"Alt+F9","position":{"x":4,"y":5}}"#)
                .expect("legacy settings should deserialize");

        // No saved layout: a pre-anchor install that never chose one follows the edge.
        assert_eq!(settings.shape, VoiceOverlayShape::FollowEdge);
        assert_eq!(settings.names, VoiceOverlayNames::Always);
        assert_eq!(settings.background, VoiceOverlayNameBackground::Light);
        assert_eq!(settings.view, VoiceOverlayView::Everyone);
        assert_eq!(settings.linger_seconds, 3);
        assert_eq!(settings.quiet_fade, VoiceOverlayQuietFade::None);
        assert!(settings.muted_hint && settings.show_weak_connections && settings.show_joins_and_leaves);
        assert!(!settings.show_on_join);
        assert!(settings.show_knocks);
        assert_eq!(settings.show_messages, VoiceOverlayMessages::Off);
        assert_eq!(settings.overlay_buttons, VoiceOverlayButtons::default());
        assert!(settings.scroll_volume);
        assert_eq!(settings.interact, VoiceOverlayInteract::Hover);
        assert_eq!(settings.anchor, None);
        assert_eq!(settings.legacy_position, Some(VoiceOverlayPosition { x: 4, y: 5 }));
    }

    #[test]
    fn legacy_layout_keeps_its_shape() {
        let strip: VoiceOverlaySettings = serde_json::from_str(
            r#"{"enabled":true,"hotkey":"Alt+F8","layout":"horizontal","showNames":true,"nameBackground":"strong","position":{"x":300,"y":20}}"#,
        )
        .expect("legacy strip settings should deserialize");
        assert_eq!(strip.shape, VoiceOverlayShape::Row);
        assert_eq!(strip.background, VoiceOverlayNameBackground::Strong);
        assert_eq!(strip.names, VoiceOverlayNames::Always);

        let hidden: VoiceOverlaySettings =
            serde_json::from_str(r#"{"showNames":false,"nameBackground":"off"}"#).expect("hidden names");
        assert_eq!(hidden.names, VoiceOverlayNames::Never);
        assert_eq!(hidden.background, VoiceOverlayNameBackground::Off);

        let odd: VoiceOverlaySettings =
            serde_json::from_str(r#"{"lingerSeconds":4}"#).expect("odd linger");
        assert_eq!(odd.linger_seconds, 3);
        assert_eq!(strip.legacy_position, Some(VoiceOverlayPosition { x: 300, y: 20 }));

        let list: VoiceOverlaySettings =
            serde_json::from_str(r#"{"layout":"vertical"}"#).expect("legacy list settings");
        assert_eq!(list.shape, VoiceOverlayShape::Column);
    }

    #[test]
    fn participant_speaking_level_is_backward_compatible() {
        let legacy: VoiceOverlayParticipant =
            serde_json::from_str(r#"{"userId":"person","displayName":"Person","speaking":true}"#)
                .expect("legacy participant should deserialize");
        assert_eq!(legacy.speaking_level, 0);

        let current: VoiceOverlayParticipant = serde_json::from_str(
            r#"{"userId":"person","displayName":"Person","speaking":true,"speakingLevel":73}"#,
        )
        .expect("current participant should deserialize");
        assert_eq!(current.speaking_level, 73);
    }

    #[test]
    fn call_state_fields_survive_the_snapshot_and_default_off() {
        let legacy: VoiceOverlaySnapshot = serde_json::from_str(
            r#"{"connected":true,"participants":[{"userId":"person","displayName":"Person"}]}"#,
        )
        .expect("a snapshot without call state should deserialize");
        assert!(!legacy.away_supported);
        assert!(!legacy.participants[0].away);

        let current: VoiceOverlaySnapshot = serde_json::from_str(
            r#"{"awaySupported":true,"participants":[{"userId":"person","away":true,"deafened":true}]}"#,
        )
        .expect("a snapshot with call state should deserialize");
        assert!(current.away_supported);
        assert!(current.participants[0].away && current.participants[0].deafened);
        let echoed = serde_json::to_value(&current).expect("snapshot should serialize");
        assert_eq!(echoed["awaySupported"], true);
        assert_eq!(echoed["participants"][0]["away"], true);
    }

    #[test]
    fn corrupt_settings_falls_back_to_defaults() {
        let path = temp_settings_path("corrupt");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("temp settings parent");
        }
        fs::write(&path, "{not-json").expect("corrupt settings write");

        let settings = load_settings_from_path(&path);

        assert_eq!(settings, VoiceOverlaySettings::default());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn patch_normalizes_empty_hotkey_to_default() {
        let settings = apply_settings_patch(
            &VoiceOverlaySettings {
                enabled: false,
                hotkey: "Alt+F9".to_string(),
                ..VoiceOverlaySettings::default()
            },
            VoiceOverlaySettingsPatch {
                enabled: Some(true),
                hotkey: Some("   ".to_string()),
                shape: Some(VoiceOverlayShape::Row),
                size: Some(VoiceOverlaySize::Small),
                interact: Some(VoiceOverlayInteract::Never),
                names: Some(VoiceOverlayNames::Never),
                background: Some(VoiceOverlayNameBackground::Off),
                view: Some(VoiceOverlayView::OnlyTalking),
                linger_seconds: Some(9),
                quiet_fade: Some(VoiceOverlayQuietFade::Some),
                muted_hint: Some(false),
                show_weak_connections: Some(false),
                show_joins_and_leaves: Some(false),
                show_knocks: Some(false),
                show_messages: Some(VoiceOverlayMessages::Tree),
                show_on_join: Some(true),
                overlay_buttons: Some(VoiceOverlayButtons {
                    mute: false,
                    deafen: true,
                    away: false,
                }),
                scroll_volume: Some(false),
            },
        );

        assert!(settings.enabled);
        assert_eq!(settings.hotkey, DEFAULT_OVERLAY_HOTKEY);
        assert_eq!(settings.shape, VoiceOverlayShape::Row);
        assert_eq!(settings.size, VoiceOverlaySize::Small);
        assert_eq!(settings.interact, VoiceOverlayInteract::Never);
        assert_eq!(settings.names, VoiceOverlayNames::Never);
        assert_eq!(settings.background, VoiceOverlayNameBackground::Off);
        assert_eq!(settings.view, VoiceOverlayView::OnlyTalking);
        assert_eq!(settings.linger_seconds, 3);
        assert_eq!(settings.quiet_fade, VoiceOverlayQuietFade::Some);
        assert!(!settings.muted_hint && !settings.show_weak_connections && !settings.show_joins_and_leaves);
        assert!(settings.show_on_join);
        assert!(!settings.show_knocks);
        assert_eq!(settings.show_messages, VoiceOverlayMessages::Tree);
        assert_eq!(
            settings.overlay_buttons,
            VoiceOverlayButtons {
                mute: false,
                deafen: true,
                away: false,
            }
        );
        assert!(!settings.scroll_volume);
    }

    #[test]
    fn card_actions_deserialize_from_the_overlay() {
        let mic: VoiceOverlayAction = serde_json::from_str(r#"{"kind":"mic"}"#).expect("mic");
        assert_eq!(mic, VoiceOverlayAction::Mic);
        let away: VoiceOverlayAction =
            serde_json::from_str(r#"{"kind":"away","away":true}"#).expect("away");
        assert_eq!(away, VoiceOverlayAction::Away { away: true });
        let volume: VoiceOverlayAction =
            serde_json::from_str(r#"{"kind":"volume","userId":"u_1","percent":120}"#).expect("volume");
        assert_eq!(
            volume,
            VoiceOverlayAction::Volume {
                user_id: "u_1".to_string(),
                percent: 120,
            }
        );
        let knock: VoiceOverlayAction =
            serde_json::from_str(r#"{"kind":"knock","knockId":"k_1","open":true}"#).expect("knock");
        assert_eq!(
            knock,
            VoiceOverlayAction::Knock {
                knock_id: "k_1".to_string(),
                open: true,
            }
        );
        let reply: VoiceOverlayAction = serde_json::from_str(
            r#"{"kind":"knockReply","knockId":"k_1","reply":"later","until":"2026-11-02T16:00:00.000Z"}"#,
        )
        .expect("knock reply");
        assert_eq!(
            reply,
            VoiceOverlayAction::KnockReply {
                knock_id: "k_1".to_string(),
                reply: "later".to_string(),
                until: Some("2026-11-02T16:00:00.000Z".to_string()),
            }
        );
        let coming: VoiceOverlayAction =
            serde_json::from_str(r#"{"kind":"knockReply","knockId":"k_1","reply":"coming"}"#).expect("coming");
        assert_eq!(
            coming,
            VoiceOverlayAction::KnockReply {
                knock_id: "k_1".to_string(),
                reply: "coming".to_string(),
                until: None,
            }
        );
    }

    #[test]
    fn heads_up_lines_round_trip_and_default_to_none() {
        let older: VoiceOverlaySnapshot =
            serde_json::from_str(r#"{"connected":true}"#).expect("snapshot without heads-up lines");
        assert!(older.heads_up.is_empty());

        let current: VoiceOverlaySnapshot = serde_json::from_str(
            r#"{"headsUp":[{"id":"k_1","kind":"knock","actorName":"Arash","avatarUrl":null,"text":"","at":"2026-10-29T10:00:00Z"},{"id":"m_1","kind":"message","actorName":"Mina","text":"in design: hi","at":"2026-10-29T10:00:01Z"}]}"#,
        )
        .expect("snapshot with heads-up lines");
        assert_eq!(current.heads_up[0].kind, VoiceOverlayHeadsUpKind::Knock);
        assert_eq!(current.heads_up[1].kind, VoiceOverlayHeadsUpKind::Message);
        let echoed = serde_json::to_value(&current).expect("snapshot should serialize");
        assert_eq!(echoed["headsUp"][1]["actorName"], "Mina");
        assert_eq!(echoed["headsUp"][0]["kind"], "knock");
    }

    #[test]
    fn messages_setting_is_off_unless_chosen() {
        let off: VoiceOverlaySettings = serde_json::from_str(r#"{"enabled":true}"#).expect("no messages key");
        assert_eq!(off.show_messages, VoiceOverlayMessages::Off);
        let tree: VoiceOverlaySettings =
            serde_json::from_str(r#"{"showMessages":"tree"}"#).expect("tree messages");
        assert_eq!(tree.show_messages, VoiceOverlayMessages::Tree);
    }

    #[test]
    fn snapshot_fields_default_for_older_senders() {
        let snapshot: VoiceOverlaySnapshot =
            serde_json::from_str(r#"{"connected":true,"participants":[{"userId":"u_1"}]}"#)
                .expect("snapshot without the card's controls");

        assert!(!snapshot.away_supported);
        let participant = &snapshot.participants[0];
        assert!(!participant.away);
        assert_eq!(participant.volume_percent, 100);
    }

    #[test]
    fn partial_button_settings_keep_the_other_buttons_on() {
        let settings: VoiceOverlaySettings =
            serde_json::from_str(r#"{"enabled":true,"hotkey":"Alt+F8","overlayButtons":{"mute":false}}"#)
                .expect("partial button settings should deserialize");

        assert_eq!(
            settings.overlay_buttons,
            VoiceOverlayButtons {
                mute: false,
                deafen: true,
                away: true,
            }
        );
        assert!(settings.scroll_volume);
    }

    #[test]
    fn snapshot_fields_from_older_builds_default() {
        let snapshot: VoiceOverlaySnapshot = serde_json::from_str(
            r#"{"nestId":"n","participants":[{"userId":"u","displayName":"U"}]}"#,
        )
        .expect("older snapshot");
        assert!(!snapshot.reconnecting && !snapshot.local_muted_hint);
        assert_eq!(
            snapshot.participants[0].connection_quality,
            VoiceOverlayConnectionQuality::Unknown
        );
        assert_eq!(snapshot.participants[0].joined_at, None);
    }

    #[test]
    fn window_grows_away_from_its_anchor_corner() {
        let anchor = VoiceOverlayAnchor {
            corner: VoiceOverlayCorner::BottomRight,
            dx: 12,
            dy: 12,
            ..VoiceOverlayAnchor::default()
        };
        let small = window_rect_for_anchor(&anchor, AREA, 200, 100);
        let large = window_rect_for_anchor(&anchor, AREA, 200, 300);
        assert_eq!((small.right, small.bottom), (1908, 1028));
        assert_eq!((large.right, large.bottom), (1908, 1028));
        assert_eq!(large.top, small.top - 200);

        let top_left = window_rect_for_anchor(&VoiceOverlayAnchor::default(), AREA, 200, 300);
        assert_eq!((top_left.left, top_left.top), (0, 0));
    }

    #[test]
    fn window_stays_inside_the_work_area() {
        let anchor = VoiceOverlayAnchor {
            corner: VoiceOverlayCorner::TopLeft,
            dx: 1900,
            dy: 1000,
            ..VoiceOverlayAnchor::default()
        };
        let rect = window_rect_for_anchor(&anchor, AREA, 300, 200);
        assert_eq!((rect.right, rect.bottom), (1920, 1040));
    }

    #[test]
    fn dropping_near_an_edge_snaps_to_it() {
        let near_top_right = ScreenRect {
            left: 1700,
            top: 18,
            right: 1900,
            bottom: 118,
        };
        let anchor = anchor_from_rect(near_top_right, AREA, None);
        assert_eq!(anchor.corner, VoiceOverlayCorner::TopRight);
        assert_eq!((anchor.dx, anchor.dy), (SNAP_MARGIN, SNAP_MARGIN));
        assert!(anchor.snapped_side && anchor.snapped_end);

        let floating = ScreenRect {
            left: 400,
            top: 300,
            right: 600,
            bottom: 400,
        };
        let anchor = anchor_from_rect(floating, AREA, None);
        assert_eq!(anchor.corner, VoiceOverlayCorner::TopLeft);
        assert_eq!((anchor.dx, anchor.dy), (400, 300));
        assert!(!anchor.snapped_side && !anchor.snapped_end);
    }

    #[test]
    fn follow_edge_is_a_row_only_along_the_top_or_bottom() {
        let along_bottom = anchor_from_rect(
            ScreenRect {
                left: 800,
                top: 950,
                right: 1100,
                bottom: 1030,
            },
            AREA,
            None,
        );
        assert_eq!(
            resolved_shape(VoiceOverlayShape::FollowEdge, Some(&along_bottom)),
            VoiceOverlayResolvedShape::Row
        );

        let in_corner = VoiceOverlayAnchor {
            snapped_side: true,
            snapped_end: true,
            ..VoiceOverlayAnchor::default()
        };
        assert_eq!(
            resolved_shape(VoiceOverlayShape::FollowEdge, Some(&in_corner)),
            VoiceOverlayResolvedShape::Column
        );
        assert_eq!(
            resolved_shape(VoiceOverlayShape::FollowEdge, None),
            VoiceOverlayResolvedShape::Column
        );
        assert_eq!(
            resolved_shape(VoiceOverlayShape::Row, Some(&in_corner)),
            VoiceOverlayResolvedShape::Row
        );
    }

    #[test]
    fn card_size_is_capped_per_size_setting() {
        let (width, height) = max_card_size(VoiceOverlaySize::Medium, AREA, 1.0);
        assert_eq!(width, 1728.0);
        assert_eq!(height, 520.0);
        let (_, large) = max_card_size(VoiceOverlaySize::Large, AREA, 2.0);
        assert_eq!(large, 312.0);
    }

    #[test]
    fn identical_snapshots_do_not_emit_work() {
        let state = new_voice_overlay_state();
        let snapshot = VoiceOverlaySnapshot::default();
        assert!(!replace_overlay_snapshot(&state, &snapshot).expect("snapshot comparison"));

        let changed = VoiceOverlaySnapshot {
            nest_id: Some("nest-1".to_string()),
            connected: true,
            ..VoiceOverlaySnapshot::default()
        };
        assert!(replace_overlay_snapshot(&state, &changed).expect("snapshot update"));
        assert!(!replace_overlay_snapshot(&state, &changed).expect("snapshot deduplication"));
    }

    fn temp_settings_path(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        std::env::temp_dir()
            .join("raven-overlay-tests")
            .join(format!("{name}-{nanos}.json"))
    }
}
