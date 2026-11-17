//! The MobileNative lifecycle and permission owner. It turns Android events into the
//! eligibility state engines read through `crate::media_eligibility`.

use std::sync::{Mutex, MutexGuard};

use raven_mobile_native::{
    MobileNativeEvent, PermissionKind, PermissionSnapshot, PermissionStatus,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use super::gate::MobileNativeGate;

pub const MOBILE_NATIVE_MEDIA_STATE: &str = "mobile-native-media-state";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileNativeSnapshot {
    pub foreground: bool,
    pub epoch: u64,
    pub call_active: bool,
    pub microphone: PermissionStatus,
    pub camera: PermissionStatus,
}

struct MobileNativeInner {
    gate: MobileNativeGate,
    permissions: PermissionSnapshot,
}

impl MobileNativeInner {
    fn snapshot(&self) -> MobileNativeSnapshot {
        MobileNativeSnapshot {
            foreground: self.gate.foreground,
            epoch: self.gate.epoch,
            call_active: self.gate.call_active,
            microphone: self.permissions.microphone.clone(),
            camera: self.permissions.camera.clone(),
        }
    }
}

pub struct MobileNativeMedia {
    /// Desired state. Never held across an await or a call into the plugin.
    state: Mutex<MobileNativeInner>,
    /// Serializes begin/end transitions, so a new call waits for a pending stop.
    transition: tokio::sync::Mutex<()>,
    /// Tauri Android passes callback 0 for every invoke and keeps one pending permission
    /// callback, so overlapping requests would leave the first one unresolved forever.
    /// `mobile_native_request_permission` holds this across the plugin call.
    permission_request: tokio::sync::Mutex<()>,
}

impl Default for MobileNativeMedia {
    fn default() -> Self {
        Self {
            state: Mutex::new(MobileNativeInner {
                gate: MobileNativeGate::default(),
                permissions: PermissionSnapshot {
                    microphone: PermissionStatus::NotRequested,
                    camera: PermissionStatus::NotRequested,
                },
            }),
            transition: tokio::sync::Mutex::new(()),
            permission_request: tokio::sync::Mutex::new(()),
        }
    }
}

impl MobileNativeMedia {
    fn lock(&self) -> Result<MutexGuard<'_, MobileNativeInner>, String> {
        self.state
            .lock()
            .map_err(|_| "MobileNative media state is unavailable.".into())
    }

    /// Reads fields under one lock without cloning the whole snapshot.
    fn read<T>(&self, read: impl FnOnce(&MobileNativeInner) -> T) -> Result<T, String> {
        self.lock().map(|inner| read(&inner))
    }

    pub fn snapshot(&self) -> Result<MobileNativeSnapshot, String> {
        self.read(MobileNativeInner::snapshot)
    }
}

pub fn audio_allowed(app: &AppHandle) -> bool {
    app.state::<MobileNativeMedia>()
        .read(|inner| inner.gate.audio_allowed())
        .unwrap_or(false)
}

/// The OS microphone permission, or `Denied` when the state cannot be read.
pub fn microphone_permission(app: &AppHandle) -> PermissionStatus {
    app.state::<MobileNativeMedia>()
        .read(|inner| inner.permissions.microphone.clone())
        .unwrap_or(PermissionStatus::Denied)
}

/// The open call's epoch. A call keeps running in the background, so this ignores the
/// foreground; only leaving for good ends it.
pub fn require_call(app: &AppHandle) -> Result<u64, String> {
    let (active, epoch) = app
        .state::<MobileNativeMedia>()
        .read(|inner| (inner.gate.call_active, inner.gate.epoch))?;
    if !active {
        return Err("This call has ended. Join again to continue.".into());
    }
    Ok(epoch)
}

pub fn require_camera(app: &AppHandle) -> Result<u64, String> {
    let (active, foreground, camera, epoch) = app.state::<MobileNativeMedia>().read(|inner| {
        (
            inner.gate.call_active,
            inner.gate.foreground,
            inner.permissions.camera.clone(),
            inner.gate.epoch,
        )
    })?;
    if !active {
        return Err("Join a call to use the camera.".into());
    }
    if !foreground {
        return Err("The camera is off while Raven is in the background.".into());
    }
    if camera != PermissionStatus::Granted {
        return Err("Raven needs camera permission while in the foreground.".into());
    }
    Ok(epoch)
}

/// Whether a foreground-only action (the permission dialog) still belongs to `epoch`.
pub fn epoch_matches(app: &AppHandle, epoch: u64) -> bool {
    app.state::<MobileNativeMedia>()
        .read(|inner| inner.gate.foreground && inner.gate.epoch == epoch)
        .unwrap_or(false)
}

/// Whether camera capture for this call epoch may still run. Called once per frame.
pub fn camera_current(app: &AppHandle, epoch: u64) -> bool {
    app.state::<MobileNativeMedia>()
        .read(|inner| {
            inner.gate.foreground
                && inner.gate.call_active
                && inner.gate.epoch == epoch
                && inner.permissions.camera == PermissionStatus::Granted
        })
        .unwrap_or(false)
}

fn emit(app: &AppHandle) -> Result<MobileNativeSnapshot, String> {
    let snapshot = app.state::<MobileNativeMedia>().snapshot()?;
    app.emit(MOBILE_NATIVE_MEDIA_STATE, &snapshot)
        .map_err(|e| e.to_string())?;
    Ok(snapshot)
}

fn store_permissions(app: &AppHandle, permissions: PermissionSnapshot) {
    if let Ok(mut inner) = app.state::<MobileNativeMedia>().lock() {
        inner.permissions = permissions;
    }
}

/// Reloads the OS permissions. A failure is logged and keeps the last known values.
async fn refresh_permissions(app: &AppHandle) {
    match raven_mobile_native::permission_status(app).await {
        Ok(permissions) => store_permissions(app, permissions),
        Err(error) => eprintln!("[mobile-native] permission_status refresh failed: {error}"),
    }
}

async fn resync_video(app: &AppHandle) {
    let video = app
        .state::<crate::video::state::SharedVideoEngineState>()
        .inner()
        .clone();
    crate::video::state::resync_video(app, &video).await;
}

pub fn initialize(app: &AppHandle) {
    let callback_app = app.clone();
    let channel = tauri::ipc::Channel::<MobileNativeEvent>::new(move |event| {
        let event = event.deserialize::<MobileNativeEvent>()?;
        handle_event(&callback_app, event);
        Ok(())
    });
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = raven_mobile_native::listen(&app, channel).await {
            eprintln!("[mobile-native] could not subscribe to native lifecycle: {error}");
            handle_event(&app, MobileNativeEvent::BackgroundTerminal);
            return;
        }
        refresh_permissions(&app).await;
        if let Err(error) = emit(&app) {
            eprintln!("[mobile-native] initialize emit failed: {error}");
        }
    });
}

/// Engine work that follows a lifecycle event once the gate has been updated.
enum AfterEvent {
    Terminated,
    Backgrounded,
    Foregrounded,
    AudioFocus,
}

fn handle_event(app: &AppHandle, event: MobileNativeEvent) {
    let after = {
        let state = app.state::<MobileNativeMedia>();
        let Ok(mut inner) = state.lock() else {
            return;
        };
        match event {
            MobileNativeEvent::Foregrounded => {
                inner.gate.foreground = true;
                AfterEvent::Foregrounded
            }
            MobileNativeEvent::Backgrounded => {
                inner.gate.background();
                AfterEvent::Backgrounded
            }
            MobileNativeEvent::BackgroundTerminal => {
                inner.gate.terminate();
                AfterEvent::Terminated
            }
            MobileNativeEvent::AudioFocus { focused } => {
                inner.gate.focused = focused;
                AfterEvent::AudioFocus
            }
        }
    };
    // This callback closes the gate before waiting for any engine operation. Device
    // workers also observe it while a connect/reconcile is holding the ops lock.
    if let Err(error) = emit(app) {
        eprintln!("[mobile-native] handle_event emit failed: {error}");
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match after {
            AfterEvent::Terminated => {
                if let Err(error) = complete_pending_stop(&app).await {
                    eprintln!("[mobile-native] foreground call shutdown failed: {error}");
                }
                return;
            }
            AfterEvent::Foregrounded => {
                refresh_permissions(&app).await;
                if let Err(error) = emit(&app) {
                    eprintln!("[mobile-native] foregrounded emit failed: {error}");
                }
                resync_video(&app).await;
            }
            // Releases the camera; audio keeps running.
            AfterEvent::Backgrounded => resync_video(&app).await,
            AfterEvent::AudioFocus => {}
        }
        crate::audio::state::resync_audio_eligibility(&app).await;
    });
}

async fn stop_native_media(app: &AppHandle) -> Result<(), String> {
    let audio = app
        .state::<crate::audio::state::SharedAudioEngineState>()
        .inner()
        .clone();
    let video = app
        .state::<crate::video::state::SharedVideoEngineState>()
        .inner()
        .clone();
    {
        let mut engine = audio
            .write()
            .map_err(|_| "Native audio state is unavailable.".to_string())?;
        engine.capture_demand.call_active = false;
        engine.capture_demand.monitoring = false;
    }
    let (audio_result, video_result) = tokio::join!(
        crate::audio::state::disconnect_audio_room(app, &audio),
        crate::video::state::disconnect_video_room(app, &video, &audio),
    );
    audio_result.map_err(|error| format!("Could not stop native audio: {error}"))?;
    video_result.map_err(|error| format!("Could not stop native video: {error}"))?;
    Ok(())
}

async fn complete_pending_stop(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<MobileNativeMedia>();
    let _transition = state.transition.lock().await;
    drain_pending_stop(app, &state).await
}

/// Called under the transition lock, separate from both the desired-state lock and
/// engine ops locks. A begin must finish any queued stop before opening a new lease.
async fn drain_pending_stop(app: &AppHandle, state: &MobileNativeMedia) -> Result<(), String> {
    loop {
        let Some(epoch) = state.lock()?.gate.pending_stop else {
            return Ok(());
        };
        stop_native_media(app).await?;
        raven_mobile_native::audio_focus(app, false).await?;
        state.lock()?.gate.finish_stop(epoch);
    }
}

/// Requests communication audio focus for the call `epoch` and records the result in
/// the gate. Errors when the call ended while waiting, or when the plugin failed.
async fn acquire_focus(
    app: &AppHandle,
    state: &MobileNativeMedia,
    epoch: u64,
) -> Result<bool, String> {
    let focus = raven_mobile_native::audio_focus(app, true).await;
    let mut inner = state.lock()?;
    if inner.gate.epoch != epoch || !inner.gate.call_active {
        return Err("The call was cancelled while acquiring audio focus.".into());
    }
    let granted = focus?;
    inner.gate.focused = granted;
    Ok(granted)
}

#[tauri::command]
pub async fn mobile_native_get_state(
    app: AppHandle,
    state: State<'_, MobileNativeMedia>,
) -> Result<MobileNativeSnapshot, String> {
    let permissions = raven_mobile_native::permission_status(&app).await?;
    state.lock()?.permissions = permissions;
    emit(&app)
}

#[tauri::command]
pub async fn mobile_native_begin_call(
    app: AppHandle,
    state: State<'_, MobileNativeMedia>,
    expected_epoch: u64,
) -> Result<MobileNativeSnapshot, String> {
    let _transition = state.transition.lock().await;
    drain_pending_stop(&app, &state).await?;
    state.lock()?.gate.begin(expected_epoch)?;
    let error = match acquire_focus(&app, &state, expected_epoch).await {
        Ok(true) => return emit(&app),
        Ok(false) => "Another app currently owns communication audio.".to_string(),
        Err(error) => error,
    };
    // A cancelled call was already ended; only end this one.
    let mut inner = state.lock()?;
    if inner.gate.epoch == expected_epoch {
        inner.gate.end();
    }
    Err(error)
}

#[tauri::command]
pub async fn mobile_native_end_call(
    app: AppHandle,
    state: State<'_, MobileNativeMedia>,
) -> Result<MobileNativeSnapshot, String> {
    state.lock()?.gate.end();
    emit(&app)?;
    complete_pending_stop(&app).await?;
    emit(&app)
}

#[tauri::command]
pub async fn mobile_native_request_permission(
    app: AppHandle,
    state: State<'_, MobileNativeMedia>,
    kind: PermissionKind,
    expected_epoch: u64,
) -> Result<MobileNativeSnapshot, String> {
    let _request = state.permission_request.lock().await;
    if !epoch_matches(&app, expected_epoch) {
        return Err("The device action was cancelled.".into());
    }
    let permissions = raven_mobile_native::request_permission(&app, kind.clone()).await?;
    // The answer is OS truth even when the action that asked was cancelled.
    state.lock()?.permissions = permissions;
    if !epoch_matches(&app, expected_epoch) {
        emit(&app)?;
        return Err("The device action was cancelled while requesting permission.".into());
    }
    match kind {
        PermissionKind::Microphone => crate::audio::state::resync_audio_eligibility(&app).await,
        PermissionKind::Camera => resync_video(&app).await,
    }
    emit(&app)
}

#[tauri::command]
pub async fn mobile_native_open_settings(app: AppHandle) -> Result<(), String> {
    raven_mobile_native::open_settings(&app).await
}
