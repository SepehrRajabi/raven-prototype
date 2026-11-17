use std::{env, fs, path::PathBuf};

fn main() {
    tauri_plugin::Builder::new(&[])
        .android_path("android")
        .try_build()
        .expect("failed to build raven-mobile-native Tauri plugin");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        stage_webrtc();
    }
}

/// Copies what Gradle needs from the exact libwebrtc archive webrtc-sys selected: its Java
/// classes, and the JNI companion with its C++ runtime. A jar from another WebRTC revision
/// breaks JNI. `scripts/mobile-native.ts` sets the destinations, which Gradle also reads;
/// a plain `cargo check` leaves them unset and skips staging.
fn stage_webrtc() {
    println!("cargo:rerun-if-env-changed=ORG_GRADLE_PROJECT_ravenWebrtcJar");
    println!("cargo:rerun-if-env-changed=ORG_GRADLE_PROJECT_ravenNativeLibs");
    println!("cargo:rerun-if-env-changed=ANDROID_NDK_HOME");
    let (Some(jar_out), Some(libs_out)) = (
        env::var_os("ORG_GRADLE_PROJECT_ravenWebrtcJar").map(PathBuf::from),
        env::var_os("ORG_GRADLE_PROJECT_ravenNativeLibs").map(PathBuf::from),
    ) else {
        return;
    };
    assert_eq!(
        env::var("CARGO_CFG_TARGET_ARCH").as_deref(),
        Ok("aarch64"),
        "Raven's Android build supports arm64 only"
    );
    if webrtc_sys_build::custom_dir().is_none() {
        webrtc_sys_build::download_webrtc().expect("could not download Android libwebrtc");
    }
    let webrtc = webrtc_sys_build::webrtc_dir();
    let jar = webrtc.join("libwebrtc.jar");
    // The locked jar is relocated to livekit.org.webrtc and loads lkjingle_peerconnection_so,
    // which needs the NDK's shared C++ runtime beside it.
    let companion = webrtc.join("lib/libjingle_peerconnection_so.so");
    let cpp_runtime = webrtc_sys_build::android_ndk_toolchain()
        .expect("Android NDK toolchain is unavailable")
        .join("sysroot/usr/lib/aarch64-linux-android/libc++_shared.so");
    let libs_out = libs_out.join("arm64-v8a");
    fs::create_dir_all(jar_out.parent().expect("jar destination has a parent"))
        .expect("could not create the Android jar staging directory");
    fs::create_dir_all(&libs_out).expect("could not create the Android library staging directory");
    fs::copy(&jar, &jar_out).expect("locked WebRTC archive has no readable libwebrtc.jar");
    fs::copy(
        &companion,
        libs_out.join("liblkjingle_peerconnection_so.so"),
    )
    .expect("locked WebRTC archive has no JNI companion");
    fs::copy(&cpp_runtime, libs_out.join("libc++_shared.so"))
        .expect("Android NDK has no shared C++ runtime");
    for input in [&jar, &companion, &cpp_runtime] {
        println!("cargo:rerun-if-changed={}", input.display());
    }
}
