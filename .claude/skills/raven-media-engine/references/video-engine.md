# Video engine

Source root: `apps/desktop/src-tauri/src/video/`. It mirrors the audio engine's
structure (state lock + async `ops` lock, desired-state reconcile) but has no DSP:
a source captures when it is enabled, publishing, and has a sink attached.

Two LiveKit connections live in `VideoEngine` (`engine.rs`), on a runtime whose
threads are named `raven-video-engine`:

- **Publisher**, identity `<userId>#video` — sends camera, display and window tracks.
- **Viewer**, identity `<userId>` — receives remote video (and, optionally, the user's
  own published video for RTC self-preview).

`VideoLinkFlags { connected, viewer_connected }` are atomics the state layer copies
into `VideoMixerState`. `mixer.session_lost` is set when either room ends for a reason
the app did not ask for; the React supervisor reacts to it.

## Send path

```
capture backend ─► I420 frame ─► ProfiledVideoFrameSink ─► RelayVideoFrameSink ─► VideoPublishSink ─► NativeVideoSource
   (own thread)                   (applies the profile)      (follows re-publish)     │
                                                                                       └─► local preview copy (optional)
```

- **Capture** (`capture.rs`, `VideoCaptureManager::reconcile`), one runtime per source:
  - Camera — `nokhwa` (Media Foundation / AVFoundation / V4L2). On Windows,
    `directshow.rs` adds a DirectShow backend for devices Media Foundation cannot open,
    notably software cameras such as OBS Virtual Camera.
  - Display and window — Windows.Graphics.Capture through `windows-capture` on
    Windows; ScreenCaptureKit on macOS; xdg-desktop-portal + PipeWire (`ashpd`) on
    Linux. `screen_capture_runtime_readiness` reports whether sharing can work.
- **Conversion** (`convert.rs`) — packed RGB/BGRA to planar I420 with BT.601, pure
  Rust. Profile dimensions are always even (`even_dimension`), as 4:2:0 requires.
- **Frame pacing** (`ProfiledVideoFrameSink`, `pacing.rs`) — Windows Graphics Capture
  delivers at the display refresh rate (and nothing while the screen is still). A
  `FramePacer` keeps a deadline that advances one interval per accepted frame and accepts
  frames up to a quarter interval early, resetting only after a gap longer than an
  interval (no burst catch-up). Do not go back to "forward if `now - last >= interval`":
  at 60 Hz with a 30 fps target it forwarded about 20 fps, and at 60 fps under 40.
  The WGC backend asks `sink.frame_due()` *before* `frame.buffer()`, so frames that
  will be dropped cost no GPU readback or BGRA→I420 (6–10 ms each at 1080p–1440p).
  `VideoCaptureCounters` (captured, forwarded) live on the capture manager and go into
  the quality report.
- **`RelayVideoFrameSink`** — a running capture holds a relay, not the publish sink
  itself, so when a track is republished after a reconnect the capture keeps running
  and simply starts feeding the new sink.
- **Publish** (`publish_source`) — track `raven-video-<trackId>`,
  `NativeVideoSource::new(resolution, is_screencast)`, `video_encoding` and
  `simulcast` from `VideoPublishTuning`.

`VideoCaptureSignature` plays the role of the audio capture signature: only changes
that need the device reopened restart a capture.

### Quality profiles (`domain.rs`)

| Profile | Resolution | fps | Max bitrate |
|---|---|---|---|
| `Presentation` | 1920×1080 | 10 | 4 Mbps |
| `High` | 1920×1080 | 30 | 6 Mbps |
| `HighMotion` | 1280×720 | 60 | 6 Mbps |
| `Balanced` | 1280×720 | 30 | 2.5 Mbps |
| `Low` | 854×480 | 15 | 750 kbps |
| `Custom` | 2…7680 × 2…4320, 1…120 fps | | pixels × fps × 0.10 (camera) or 0.12 (screen), clamped 0.3…8 Mbps |

The encoder is libwebrtc's software VP8 (`libvpx`) on Windows: webrtc-sys 0.3.34 builds
no hardware encoder there, and Raven leaves `TrackPublishOptions` at the default codec and
`VideoEncoderBackend::Auto`. The quality report shows `encoderImplementation` /
`powerEfficientEncoder` (outbound) and `decoderImplementation` (inbound), and the dock's
network popover prints them. Measured 2026-10-16 (Ryzen 9 9950X): VP8 encode 2.3–3.9 ms
per frame at 720p–1080p, `qualityLimitationReason` `none`, about 1–2 cores for the whole
app while sharing. The GPU load seen while sharing is 3D work on the display adapter (WGC's
D3D11 device and readback, the WebView compositing the preview, DWM), not Video Encode.

`resolved_for_source(width, height)` fits the profile to the real source size
(`output_dimensions_for_budget`) so a share is never upscaled or distorted. Simulcast:
camera only, long edge ≥ 960 px, not `Low` or `Presentation`.

Text sharpness on a share depends on resolution and bitrate, not frame rate, which is
why `Presentation` keeps 1080p at 10 fps. If a share looks bad, check in this order:
the profile actually applied to the source, `resolved_for_source` output, the bitrate
the SFU reports, then the *receive-side* limits below.

## Receive path and how frames reach the WebView

Frames never cross Tauri's JSON bridge. `stream.rs` runs a tiny HTTP server:

- `VideoFrameService::start()` binds `127.0.0.1:0` and generates a random token.
  `video_get_stream_endpoint` returns `base_url = http://127.0.0.1:<port>/<token>`.
- Each visible stream has two routes, both with `Access-Control-Allow-Origin: *`:
  `<streamId>.i420` (`application/octet-stream`: frames of a 16-byte LE header `RVF1`,
  width, height, payload length, then tight Y, U, V planes; about one frame of socket send
  buffer so a slow page pushes back) and `<streamId>.mjpg` (`multipart/x-mixed-replace`,
  boundary `ravenframe`, JPEGs). `components/media/VideoSurface.tsx` fetches `.i420` and
  draws it with WebGL2 (BT.601 limited range, three R8 textures, one frame per animation
  frame, so a hidden window stops reading). It falls back to an `<img>` on `.mjpg` when
  WebGL2 or a context is unavailable, a context is lost, or 12 contexts are live
  (`lib/videoFrames.ts`).
- `VideoFrameHub` holds at most one pending frame per subscriber, and each subscriber has a
  format (raw or JPEG); `publish` goes only to that format and the worker produces only
  formats someone watches (`has_subscribers_for`). `VideoFramePublisher`
  encodes on a worker only when `wants_frame()` says so: the stream has a subscriber,
  the frame-rate budget allows (the same `FramePacer`, with a third of an interval of
  early tolerance for network jitter), and the encoder is idle. An invisible tile costs
  nothing and a slow WebView drops frames instead of building a backlog.
- The JPEG step (`encode_i420_jpeg`) hands the I420 planes to libjpeg as raw 4:2:0
  YCbCr (range-expanded from video levels through lookup tables) with mozjpeg's
  *fastest* profile. mozjpeg's default profile (trellis, optimised progressive scans)
  took 360–570 ms per 1080p frame even optimised, which held every watched share and
  the local self-preview to about 2–10 fps; the raw fast path takes 11–14 ms (files are
  ~25% larger, irrelevant on loopback). `presentation_cost` in `stream.rs` is an ignored
  benchmark: `cargo.ps1 test --release --lib presentation_cost '--' --ignored --nocapture`.
  `PresentationCounters` (shown, encoded, encode time) feed the per-stream stats.

For a remote track the viewer loop does: `TrackSubscribed` →
`NativeVideoStream::new(rtc_track)` → for each decoded frame, if wanted, `to_i420()` →
`tight_i420_frame` → `VideoFramePublisher`. Stream id comes from the publication SID
(`remote_stream_id`).

Presentation limits (`VideoPresentationSettings::limits_for(source)` → width, height,
fps, JPEG quality):

| Presentation profile | Camera tiles | Screen shares |
|---|---|---|
| `Efficiency` | 640×360, 10 fps, q68 | 1920×1080, 15 fps, q92 |
| `Balanced` (default) | 960×540, 15 fps, q76 | 1920×1080, 30 fps, q92 |
| `Quality` | 1280×720, 30 fps, q84 | 1920×1080, 60 fps, q92 |

These cap only what this user's WebView is shown; they do not change what is received
from the network or what anyone else sees. A share always gets full 1080p; only its
frame rate follows the profile. The share caps were raised on 2026-10-16 (from 10/15/30)
so a default viewer sees a 30 fps share at 30; Settings › Audio and video says so.

## Self preview

`SelfPreviewMode::Local` (default): `preview.rs` (`VideoPreviewController`) wraps the
publish sinks and mirrors a bounded copy of the frames being sent straight into the
frame hub. Cheap, shows exactly what is captured, involves no network.

`SelfPreviewMode::Rtc`: the viewer subscribes to the user's own `#video` tracks, so
the preview shows what peers actually receive after encoding. Switching mode calls
`apply_viewer_subscriptions`.

## Shares with audio

`video_start_display_share` takes `with_system_audio`; `video_start_window_share`
takes `with_app_audio` plus the window's `process_id`. The command first asks the
**audio** engine for a linked source (`add_and_publish_shared_audio_source`, type
`SystemAudio` or `AppAudio`), then mutates video state, storing
`linked_audio_source_id`; if the video mutation fails the audio source is removed again. Stopping the share or
disconnecting removes the linked audio source (`remove_shared_audio_source`). The audio
mutation always happens before the video state lock is taken, never nested — that
ordering is what keeps the two engines deadlock-free. The shared audio shows up as an
ordinary mixer channel with its own strip and chain.

## Minimized windows (Windows)

Windows does not draw a minimized window, so WGC delivers nothing for it. Decided by
Soroush (2026-10-17): starting a share of a minimized app quietly restores it (no focus),
and an app minimized mid-share pauses the share instead of ending it.

- **Picker.** `imaging::window_size` reads a minimized (iconic) window from
  `GetWindowPlacement`: `rcNormalPosition`, or the monitor's work area when the window is
  restored maximized (`WPF_RESTORETOMAXIMIZED`); `restored_window_size` is the pure part.
  `GetWindowRect` would give the ~160×28 title-bar box parked at -32000. A minimized
  window gets `minimized: true` and no thumbnail (`PrintWindow` gives a stub); the picker
  shows its icon and "Minimized".
- **Share size.** `video_start_window_share` resolves the profile from
  `window_share_size(window_id)` (same function), not from the size the UI sent, which is
  only a fallback. Capture start still restores the window (`restore_window_if_minimized`).
  The output size is fixed for the share: resizing the window mid-share scales frames into
  the original shape (stretched, not letterboxed).
- **Pause.** A window share's runtime runs a `WindowWatch` thread (`raven-window-watch`)
  that checks `IsWindow` / `IsIconic` every 250 ms (`WindowShareActivity`). While
  minimized: the runtime reports `status: paused`, `pausedReason: minimized`; WGC frames
  are ignored; the watcher re-sends the held frame (`HeldFrame`, a copy of a sent frame
  kept at most every 250 ms by `ProfiledVideoFrameSink`) every 500 ms. The track stays
  **unmuted** — a muted screen track means "not sharing" to the UI — so viewers keep the
  picture and a Watch during the pause still gets a keyframe.
- **Telling the engine.** Captures report through `CaptureEvents` (installed by
  `finish_video_mutation`). `StateChanged` runs `resync_video`; reconcile reads the
  runtime's new state. `TargetClosed` (the watcher, or WGC's `on_closed` for a closed
  window or unplugged monitor) stops the source like Stop sharing, linked audio included.
- **Telling viewers.** `VideoEngine::reconcile_share_attributes` keeps the publisher's
  participant attribute `raven.share.paused` (`SHARE_PAUSED_ATTRIBUTE`) at `minimized`
  while a published share is paused and `""` (deleted) otherwise; it sends only on change
  and starts empty on each connect. The viewer copies it onto that participant's screen
  share as `RemoteVideoTrackState.pausedReason`. The UI dims the picture and says why
  (`MediaTile`, the share cards, the dock's share tooltip and icon, one toast).

Linux (portal) and macOS (ScreenCaptureKit) have no watcher: what a minimized window does
there is untested.

## Picture in picture

Each video can have its own always-on-top Tauri window (`lib/pictureInPicture.ts`,
`components/media/PictureInPictureWindow.tsx`, `shells/ravenv1/usePictureInPicture.ts`).
Browser picture in picture is not an option: it needs a `<video>`, and frames are raw I420
on a WebGL canvas (MJPEG in an `<img>` as the fallback).

- **The engine has no idea.** A window reads `video_get_state` and the loopback endpoint
  itself and finds its tile through `useNativeMediaTiles`. `VideoFrameHub` fans out one
  JPEG, so a window adds no capture or encode.
- **Closing.** A window closes itself after 5 s with nothing to show: no tile, camera off,
  or not receiving. `viewerConnected` false is "Reconnecting…", not gone. Main closes all
  of them when `activeNestId` clears, which is a real leave, and on page load, so a reload
  mid-call closes them.
- **A hard-killed sharer** closes the window only once LiveKit drops the participant, about
  20 s later.
- **Your own camera** keeps `syncLocalPreviewEnabled` on while it is in a window, with
  Raven hidden or the Mixer open.
- **Capture.** `contentProtected` gives affinity 17 (`WDA_EXCLUDEFROMCAPTURE`) on Windows.
  `video/capture.rs` also drops these windows from the picker by title and process id; the
  title lives in both places. Linux has no such option.

## Commands (`state.rs`)

`video_connect_room(url, publisherToken, viewerToken)`, `video_disconnect_room`,
`video_start_camera`, `video_start_display_share`, `video_start_window_share`,
`video_set_source_profile`, `video_stop_source`, `video_set_self_preview_mode`,
`video_set_presentation_profile`, `video_set_remote_video_receiving`,
`video_set_local_preview_enabled`, `video_get_stream_endpoint`, `video_list_cameras`,
`video_list_displays`, `video_list_windows`, `video_get_state`,
`video_get_capabilities`, `video_get_network_totals`, `video_get_quality_report`,
`video_get_stream_stats`.

`video_get_stream_stats(streamIds?)` returns one `VideoStreamStats` per subscribed remote
video track, keyed by `remote_stream_id`: decoded size, received/decoded/shown fps,
bitrate, loss, jitter, frames dropped, codec, decoder, published size and the average
JPEG time (zero while only raw viewers watch; `shown` counts frames of either format). Rates are deltas against the previous call (`VideoStreamStatsCache`, at least
500 ms apart; a call sooner reuses the last rates), so the first call returns null rates.
The ops lock is held only to collect track handles. The sender's requested frame rate is
not signalled to receivers (LiveKit publications carry dimensions only), so it is absent.

Mutations go through `mutate_video_state` → `finish_video_mutation`, which reconciles
publications and capture runtimes and emits `video-state-changed` with the full
`VideoMixerState` (`connected`, `viewerConnected`, `sessionLost`, `localSources`,
`participants`, `remoteTracks`, `selfPreviewMode`, `presentation`).

Per-participant receive choices (Watch / Stop watching) live in
`VideoEngineState.remote_preferences`, keyed by `subscription_key(participant, source)`.
They are passed into `connect`, so an automatic rejoin keeps them, and cleared by
`video_disconnect_room`. Without one, cameras are received and screen shares are not
(`should_receive_video`); the UI reads a track's `desired` flag as "you are watching it".
