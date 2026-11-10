use super::pack::{item_entry, read_pack, Limits};
use super::*;
use std::io::{Cursor, Write};
use zip::write::SimpleFileOptions;

const WEBP: &[u8] = b"RIFF\x10\x00\x00\x00WEBPVP8 rest-of-file";
const GIF: &[u8] = b"GIF89a-rest-of-file";

struct Root(PathBuf);
impl Root {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("raven-library-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn staged(&self) -> usize {
        fs::read_dir(&self.0).map(|entries| entries.count()).unwrap_or(0)
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn zip(entries: &[(&str, &[u8])]) -> Cursor<Vec<u8>> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        if name.ends_with('/') {
            writer.add_directory(name.trim_end_matches('/'), SimpleFileOptions::default()).unwrap();
        } else {
            writer.start_file(*name, SimpleFileOptions::default()).unwrap();
            writer.write_all(bytes).unwrap();
        }
    }
    let mut cursor = writer.finish().unwrap();
    cursor.set_position(0);
    cursor
}

fn manifest(items: &[(&str, &str)]) -> Vec<u8> {
    let items: Vec<_> = items
        .iter()
        .map(|(file, kind)| serde_json::json!({ "file": file, "kind": kind, "title": "Cat waving", "keywords": ["hi"], "emoji": "👋" }))
        .collect();
    serde_json::to_vec(&serde_json::json!({ "format": "ravenpack", "version": 1, "title": "Cats", "source": "telegram", "items": items })).unwrap()
}

#[test]
fn reads_a_good_pack_and_stages_its_items() {
    let root = Root::new();
    let manifest = manifest(&[("items/0001.webp", "sticker"), ("items/0002.gif", "gif")]);
    let pack = read_pack(
        zip(&[("manifest.json", &manifest), ("items/", b""), ("items/0001.webp", WEBP), ("items/0002.gif", GIF)]),
        &root.0,
        Limits::default(),
    )
    .unwrap();
    assert_eq!(pack.title, "Cats");
    assert_eq!(pack.source, "telegram");
    assert_eq!(pack.items.len(), 2);
    let first = &pack.items[0];
    assert_eq!(first.kind, "sticker");
    assert_eq!(first.keywords, vec!["hi".to_string()]);
    assert_eq!(first.emoji.as_deref(), Some("👋"));
    let staged = first.staged.as_ref().unwrap();
    assert_eq!(staged.content_type, "image/webp");
    assert_eq!(staged.sha256, hex(&Sha256::digest(WEBP)));
    assert_eq!(read_staged(&root.0, &staged.handle).unwrap(), WEBP);
    assert_eq!(pack.items[1].staged.as_ref().unwrap().content_type, "image/gif");
    assert_eq!(root.staged(), 2);
}

#[test]
fn an_unknown_file_type_is_listed_but_not_staged() {
    let root = Root::new();
    let manifest = manifest(&[("items/0001.bin", "sticker")]);
    let pack = read_pack(zip(&[("manifest.json", &manifest), ("items/0001.bin", b"nothing known")]), &root.0, Limits::default()).unwrap();
    assert!(pack.items[0].staged.is_none());
    assert_eq!(root.staged(), 0);
}

#[test]
fn rejects_paths_outside_items() {
    for name in ["../evil.webp", "items/../evil.webp", "items/sub/evil.webp", "/etc/evil.webp", "items/..\\evil.webp", "items/.hidden", "other.json", "items/C:evil"] {
        let root = Root::new();
        let manifest = manifest(&[("items/0001.webp", "sticker")]);
        let result = read_pack(zip(&[("manifest.json", &manifest), ("items/0001.webp", WEBP), (name, WEBP)]), &root.0, Limits::default());
        assert_eq!(result.unwrap_err(), LibraryError::BadEntry, "{name}");
        assert_eq!(root.staged(), 0);
    }
    assert!(item_entry("items/0001.webm"));
    assert!(!item_entry("items/"));
}

#[test]
fn a_manifest_naming_a_path_is_refused() {
    let root = Root::new();
    let manifest = manifest(&[("../0001.webp", "sticker")]);
    let result = read_pack(zip(&[("manifest.json", &manifest), ("items/0001.webp", WEBP)]), &root.0, Limits::default());
    assert_eq!(result.unwrap_err(), LibraryError::BadManifest);
}

#[test]
fn rejects_too_many_items() {
    let root = Root::new();
    let files: Vec<String> = (0..501).map(|index| format!("items/{index:04}.webp")).collect();
    let listed: Vec<(&str, &str)> = files.iter().map(|file| (file.as_str(), "sticker")).collect();
    let manifest = manifest(&listed);
    let mut entries: Vec<(&str, &[u8])> = vec![("manifest.json", &manifest)];
    entries.extend(files.iter().map(|file| (file.as_str(), WEBP)));
    assert_eq!(read_pack(zip(&entries), &root.0, Limits::default()).unwrap_err(), LibraryError::TooManyItems);
    // A manifest listing more items than the zip holds is refused the same way.
    let small = Limits { items: 2, ..Limits::default() };
    let manifest = manifest_of(3);
    let result = read_pack(zip(&[("manifest.json", &manifest), ("items/0000.webp", WEBP)]), &root.0, small);
    assert_eq!(result.unwrap_err(), LibraryError::TooManyItems);
}

fn manifest_of(count: usize) -> Vec<u8> {
    let files: Vec<String> = (0..count).map(|index| format!("items/{index:04}.webp")).collect();
    manifest(&files.iter().map(|file| (file.as_str(), "sticker")).collect::<Vec<_>>())
}

#[test]
fn rejects_oversize_entries_and_packs() {
    let root = Root::new();
    let manifest = manifest(&[("items/0001.webp", "sticker")]);
    let mut big = WEBP.to_vec();
    big.resize(2048, 0);
    let tight = Limits { entry: 1024, ..Limits::default() };
    let result = read_pack(zip(&[("manifest.json", &manifest), ("items/0001.webp", &big)]), &root.0, tight);
    assert_eq!(result.unwrap_err(), LibraryError::TooLarge);

    let two = manifest_of(2);
    let tight = Limits { entry: 4096, total: 3000, ..Limits::default() };
    let result = read_pack(zip(&[("manifest.json", &two), ("items/0000.webp", &big), ("items/0001.webp", &big)]), &root.0, tight);
    assert_eq!(result.unwrap_err(), LibraryError::TooLarge);
    assert_eq!(root.staged(), 0);
}

#[test]
fn rejects_a_bad_manifest() {
    let cases: Vec<Vec<u8>> = vec![
        b"not json".to_vec(),
        br#"{"format":"zip","version":1,"title":"Cats","items":[{"file":"items/0001.webp","kind":"sticker"}]}"#.to_vec(),
        br#"{"format":"ravenpack","version":2,"title":"Cats","items":[{"file":"items/0001.webp","kind":"sticker"}]}"#.to_vec(),
        br#"{"format":"ravenpack","version":1,"title":" ","items":[{"file":"items/0001.webp","kind":"sticker"}]}"#.to_vec(),
        br#"{"format":"ravenpack","version":1,"title":"Cats","items":[{"file":"items/0001.webp","kind":"emoji"}]}"#.to_vec(),
        br#"{"format":"ravenpack","version":1,"title":"Cats","items":[{"file":"items/0009.webp","kind":"sticker"}]}"#.to_vec(),
        br#"{"format":"ravenpack","version":1,"title":"Cats","items":[]}"#.to_vec(),
        br#"{"format":"ravenpack","version":1,"title":"Cats","items":[{"file":"items/0001.webp","kind":"sticker"},{"file":"items/0001.webp","kind":"sticker"}]}"#.to_vec(),
        br#"{"format":"ravenpack","version":1,"title":"Cats","items":[{"file":"items/0001.webp","kind":"sticker","keywords":"hi"}]}"#.to_vec(),
    ];
    for manifest in cases {
        let root = Root::new();
        let result = read_pack(zip(&[("manifest.json", &manifest), ("items/0001.webp", WEBP)]), &root.0, Limits::default());
        assert_eq!(result.unwrap_err(), LibraryError::BadManifest, "{}", String::from_utf8_lossy(&manifest));
    }
    let root = Root::new();
    assert_eq!(read_pack(zip(&[("items/0001.webp", WEBP)]), &root.0, Limits::default()).unwrap_err(), LibraryError::BadManifest);
    assert_eq!(read_pack(Cursor::new(b"not a zip".to_vec()), &root.0, Limits::default()).unwrap_err(), LibraryError::NotPack);
}

#[test]
fn stage_sniffs_and_hashes() {
    let root = Root::new();
    let staged = stage(&root.0, GIF, "C:\\Users\\me\\cat.gif").unwrap();
    assert_eq!(staged.name, "cat.gif");
    assert_eq!(staged.content_type, "image/gif");
    assert_eq!(staged.size, GIF.len() as u64);
    assert_eq!(read_staged(&root.0, &staged.handle).unwrap(), GIF);
    discard(&root.0, &staged.handle).unwrap();
    assert_eq!(root.staged(), 0);
    assert_eq!(stage(&root.0, b"plain text", "notes.txt").unwrap_err(), LibraryError::Unsupported);
    assert_eq!(sniff(&[0x1F, 0x8B, 8, 0], "pack.tgs"), Some("application/x-tgsticker"));
    assert_eq!(sniff(&[0x1F, 0x8B, 8, 0], "archive.gz"), None);
    assert!(read_staged(&root.0, "../escape").is_err());
}
