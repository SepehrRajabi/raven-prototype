# Desktop review: native Rust (Tauri)

**Date:** 2026-11-13 · **Reviewer model:** Fable 5.2 · **Grade:** B

**Scope:** all of `apps/desktop/src-tauri/src`: command registration in `lib.rs`, `audio/`, `video/`, `workshop/`, `attachments/`, `library/` (`.ravenpack` parsing), `updater.rs`, the tray, overlay, picture-in-picture and fullscreen windows, `push_to_talk`, `media_hotkeys`, `notifications`, `diagnostics` and `account_export`. Also `tauri.conf.json`, `capabilities/*.json` and `Cargo.toml`. Vendored code was skipped.

Paths below are relative to `apps/desktop/src-tauri/`.

## 1. Assessment

The native side is in good shape for a prototype of this size (about 42k lines). The documented lock rule is followed: every mutating command takes `ops`, changes the model under a short state lock, releases it, then reconciles. Clippy found no lock held across an `.await`. Workshop, `.ravenpack` and attachment parsing are written defensively. The weaknesses are a wide-open IPC surface (no CSP, no per-window command scoping), a capture callback that allocates and takes locks, blocking work in synchronous commands, and a few network awaits without timeouts while `ops` is held. The Windows and Linux code was read but only compiled and tested on macOS.

## 2. Findings

| Sev | Location | Issue | Failure scenario | Fix | Status |
|---|---|---|---|---|---|
| **High** | `tauri.conf.json:28`, `capabilities/default.json:5`, `build.rs` | `"csp": null`, and no `AppManifest::commands`, so all ~150 commands are callable from every window (main, overlay, `pip-*`, `nest-window-*`). Only the updater checks the caller (`updater.rs:432`). | One script injection in any window can start the camera or a screen share, publish any local port (`workshop_publish`), or read local media. | Set a strict CSP; scope commands per window in `build.rs`; reuse `require_main` for media and Workshop commands. | CONFIRMED (config); whether remote origins can also call app commands: PLAUSIBLE |
| **Med** | `library/mod.rs:258,307`, `attachments/mod.rs:249` | `library_stage {path}`, `read_ravenpack(path)` and `attachment_prepare {path}` open any path the page supplies. | Combined with the row above, a script reads any GIF, PNG, WebP, MP4, WebM or zip on disk and gets it back through `library_read`. | Accept only paths the native picker or drop handler issued (a token map). | CONFIRMED |
| **Med** | `audio/capture.rs:1819-1860, 1790-1806, 1913`; `audio/engine.rs:534-580` | The cpal input callback runs the whole chain inline: about 8 `Vec` allocations per 10 ms frame, three mutexes, `eprintln!`, and Studio inference. | Under allocator or lock contention the device thread overruns, causing dropouts or a false "Studio too slow" fallback to Strong. | Preallocate scratch buffers; hand frames to a worker thread through an SPSC ring; no logging in the callback. | Code CONFIRMED; impact PLAUSIBLE |
| **Med** | `audio/playback.rs:416` | The output callback takes blocking `bus.tracks`, cue and reference locks that reader tasks also take. | A preempted reader holding the lock causes an audible glitch. | `try_lock` and repeat the last buffer, or use lock-free per-track rings. | PLAUSIBLE |
| **Med** | `audio/state.rs:2575-2607`, `audio/engine.rs:716,775`; `video/engine.rs:883,942` | `Room::connect` and `room.close()` are awaited with no timeout while `ops` is held. | On a black-holed network, mute, gain and leave all queue behind the connect or close. | Wrap them in `tokio::time::timeout`; close in a detached task. | PLAUSIBLE (depends on LiveKit's own timeouts) |
| **Med** | `audio/state.rs:1906-1916, 2113, 2171-2247`; `video/state.rs:397-409` | Synchronous commands run on the main thread: cpal, camera and window enumeration (with thumbnails), and preset saves that write a file under the state write lock. | The UI freezes while devices are listed on Windows; meters stall during a slow disk write. | Make them `async` with `spawn_blocking`; save after dropping the guard. | CONFIRMED |
| **Med** | `updater.rs:205-221` | The signature covers only the installer; the version comes from the unsigned manifest; nothing native checks the version or call state (`busy` is set by the page). | Whoever controls the update host relabels an older signed build as "9.9.9" and rolls users back. | Check the installed version after install; gate install on the engine's own connected flag. | PLAUSIBLE (plugin behaviour not re-read) |
| **Low** | `workshop/link.rs:586`, `workshop/wss.rs` | The handshake has no timeout, and the WSS route has no keepalive or idle timeout (QUIC has both). | A relay that accepts the WebSocket and then goes silent hangs `workshop_publish`; a half-open TCP session stays "live". | Time out the handshake; add WebSocket pings. | CONFIRMED |
| **Low** | `workshop/consumer.rs:1011` | Accept errors are ignored and the loop continues. | Running out of file descriptors spins a core. | Back off on error. | PLAUSIBLE |
| **Low** | `diagnostics.rs:205-217` | Renderer-crash recovery reloads with no backoff or cap. | A page that crashes on load loops crash → disconnect → reload forever. | Cap attempts within a time window. | PLAUSIBLE |
| **Low** | `video/capture.rs:2094-2101` | `FD_CLOEXEC` is cleared on the PipeWire screencast fd in the parent, and `gst-launch-1.0` and `pw-record` are found through `PATH`. | Any child spawned at the same time inherits the screen-capture fd. | `dup2` in `pre_exec`; use absolute or validated binaries. | CONFIRMED |
| **Low** | `audio/capture.rs:518` | `stop()` signals but does not join; a restart reopens the device within the 100 ms tick. | An exclusive ALSA device reports busy, and the first-open error is returned with no retry until the next change. | Join with a bound, or retry the first open. | PLAUSIBLE |
| **Low** | `audio/devices.rs:17` | Full cpal enumeration every 2 s (6 s on Linux) for the life of the app, even idle in the tray. | Battery drain and ALSA probing while not in a call. | Use OS device notifications, or poll only when visible or in a call. | CONFIRMED |
| **Low** | `video/directshow.rs:207-210` | The `pUnk` of the `AM_MEDIA_TYPE` returned by `GetConnectedMediaType` is never released, and the frame buffer is sized from device-reported dimensions without a cap. | A small leak per camera open. The vtable order and buffer-size handling are otherwise sound. | Release `pUnk`; clamp the dimensions. | CONFIRMED |
| **Low** | `Cargo.toml:9`, `video/capture.rs:177` | `rust-version = 1.77.2`, but `is_none_or` needs 1.82. | The build fails on the declared minimum Rust version. | Raise `rust-version`. | CONFIRMED (clippy) |
| **Low** | `video/stream.rs:134` | One thread per loopback connection, uncapped. | A local process exhausts threads (5 s each). | Cap concurrent clients. | CONFIRMED |

## 3. Strengths and recommendations

**Strengths**

- **Lock discipline:** `ops` is always taken before state; device and network work runs with state released; `block_in_place` wraps device opens.
- **Resilience:** `catch_unwind` around capture processing, the JPEG encoder and the Studio model build; poisoned locks recover; NaN output triggers a rebuild; stall detection and device following are in place.
- **Workshop:** loopback-only dial and bind are enforced in code; TLS 1.3 with webpki roots; the insecure verifier and `ws://` are compiled out of release builds; frames are capped at 4 KB; flows are bounded by QUIC and yamux stream limits.
- **Parsing:** `.ravenpack` has a strict entry-name allowlist, count and size caps checked both before and during reads, and nothing is extracted to archive-named paths. Images have dimension and allocation limits, UUID handles and symlink checks.
- **Updater:** main-window-only; the endpoint override is debug-only; the public key in `tauri.conf.json` matches `updater/raven-updater.key.pub`.

**Recommendations**

- Split the largest files, which mix platform backends: `audio/state.rs` (5.3k lines) and `audio/capture.rs` (4.9k).
- Add CI that runs `cargo check` and clippy on Windows and Linux. The `#[cfg(windows)]` code (WASAPI, DirectShow, WebView2, subclassing) holds most of the `unsafe` code and was not compiled in this review.
- Add tests for command and capability scoping, the Workshop handshake timeout, and updater state transitions.

## 4. Build, test and clippy (macOS host only)

- `cargo clippy --all-targets --locked`: exit 0, with 31 warnings in the library, all style-level: derivable `Default`, `div_ceil`, too many arguments, an unused import in `media_hotkeys.rs:9`, a dead `prefers_directshow`, and the `rust-version` mismatch.
- `cargo test --lib --locked`: 353 passed, 0 failed, 5 ignored (three are the live Workshop tests).
