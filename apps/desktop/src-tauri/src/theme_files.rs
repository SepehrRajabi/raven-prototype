//! Opening and saving custom theme files (.css). Both pickers run here rather than in the
//! WebView, so the page never names a path to read or write: it gets the text of the file
//! the person chose, or hands over the text to save where they choose.

use std::fs;
use tauri::ipc::{InvokeBody, Request};
use tauri::Manager;

/// The largest theme Raven reads or writes. The page checks the same limit.
const THEME_LIMIT: u64 = 256 * 1024;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeFile {
    /// The file's name, without its folder.
    name: String,
    text: String,
}

/// Keeps only what is safe in a file name, and makes it a .css.
fn safe_theme_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("").trim();
    let cleaned: String = base
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        .collect();
    let stem = cleaned.trim_end_matches(".css").trim_matches('.');
    if stem.is_empty() {
        "raven-theme.css".into()
    } else {
        format!("{stem}.css")
    }
}

/// Asks which .css file to load and returns its text. `None` when the person cancels.
#[tauri::command]
pub async fn open_theme_file(window: tauri::WebviewWindow) -> Result<Option<ThemeFile>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picker = window
        .dialog()
        .file()
        .set_parent(&window)
        .add_filter("CSS theme", &["css"]);
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = picker.blocking_pick_file() else {
            return Ok(None);
        };
        let path = path
            .into_path()
            .map_err(|_| "That file can't be opened.".to_string())?;
        let size = fs::metadata(&path)
            .map_err(|err| format!("Couldn't read the file: {err}"))?
            .len();
        if size > THEME_LIMIT {
            return Err(format!("A theme can be at most {} KB.", THEME_LIMIT / 1024));
        }
        let bytes = fs::read(&path).map_err(|err| format!("Couldn't read the file: {err}"))?;
        let text = String::from_utf8(bytes).map_err(|_| "That file isn't text Raven can read.".to_string())?;
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "theme.css".into());
        Ok(Some(ThemeFile { name, text }))
    })
    .await
    .map_err(|_| "Opening was interrupted.".to_string())?
}

/// Asks where to save a theme, starting in Downloads, then writes it there. Returns the
/// saved path, or `None` when the person cancels.
#[tauri::command]
pub async fn save_theme_file(
    window: tauri::WebviewWindow,
    request: Request<'_>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("The theme was not sent as a file.".into());
    };
    if bytes.len() as u64 > THEME_LIMIT {
        return Err(format!("A theme can be at most {} KB.", THEME_LIMIT / 1024));
    }
    let name = request
        .headers()
        .get("X-Raven-Theme-Name")
        .and_then(|h| std::str::from_utf8(h.as_bytes()).ok())
        .map(safe_theme_name)
        .unwrap_or_else(|| "raven-theme.css".into());
    let bytes = bytes.clone();
    let mut picker = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_file_name(name)
        .add_filter("CSS theme", &["css"]);
    if let Ok(downloads) = window.app_handle().path().download_dir() {
        picker = picker.set_directory(downloads);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = picker.blocking_save_file() else {
            return Ok(None);
        };
        let path = path
            .into_path()
            .map_err(|_| "That location can't be saved to.".to_string())?;
        fs::write(&path, bytes).map_err(|err| format!("Couldn't write the file: {err}"))?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|_| "Saving was interrupted.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::safe_theme_name;

    #[test]
    fn keeps_a_normal_name() {
        assert_eq!(safe_theme_name("ayu-mirage.css"), "ayu-mirage.css");
        assert_eq!(safe_theme_name("ayu-mirage"), "ayu-mirage.css");
    }

    #[test]
    fn drops_folders_and_odd_characters() {
        assert_eq!(safe_theme_name("../../etc/pass wd.css"), "passwd.css");
        assert_eq!(safe_theme_name("C:\\Users\\x\\night owl.css"), "nightowl.css");
    }

    #[test]
    fn falls_back_when_nothing_is_left() {
        assert_eq!(safe_theme_name("///"), "raven-theme.css");
        assert_eq!(safe_theme_name(".css"), "raven-theme.css");
    }
}
