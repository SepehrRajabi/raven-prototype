//! Secrets the main window keeps in the operating system's credential store: the macOS
//! Keychain, Windows Credential Manager, or the Secret Service on Linux (GNOME Keyring,
//! KWallet). Raven keeps its sign-in sessions here instead of in the webview's storage.
//!
//! Only the main window may call these commands. When no credential store is reachable
//! (a Linux session without a Secret Service, for example) the commands fail with
//! `unavailable`, and the interface keeps sessions where it kept them before.

use serde::Serialize;
use tauri::WebviewWindow;

/// The service name every Raven secret is filed under.
const SERVICE: &str = "app.raven.desktop";

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum SecretError {
    /// Called from a window other than the main one.
    NotAllowed(String),
    /// The key is not one Raven uses.
    InvalidKey(String),
    /// No credential store is reachable, or it refused access.
    Unavailable(String),
}

/// Keys are short, fixed names chosen by the interface, never user input.
fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 64
        && key
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
}

fn check(window: &WebviewWindow, key: &str) -> Result<(), SecretError> {
    check_label(window.label(), key)
}

fn check_label(label: &str, key: &str) -> Result<(), SecretError> {
    if label != "main" {
        return Err(SecretError::NotAllowed(
            "Secrets are read only by Raven's main window.".to_string(),
        ));
    }
    if !valid_key(key) {
        return Err(SecretError::InvalidKey(format!("Unknown secret name: {key:?}")));
    }
    Ok(())
}

fn entry(key: &str) -> Result<keyring::Entry, SecretError> {
    keyring::Entry::new(SERVICE, key).map_err(unavailable)
}

fn unavailable(err: keyring::Error) -> SecretError {
    SecretError::Unavailable(err.to_string())
}

/// The secret saved under `key`, or `None` when there is none.
#[tauri::command]
pub async fn secret_get(window: WebviewWindow, key: String) -> Result<Option<String>, SecretError> {
    check(&window, &key)?;
    // The platform stores can block (a Keychain prompt, a D-Bus round trip): keep them
    // off the main thread.
    tauri::async_runtime::spawn_blocking(move || match entry(&key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(unavailable(err)),
    })
    .await
    .map_err(|err| SecretError::Unavailable(err.to_string()))?
}

#[tauri::command]
pub async fn secret_set(window: WebviewWindow, key: String, value: String) -> Result<(), SecretError> {
    check(&window, &key)?;
    tauri::async_runtime::spawn_blocking(move || entry(&key)?.set_password(&value).map_err(unavailable))
        .await
        .map_err(|err| SecretError::Unavailable(err.to_string()))?
}

/// Removes the secret; removing one that does not exist succeeds.
#[tauri::command]
pub async fn secret_delete(window: WebviewWindow, key: String) -> Result<(), SecretError> {
    check(&window, &key)?;
    tauri::async_runtime::spawn_blocking(move || match entry(&key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(unavailable(err)),
    })
    .await
    .map_err(|err| SecretError::Unavailable(err.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_main_window_may_ask() {
        assert!(check_label("main", "sessions").is_ok());
        assert!(matches!(check_label("voice-overlay", "sessions"), Err(SecretError::NotAllowed(_))));
        assert!(matches!(check_label("pip", "sessions"), Err(SecretError::NotAllowed(_))));
    }

    #[test]
    fn keys_are_short_fixed_names() {
        assert!(valid_key("sessions"));
        assert!(valid_key("raven.sessions-1"));
        assert!(!valid_key(""));
        assert!(!valid_key("Sessions"));
        assert!(!valid_key("a/b"));
        assert!(!valid_key(&"a".repeat(65)));
    }

    #[test]
    fn errors_serialize_with_a_kind() {
        let json = serde_json::to_string(&SecretError::Unavailable("no store".into())).unwrap();
        assert_eq!(json, r#"{"kind":"unavailable","message":"no store"}"#);
    }
}
