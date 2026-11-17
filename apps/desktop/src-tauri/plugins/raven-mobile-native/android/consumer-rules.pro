# Keep methods discovered reflectively by Tauri's Android plugin registrar.
-keep class app.raven.mobilenative.** { *; }
# Rust/WebRTC resolves these classes and callbacks through JNI, invisible to R8.
-keep class livekit.org.webrtc.** { *; }
