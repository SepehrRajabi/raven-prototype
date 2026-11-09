fn main() {
    #[cfg(target_os = "macos")]
    link_swift_runtime();

    tauri_build::build()
}

/// The ScreenCaptureKit crates (screencapturekit, apple-metal, apple-cf) ship Swift
/// bridges whose objects need Swift's static compatibility libraries
/// (`libswiftCompatibility56.a` and friends). Their build scripts only add the full
/// Xcode toolchain path, so a machine with just the Command Line Tools fails to link
/// with an undefined `__swift_FORCE_LOAD_$_swiftCompatibility56`. Ask the active
/// toolchain where `swiftc` lives and add its `lib/swift/macosx` beside it, which is
/// right for both Xcode and the Command Line Tools.
///
/// The bridges also load the Swift runtime (`@rpath/libswift_Concurrency.dylib`), which
/// ships with macOS in /usr/lib/swift. apple-metal adds that rpath with
/// `rustc-link-arg`, but a dependency's link args never reach our binary, so without
/// this the app aborts at launch with "Library not loaded".
#[cfg(target_os = "macos")]
fn link_swift_runtime() {
    use std::path::PathBuf;
    use std::process::Command;

    link_webrtc_objc_categories();
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");

    let Ok(output) = Command::new("xcrun").args(["--find", "swiftc"]).output() else {
        return;
    };
    if !output.status.success() {
        return;
    }
    let swiftc = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
    // .../usr/bin/swiftc -> .../usr/lib/swift/macosx
    let Some(usr) = swiftc.parent().and_then(|bin| bin.parent()) else {
        return;
    };
    let lib = usr.join("lib/swift/macosx");
    if lib.is_dir() {
        println!("cargo:rustc-link-search=native={}", lib.display());
    }
}

/// LiveKit's libwebrtc.a adds Objective-C categories, to Foundation classes
/// (`+[NSString stringForAbslStringView:]`) and to its own. No symbol points at a
/// category, so the linker leaves those object files out and the app aborts with
/// "unrecognized selector" when WebRTC lists its video encoders, as a call starts.
///
/// The usual cure, `-ObjC`, loads every Objective-C and Swift object in the link, and
/// screencapturekit and apple-cf both ship a Swift module named CoreMediaBridge, which
/// then collide. Force-loading all of libwebrtc.a fails too: it holds tools with their own
/// `main`. So copy just the object files that define categories into an archive of their
/// own and force-load that. The linker then has their symbols and never takes the same
/// files from libwebrtc.a.
#[cfg(target_os = "macos")]
fn link_webrtc_objc_categories() {
    use std::path::PathBuf;
    use std::process::Command;

    // The same locked, idempotent download webrtc-sys does; this script may run first.
    if webrtc_sys_build::custom_dir().is_none() {
        webrtc_sys_build::download_webrtc().expect("could not download LiveKit's libwebrtc");
    }
    let lib = webrtc_sys_build::webrtc_dir().join("lib/libwebrtc.a");
    println!("cargo:rerun-if-changed={}", lib.display());

    let listing = Command::new("nm")
        .arg("-A")
        .arg(&lib)
        .output()
        .expect("could not run nm on libwebrtc.a");
    assert!(listing.status.success(), "nm failed on {}", lib.display());
    // Lines read "<archive>:<member>: <address> s __OBJC_$_CATEGORY_...".
    let prefix = format!("{}:", lib.display());
    let mut members: Vec<String> = String::from_utf8_lossy(&listing.stdout)
        .lines()
        .filter(|line| line.contains("__OBJC_$_CATEGORY_"))
        .filter_map(|line| line.strip_prefix(&prefix)?.split(": ").next())
        .map(str::to_owned)
        .collect();
    members.sort();
    members.dedup();
    assert!(!members.is_empty(), "found no Objective-C categories in {}", lib.display());

    let dir = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("webrtc-objc-categories");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let run = |command: &mut Command| {
        let status = command.current_dir(&dir).status().expect("could not run ar");
        assert!(status.success(), "{command:?} failed");
    };
    run(Command::new("ar").arg("-x").arg(&lib).args(&members));
    let archive = dir.join("libraven_webrtc_objc_categories.a");
    run(Command::new("ar").arg("-rcs").arg(&archive).args(&members));
    println!("cargo:rustc-link-arg=-Wl,-force_load,{}", archive.display());
}
