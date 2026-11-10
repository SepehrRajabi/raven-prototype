//! GIF and sticker files on their way into a library. A file the person picks or drops,
//! or one taken out of a `.ravenpack`, is staged on disk with its SHA-256, so the page
//! can ask the server whether it already has it before uploading anything. The page
//! reads a staged file back by its handle to upload it, then discards it.
//! docs/chat.md has the server side; docs/plans/gifs-stickers/README.md the pack format.
mod pack;
#[cfg(test)]
mod tests;

pub use pack::{Pack, PackItem};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};
use tauri::{
    ipc::{InvokeBody, Request, Response},
    Manager,
};

/// The server takes originals of at most 20 MB.
pub const FILE_LIMIT: u64 = 20 * 1024 * 1024;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum LibraryError {
    /// Not a GIF, WebP, PNG, WebM, MP4 or TGS file.
    Unsupported,
    TooLarge,
    /// Not a zip file at all.
    NotPack,
    /// An entry whose name isn't `manifest.json` or `items/<plain name>`.
    BadEntry,
    BadManifest,
    TooManyItems,
    Io,
}
impl From<std::io::Error> for LibraryError {
    fn from(_: std::io::Error) -> Self {
        Self::Io
    }
}
pub type Result<T> = std::result::Result<T, LibraryError>;

/// A file waiting on this computer to be added to a library.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StagedFile {
    pub handle: String,
    pub name: String,
    pub content_type: String,
    pub size: u64,
    /// Lowercase hex, as the server wants it.
    pub sha256: String,
}

fn staging(app: &tauri::AppHandle) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|_| LibraryError::Io)?
        .join("library-staging"))
}

fn valid_handle(handle: &str) -> bool {
    uuid::Uuid::parse_str(handle).is_ok_and(|id| id.to_string() == handle)
}

/// What the bytes are, by their first bytes. TGS is gzip, so only its name tells it apart
/// from any other gzip file.
pub fn sniff(bytes: &[u8], name: &str) -> Option<&'static str> {
    let lower = name.to_ascii_lowercase();
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some("image/png");
    }
    if bytes.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        return Some("video/webm");
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        return Some("video/mp4");
    }
    if bytes.starts_with(&[0x1F, 0x8B]) && lower.ends_with(".tgs") {
        return Some("application/x-tgsticker");
    }
    None
}

fn plain_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let clean: String = base.chars().filter(|c| !c.is_control()).take(120).collect();
    if clean.trim().is_empty() {
        "file".into()
    } else {
        clean
    }
}

/// Writes a file to the staging folder and describes it. A folder rename is the commit
/// point, so a reader never sees half a file.
pub fn stage(root: &Path, bytes: &[u8], name: &str) -> Result<StagedFile> {
    if bytes.len() as u64 > FILE_LIMIT {
        return Err(LibraryError::TooLarge);
    }
    let content_type = sniff(bytes, name).ok_or(LibraryError::Unsupported)?;
    let handle = uuid::Uuid::new_v4().to_string();
    let staged = StagedFile {
        handle: handle.clone(),
        name: plain_name(name),
        content_type: content_type.into(),
        size: bytes.len() as u64,
        sha256: hex(&Sha256::digest(bytes)),
    };
    fs::create_dir_all(root)?;
    let folder = root.join(format!("{handle}.tmp"));
    fs::create_dir(&folder)?;
    let write = || -> Result<()> {
        fs::write(folder.join("file"), bytes)?;
        fs::write(
            folder.join("file.json"),
            serde_json::to_vec(&staged).map_err(|_| LibraryError::Io)?,
        )?;
        fs::rename(&folder, root.join(&handle))?;
        Ok(())
    };
    if let Err(error) = write() {
        let _ = fs::remove_dir_all(&folder);
        return Err(error);
    }
    Ok(staged)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn folder_of(root: &Path, handle: &str) -> Result<PathBuf> {
    if !valid_handle(handle) {
        return Err(LibraryError::Io);
    }
    let path = root.join(handle);
    if fs::symlink_metadata(&path)?.file_type().is_symlink() {
        return Err(LibraryError::Io);
    }
    Ok(path)
}

/// The bytes of a staged file, checked against what was recorded when it was staged.
pub fn read_staged(root: &Path, handle: &str) -> Result<Vec<u8>> {
    let folder = folder_of(root, handle)?;
    let staged: StagedFile = serde_json::from_slice(&fs::read(folder.join("file.json"))?)
        .map_err(|_| LibraryError::Io)?;
    let path = folder.join("file");
    if fs::symlink_metadata(&path)?.file_type().is_symlink() {
        return Err(LibraryError::Io);
    }
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(FILE_LIMIT + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 != staged.size {
        return Err(LibraryError::Io);
    }
    Ok(bytes)
}

pub fn discard(root: &Path, handle: &str) -> Result<()> {
    if !valid_handle(handle) {
        return Err(LibraryError::Io);
    }
    if !root.join(handle).try_exists()? {
        return Ok(());
    }
    fs::remove_dir_all(folder_of(root, handle)?)?;
    Ok(())
}

/// Removes staged files older than `cutoff`: an import or an add that never finished.
fn sweep(root: &Path, cutoff: SystemTime) -> Result<()> {
    if !root.try_exists()? {
        return Ok(());
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let base = name.strip_suffix(".tmp").unwrap_or(&name);
        if !valid_handle(base) || !entry.file_type()?.is_dir() {
            continue;
        }
        if entry.metadata()?.modified()? < cutoff {
            fs::remove_dir_all(entry.path())?;
        }
    }
    Ok(())
}

#[derive(Deserialize)]
struct RawOptions {
    name: String,
}
#[derive(Deserialize)]
struct PathOptions {
    path: PathBuf,
}

fn read_path(path: &Path) -> Result<Vec<u8>> {
    let file = fs::File::open(path)?;
    if file.metadata()?.len() > FILE_LIMIT {
        return Err(LibraryError::TooLarge);
    }
    let mut bytes = Vec::new();
    file.take(FILE_LIMIT + 1).read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// Stages a file: its bytes with `{name}` in the `X-Raven-Library` header (picked in the
/// page), or `{path}` (dropped on the window).
#[tauri::command]
pub async fn library_stage(app: tauri::AppHandle, request: Request<'_>) -> Result<StagedFile> {
    let root = staging(&app)?;
    let (bytes, name) = match request.body() {
        InvokeBody::Raw(bytes) => {
            if bytes.len() as u64 > FILE_LIMIT {
                return Err(LibraryError::TooLarge);
            }
            let options: RawOptions = request
                .headers()
                .get("X-Raven-Library")
                .and_then(|h| std::str::from_utf8(h.as_bytes()).ok())
                .and_then(|h| serde_json::from_str(h).ok())
                .ok_or(LibraryError::Unsupported)?;
            (bytes.clone(), options.name)
        }
        InvokeBody::Json(value) => {
            let options: PathOptions =
                serde_json::from_value(value.clone()).map_err(|_| LibraryError::Unsupported)?;
            let name = options
                .path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            let path = options.path;
            return tauri::async_runtime::spawn_blocking(move || {
                stage(&root, &read_path(&path)?, &name)
            })
            .await
            .map_err(|_| LibraryError::Io)?;
        }
    };
    tauri::async_runtime::spawn_blocking(move || stage(&root, &bytes, &name))
        .await
        .map_err(|_| LibraryError::Io)?
}

#[tauri::command]
pub async fn library_read(app: tauri::AppHandle, handle: String) -> Result<Response> {
    let root = staging(&app)?;
    tauri::async_runtime::spawn_blocking(move || read_staged(&root, &handle).map(Response::new))
        .await
        .map_err(|_| LibraryError::Io)?
}

#[tauri::command]
pub async fn library_discard(app: tauri::AppHandle, handle: String) -> Result<()> {
    let root = staging(&app)?;
    tauri::async_runtime::spawn_blocking(move || discard(&root, &handle))
        .await
        .map_err(|_| LibraryError::Io)?
}

/// Asks for a `.ravenpack` file. None when the person cancels.
#[tauri::command]
pub async fn library_pick_pack(window: tauri::WebviewWindow) -> Result<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let picker = window
        .dialog()
        .file()
        .set_parent(&window)
        .add_filter("Raven pack", &["ravenpack", "zip"]);
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = picker.blocking_pick_file() else {
            return Ok(None);
        };
        let path = path.into_path().map_err(|_| LibraryError::Io)?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|_| LibraryError::Io)?
}

/// Opens a `.ravenpack`, checks it and stages its items. See `pack.rs` for the rules.
#[tauri::command]
pub async fn read_ravenpack(app: tauri::AppHandle, path: String) -> Result<Pack> {
    let root = staging(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let file = fs::File::open(&path)?;
        pack::read_pack(file, &root, pack::Limits::default())
    })
    .await
    .map_err(|_| LibraryError::Io)?
}

pub fn initialize(app: &tauri::AppHandle) {
    let Ok(root) = staging(app) else {
        return;
    };
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(cutoff) = SystemTime::now().checked_sub(Duration::from_secs(86400)) {
            let _ = sweep(&root, cutoff);
        }
    });
}
