//! `.ravenpack`: a zip of `manifest.json` and `items/<file>`. The format is in
//! docs/plans/gifs-stickers/README.md. Everything is checked before anything is staged:
//! entry names (no paths, so nothing can be written or read outside the pack), counts and
//! sizes, and the manifest. Files are originals; the server converts them and enforces
//! its own limits when they are added.
use super::{discard, sniff, stage, LibraryError, Result, StagedFile};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    io::{Read, Seek},
    path::Path,
};

pub struct Limits {
    pub items: usize,
    pub entry: u64,
    pub total: u64,
    pub manifest: u64,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            items: 500,
            entry: super::FILE_LIMIT,
            total: 200 * 1024 * 1024,
            manifest: 1024 * 1024,
        }
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PackItem {
    /// The entry it came from, `items/0001.webm`.
    pub file: String,
    pub kind: String,
    pub title: String,
    pub keywords: Vec<String>,
    pub emoji: Option<String>,
    /// None when the file is of a type Raven can't add; the page lists it as refused.
    pub staged: Option<StagedFile>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Pack {
    pub title: String,
    pub source: String,
    pub items: Vec<PackItem>,
}

#[derive(Deserialize)]
struct Manifest {
    format: String,
    version: u32,
    title: String,
    #[serde(default)]
    source: String,
    items: Vec<ManifestItem>,
}
#[derive(Deserialize)]
struct ManifestItem {
    file: String,
    kind: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    keywords: Option<Vec<String>>,
    #[serde(default)]
    emoji: Option<String>,
}

/// `items/` plus a plain file name: no folders, no `..`, no drive or root, nothing hidden.
pub fn item_entry(name: &str) -> bool {
    let Some(plain) = name.strip_prefix("items/") else {
        return false;
    };
    !plain.is_empty()
        && plain.len() <= 255
        && !plain.starts_with('.')
        && !plain.chars().any(|c| matches!(c, '/' | '\\' | ':') || c.is_control())
}

fn entry_allowed(name: &str, is_dir: bool) -> bool {
    // A folder entry for items/ is what zip tools add on their own; it holds nothing.
    (is_dir && name == "items/") || (!is_dir && (name == "manifest.json" || item_entry(name)))
}

pub fn read_pack<R: Read + Seek>(reader: R, root: &Path, limits: Limits) -> Result<Pack> {
    let mut archive = zip::ZipArchive::new(reader).map_err(|_| LibraryError::NotPack)?;
    // The manifest, items/ and the items themselves.
    if archive.len() > limits.items + 2 {
        return Err(LibraryError::TooManyItems);
    }
    let mut names = HashSet::new();
    let mut total = 0u64;
    for index in 0..archive.len() {
        let entry = archive.by_index_raw(index).map_err(|_| LibraryError::BadEntry)?;
        let name = entry.name().map_err(|_| LibraryError::BadEntry)?.to_string();
        if !entry_allowed(&name, entry.is_dir()) || !names.insert(name.clone()) {
            return Err(LibraryError::BadEntry);
        }
        let limit = if name == "manifest.json" { limits.manifest } else { limits.entry };
        if entry.size() > limit {
            return Err(LibraryError::TooLarge);
        }
        total = total.saturating_add(entry.size());
        if total > limits.total {
            return Err(LibraryError::TooLarge);
        }
    }

    let manifest = read_entry(&mut archive, "manifest.json", limits.manifest)
        .map_err(|error| if error == LibraryError::TooLarge { error } else { LibraryError::BadManifest })?;
    let manifest: Manifest =
        serde_json::from_slice(&manifest).map_err(|_| LibraryError::BadManifest)?;
    if manifest.format != "ravenpack" || manifest.version != 1 || manifest.title.trim().is_empty() {
        return Err(LibraryError::BadManifest);
    }
    if manifest.items.len() > limits.items {
        return Err(LibraryError::TooManyItems);
    }
    if manifest.items.is_empty() {
        return Err(LibraryError::BadManifest);
    }
    let mut listed = HashSet::new();
    for item in &manifest.items {
        if !item_entry(&item.file)
            || !names.contains(&item.file)
            || !listed.insert(item.file.as_str())
            || (item.kind != "gif" && item.kind != "sticker")
        {
            return Err(LibraryError::BadManifest);
        }
    }

    let mut items: Vec<PackItem> = Vec::with_capacity(manifest.items.len());
    let mut read_total = 0u64;
    let result = (|| -> Result<()> {
        for item in &manifest.items {
            let bytes = read_entry(&mut archive, &item.file, limits.entry)?;
            read_total += bytes.len() as u64;
            if read_total > limits.total {
                return Err(LibraryError::TooLarge);
            }
            let staged = if sniff(&bytes, &item.file).is_some() {
                Some(stage(root, &bytes, &item.file)?)
            } else {
                None
            };
            items.push(PackItem {
                file: item.file.clone(),
                kind: item.kind.clone(),
                title: item.title.clone().unwrap_or_default(),
                keywords: item.keywords.clone().unwrap_or_default(),
                emoji: item.emoji.clone().filter(|emoji| !emoji.is_empty()),
                staged,
            });
        }
        Ok(())
    })();
    if let Err(error) = result {
        for item in &items {
            if let Some(staged) = &item.staged {
                let _ = discard(root, &staged.handle);
            }
        }
        return Err(error);
    }
    Ok(Pack {
        title: manifest.title.trim().to_string(),
        source: manifest.source,
        items,
    })
}

/// One entry's bytes, read no further than `limit` whatever its header claims.
fn read_entry<R: Read + Seek>(archive: &mut zip::ZipArchive<R>, name: &str, limit: u64) -> Result<Vec<u8>> {
    let entry = archive.by_name(name).map_err(|_| LibraryError::BadEntry)?;
    let mut bytes = Vec::new();
    entry
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| LibraryError::BadEntry)?;
    if bytes.len() as u64 > limit {
        return Err(LibraryError::TooLarge);
    }
    Ok(bytes)
}
