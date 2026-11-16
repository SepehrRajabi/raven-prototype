//! Paths the person handed to Raven: files dropped on a window, and packs chosen in the
//! native picker. Commands that read a file by path (`attachment_prepare`,
//! `library_stage`, `read_ravenpack`) accept only these, so a script in the page cannot
//! name some other file on disk and read it back through a staged handle.
//!
//! The list lives in memory for the session and is never written anywhere. A dropped
//! path stays usable, because the composer prepares an image again when the person
//! switches between standard and full quality.

use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock, PoisonError},
};

use tauri::{DragDropEvent, Runtime, Window, WindowEvent};

/// Enough for any drop or import a person makes in one session; the oldest go first.
const LIMIT: usize = 512;

fn granted() -> &'static Mutex<VecDeque<PathBuf>> {
    static GRANTED: OnceLock<Mutex<VecDeque<PathBuf>>> = OnceLock::new();
    GRANTED.get_or_init(Default::default)
}

fn push(list: &mut VecDeque<PathBuf>, path: PathBuf) {
    if list.contains(&path) {
        return;
    }
    if list.len() >= LIMIT {
        list.pop_front();
    }
    list.push_back(path);
}

/// Records a path the person chose. Called by the native picker and the drop handler.
pub fn grant(path: &Path) {
    let mut list = granted().lock().unwrap_or_else(PoisonError::into_inner);
    push(&mut list, path.to_path_buf());
}

/// True when `path` was dropped or picked in this session, spelled exactly as Raven
/// handed it to the page.
pub fn is_granted(path: &Path) -> bool {
    granted()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .iter()
        .any(|granted| granted == path)
}

/// Window event hook: Tauri hands the dropped paths to the page in the same event, so
/// they are granted before the page can ask for them.
pub fn on_window_event<R: Runtime>(_window: &Window<R>, event: &WindowEvent) {
    if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event {
        for path in paths {
            grant(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_granted_paths_pass() {
        let path = PathBuf::from("/tmp/raven-picked-paths-test/dropped.gif");
        assert!(!is_granted(&path));
        grant(&path);
        assert!(is_granted(&path));
        assert!(!is_granted(Path::new("/tmp/raven-picked-paths-test/other.gif")));
        assert!(!is_granted(Path::new("/tmp/raven-picked-paths-test/../raven-picked-paths-test/dropped.gif")));
    }

    #[test]
    fn the_list_is_bounded() {
        let mut list = VecDeque::new();
        for i in 0..LIMIT + 10 {
            push(&mut list, PathBuf::from(format!("/f{i}")));
        }
        assert_eq!(list.len(), LIMIT);
        assert!(!list.contains(&PathBuf::from("/f0")));
        push(&mut list, PathBuf::from(format!("/f{}", LIMIT + 9)));
        assert_eq!(list.len(), LIMIT);
    }
}
