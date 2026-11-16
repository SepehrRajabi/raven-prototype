//! Disk-backed preparation, independent of chat uploads and their transport.
mod image;
mod placeholder;
#[cfg(test)]
mod tests;

use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};
use tauri::{
    ipc::{InvokeBody, Request, Response},
    Manager,
};

const INPUT_LIMIT: usize = 50 * 1024 * 1024;
const FULL_LIMIT: usize = 10 * 1024 * 1024;
const PREVIEW_LIMIT: usize = 512 * 1024;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum AttachmentError {
    Unsupported,
    TooLarge,
    Damaged,
    Io,
}
impl From<std::io::Error> for AttachmentError {
    fn from(_: std::io::Error) -> Self {
        Self::Io
    }
}
type Result<T> = std::result::Result<T, AttachmentError>;

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    Standard,
    Full,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedVariant {
    pub variant: String,
    pub content_type: String,
    pub size: u64,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedAttachment {
    pub handle: String,
    pub kind: String,
    pub content_type: String,
    pub size: u64,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub placeholder: String,
    pub animated: bool,
    pub variants: Vec<PreparedVariant>,
}

fn outbox(app: &tauri::AppHandle) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|_| AttachmentError::Io)?
        .join("chat-outbox"))
}
fn valid_handle(handle: &str) -> bool {
    uuid::Uuid::parse_str(handle).is_ok_and(|id| id.to_string() == handle)
}
fn handle_path(root: &Path, handle: &str) -> Result<PathBuf> {
    if !valid_handle(handle) {
        return Err(AttachmentError::Io);
    }
    let path = root.join(handle);
    if fs::symlink_metadata(&path)?.file_type().is_symlink() {
        return Err(AttachmentError::Io);
    }
    Ok(path)
}
fn read_variant(root: &Path, handle: &str, variant: &str) -> Result<Vec<u8>> {
    // Variant names are generic, but always single, portable path components.
    if variant.is_empty()
        || variant.len() > 64
        || !variant
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(AttachmentError::Io);
    }
    let folder = handle_path(root, handle)?;
    let description: PreparedAttachment =
        serde_json::from_slice(&fs::read(folder.join("attachment.json"))?)
            .map_err(|_| AttachmentError::Io)?;
    let declared = description
        .variants
        .iter()
        .find(|v| v.variant == variant)
        .ok_or(AttachmentError::Io)?;
    let path = folder.join(variant);
    if fs::symlink_metadata(&path)?.file_type().is_symlink() {
        return Err(AttachmentError::Io);
    }
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(FULL_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > FULL_LIMIT || bytes.len() as u64 != declared.size {
        return Err(AttachmentError::Io);
    }
    Ok(bytes)
}
fn discard(root: &Path, handle: &str) -> Result<()> {
    if !valid_handle(handle) {
        return Err(AttachmentError::Io);
    }
    if !root.join(handle).try_exists()? {
        return Ok(());
    }
    fs::remove_dir_all(handle_path(root, handle)?)?;
    Ok(())
}
fn sweep(root: &Path, keep: &[String], older_than: Option<SystemTime>) -> Result<()> {
    fs::create_dir_all(root)?;
    let keep: HashSet<&str> = keep.iter().map(String::as_str).collect();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let temporary = name.strip_suffix(".tmp").is_some_and(valid_handle);
        if (!valid_handle(&name) && !temporary)
            || keep.contains(name.as_str())
            || !entry.file_type()?.is_dir()
        {
            continue;
        }
        // An ordinary client sweep cannot race an in-progress prepare. Only the
        // age-based startup cleanup removes abandoned temporary directories.
        if temporary && older_than.is_none() {
            continue;
        }
        if let Some(cutoff) = older_than {
            if entry.metadata()?.modified()? >= cutoff {
                continue;
            }
        }
        if temporary {
            fs::remove_dir_all(entry.path())?;
        } else {
            discard(root, &name)?;
        }
    }
    Ok(())
}
fn prepare(root: &Path, bytes: Vec<u8>, name: &str, mode: Mode) -> Result<PreparedAttachment> {
    let output = image::prepare(bytes, mode)?;
    let handle = uuid::Uuid::new_v4().to_string();
    // Use a folder rename as the commit point: readers never see partial variants.
    fs::create_dir_all(root)?;
    let folder = root.join(format!("{handle}.tmp"));
    fs::create_dir(&folder)?;
    let description = PreparedAttachment {
        handle: handle.clone(),
        kind: "image".into(),
        content_type: output.content_type.into(),
        size: output.full.len() as u64,
        name: name.rsplit(['/', '\\']).next().unwrap_or("image").into(),
        width: output.width,
        height: output.height,
        placeholder: output.placeholder,
        animated: output.animated,
        variants: vec![
            PreparedVariant {
                variant: "full".into(),
                content_type: output.content_type.into(),
                size: output.full.len() as u64,
            },
            PreparedVariant {
                variant: "preview".into(),
                content_type: output.preview_type.into(),
                size: output.preview.len() as u64,
            },
        ],
    };
    let write = || -> Result<()> {
        for (name, bytes) in [
            ("full", output.full.as_slice()),
            ("preview", output.preview.as_slice()),
        ] {
            fs::write(folder.join(format!("{name}.tmp")), bytes)?;
            fs::rename(folder.join(format!("{name}.tmp")), folder.join(name))?;
        }
        fs::write(
            folder.join("attachment.json.tmp"),
            serde_json::to_vec(&description).map_err(|_| AttachmentError::Io)?,
        )?;
        fs::rename(
            folder.join("attachment.json.tmp"),
            folder.join("attachment.json"),
        )?;
        fs::rename(&folder, root.join(&handle))?;
        Ok(())
    };
    if let Err(error) = write() {
        let _ = fs::remove_dir_all(&folder);
        return Err(error);
    }
    Ok(description)
}

#[derive(Deserialize)]
struct RawOptions {
    name: String,
    mode: Mode,
}
#[derive(Deserialize)]
struct PathOptions {
    path: PathBuf,
    mode: Mode,
}
enum Input {
    Bytes(Vec<u8>, RawOptions),
    Path(PathOptions),
}
fn parse_input(body: &InvokeBody, header: Option<&str>) -> Result<Input> {
    match body {
        InvokeBody::Raw(bytes) => {
            if bytes.len() > INPUT_LIMIT {
                return Err(AttachmentError::TooLarge);
            }
            let options = header.ok_or(AttachmentError::Unsupported)?;
            Ok(Input::Bytes(
                bytes.clone(),
                serde_json::from_str(options).map_err(|_| AttachmentError::Unsupported)?,
            ))
        }
        InvokeBody::Json(value) => Ok(Input::Path(
            serde_json::from_value(value.clone()).map_err(|_| AttachmentError::Unsupported)?,
        )),
    }
}
fn prepare_input(root: &Path, input: Input) -> Result<PreparedAttachment> {
    match input {
        Input::Bytes(bytes, options) => prepare(root, bytes, &options.name, options.mode),
        Input::Path(options) => {
            let file = fs::File::open(&options.path)?;
            if file.metadata()?.len() > INPUT_LIMIT as u64 {
                return Err(AttachmentError::TooLarge);
            }
            let mut bytes = Vec::new();
            file.take(INPUT_LIMIT as u64 + 1).read_to_end(&mut bytes)?;
            prepare(
                root,
                bytes,
                &options
                    .path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy(),
                options.mode,
            )
        }
    }
}
#[tauri::command]
pub async fn attachment_prepare(
    app: tauri::AppHandle,
    request: Request<'_>,
) -> Result<PreparedAttachment> {
    let root = outbox(&app)?;
    let input = parse_input(
        request.body(),
        request
            .headers()
            .get("X-Raven-Attachment")
            .and_then(|h| std::str::from_utf8(h.as_bytes()).ok()),
    )?;
    // A path must be one the person dropped on the window this session.
    if let Input::Path(options) = &input {
        if !crate::picked_paths::is_granted(&options.path) {
            return Err(AttachmentError::Io);
        }
    }
    tauri::async_runtime::spawn_blocking(move || prepare_input(&root, input))
        .await
        .map_err(|_| AttachmentError::Damaged)?
}
#[tauri::command]
pub async fn attachment_read(
    app: tauri::AppHandle,
    handle: String,
    variant: String,
) -> Result<Response> {
    let root = outbox(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        read_variant(&root, &handle, &variant).map(Response::new)
    })
    .await
    .map_err(|_| AttachmentError::Io)?
}
#[tauri::command]
pub async fn attachment_discard(app: tauri::AppHandle, handle: String) -> Result<()> {
    let root = outbox(&app)?;
    tauri::async_runtime::spawn_blocking(move || discard(&root, &handle))
        .await
        .map_err(|_| AttachmentError::Io)?
}
#[tauri::command]
pub async fn attachment_sweep(app: tauri::AppHandle, keep: Vec<String>) -> Result<()> {
    let root = outbox(&app)?;
    tauri::async_runtime::spawn_blocking(move || sweep(&root, &keep, None))
        .await
        .map_err(|_| AttachmentError::Io)?
}
#[derive(Deserialize)]
struct SaveOptions {
    name: String,
    #[serde(rename = "contentType")]
    content_type: String,
}
fn extension_for(content_type: &str) -> &'static str {
    match content_type {
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "jpg",
    }
}
/// Asks where to save an image the person is looking at, then writes its bytes there.
/// The picker runs here rather than in the WebView, so no command writes to a path the
/// page chose. Returns false when the person cancels.
#[tauri::command]
pub async fn attachment_save(window: tauri::WebviewWindow, request: Request<'_>) -> Result<bool> {
    use tauri_plugin_dialog::DialogExt;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(AttachmentError::Unsupported);
    };
    if bytes.len() > FULL_LIMIT {
        return Err(AttachmentError::TooLarge);
    }
    let options: SaveOptions = request
        .headers()
        .get("X-Raven-Attachment")
        .and_then(|h| std::str::from_utf8(h.as_bytes()).ok())
        .and_then(|h| serde_json::from_str(h).ok())
        .ok_or(AttachmentError::Unsupported)?;
    let bytes = bytes.clone();
    let extension = extension_for(&options.content_type);
    let picker = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_file_name(options.name.rsplit(['/', '\\']).next().unwrap_or("image"))
        .add_filter("Image", &[extension]);
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = picker.blocking_save_file() else {
            return Ok(false);
        };
        let path = path.into_path().map_err(|_| AttachmentError::Io)?;
        fs::write(path, bytes)?;
        Ok(true)
    })
    .await
    .map_err(|_| AttachmentError::Io)?
}
pub fn initialize(app: &tauri::AppHandle) {
    let Ok(root) = outbox(app) else {
        return;
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _ = sweep(
            &root,
            &[],
            SystemTime::now().checked_sub(Duration::from_secs(14 * 86400)),
        );
    });
}
