//! Keeping Raven's window alive, and leaving a trail when it is not.
//!
//! Two things have blanked the main window mid-call: a render error that unmounts the
//! whole React tree, and the WebView2 renderer process dying or hanging. The first is
//! contained in the UI by error boundaries and reported here through
//! `diagnostics_log_ui_error`. The second never reaches the page, so this module watches
//! WebView2 itself: it ends the native call (nothing may stay published behind a dead
//! page), reloads the page, and the page rejoins the call it was in.
//!
//! Both land in `ui-errors.log` in the app's log directory
//! (`%LOCALAPPDATA%\app.raven.desktop\logs` on Windows), so the next one names its cause.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

const LOG_FILE: &str = "ui-errors.log";
/// The log is rolled over to `ui-errors.old.log` past this size.
const LOG_LIMIT_BYTES: u64 = 1024 * 1024;
/// A field longer than this (a stack, a component stack) is cut.
const FIELD_LIMIT: usize = 8 * 1024;

/// Record an error the page caught or could not catch. Best effort: a failure to write is
/// dropped, never surfaced to the page that is already in trouble.
#[tauri::command]
pub fn diagnostics_log_ui_error(
    app: AppHandle,
    window: tauri::Window,
    kind: String,
    message: String,
    stack: Option<String>,
    component_stack: Option<String>,
) {
    let mut entry = format!(
        "[{}] window={} {}: {}",
        timestamp(),
        window.label(),
        clip(&kind),
        clip(&message)
    );
    if let Some(stack) = stack.filter(|value| !value.trim().is_empty()) {
        entry.push_str("\n  stack:\n");
        entry.push_str(&indent(&clip(&stack)));
    }
    if let Some(components) = component_stack.filter(|value| !value.trim().is_empty()) {
        entry.push_str("\n  components:\n");
        entry.push_str(&indent(&clip(&components)));
    }
    append(&app, &entry);
}

/// Append one entry to the log, and to stderr for development runs.
pub fn append(app: &AppHandle, entry: &str) {
    eprintln!("[raven] {entry}");
    let Some(path) = log_path(app) else {
        return;
    };
    if fs::metadata(&path).is_ok_and(|meta| meta.len() > LOG_LIMIT_BYTES) {
        let _ = fs::rename(&path, path.with_file_name("ui-errors.old.log"));
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{entry}");
    }
}

fn log_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_log_dir().ok()?;
    fs::create_dir_all(&dir).ok()?;
    Some(dir.join(LOG_FILE))
}

fn clip(value: &str) -> String {
    if value.len() <= FIELD_LIMIT {
        return value.to_string();
    }
    let mut end = FIELD_LIMIT;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &value[..end])
}

fn indent(value: &str) -> String {
    value
        .lines()
        .map(|line| format!("    {}", line.trim_end()))
        .collect::<Vec<_>>()
        .join("\n")
}

/// UTC, to the second, without a date library.
fn timestamp() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or_default();
    let (days, rest) = (seconds.div_euclid(86_400), seconds.rem_euclid(86_400));
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3_600,
        rest % 3_600 / 60,
        rest % 60
    )
}

/// Reloads after a renderer crash, bounded: a page that crashes as it loads would
/// otherwise loop crash, reload, crash for as long as Raven runs.
#[cfg_attr(not(windows), allow(dead_code))]
struct ReloadBudget {
    recent: std::collections::VecDeque<Instant>,
}

#[cfg_attr(not(windows), allow(dead_code))]
impl ReloadBudget {
    /// At most this many reloads within [`Self::WINDOW`]; after that the window is left
    /// as it is and the log says why.
    const MAX: usize = 3;
    const WINDOW: Duration = Duration::from_secs(10 * 60);
    /// The first reload waits this long, each later one four times longer.
    const FIRST_DELAY: Duration = Duration::from_secs(1);

    fn new() -> Self {
        Self { recent: std::collections::VecDeque::new() }
    }

    /// How long to wait before the next reload, or None when the budget is spent.
    fn next(&mut self, now: Instant) -> Option<Duration> {
        while self
            .recent
            .front()
            .is_some_and(|at| now.duration_since(*at) >= Self::WINDOW)
        {
            self.recent.pop_front();
        }
        if self.recent.len() >= Self::MAX {
            return None;
        }
        let delay = Self::FIRST_DELAY * 4_u32.pow(self.recent.len() as u32);
        self.recent.push_back(now);
        Some(delay)
    }
}

/// Watch the main window's WebView2 processes. When the page's renderer dies or hangs,
/// end the native call and reload the page instead of leaving the window blank.
#[cfg(windows)]
pub fn watch_webview_processes(app: &AppHandle) {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2ProcessFailedEventArgs2, COREWEBVIEW2_PROCESS_FAILED_KIND,
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
        COREWEBVIEW2_PROCESS_FAILED_REASON,
    };
    use webview2_com::ProcessFailedEventHandler;
    use windows_core_webview2::Interface;

    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let app = app.clone();
    // One recovery at a time: a hung renderer is reported again while it is replaced.
    let recovering = Arc::new(AtomicBool::new(false));
    let budget = Arc::new(std::sync::Mutex::new(ReloadBudget::new()));
    let result = window.with_webview(move |webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else {
            append(&app, &format!("[{}] could not watch the WebView2 processes", timestamp()));
            return;
        };
        let handler_app = app.clone();
        let handler = ProcessFailedEventHandler::create(Box::new(move |_sender, args| {
            let app = &handler_app;
            let Some(args) = args else {
                return Ok(());
            };
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
            let _ = args.ProcessFailedKind(&mut kind);
            let mut reason = COREWEBVIEW2_PROCESS_FAILED_REASON::default();
            let mut exit_code = 0_i32;
            if let Ok(details) = args.cast::<ICoreWebView2ProcessFailedEventArgs2>() {
                let _ = details.Reason(&mut reason);
                let _ = details.ExitCode(&mut exit_code);
            }
            let name = match kind {
                COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED => "browser process exited",
                COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED => "page renderer exited",
                COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE => "page renderer unresponsive",
                COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED => "frame renderer exited",
                COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED => "GPU process exited",
                _ => "helper process exited",
            };
            append(
                app,
                &format!(
                    "[{}] window=main webview: {name} (kind {}, reason {}, exit code {exit_code:#010x})",
                    timestamp(),
                    kind.0,
                    reason.0,
                ),
            );
            let page_lost = matches!(
                kind,
                COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED
                    | COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE
            );
            if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED {
                // The whole WebView is gone and cannot be reloaded in place. Restarting
                // leaves the rooms on the way out (`RunEvent::Exit`).
                app.restart();
            }
            if page_lost && !recovering.swap(true, Ordering::SeqCst) {
                let app = app.clone();
                let recovering = Arc::clone(&recovering);
                let delay = budget
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .next(Instant::now());
                tauri::async_runtime::spawn(async move {
                    end_call_before_reload(&app).await;
                    let Some(delay) = delay else {
                        append(
                            &app,
                            &format!(
                                "[{}] the page crashed {} times in {} minutes; not reloading again",
                                timestamp(),
                                ReloadBudget::MAX,
                                ReloadBudget::WINDOW.as_secs() / 60
                            ),
                        );
                        recovering.store(false, Ordering::SeqCst);
                        return;
                    };
                    tokio::time::sleep(delay).await;
                    if let Some(window) = app.get_webview_window("main") {
                        if let Err(err) = window.reload() {
                            append(&app, &format!("[{}] reload failed: {err}", timestamp()));
                        }
                    }
                    recovering.store(false, Ordering::SeqCst);
                });
            }
            Ok(())
        }));
        let mut token = 0_i64;
        if let Err(err) = core.add_ProcessFailed(&handler, &mut token) {
            append(&app, &format!("[{}] could not watch the WebView2 processes: {err}", timestamp()));
        }
    });
    if let Err(err) = result {
        eprintln!("[raven] could not reach the main WebView: {err}");
    }
}

#[cfg(not(windows))]
pub fn watch_webview_processes(_app: &AppHandle) {}

/// The page that owned the call is gone, so nothing knows the call is up: leave both
/// rooms and release capture. The reloaded page rejoins (see `crashRecovery.ts`).
#[cfg(windows)]
async fn end_call_before_reload(app: &AppHandle) {
    use crate::audio::state::{audio_set_call_active, disconnect_audio_room, SharedAudioEngineState};
    use crate::video::state::{disconnect_video_room, SharedVideoEngineState};

    let audio = app.state::<SharedAudioEngineState>().inner().clone();
    let video = app.state::<SharedVideoEngineState>().inner().clone();
    let _ = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        let _ = disconnect_video_room(app, &video, &audio).await;
        let _ = disconnect_audio_room(app, &audio).await;
        let _ = audio_set_call_active(app.clone(), app.state::<SharedAudioEngineState>(), false).await;
    })
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_keeps_char_boundaries() {
        let long = "é".repeat(FIELD_LIMIT);
        let clipped = clip(&long);
        assert!(clipped.len() <= FIELD_LIMIT + "…".len());
        assert!(clipped.ends_with('…'));
    }

    #[test]
    fn renderer_reloads_back_off_and_stop() {
        let mut budget = ReloadBudget::new();
        let start = Instant::now();
        assert_eq!(budget.next(start), Some(Duration::from_secs(1)));
        assert_eq!(budget.next(start + Duration::from_secs(5)), Some(Duration::from_secs(4)));
        assert_eq!(budget.next(start + Duration::from_secs(20)), Some(Duration::from_secs(16)));
        assert_eq!(budget.next(start + Duration::from_secs(60)), None);
        // Once the first crash is older than the window, one more reload is allowed.
        assert_eq!(budget.next(start + ReloadBudget::WINDOW), Some(Duration::from_secs(16)));
    }

    #[test]
    fn timestamp_is_iso_utc() {
        let stamp = timestamp();
        assert_eq!(stamp.len(), 20);
        assert!(stamp.ends_with('Z'));
        assert!(stamp.starts_with("20"));
    }
}
