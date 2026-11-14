# WebRTC and LiveKit

Raven does not implement WebRTC. It uses the LiveKit Rust SDK (`livekit` 0.7.45), which
wraps Google's libwebrtc (`libwebrtc` 0.3.36, prebuilt, statically linked) and talks to
a LiveKit SFU. Raven supplies raw audio and video frames and consumes decoded ones;
codecs, RTP, ICE, DTLS/SRTP, congestion control and the jitter buffer live in libwebrtc.

When SDK behaviour matters, read the SDK source for the locked version under
`~/.cargo/registry/src/*/livekit-0.7.45` and `libwebrtc-0.3.36`. Do not reason from the
JavaScript SDK's documentation; the Rust SDK exposes less and behaves differently.

## Topology

```
Raven API  ──(JWT)──►  desktop app  ══(WebSocket signalling + WebRTC media)══►  LiveKit SFU
```

- Room name: `raven-nest-<nestId>` (`liveKitSessionName` in the Go API).
- `POST /v1/nests/:id/livekit-token[?identity=audio|video]` mints a token only when the
  caller's membership in the Nest is `joined`. It returns `{ url, token, sessionName,
  identity, displayName }`.
- Identities: `<userId>` (viewer), `<userId>#audio`, `<userId>#video`. Anything that
  shows a person must fold the suffix away: `base_participant_identity` in Rust,
  `stripSidecarIdentity` in `src/lib/mediaIdentity.ts`.
- A second sign-in with the same account evicts the first: LiveKit disconnects it with
  `DuplicateIdentity`, which Raven treats as final (no auto-rejoin, or the two apps
  would fight forever).

What the split gives: each role has its own connection, so a video reconnect cannot
interrupt audio, and the viewer can subscribe to the user's own `#video` track for RTC
self-preview — a LiveKit participant cannot subscribe to its own publications.

## Naming contract between peers

| Thing | Name |
|---|---|
| Audio track | `raven-audio-<trackId>` (trackId derived from the source id) |
| Audio stream id | `raven-source-<sourceId>` |
| Video track | `raven-video-<trackId>` |
| Video stream id | `raven-video-source-<sourceId>` |

A peer accepts an audio track only if it is audio, named `raven-audio-<uuid>`, and
published by an identity whose base is a UUID (hyphenated or 32 hex). The track's
LiveKit `source` gives the coarse type (`Microphone`, `ScreenshareAudio`); the precise
type and human names come from the publisher's **participant metadata**: a JSON map of
`trackId → { sourceType, displayName, deviceName, appName, appExeName,
appIconDataUrl }` (`SharedTrackMeta`, set with `set_metadata` during reconcile, read on
`ParticipantMetadataChanged`). App fields are filled only for app audio: the name,
executable and 32 px PNG icon are resolved from the process id when the source is
created (`resolve_app_identity`). A window share's linked audio is named after the app,
never the window title, which is private. Icons over 16 KiB are left out, and all icons
are dropped if the JSON would pass 64 KiB (LiveKit v1.13's default limit is 512 KiB, but
every change is broadcast to each peer).

## Subscriptions

Every room connects with `auto_subscribe = false`. Each engine decides per publication
and calls `set_subscribed`:

- Audio (`desired_remote_audio_subscription`): audio kind, `raven-audio-` prefix, not
  our own base identity, and receiving enabled.
- Video (`should_receive_video`): video kind with a known source, never from an
  `#audio` identity; our own tracks only when self-preview mode is `Rtc`; otherwise the
  per-participant receive preference. With no preference, cameras are received and
  screen shares are not: shares are opt-in (Watch in the stage), decided 2026-10-16.

`set_subscribed` and `LocalAudioTrack::mute()` look synchronous but spawn async work
internally. Called on a thread with no Tokio reactor they panic, so call them inside
the engine runtime (`within_runtime_context`, `handle.enter()`, or a spawned task).
`RoomEvent::Connected` arrives while the SDK is still dispatching its initial
participants; calling `set_subscribed` inline there re-enters that dispatch, so the
first subscription pass is moved to the next runtime turn.

A full reconnect rebuilds the remote peers from the join response, and the subscribe
requests made for them go down the old session and are lost. Those publications then read
`is_desired` true with no track, so comparing against `is_desired` sends nothing. On
`Reconnected` the audio engine and the video viewer re-request anything wanted but not
subscribed (found 2026-11-05 by restarting LiveKit: existing peers stayed silent and
blank, later joiners were fine).

## Audio specifics

- **Publishing** — `NativeAudioSource::new(options, 48_000, 2, queue_size_ms)`.
  `queue_size_ms = 0` is the direct path: `capture_frame` must receive *exactly* 10 ms
  frames and hands each to the encoder immediately. A non-zero queue is drained by a
  10 ms wall-clock timer and never shrinks after a burst, which is how latency used to
  creep up over a call. Raven frames to 10 ms itself (`PublishFramer`).
- **Options** — `AudioSourceOptions` all false (sonora already did NS/AEC/AGC).
  Microphone: SDK default encoding (Opus, 48 kbps "music" preset) with DTX on. Shared
  system/app audio: `max_bitrate = 128_000`, DTX off, because it is programme material.
  RED is left at the SDK default (on).
- **DTX** means a quiet microphone sends far fewer than 50 packets per second. That is
  normal; judge health by concealment and loss, not packet rate.
- **Receiving** — `NativeAudioStream::new(rtc_track, sample_rate, channels)` yields
  ~10 ms i16 frames, resampled by libwebrtc to whatever rate is asked for. It has a
  bounded queue of about 10 frames; a reader that stalls loses audio rather than
  accumulating delay.
- **Mute** — `LocalAudioTrack::mute()` disables the RTC track and signals peers; the
  SFU stops forwarding. Raven also zeroes the samples itself.

## Video specifics

- `NativeVideoSource::new(VideoResolution { width, height }, is_screencast)` takes I420
  frames. It spawns a keep-alive task, so it must be created inside the engine runtime.
- `TrackPublishOptions`: `video_encoding { max_bitrate, max_framerate }` and
  `simulcast` are the only knobs that reach the encoder. The Rust SDK does not expose
  content hints or degradation preference; `is_screencast` is the only screen-content
  signal. The codec is the SDK default (not overridden): VP8 with
  `VideoEncoderBackend::Auto`, which on Windows means software libvpx, because
  webrtc-sys 0.3.34 compiles no hardware encoder there (its NVENC path is Linux-only).
  Hardware encoding would need a patched webrtc-sys (NVENC, H.264, NVIDIA only) or a
  Media Foundation encoder of our own (any vendor, and the only way to pick a GPU).
- Frame rate is enforced by Raven's capture pacer, not by `max_framerate`. Every paced
  frame reaches WebRTC (media-source `frames` equals Raven's forwarded count). With an
  irregular source (a background browser window drawing at 51–59 Hz) libvpx still
  encoded only about 27 of 30 with `qualityLimitationReason` `none`; a minimum-gap rule
  and a raised `max_framerate` were tried and changed nothing, so that loss is inside
  libwebrtc. A steady 60 Hz source encodes 29.7 of 30.
- Simulcast is on only for camera sources at 960 px or larger on the long edge, and not
  for the Low or Presentation profiles. Screen shares are single-layer.

## Connection lifecycle

| SDK event | Audio engine | Video engine |
|---|---|---|
| `Reconnecting` | status `reconnecting` | — |
| `Reconnected` | status `connected`, then `resync_media` (re-run reconcile) | `resync_video` |
| `Disconnected { reason }` | if not client-initiated: abort readers, clear remote tracks, set `session.connection_lost`, status `error` | `mark_session_lost` → `mixer.session_lost = true` |

What the SDK does on its own: on a signalling or transport failure it tries to resume,
then to fully reconnect, for about 10 attempts over roughly 50 s. A **full reconnect
republishes local tracks with new SIDs**. Therefore:

- Never store a publication SID. Look it up by track name when needed
  (`local_publication_sid(room, name)`); the video engine reads `entry.track.sid()`.
- After `Reconnected`, do not assume publications survived: reconcile again and
  republish anything missing ("lost publications" are dropped from the engine's map
  first so reconcile sees them as absent).
- After `Disconnected` the room object is dead. Recovery is a brand-new connect with
  fresh tokens, driven by the React supervisor (see the control-plane reference).

`describe_disconnect` maps `livekit::DisconnectReason` to `(code, message,
recoverable)`: `DuplicateIdentity`, `ParticipantRemoved`, `RoomDeleted`/`RoomClosed`
are final; `ServerShutdown` and everything else are recoverable. Import the enum as
`livekit::DisconnectReason` — `livekit::prelude` does not re-export the same type.

On app exit, `leave_rooms_before_exit` (`lib.rs`, `RunEvent::Exit`) disconnects video
then audio inside a 1.5 s timeout so peers see an immediate leave rather than a frozen
participant until the SFU times the connection out.

## Things observed on a real server

- The SFU batches participant updates for participants that publish nothing. A leave
  of `<userId>#audio` reaches peers in ~100–200 ms; the `#video` and viewer
  participants (no tracks, camera off) show up 2–3 s later. That is the server, not a
  slow disconnect.
- A Chromium peer must attach a remote audio track to an `<audio>` element (muted is
  fine) before WebAudio or `getStats()` report decoded samples.
- libwebrtc links the **static MSVC CRT**. `src-tauri/.cargo/config.toml` sets
  `+crt-static` for `x86_64-pc-windows-msvc`; without it linking fails (LNK2038).

## Local server for development

`livekit-server --dev` uses the published key pair `devkey` / `secret`. A development
`.env` may point `LIVEKIT_URL` at port 8780 on the LAN address, not the default
`127.0.0.1:7880`, so the dev server needs a config with that port and
`--bind 0.0.0.0 --node-ip <LAN IP>`. `scripts/stack.ps1` does this from `.env`.
Production uses TLS (`wss://`); the desktop crate enables `rustls-tls-webpki-roots`.
