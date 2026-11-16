//! Raven's updater: Tauri's signed updater reading one static manifest.
//!
//! The release script puts `latest.json` and the signed installers on the update host.
//! Raven checks that file, tells the user when a newer version exists, and downloads and
//! installs only when asked. Three rules keep a working installation safe:
//!
//! - nothing is installed unless its signature matches the key built into this app (the
//!   plugin verifies the bytes as part of the download);
//! - a failed check, download or install leaves the current version running;
//! - Raven never restarts while the shell reports it is busy (in a Nest, capturing), or
//!   while the native audio engine itself is in a call, whatever the page says;
//! - the version a manifest announces must be the version the installer was signed for
//!   (`requireSignedVersion`, checked by the plugin), so an older signed build cannot be
//!   offered under a newer number.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_updater::{Update, UpdaterExt};

pub const UPDATE_ENDPOINT: &str = "https://updates.rvn.bluehour.cloud/latest.json";
pub const PUBLIC_KEY: &str = include_str!("../updater/raven-updater.key.pub");

const STATE_EVENT: &str = "raven-updater-state";
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(10);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);
const DOWNLOAD_ATTEMPTS: u32 = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdatePhase {
    Idle,
    Checking,
    Available,
    Downloading,
    Ready,
    Installing,
}

/// One earlier version's notes, from the manifest's `history`.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PastRelease {
    pub version: String,
    pub notes: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
    pub version: String,
    pub notes: String,
    /// Notes of the versions before this one, for someone several versions behind.
    pub history: Vec<PastRelease>,
    /// The signed installer itself, offered as a manual download if installing fails.
    pub download_url: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub downloaded: u64,
    pub total: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterSnapshot {
    pub current_version: String,
    pub phase: UpdatePhase,
    pub available: Option<AvailableUpdate>,
    pub progress: Option<DownloadProgress>,
    /// What went wrong in the last step the user asked for. The phase says where they
    /// are left: `available` after a failed download, `ready` after a failed install.
    pub error: Option<String>,
    pub last_checked_at_ms: Option<u64>,
    pub busy: bool,
    pub busy_reason: String,
}

struct UpdaterState {
    snapshot: UpdaterSnapshot,
    /// The update the last check found, kept so download and install act on exactly it.
    found: Option<Update>,
    /// Downloaded and signature-checked installer bytes for `found`.
    bytes: Option<Vec<u8>>,
}

struct Inner {
    app: AppHandle,
    state: Mutex<UpdaterState>,
    busy: AtomicBool,
    /// One check, download or install at a time.
    operation: tokio::sync::Mutex<()>,
}

#[derive(Clone)]
pub struct UpdaterRuntime(Arc<Inner>);

pub fn initialize(app: &AppHandle) {
    let runtime = UpdaterRuntime(Arc::new(Inner {
        app: app.clone(),
        state: Mutex::new(UpdaterState {
            snapshot: UpdaterSnapshot {
                current_version: app.package_info().version.to_string(),
                phase: UpdatePhase::Idle,
                available: None,
                progress: None,
                error: None,
                last_checked_at_ms: None,
                busy: false,
                busy_reason: String::new(),
            },
            found: None,
            bytes: None,
        }),
        busy: AtomicBool::new(false),
        operation: tokio::sync::Mutex::new(()),
    }));
    app.manage(runtime.clone());
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        loop {
            runtime.check(false).await;
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

impl UpdaterRuntime {
    fn snapshot(&self) -> UpdaterSnapshot {
        self.0
            .state
            .lock()
            .expect("updater state poisoned")
            .snapshot
            .clone()
    }

    /// Changes the state and tells the windows about it.
    fn update(&self, change: impl FnOnce(&mut UpdaterState)) -> UpdaterSnapshot {
        let snapshot = {
            let mut state = self.0.state.lock().expect("updater state poisoned");
            change(&mut state);
            state.snapshot.clone()
        };
        let _ = self.0.app.emit(STATE_EVENT, &snapshot);
        snapshot
    }

    /// Looks for a newer version. An automatic check that fails says nothing and is
    /// tried again at the next interval; a check the user asked for reports the failure.
    async fn check(&self, manual: bool) -> UpdaterSnapshot {
        let _operation = self.0.operation.lock().await;
        let before = self.snapshot().phase;
        self.update(|state| {
            state.snapshot.phase = UpdatePhase::Checking;
            if manual {
                state.snapshot.error = None;
            }
        });
        match self.fetch_latest().await {
            Ok(found) => self.update(|state| {
                state.snapshot.last_checked_at_ms = Some(now_ms());
                state.snapshot.error = None;
                let Some(found) = found else {
                    state.snapshot.phase = UpdatePhase::Idle;
                    state.snapshot.available = None;
                    state.snapshot.progress = None;
                    state.found = None;
                    state.bytes = None;
                    return;
                };
                let same_version = state
                    .snapshot
                    .available
                    .as_ref()
                    .is_some_and(|available| available.version == found.version);
                if same_version && state.bytes.is_some() {
                    // Already downloaded: keep it rather than fetch the same bytes again.
                    state.snapshot.phase = UpdatePhase::Ready;
                    return;
                }
                state.snapshot.phase = UpdatePhase::Available;
                state.snapshot.progress = None;
                state.snapshot.available = Some(AvailableUpdate {
                    version: found.version.clone(),
                    notes: found.body.clone().unwrap_or_default(),
                    history: past_releases(&found.raw_json),
                    download_url: found.download_url.to_string(),
                });
                state.bytes = None;
                state.found = Some(found);
            }),
            Err(error) => {
                eprintln!("[raven] update check failed: {error}");
                self.update(|state| {
                    state.snapshot.phase = before;
                    if manual {
                        state.snapshot.error = Some(
                            "Raven couldn’t check for updates. Check your connection and try again."
                                .to_string(),
                        );
                    }
                })
            }
        }
    }

    async fn fetch_latest(&self) -> Result<Option<Update>, String> {
        let endpoint = endpoint()
            .parse::<tauri::Url>()
            .map_err(|error| error.to_string())?;
        let updater = self
            .0
            .app
            .updater_builder()
            .endpoints(vec![endpoint])
            .map_err(|error| error.to_string())?
            .timeout(CHECK_TIMEOUT)
            .build()
            .map_err(|error| error.to_string())?;
        updater.check().await.map_err(|error| error.to_string())
    }

    /// Downloads the update the last check found. The plugin verifies the signature
    /// before returning the bytes, so a cut-off or altered download never becomes `ready`.
    async fn download(&self) -> Result<UpdaterSnapshot, String> {
        let _operation = self.0.operation.lock().await;
        let found = {
            let state = self.0.state.lock().expect("updater state poisoned");
            if state.bytes.is_some() {
                return Ok(state.snapshot.clone());
            }
            state.found.clone()
        };
        let Some(found) = found else {
            return Err("There is no update to download. Check for updates first.".to_string());
        };
        self.update(|state| {
            state.snapshot.phase = UpdatePhase::Downloading;
            state.snapshot.error = None;
            state.snapshot.progress = Some(DownloadProgress {
                downloaded: 0,
                total: None,
            });
        });

        let mut signature_failed = false;
        for attempt in 0..DOWNLOAD_ATTEMPTS {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_secs(2 * 3_u64.pow(attempt - 1))).await;
            }
            let progress = self.clone();
            let mut downloaded = 0_u64;
            let mut shown_percent = 0_u64;
            let result = found
                .download(
                    move |chunk, total| {
                        downloaded = downloaded.saturating_add(chunk as u64);
                        // One event per percent is plenty for a progress bar.
                        let percent = total
                            .filter(|total| *total > 0)
                            .map(|total| downloaded.saturating_mul(100) / total);
                        if percent.is_some_and(|percent| percent == shown_percent) {
                            return;
                        }
                        shown_percent = percent.unwrap_or(shown_percent);
                        progress.update(|state| {
                            state.snapshot.progress = Some(DownloadProgress { downloaded, total });
                        });
                    },
                    || {},
                )
                .await;
            match result {
                Ok(bytes) => {
                    return Ok(self.update(|state| {
                        state.snapshot.phase = UpdatePhase::Ready;
                        state.snapshot.progress = None;
                        state.bytes = Some(bytes);
                    }));
                }
                Err(error) => {
                    eprintln!(
                        "[raven] update download attempt {} failed: {error}",
                        attempt + 1
                    );
                    // A download that fails the signature or signed-version check would
                    // fail the same way again.
                    if is_signature_failure(&error) {
                        signature_failed = true;
                        break;
                    }
                }
            }
        }
        let message = if signature_failed {
            "The download didn’t pass Raven’s signature check, so it wasn’t installed."
        } else {
            "The download didn’t finish. Your current version is unchanged."
        };
        Ok(self.update(|state| {
            state.snapshot.phase = UpdatePhase::Available;
            state.snapshot.progress = None;
            state.snapshot.error = Some(message.to_string());
        }))
    }

    /// Installs the downloaded update and restarts into it. On Windows the installer
    /// takes over and ends this process; on Linux the AppImage is swapped in place.
    async fn install(&self) -> Result<UpdaterSnapshot, String> {
        let _operation = self.0.operation.lock().await;
        if self.0.busy.load(Ordering::SeqCst) {
            return Err(self.busy_message());
        }
        // The page reports calls through `updater_set_busy`; the engine's own state is
        // checked as well, so a page that failed to report one cannot end a call.
        if engine_in_call(&self.0.app) {
            return Err("Raven can’t restart while you are in a call.".to_string());
        }
        let (found, bytes) = {
            let state = self.0.state.lock().expect("updater state poisoned");
            match (state.found.clone(), state.bytes.clone()) {
                (Some(found), Some(bytes)) => (found, bytes),
                _ => return Err("Download the update before restarting.".to_string()),
            }
        };
        self.update(|state| {
            state.snapshot.phase = UpdatePhase::Installing;
            state.snapshot.error = None;
        });
        crate::stop_api_sidecar(&self.0.app);
        match found.install(bytes) {
            Ok(()) => {
                if cfg!(target_os = "linux") {
                    self.0.app.restart();
                }
                Ok(self.snapshot())
            }
            Err(error) => {
                eprintln!("[raven] update install failed: {error}");
                if crate::should_start_api_sidecar() {
                    let _ = crate::start_api_sidecar(&self.0.app);
                }
                Ok(self.update(|state| {
                    state.snapshot.phase = UpdatePhase::Ready;
                    state.snapshot.error = Some(
                        "Raven couldn’t install the update. Your current version is unchanged."
                            .to_string(),
                    );
                }))
            }
        }
    }

    fn set_busy(&self, busy: bool, reason: String) -> UpdaterSnapshot {
        self.0.busy.store(busy, Ordering::SeqCst);
        self.update(|state| {
            state.snapshot.busy = busy;
            state.snapshot.busy_reason = if busy { reason } else { String::new() };
        })
    }

    fn busy_message(&self) -> String {
        let reason = self.snapshot().busy_reason;
        if reason.is_empty() {
            "Raven can’t restart right now. Try again in a moment.".to_string()
        } else {
            format!("Raven can’t restart while {reason}.")
        }
    }
}

/// True while the native audio engine is joining, in, or rejoining a call.
fn engine_in_call(app: &AppHandle) -> bool {
    use crate::audio::{domain::AudioConnectionStatus, state::SharedAudioEngineState};
    let Some(state) = app.try_state::<SharedAudioEngineState>() else {
        return false;
    };
    let engine = state
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    engine.capture_demand.call_active
        || matches!(
            engine.mixer.session.connection_status,
            AudioConnectionStatus::Connecting
                | AudioConnectionStatus::Connected
                | AudioConnectionStatus::Reconnecting
        )
}

/// Whether a download was refused for its signature: bad bytes, the wrong key, or a version
/// other than the one it was signed for.
fn is_signature_failure(error: &tauri_plugin_updater::Error) -> bool {
    use tauri_plugin_updater::Error;
    matches!(
        error,
        Error::Minisign(_)
            | Error::Base64(_)
            | Error::SignatureUtf8(_)
            | Error::SignedVersionMismatch { .. }
            | Error::MissingSignedVersion
    )
}

/// Debug builds may point at another manifest (`RAVEN_UPDATE_ENDPOINT`) to rehearse an
/// update without publishing one. Release builds always use the real host.
fn endpoint() -> String {
    if cfg!(debug_assertions) {
        if let Ok(value) = std::env::var("RAVEN_UPDATE_ENDPOINT") {
            if !value.trim().is_empty() {
                return value;
            }
        }
    }
    UPDATE_ENDPOINT.to_string()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
pub fn updater_get_state(state: State<'_, UpdaterRuntime>) -> UpdaterSnapshot {
    state.snapshot()
}

#[tauri::command]
pub async fn updater_check(
    window: WebviewWindow,
    state: State<'_, UpdaterRuntime>,
) -> Result<UpdaterSnapshot, String> {
    require_main(&window)?;
    Ok(state.check(true).await)
}

#[tauri::command]
pub async fn updater_download(
    window: WebviewWindow,
    state: State<'_, UpdaterRuntime>,
) -> Result<UpdaterSnapshot, String> {
    require_main(&window)?;
    state.download().await
}

#[tauri::command]
pub async fn updater_install(
    window: WebviewWindow,
    state: State<'_, UpdaterRuntime>,
) -> Result<UpdaterSnapshot, String> {
    require_main(&window)?;
    state.install().await
}

/// The shell reports when restarting would interrupt something (a Nest, a capture).
#[tauri::command]
pub fn updater_set_busy(
    window: WebviewWindow,
    state: State<'_, UpdaterRuntime>,
    busy: bool,
    reason: String,
) -> Result<UpdaterSnapshot, String> {
    require_main(&window)?;
    Ok(state.set_busy(busy, reason))
}

fn require_main(window: &WebviewWindow) -> Result<(), String> {
    if is_main_window_label(window.label()) {
        Ok(())
    } else {
        Err("Updates are managed from Raven's main window.".to_string())
    }
}

fn is_main_window_label(label: &str) -> bool {
    label == "main"
}

/// A manifest without a usable `history` still offers the update, with its own notes.
fn past_releases(manifest: &serde_json::Value) -> Vec<PastRelease> {
    manifest
        .get("history")
        .and_then(|history| serde_json::from_value(history.clone()).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    #[test]
    fn manifest_history_is_read_and_its_absence_is_harmless() {
        let manifest = serde_json::json!({ "history": [{ "version": "0.1.6", "notes": "Fixes" }] });
        let history = super::past_releases(&manifest);
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].version, "0.1.6");
        assert!(super::past_releases(&serde_json::json!({})).is_empty());
        assert!(super::past_releases(&serde_json::json!({ "history": "nope" })).is_empty());
    }

    #[test]
    fn endpoint_and_key_are_fixed_release_inputs() {
        assert_eq!(
            super::UPDATE_ENDPOINT,
            "https://updates.rvn.bluehour.cloud/latest.json"
        );
        assert!(super::PUBLIC_KEY.trim().len() > 100);
    }

    #[test]
    fn the_app_config_points_at_the_same_manifest() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        assert_eq!(
            config["plugins"]["updater"]["endpoints"][0],
            super::UPDATE_ENDPOINT
        );
    }

    #[test]
    fn updater_commands_are_main_window_only() {
        assert!(super::is_main_window_label("main"));
        assert!(!super::is_main_window_label("nest-window-123"));
        assert!(!super::is_main_window_label("voice-overlay"));
    }
}
