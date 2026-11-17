# Platform Media Support

This note tracks native desktop media capture support by operating system.

## macOS

### Supported

- **Camera capture**
  - Uses `nokhwa` through the existing camera interface.
  - On macOS this relies on AVFoundation-compatible camera devices.
  - Raven asks macOS for camera access the first time the camera is turned on, before
    `nokhwa` touches the device. If access was refused, turning the camera on says where
    in System Settings to allow it.
  - Mac cameras offer no MJPEG, so Raven falls back to the formats they do offer
    (usually YUYV) when the MJPEG request fails.

- **Display capture**
  - Uses ScreenCaptureKit through the existing video capture interface.
  - Raven enumerates ScreenCaptureKit displays and captures BGRA frames, then converts them to I420 for the existing video publish path.
  - Display sharing can create a linked `SystemAudio` mixer source when the user enables display audio.

- **Window capture**
  - Uses ScreenCaptureKit window enumeration and desktop-independent window filters.
  - Raven reports window capture support on macOS and can link the window share to an `AppAudio` source for the window owning process.

- **System audio capture**
  - Uses ScreenCaptureKit audio capture at 48 kHz stereo.
  - The captured samples flow through the same Raven gain, mute, metering, safety, processing, and publishing path as other local audio sources.
  - Current capture excludes Raven's own process audio.

- **Application audio capture**
  - Uses the best available ScreenCaptureKit path: Raven lists ScreenCaptureKit running applications and captures audio by filtering the stream to the selected app process.
  - This is exposed through the existing `AppAudio` source type and app-process list capability on macOS.

### Not Supported / Current Limitations

- **Legacy `ScreenAudio` source type**
  - The native capture path still reports `supports_screen_audio: false`.
  - Screen/display audio should be represented as linked `SystemAudio` or `AppAudio` sources, not as the older `ScreenAudio` source type.

- **Per-window-only audio**
  - Window audio links to the owning application process.
  - If an app has multiple windows or helper processes, ScreenCaptureKit may behave like app-scoped capture rather than exact single-window audio isolation.

- **Output-device-specific system audio**
  - The current macOS ScreenCaptureKit system-audio path captures the system mix; it does not yet select a particular output device.
  - Any selected output device name should be treated as UI metadata unless a real device-specific macOS path is added.

- **App icons and thumbnails**
  - macOS app-audio and window enumeration currently return no icon or thumbnail data URLs.
  - The UI should tolerate missing icons and use text labels or fallback glyphs.

- **Permission-free capture**
  - ScreenCaptureKit requires macOS privacy permission for screen/system audio recording.
  - Permission denial should be treated as a runtime environment problem, not as a compile or capability failure.

## macOS Build Requirements

Build and runtime validation should happen on real macOS hardware or a macOS CI runner with the Apple SDK available. Windows or Linux cross-checks are not enough for ScreenCaptureKit.

Install:

- Xcode Command Line Tools: `xcode-select --install`
- Rust stable with the host Apple target, for example `aarch64-apple-darwin` on Apple Silicon or `x86_64-apple-darwin` on Intel
- Bun and the normal Tauri desktop build prerequisites
- A macOS version new enough for ScreenCaptureKit audio capture; target macOS 13+ for system/app audio

Confirm the app bundle has a screen-capture usage description before packaged testing. ScreenCaptureKit apps should include `NSScreenCaptureUsageDescription` in the generated `Info.plist`; add or verify the Tauri macOS bundle config for this before release packaging.

## macOS Verification Plan

Run these on macOS:

1. Check toolchain availability:

```bash
xcode-select -p
swift --version
rustup target list --installed | grep apple-darwin
```

2. Build and type-check the desktop app:

```bash
cd apps/desktop/src-tauri
cargo fmt -- --check
cargo check --lib
```

3. Build the frontend:

```bash
cd apps/desktop
bun install
bun run build
```

4. Run Raven and test capture flows:

```bash
cd apps/desktop
bun run tauri dev
```

Manual checks:

- `video_get_capabilities` reports camera, display, window, display audio, and window audio support.
- `audio_get_capabilities` reports microphone, system audio, app audio, input devices, output devices, and app-audio process listing support.
- Camera list shows AVFoundation cameras and can publish a camera track.
- Display list shows physical displays; display share publishes frames.
- Window list shows on-screen windows with app names and process ids; window share publishes frames.
- Display share with audio creates a linked `SystemAudio` source and the audio meter moves while desktop audio plays.
- Window share with app audio creates a linked `AppAudio` source for the owning process and the meter moves while that app plays audio.
- App audio picker lists ScreenCaptureKit applications and can publish at least one active media app.
- Stopping a display/window share also removes its linked audio source.
- Permission-denied behavior is understandable: revoke Screen & System Audio Recording permission, start capture, and verify Raven surfaces a useful error.

If macOS privacy permissions get wedged during testing, reset them and relaunch Raven:

```bash
tccutil reset ScreenCapture
```

## macOS Cross-Build Note

ScreenCaptureKit depends on Apple SDK and Swift/Objective-C runtime pieces that are not meaningfully validated from this Windows checkout. Treat a Windows-hosted `cargo check --lib` as a regression check for non-macOS code only. The source of truth for macOS support is a native macOS `cargo check`, Tauri run, and manual ScreenCaptureKit permission/capture test.

## Linux

### Supported

- **Camera capture**
  - Uses `nokhwa` through the existing camera interface.
  - On Linux this relies on V4L2-compatible camera devices.

- **Display capture**
  - Uses `xdg-desktop-portal` ScreenCast for user-approved source selection.
  - Uses PipeWire as the compositor-provided capture transport.
  - The current implementation launches a GStreamer pipeline from the portal PipeWire stream and feeds raw I420 frames into Raven's existing video publish path.

- **Window capture**
  - Uses the same `xdg-desktop-portal` ScreenCast path as display capture.
  - The portal is responsible for presenting the compositor's window picker.
  - Raven exposes a portal-backed picker entry instead of enumerating Wayland windows directly.

- **System audio capture**
  - Uses PipeWire sink-monitor capture through `pw-record`.
  - Output devices are discovered with `pw-dump` when available, with CPAL output enumeration as a fallback for UI listing.
  - Captured samples flow through the same Raven audio processing, metering, gain, mute, safety, and publishing path as other local audio sources.

### Not Supported

- **Per-application audio capture**
  - Linux does not have a portable equivalent to the Windows process-loopback path currently used by Raven.
  - App audio is reported as unsupported in native capabilities.
  - The UI should guide users to use system audio capture instead.

- **Window-specific audio capture**
  - Because app audio is unsupported, window share audio is disabled on Linux.
  - Display/system audio capture remains available.

- **Direct Wayland window/display enumeration**
  - Raven should not try to bypass the desktop portal on Wayland.
  - The portal/compositor owns the real source selection UX and permission flow.

## Linux Build Requirements

Install the normal Rust, Bun, and Tauri Linux build dependencies, plus media stack packages:

- `xdg-desktop-portal`
- A portal backend for the desktop environment, for example `xdg-desktop-portal-gnome`, `xdg-desktop-portal-kde`, or `xdg-desktop-portal-wlr`
- PipeWire and a session manager, usually WirePlumber
- PipeWire tools: `pw-record`, `pw-dump`
- Pulse compatibility tools if available: `pactl`
- GStreamer runtime and PipeWire plugin, including `gst-launch-1.0` and `pipewiresrc`

Example Debian/Ubuntu package set:

```bash
sudo apt install \
  build-essential pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev \
  xdg-desktop-portal pipewire wireplumber pipewire-bin pulseaudio-utils \
  gstreamer1.0-tools gstreamer1.0-pipewire gstreamer1.0-plugins-base gstreamer1.0-plugins-good
```

Package names vary by distro. On Fedora/Arch, install the equivalent WebKitGTK/Tauri build dependencies, portal backend, PipeWire tools, and GStreamer PipeWire plugin.

## Linux Verification Plan

Run these on an actual Linux desktop session, not from Windows cross-compilation:

1. Check tool availability:

```bash
command -v xdg-desktop-portal
command -v pw-record
command -v pw-dump
command -v gst-launch-1.0
gst-inspect-1.0 pipewiresrc
```

2. Confirm PipeWire sees output sinks:

```bash
pw-dump | grep -E '"media.class"|Audio/Sink|node.name' -n
pactl get-default-sink
```

3. Build and type-check the desktop app:

```bash
cd apps/desktop/src-tauri
cargo fmt -- --check
cargo check --lib
```

4. Build the frontend:

```bash
cd apps/desktop
bun install
bun run build
```

5. Run Raven and test capture flows:

```bash
cd apps/desktop
bun run tauri dev
```

Manual checks:

- Camera list shows V4L2 cameras and can publish a camera track.
- Screen share opens the portal chooser and publishes selected display frames.
- Window share opens the portal chooser and publishes selected window frames.
- System audio source lists output sinks and shows live meter movement while desktop audio plays.
- App audio is not offered as supported on Linux and the UI explains that system audio should be used instead.

## Cross-Build Note

Linux media support should be validated on Linux. A Windows-hosted `cargo check --target x86_64-unknown-linux-gnu` can be blocked by existing native C/C++ dependencies and missing Linux cross toolchains before it reaches Raven's Linux capture code. Treat native Linux `cargo check` and runtime portal/PipeWire testing as the source of truth.
