# Testing the media engine

Two levels. Unit tests cover DSP maths, state transitions and policies. Only a live
call covers connect, publish, capture, playback and recovery — the paths where the
alpha bugs were. Do both when the change touches those paths.

Scripts referenced here are in this skill's `scripts/` folder. They find the repository
from the current directory (or `RAVEN_REPO`) and keep logs, PIDs and build output in
`%TEMP%\raven-media-rig`.

## Unit and static checks

| What | Command | Where |
|---|---|---|
| Rust tests | `scripts/cargo.ps1 test --lib` | any directory |
| One module | `scripts/cargo.ps1 test --lib dynamics::` | |
| Type check | `scripts/cargo.ps1 check --lib --message-format short` | |
| Lints / format | `scripts/cargo.ps1 clippy --lib`, `scripts/cargo.ps1 fmt --all` | |
| Frontend tests | `bun test` | `apps/desktop` |
| Types + bundle | `bun run build` (`tsc && vite build`) | `apps/desktop` |
| API | `go vet ./... && go test ./...` | `services/api` |

Plain `cargo` does not work in a fresh Windows shell: the crate needs MSVC on
`PATH`, libclang, C++20 flags and a short `CARGO_TARGET_DIR` (`%USERPROFILE%\rv`, to
stay under MAX_PATH). `cargo.ps1` dot-sources the project's `scripts\msvc-env.ps1` and
`scripts\native-build-env.ps1`, which set all of that. A cold build takes minutes.

Use Bun for everything JavaScript. Linux code paths (`cfg(target_os)`) compile here in
Docker in WSL, in the image from `infra/release/Dockerfile.linux-appimage`; macOS code
paths cannot be compiled here.

Where tests live: next to the code, in `#[cfg(test)] mod tests` at the bottom of each
Rust file. Good models to copy: limiter properties in `dynamics.rs`, "editing a
parameter keeps state" in `processor.rs`, playout prime/underrun/trim in `playback.rs`,
chunk-invariance in `resample.rs`, live-control tests in `capture.rs`. Frontend:
`speakingActivity.test.ts`, `mediaReconnect.test.ts`, `nestEntry.test.ts`.

## Live call rig

The app alone only reaches "Server is unreachable". A real call needs, in order:

```
scripts/stack.ps1 up      # builds the API from the working tree, starts it and LiveKit
scripts/app.ps1 up        # tauri dev with the WebView debug port on 127.0.0.1:9223
bun scripts/cdp.ts state  # is it signed in, what does the native state say
```

`stack.ps1` reads addresses and keys from the repository `.env`. In the usual setup the
API binds the LAN address on port 6977 against a local PostgreSQL, and `LIVEKIT_URL`
uses port 8780. It starts LiveKit only when that URL points at the local machine, and it
never stops a server it did not start. The WebView keeps a saved session, so the app
normally lands signed in.

### Driving the app

`cdp.ts` talks to the WebView over the DevTools protocol:

```
bun scripts/cdp.ts click "2TA WTF"        # open a space from the sidebar (use a real name)
bun scripts/cdp.ts click "Preview"        # room preview
bun scripts/cdp.ts click "Enter Room" 6000
bun scripts/cdp.ts click "MIC OFF"        # unmute; label becomes "MIC ON"
bun scripts/cdp.ts click "SOUND ON"       # deafen; label becomes "DEAFENED"
bun scripts/cdp.ts click "Leave" 2500
bun scripts/cdp.ts click "Close"          # the title-bar button: exits the app
bun scripts/cdp.ts eval my-check.js       # anything else
```

Labels follow the server's configured vocabulary (Room/Space or Nest/Tree). When a
click finds nothing it lists the buttons that exist. `state` and every `click` print
the native state: `session` (connection, playback, device, `connectionLost`), local
sources (muted, runtime rate/channels/device, meter), remote tracks (subscription,
meter), and video link flags.

### A second participant

Most of the engine only runs with someone else in the room.

```
bun scripts/make-bot.ts raven-nest-<nestId>
python -m http.server 8899 --bind 127.0.0.1 --directory "%TEMP%\raven-media-rig\bot"
```

Open `http://localhost:8899` in a Chromium browser and click **Start bot** (the click
is needed to start WebAudio). The room name is in `%TEMP%\raven-media-rig\livekit.log`
after the app has joined.

Inside Claude's desktop app a `file://` page outside the project is rendered as a
static snapshot and will not run, so serve the folder through the preview tool: add
this to `.claude/launch.json` for the test, `preview_start` it, and remove it after.

```json
{
  "name": "call-bot",
  "runtimeExecutable": "python",
  "runtimeArgs": ["-m", "http.server", "8899", "--bind", "127.0.0.1", "--directory",
                  "<folder holding the bot page>"],
  "port": 8899
}
```

The bot joins as `<uuid>#audio` with a `raven-audio-<uuid>` track, so the Rust engine
treats it as a peer. It is not a Raven user: the API does not know it, so UI features
keyed to Nest membership (knock notice, speaking ring on a tile, presence) need a
second real Raven client instead.

In the bot page: `botTone(0.03)` starts a 440 Hz tone at about −30 dBFS peak (it plays
on the tester's speakers — keep it quiet and short, and say so); `botRx(4000)` reports
what the bot receives from the app; `botStatus()` shows participants and events.

### Talking bots (Auto-level)

A tone is not speech, so it never passes the voice detector. `scripts/voice-bot.py`
(same venv as `share-bot.py`; setup in its header) publishes a synthetic voice at a
chosen K-weighted loudness as a microphone. Two bots talking at once 20 dB apart look
like bleed, so give them turns:

```
python voice-bot.py raven-nest-<nestId> 0 -33 --offset 0 --seconds 120
python voice-bot.py raven-nest-<nestId> 1 -14 --offset 3 --seconds 120
```

`--mute F-T` mutes the track between those seconds. Read the faders with an `eval` of
`audio_get_state` (`receiverChannelStrip.gainDb` and `.autoLevel`). The bots write their
entries into the real `remembered-volumes.json` (`%APPDATA%pp.raven.desktop`, shared
with an installed Raven).

### Measuring video frame rates

`tauri dev` builds unoptimised, and the video pixel code (conversion, resize, JPEG) is
several times slower there than in an installed copy. For any frame-rate or CPU number,
set `$env:RAVEN_APP_RELEASE = "1"` before `app.ps1 up` (it runs `tauri dev --release`).

Share a window that keeps moving (a still screen sends nothing), set self preview to RTC
(`video_set_self_preview_mode` `rtc`), and take two samples about 10 s apart:
`video_get_quality_report` gives cumulative `capture.captured` / `capture.forwarded` and
`outbound.sourceFrames` / `framesEncoded` / `framesSent`; `video_get_stream_stats` gives
received, decoded and shown fps for the self stream. Counting `--ravenframe` parts on a
`fetch` of `<baseUrl>/<streamId>` checks "shown" from outside Rust. Do not share the real
screen; open a test animation in its own browser window. Chromium stops drawing a window
it thinks is hidden and WGC gets nothing from a minimised one, so launch it with
`--disable-backgrounding-occluded-windows --disable-renderer-backgrounding
--disable-features=CalculateNativeWinOcclusion` and push it behind other windows rather
than in front of the user's work.

Results on 2026-10-16 (Ryzen 9 9950X, RTX 3060 Ti, 60 Hz display), optimised builds:

| Share | Build | Captured | Forwarded | Encoded | Decoded | Shown |
|---|---|---|---|---|---|---|
| High 30, 1280×760 window | v0.1.3 | — | — | 20.6 | 20.2 | 8.3 |
| High 30, 1280×760 window | fixed | 58.6 | 30.0 | 26.5–27.1 | 26.5–27 | 26.2–27 |
| High 30, 1920×1040 window (foreground) | fixed | 30.1 | 30.1 | 29.7 | 29.7 | 29.6 |
| High motion 60, 1244×740 | v0.1.3 | — | — | 33–35 | 33–35 | 10 |
| High motion 60, 1244×740 | fixed | 57.2 | 57.2 | 56.9 | 56.9 | 56 (Quality) / 30 (Balanced) |

### What to measure

| Scenario | How | Healthy result |
|---|---|---|
| Receive level | `botTone(0.03)`, then `cdp.ts state` | remote meter ≈ −30 dB peak / −33.5 dB RMS |
| Send continuity | unmute, `botRx(4000)` | `samplesPerSec` ≈ 48 000, `lost` 0, `concealedSamples` 0 |
| Send latency | `botRx` twice, a few seconds apart | `jitterBufferMs` settles around 25–40 and stays there |
| Mute is hot | toggle the mic several times | bot logs only `muted`/`unmuted`; the source's `runtime` is unchanged; each toggle tens of ms |
| Short outage | `stack.ps1 lk-down`, wait 8 s, `lk-up` | status `reconnecting`, then `connected` within ~10 s of the server returning, no user action |
| Long outage | same with 70–80 s | `connectionLost` (recoverable) after ~50 s, then the app rejoins by itself; mic republished under the same track name |
| Leave | click Leave | bot logs `left <id>#audio` within a few hundred ms |
| Exit mid-call | click the title-bar Close | bot sees the leave at once; process gone in well under a second |
| Clean run | `scripts/app.ps1 log` | no panics |
| Mic released on leave | Leave, then `scripts/mic-sessions.ps1` | mic `runtime` `inactive`; session `inactive` (ACTIVE in a call or with the Mixer open) |

A quiet microphone shows fewer than 50 packets per second because of Opus DTX; that is
not loss. The first `botRx` after subscribing can show a large `jitterBufferMs` while
the browser drains its start-up backlog; measure again.

Finish with `scripts/app.ps1 down` and `scripts/stack.ps1 down`.

### Traps

- **Do not close the app with `Process.CloseMainWindow()` or a posted `WM_CLOSE`.** The
  window framework keeps a visible, ownerless "Tao Thread Event Target" window; closing
  it leaves the process alive with a dead event loop, and every window command and
  event then fails with "failed to send message to the webview". It looks exactly like
  an app bug. Use the title-bar button.
- **Scan the log before relaunching.** `app.ps1 up` starts a new log.
- **Editing under `apps/desktop/src-tauri` while `tauri dev` runs triggers a rebuild**
  and restarts the app; editing `apps/desktop/src` hot-reloads the UI. Port 1420 is the
  dev server's.
- **Side effects of a live test**: it joins a real room in the local database as the
  signed-in user, opens the microphone, and plays the tone. Tell the user.

- **The microphone privacy registry is not reliable here.** `CapabilityAccessManager\ConsentStore\microphone\NonPackaged` can stop being updated (seen on a Windows 11 development PC in October 2026). Use `scripts/mic-sessions.ps1`, which asks WASAPI directly.
- **The browser bot may not connect from a browser on some machines.** On 2026-10-16 the
  in-app pane, Edge and a clean Chrome profile all failed with "could not establish pc
  connection": the browser sent ICE checks to LiveKit's LAN address and LiveKit received
  none, while the native app connected. Something on that PC intercepted browser traffic.
  Use the native `scripts/share-bot.py` (LiveKit Python SDK, setup in its header) for
  video participants instead; it is what checked opt-in screen shares. An Edge profile
  signs in and syncs the user's extensions (a proxy among them), so prefer Chrome with
  `--disable-extensions` if you try a browser, and delete the profile after.

### Screen shares and cameras from other people

`make-bot.ts` adds `botShare(1|2)` / `botStopShare()` (canvas shares) to the browser bot.
`share-bot.py` does the same natively, one process per sharer: indices 0–2 share a moving
1280×720 screen, 3 publishes a camera. Each joins as `<hex>#video`, so the app sees a
person. Screen shares are opt-in (not received until Watch); check with
`video_get_network_totals` (`screenShareReceivedBytes` over a few seconds) and the
track's `desired` / `subscribed` in `video_get_state`. Saving a `*.test.ts` while in a
call reloads the page and leaves the call.

## What the rig cannot show

These need real hardware or a second Raven client, and should be reported as untested
rather than assumed:

- Bluetooth headsets (the endpoint flips to mono Hands-Free when the mic opens),
  5.1/7.1 and mono outputs — the cases the device-format rule exists for.
- Unplugging a device or changing the Windows default mid-call.
- Echo with open speakers; self-hearing while sharing system audio.
- Camera and screen share picture quality; a 60-minute call for latency drift.
- Knock toast and chime, speaking ring on tiles, presence going offline.
- Anything on Linux or macOS.
