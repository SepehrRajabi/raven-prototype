//! Which window may call which command, checked a second time in Rust.
//!
//! Tauri's ACL (build.rs, `capabilities/*.json`, `permissions/`) already limits each
//! window to the commands its capability grants. Commands that start capture or a
//! screen share, join a call, open a Workshop path or read a file the page names are
//! also refused here unless the caller is the main window, so a capability file edited
//! by mistake cannot hand them to the overlay or a picture-in-picture window.

use tauri::{ipc::Invoke, Runtime};

#[allow(dead_code)] // APP_COMMANDS is for build.rs and the tests.
mod lists {
    include!("../app_commands.rs");
}
pub use lists::MAIN_ONLY;

pub const MAIN_WINDOW: &str = "main";

/// True when `window` may call `command` as far as this check is concerned.
pub fn allowed(command: &str, window: &str) -> bool {
    window == MAIN_WINDOW || !MAIN_ONLY.contains(&command)
}

/// Wraps the generated invoke handler with the main-only check.
pub fn guard<R: Runtime>(
    handler: impl Fn(Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke: Invoke<R>| {
        let window = invoke.message.webview_ref().window_ref().label().to_string();
        let command = invoke.message.command().to_string();
        if !allowed(&command, &window) {
            invoke
                .resolver
                .reject(format!("{command} is available only in Raven's main window."));
            return true;
        }
        handler(invoke)
    }
}

#[cfg(test)]
mod tests {
    use super::lists::APP_COMMANDS;
    use super::*;
    use std::collections::BTreeSet;

    /// The names inside `generate_handler![...]` in lib.rs.
    fn registered() -> BTreeSet<String> {
        let lib = include_str!("lib.rs");
        let start = lib.find("generate_handler![").expect("generate_handler! in lib.rs")
            + "generate_handler![".len();
        // The list ends at the `]` that closes it, not at one inside a `#[cfg(...)]`.
        let mut depth = 1;
        let end = start
            + lib[start..]
                .find(|c| {
                    match c {
                        '[' => depth += 1,
                        ']' => depth -= 1,
                        _ => {}
                    }
                    depth == 0
                })
                .expect("end of generate_handler!");
        lib[start..end]
            .split(',')
            .map(|item| {
                // Drop attributes such as `#[cfg(mobile)]` written above a command.
                let item = item.trim();
                let name = item.rfind(']').map_or(item, |at| item[at + 1..].trim());
                name.rsplit("::").next().unwrap_or("").to_string()
            })
            .filter(|name| !name.is_empty())
            .collect()
    }

    #[test]
    fn every_registered_command_is_listed_for_the_acl() {
        let listed: BTreeSet<String> = APP_COMMANDS.iter().map(|c| c.to_string()).collect();
        let registered = registered();
        let missing: Vec<_> = registered.difference(&listed).collect();
        let stale: Vec<_> = listed.difference(&registered).collect();
        assert!(
            missing.is_empty(),
            "add these to APP_COMMANDS in app_commands.rs, or no window can call them: {missing:?}"
        );
        assert!(stale.is_empty(), "no longer registered in lib.rs: {stale:?}");
    }

    #[test]
    fn main_only_commands_exist() {
        for command in MAIN_ONLY {
            assert!(APP_COMMANDS.contains(command), "{command} is not a command");
        }
    }

    #[test]
    fn secondary_windows_are_never_granted_a_main_only_command() {
        let sets = include_str!("../permissions/windows.toml");
        for command in MAIN_ONLY {
            let permission = format!("\"allow-{}\"", command.replace('_', "-"));
            assert!(
                !sets.contains(&permission),
                "{command} is main-only but permissions/windows.toml grants it"
            );
        }
        for line in sets.lines().filter(|line| line.trim().starts_with("\"allow-")) {
            let name = line.trim().trim_start_matches("\"allow-").trim_end_matches("\",");
            assert!(
                APP_COMMANDS.contains(&name.replace('-', "_").as_str()),
                "permissions/windows.toml names an unknown command: {name}"
            );
        }
    }

    #[test]
    fn only_the_main_window_reaches_capture_and_workshop() {
        for command in ["video_start_camera", "video_start_display_share", "workshop_publish", "library_stage"] {
            assert!(allowed(command, "main"));
            assert!(!allowed(command, "voice-overlay"));
            assert!(!allowed(command, "pip-camera-x"));
            assert!(!allowed(command, "studio-window-1"));
        }
        assert!(allowed("video_get_state", "pip-camera-x"));
    }
}
