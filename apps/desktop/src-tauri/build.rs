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
