---
name: raven-media-engine
description: Explains and guides work on Raven's native media engine — the Rust audio and video engines in apps/desktop/src-tauri, their LiveKit/WebRTC sidecars, capture, playback, the mixer, the DSP processor chain, and the React and Go code that drives them. Use when changing, reviewing or debugging calls, audio capture or playback, devices, mute/deafen, echo cancellation, processors, presets, meters, camera or screen share, reconnects, or anything under src-tauri/src/audio or src-tauri/src/video in the Raven repository.
---

# Raven media engine

Raven is a Tauri v2 desktop app. **All media is native Rust.** The WebView never opens a
LiveKit room, never owns a WebRTC track, and never touches a sample: it invokes
commands, receives state snapshots, and shows video through `<img>` tags fed by a
loopback stream. The goal the engine is held to is "Discord/Meet reliability with
DAW-grade processing".

## The shape of a call

One user joins a Nest's LiveKit room (`raven-nest-<nestId>`) as up to three participants:

```
<userId>#audio   audio sidecar    src-tauri/src/audio   publishes + plays ALL audio
<userId>#video   video publisher  src-tauri/src/video   camera, screen, window
<userId>         native viewer    src-tauri/src/video   receives remote video
```

```
mic / system / app audio ─► capture ─► APM front ─► suppressor ─► APM back ─► fader ─► chain ─► safety ─► 10 ms framer ─► LiveKit
                                         ▲                                                                             (Opus)
                         render reference│ (what the speaker played, for echo cancel)
speaker ◄─ bus limiter ◄─ master mute ◄─ mix ◄─ playout buffer ◄─ receiver strip ◄─ LiveKit
```

Sample-accurate order, constants and file locations are in the references.

## Rules the engine is built on

Break one of these and the "random" alpha bugs come back. Each has a reason.

1. **State and side effects are separate.** The mixer model sits behind a short
   `RwLock`. The LiveKit connection and capture runtimes sit behind a separate async
   `ops` mutex. Lock order is `ops` → state. Never hold the state lock across an
   `.await`, a network call, or a device open; never `block_on` inside a command.
2. **The model is the desired state.** Commands edit the model, then one reconcile pass
   makes publications and capture runtimes match it. Reconnects, device changes and
   failed publishes heal by running the same pass again. Do not add imperative
   side paths that bypass reconcile.
3. **Open devices in their own format.** cpal's WASAPI backend does not convert. Ask
   the device for its default config and adapt (channel map, sample type, resample).
   Forcing 2-channel f32 silently breaks mono Bluetooth and 5.1/7.1 endpoints.
4. **Devices are followed, not assumed.** Capture and playback follow the system
   default, fall back to it when the chosen device disappears *without erasing the
   choice*, return to it when it reappears, and never stop retrying during a session.
5. **Mute keeps the track.** A muted source stays published and captured; its samples
   are ramped to zero and the LiveKit track is flagged muted. Track id is derived from
   the source id, so it is stable across mute, reconnect and rejoin. Push to talk is not
   a mute: its talk gate (`src-tauri/src/push_to_talk.rs`, an atomic read in the
   microphone's `fader_target`) ramps the fader to zero with no flag, reconcile or device
   restart, so listeners see someone not speaking. A hard mute still wins over the key.
   Server mute is the one exception: LiveKit takes publishing away (`can_publish` off on
   `#audio`), so reconcile publishes nothing and capture stops. That is still the model and
   the reconcile pass, driven by `capture_demand.publish_revoked` from LiveKit's permission.
6. **Nothing clicks.** Gain, mute, master mute and limiter gain all move by ramps.
   Parameter edits are applied in place (`sync_state`) so filters keep their memory.
7. **Edits never restart a device.** Gain, mute, safety ceiling and the processor chain
   travel through `LiveControls`, not the capture signature.
8. **Latency must not accumulate.** The publish path cannot build a queue (exact 10 ms
   frames straight to the encoder; the small hand-off backlog drops instead of
   waiting); the playout buffer primes to 30 ms and trims above 120 ms.
9. **A lost room is rejoined by the app.** The engines report *why* a connection ended;
   the React supervisor rejoins with fresh tokens and backoff, except after a duplicate
   sign-in, a removal, or a closed room.
10. **The audio thread never waits on the UI.** Device callbacks and readers use
    atomics, try-locks and bounded channels. State and meter emits are best-effort.

## Where things live

| Concern | File (under `apps/desktop/`) |
|---|---|
| Audio commands, mixer model mutations, presets | `src-tauri/src/audio/state.rs` |
| LiveKit audio room, publish sinks, remote readers | `src-tauri/src/audio/engine.rs` |
| Speaker, playout buffers, mix bus, render reference | `src-tauri/src/audio/playback.rs` |
| Mic / loopback / app capture, APM, live controls | `src-tauri/src/audio/capture.rs` |
| Processor chain (gain, filters, EQ, gate, comp, limiter) | `src-tauri/src/audio/processor.rs` |
| Look-ahead limiter, safety stage, resampler | `audio/dynamics.rs`, `safety.rs`, `resample.rs` |
| Noise suppressor stage (RNNoise, DeepFilterNet, Studio hand-off, overrun guard) | `src-tauri/src/audio/suppression.rs` |
| DeepFilterNet's inference library and model, vendored | `src-tauri/vendor/deep_filter` |
| Serde types shared with the UI | `src-tauri/src/audio/domain.rs`, `video/domain.rs` |
| Video rooms, publish, viewer subscriptions | `src-tauri/src/video/engine.rs` |
| Camera / screen / window capture | `src-tauri/src/video/capture.rs`, `directshow.rs`, `convert.rs` |
| Frames to the WebView | `src-tauri/src/video/stream.rs`, `preview.rs` |
| Typed command wrappers and events | `src/lib/audio.ts`, `src/lib/video.ts` |
| Join, leave, reconnect, deafen, device preferences | `src/shells/ravenv1/useRavenMediaAdapter.ts` |
| Mixer UI | `src/components/AudioMixerPanel.tsx` |
| Tokens, presence, session lifetime | `services/api/internal/http/server.go`, `sessions.go`, `maintenance.go` |

`docs/architecture.md` ("Desktop media engines") is the short canonical statement of
the rules above.

## Read only the reference you need

- [Audio engine](references/audio-engine.md): the send and receive paths in order,
  capture backends and supervision, echo cancellation, playback, every timing constant.
- [Mixer and DSP](references/mixer-dsp.md): the mixer model, channel strips, each
  processor's algorithm, parameters and ranges, presets, meters, how to add a processor.
- [WebRTC and LiveKit](references/webrtc-livekit.md): topology, tokens, naming,
  subscription policy, SDK behaviours that bite, reconnect and disconnect semantics.
- [Video engine](references/video-engine.md): publisher and viewer, capture backends,
  quality profiles and bitrates, how frames reach the WebView, self preview.
- [Control plane](references/control-plane.md): the command pattern, events, the
  React adapter (join, leave, supervisor, heartbeat, deafen), the Go endpoints.
- [Testing](references/testing.md): build and test commands on this Windows machine, and
  the live-call rig in `scripts/` that drives the real app against a second participant.

## Working on it

Trace a change through all three layers before editing: the Tauri command in
`state.rs`, the engine or capture code it reaches through reconcile, and the TypeScript
wrapper plus the adapter that calls it. A new field on a serde type needs its twin in
`src/lib/audio.ts` or `video.ts`.

Unit tests prove DSP maths and state transitions; they cannot prove a call works.
After touching connect, publish, capture, playback or reconnect code, run the live rig
in [Testing](references/testing.md) and report measured results (levels, packet loss,
jitter-buffer delay, recovery time), not "should work". Linux compiles here in Docker in
WSL (`infra/release/Dockerfile.linux-appimage`); macOS does not. Say which backends were
only compiled, or not checked at all, rather than implying they ran.

Product decisions already made by Soroush; do not reopen them without being asked:
hot-mic mute (Discord-style), knock as a heads-up with a ~3 s cancelable countdown and
no approval step, Linux global hotkeys on X11 first with Wayland later.

Capture lifetime (decided 2026-10-16): a local source captures only while it is
`enabled` **and** there is a reason to — the user is in a call (`audio_set_call_active`,
held from join until a real leave, across the app's reconnect cycle) or the Mixer view is
on screen (`audio_set_monitoring`). Leave releases the microphone, so the OS stops
reporting it in use. Do not tie capture to the LiveKit connection state.

## Maintaining this skill

Facts here were checked against the code on 2026-10-11 (livekit 0.7.45, libwebrtc
0.3.36, cpal 0.15.3, sonora 0.1.0, nokhwa 0.10.11). Noise suppression was added on
2026-10-18: nnnoiseless 0.5, and DeepFilterNet's `deep_filter` 0.5.7-pre vendored from
upstream revision `d375b2d8` (2024-10-17) into `src-tauri/vendor/deep_filter`, on tract
0.21.4 (tract-core, -onnx, -pulse, -hir, pinned with `=`). Constants and file names drift:
verify against the source before quoting one in a fix. Update the affected reference
when a task changes a durable contract; do not record a debugging workaround as a rule.
