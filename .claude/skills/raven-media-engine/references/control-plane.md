# Control plane

How a click becomes a change in the engine, and how the engine's state gets back to
the screen. Three layers: Tauri commands (Rust), typed wrappers and the media adapter
(TypeScript), and the API that grants access (Go).

## Tauri commands: one pattern

Tauri runs **sync** commands on the main (UI) thread and **async** commands on its
Tokio runtime. Anything that touches the network or a device is therefore `async`.
Sync commands are reserved for pure reads and atomics (`audio_get_state`,
`audio_set_output_device`, `video_get_state`, device lists).

State is split in two (`audio/state.rs`, mirrored in `video/state.rs`):

```rust
pub struct AudioEngineState { mixer, user_presets, runtime: Arc<AudioRuntime>, .. }  // behind std RwLock
pub struct AudioRuntime { ops: tokio::sync::Mutex<AudioOps>, output: Arc<OutputMixer> }
pub struct AudioOps { engine: AudioEngine, capture: CaptureRuntimeManager }
```

Every mutating command follows `mutate_audio_state`:

1. `ops.lock().await` — serialises side effects; one mutation at a time.
2. Take the state write lock, apply the model change, **release it**.
3. `reconcile_media`: clone the sources →
   `engine.reconcile_publications(&sources).await` → `capture.reconcile(..)` inside
   `tokio::task::block_in_place` (it opens devices and joins threads) → take the state
   lock briefly to merge the returned runtime states.
4. Drop `ops`, snapshot, emit `audio-state-changed`, return the snapshot.

Rules that follow from it:

- Lock order is always `ops` → state. Engine tasks (event loop, readers, capture pump)
  take only the state lock, briefly, and prefer `try_write`/`try_read` on hot paths.
- A publish or device error is returned to the caller *after* the model and the rest
  of reconcile have been applied, so one failing source does not block the others.
- LiveKit calls run on the engine's own runtime: `handle.spawn(fut).await` for async
  SDK calls, `handle.enter()` / `within_runtime_context` for sync ones.
- `resync_media` / `resync_video` run the same reconcile with no model change. The
  engine event loops call them after `Reconnected`.
- Cross-engine work goes audio first, then video, never nested (shared audio for a
  screen share is created before the video state lock is taken).

Helpers worth knowing: `mutate_audio_state_with_instruction` (also emits
`audio-track-publish-instruction`), `add_and_publish_shared_audio_source`,
`remove_shared_audio_source`, `disconnect_audio_room`, `disconnect_video_room`,
`finish_video_mutation`.

## Events from Rust to the WebView

| Event | Payload | Notes |
|---|---|---|
| `audio-state-changed` | full `AudioMixerState` | after every mutation and engine-side change |
| `audio-meter-changed` | `AudioMeterUpdate` | ~every 120 ms per active source/track |
| `audio-devices-changed` | — | device list or default changed; refresh pickers |
| `audio-track-publish-instruction` | publish/unpublish instruction | diagnostic trail |
| `video-state-changed` | full `VideoMixerState` | after every video mutation |

Snapshots are whole-state, so a missed event is healed by the next one. Commands also
return the fresh snapshot; the UI sets state from the return value and from events.

## TypeScript

- `src/lib/audio.ts` — `audioCommands` (one function per command), the serde twins of
  `domain.rs`, and `subscribe*` helpers for the events. `src/lib/video.ts` likewise.
  A field added in Rust must be added here; Rust serialises camelCase.
- `src/shells/ravenv1/useRavenMediaAdapter.ts` — the only place that sequences a call.
- `src/lib/speakingActivity.ts` — speaking ring from meter updates (pre-fader, and the
  voice detector's `voiceProbability`).
- `src/lib/mediaDevicePreference.ts` — persisted input/output choices.
- `src/components/AudioMixerPanel.tsx` — the mixer UI (strips, chains, presets).
- `src/shells/ravenv1/nestEntry.ts` + `useNestEntry.ts` — the knock countdown.

### Join (`joinMediaSession`)

1. If already in another Nest, leave it.
2. Apply join defaults *before* connecting, because the sidecars publish whatever the
   model says the moment they connect: `applyVideoJoinDefaults` (stop camera / shares
   if the user chose so) and, with "always join muted", `muteLocalMicrophones`.
3. `audio_set_call_active(true)`, so a microphone kept from an earlier call opens before
   its track is published (a device error here never fails the join).
4. `connectMedia(nestId)`: viewer token and audio token → `audio_connect_room` →
   re-apply deafen (`setRemoteAudioReceiving`, `setOutputMuted`) → video token →
   `video_connect_room(url, videoToken, viewerToken)` → self-preview mode →
   `api.joinSession`, `api.joinNestPresence`, `api.updatePresence`.
5. `prepareMicrophone`: make sure a microphone source exists and is published, muted.
   From then on the mic button only toggles mute (`toggleMic` → `muteMic`).

### Leave (`leaveMediaSession`)

`cleanupMediaOnly` (both `disconnect_room` commands in parallel, then
`audio_set_call_active(false)`, which releases local capture) then
`api.disconnectFromNest`, tolerating an API failure — the server times the client out
by itself. Closing the window also fires `disconnectFromNest` on `pagehide`, and Rust's
`leave_rooms_before_exit` closes the rooms.

### Session supervisor

While `phase === "connected"`:

- `audioState.session.connectionLost` with `recoverable: false` → leave locally and
  show the reason. No rejoin.
- `connectionLost.recoverable`, or `videoState.sessionLost` → reconnect loop:
  wait `mediaReconnectDelayMs(attempt)` (`MEDIA_RECONNECT_DELAYS_MS` = 1, 2, 5, 10, 20,
  30 s) or until the browser fires `online`, then `api.joinNest` (membership may have
  lapsed) and `connectMedia` again with fresh tokens. `reconnecting` is exposed to the
  UI ("Reconnecting media…"). The loop stops when the user leaves.

Local publications restore themselves: the model still says what should be published,
and reconcile runs on connect. The loop never calls `cleanupMediaOnly` or clears
`call_active` (except when the user left mid-attempt), so capture stays open across it.

### Mixer monitoring

`MixerView` (`shells/ravenv1/views/index.tsx`) calls `audio_set_monitoring(true)` on
mount and `false` on unmount. Outside a call that is the only thing that keeps local
capture, and therefore the input meters, running.

### Heartbeat

Every 5 s (`NEST_HEARTBEAT_INTERVAL_MS`, 8 s timeout) the adapter posts
`presenceHeartbeat(signal, true, nestId)`. If the reply says `nestActive: false` the
server has timed this client out of the Nest (sleep, long stall); the adapter
re-asserts `joinNest`, `joinSession`, `joinNestPresence`, `updatePresence` instead of
leaving the user as a ghost who is in LiveKit but not in the Nest.

### Deafen and devices

- `DeafenMode = "instant" | "bandwidthSaver"`. Instant = `audio_set_output_muted`
  only. Bandwidth saver also calls `audio_set_remote_audio_receiving(false)`, which
  unsubscribes remote audio.
- The saved speaker is applied once at startup and on an explicit change
  (`appliedOutputRef`). Refreshing the device list must never re-send
  `audio_set_output_device` — that used to restart the speaker and cause dropouts —
  and a momentarily absent device must never erase the saved preference.
- `subscribeAudioDevicesChanged` refreshes the pickers on hot-plug.

## Go API touchpoints (`services/api/internal/http/`)

- `POST /v1/nests/:id/livekit-token[?identity=audio|video]` (`server.go`) — requires
  membership state `joined`; returns `url`, `token`, `sessionName`, `identity`.
- `POST /v1/presence/heartbeat` — accepts `nestId`, returns `nestActive`
  (`domain.go`). `staleNestActivityTimeout` is 45 s (`sessions.go`).
- `maintenance.go` — a 10 s ticker expires stale presence and broadcasts
  `presence.changed`; `POST /v1/presence/goodbye`; `POST|DELETE
  /v1/nests/:id/entry-notice` for the knock (`nest.entering`,
  `nest.entering.cancelled`, sent only to the people inside).
- `events.go` — the SSE stream `/v1/nest-events` with 15 s keepalive comments and
  `X-Accel-Buffering: no`. Behind nginx it needs `proxy_buffering off`
  (`infra/homelab/nginx/mimir.conf`).

The API decides who may join; LiveKit decides nothing about Raven's rules. A user who
is in the LiveKit room but not `joined` in the Nest (or the reverse) is a bug in one of
the paths above.

## Adjacent modules

- `src-tauri/src/media_hotkeys.rs` + `src/lib/mediaHotkeys.ts` — global hotkeys for
  mic, camera, deafen and screen share (`tauri-plugin-global-shortcut`; Windows and
  Linux X11, with the reason reported on Wayland). They only emit an action; the
  adapter performs it.
- `src-tauri/src/overlay.rs` and `src/components/VoiceOverlayWindow.tsx` — the voice
  overlay window; it consumes the same state and meter events.
- `src-tauri/src/lib.rs` — registers every command, starts the device watcher, and
  handles `RunEvent::Exit`.

## When the page goes down mid-call (added 2026-10-28)

The WebView page owns the call: the adapter's unmount cleanup leaves both rooms. So
anything that unmounts the React root ends the call. Guards:

- `components/ErrorBoundary.tsx` wraps the title bar, sidebar, main view, arrival
  notices and dock in `RavenShellV1.tsx`, so a render error there leaves the shell (and
  the call) mounted. A root boundary in `main.tsx` shows `AppCrashFallback`, which
  reloads once (at most once a minute).
- `diagnostics.rs` listens for WebView2 `ProcessFailed`. A dead or hung page renderer:
  leave both rooms, release capture, reload. Browser process gone: `app.restart()`.
- `lib/crashRecovery.ts` keeps the active Nest in session storage; after a reload the
  shell runs `data.joinNest` then `media.joinMediaSession` (no knock heads-up).
- Every caught or uncaught UI error and every WebView2 process failure is appended to
  `%LOCALAPPDATA%\app.raven.desktop\logs\ui-errors.log`. Ask a tester for that file.
