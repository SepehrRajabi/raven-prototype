# Raven Architecture

Raven is a desktop-first application. The React UI runs inside Tauri v2 and communicates with a local/dev Go Fiber API over HTTP. RTC media is handled by LiveKit after Raven admission succeeds.

## Components

- `apps/desktop`: Tauri v2 shell, React, TypeScript, Tailwind, and shadcn/ui-style components.
- `services/api`: Go Fiber API with SQLite persistence and LiveKit Go SDK token issuance.
- `packages/shared`: shared TypeScript domain types.

## Domain

The primary meeting entity is a **Nest**. A user can belong to multiple active Nests simultaneously. Admission is modeled separately from membership:

- `nest_members` stores creator, moderator, and participant membership.
- `nest_invitations` stores explicit username-based invitations.
- `nest_join_requests` stores approval-needed access requests.

Invited users can join immediately. Uninvited users who enter a Nest code or link wait until a creator or moderator accepts their Join Request.

## RTC

Raven uses LiveKit for realtime media. The API uses LiveKit's Go packages to issue a short-lived LiveKit access token only to users whose Nest membership state is `joined`. The LiveKit session name is derived from the internal Nest id, while the product UI continues to use Nest terminology.

Local development defaults:

```text
LIVEKIT_URL=ws://127.0.0.1:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
```

The desktop app publishes camera, microphone, and display-share tracks through LiveKit and renders remote participant media in the Active Nest screen.

### Desktop media engines

All media is native (Rust); the WebView only presents state and bounded frame streams. A user joins a Nest's LiveKit room as up to three participants:

- `<userId>#audio` — the audio sidecar (`src-tauri/src/audio`). It captures, processes (voice processing, the per-channel processor chain, a safety limiter), and publishes every local audio source, and it subscribes to, shapes, mixes, and plays every remote one.
- `<userId>#video` — the video publisher (`src-tauri/src/video`) for camera and screen/window shares.
- `<userId>` — the native viewer, which receives remote video.

Rules the engines are built around:

- **State and side effects are separate.** The mixer model (`AudioEngineState`, `VideoEngineState`) sits behind a short-lived state lock. The LiveKit connection and capture runtimes sit behind a separate async `ops` lock (`AudioRuntime`, `VideoRuntime`). Commands are async: take `ops`, change the model under the state lock, release it, do the network and device work, then merge the result. Nothing awaits the network or opens a device while holding the state lock, and nothing blocks the UI thread.
- **The model is the desired state.** A reconcile pass makes publications and capture runtimes match it. That is how a reconnect, a device change, or a failed publish heals: the same pass runs again.
- **Devices are followed, not assumed.** Playback and capture open a device in its own format, follow the system default, fall back to it when a chosen device disappears (keeping the choice), and keep retrying.
- **Capture runs only when needed.** An enabled local source holds its device open while the user is in a call (from join until a real leave, across the app's own reconnects) or the Mixer is on screen. Leaving releases the microphone.
- **Noise suppression is a live control.** The microphone's mode (Off, Standard, Strong, Studio) and depth are read by the capture thread, which fades to the new suppressor, so changing them mid-call never reopens the device. Studio's model (DeepFilterNet 3, vendored in `src-tauri/vendor/deep_filter`) is built on a thread of its own and handed to the capture thread, never built on the audio thread; if it can't keep up on this computer, Strong takes over for the rest of the call and the user's choice stays Studio. Echo cancellation and automatic gain are still part of the capture's identity and do reopen it. A listener can also run Strong on one person's microphone, on their own side only.
- **Speaking is detected, not guessed from loudness.** Each microphone, local or received, goes through WebRTC's voice detector on the machine that hears it; only the resulting probability reaches the UI.
- **Mute keeps the track.** A muted source stays published (its samples are zeroed in the capture path), so unmuting is instant and a source keeps one track identity; peers keep their own strip settings for it. Server mute is the exception: LiveKit takes publishing away from `#audio`, the engine reads that permission into the model, and reconcile publishes nothing and releases the device. Lifting it leaves the microphone off.
- **Sound cues are played by the engine, into the call's output.** Mute and unmute, a profile knock, a share starting or stopping, someone joining or leaving, someone raising a hand, and the join heads-up are synthesised in `audio/cues.rs` (no sound files) and mixed into the playback bus before the echo-cancellation reference is taken, so they follow the chosen speaker and the canceller removes them from the microphone. Deafen silences all of them except your own mute toggle. Joined and left are decided natively from the other person's `#audio` participant arriving or leaving (never for the people already in the room, never during a reconnect, and not for a quick reconnect of theirs). The switches and volume are kept on the device with the other media settings and pushed to the engine.
- **A raised hand asks the room, not a host.** "I'd like to speak" is a marker on the person's own participation (`POST /v1/nests/:id/session/state`, see `docs/api.md`). The server orders the line and sends only places, never times. The client lowers the hand itself after about 3 s of the owner's own speech with the microphone live (`lib/raisedHand.ts`); speech while muted or server-muted does not count. "Your turn" is decided on the device from the voice activity already in the call: first in line and no one else speaking for 1.5 s. The hand cue plays when another person's hand goes up, never for hands already up when you arrive.
- **A lost room is rejoined by the app.** The engines report why a connection was lost; the UI rejoins with fresh tokens and backoff, except after a duplicate sign-in, a removal, or a closed room.

## Text chat

Direct messages, groups and text Nests are served by the same API process and stored in the same database as everything else; there is no separate chat service, socket server or broker. A message is written with an ordinary HTTP request, which is answered only after the row is committed. It reaches other people over the event stream the client already holds open (`GET /v1/nest-events`), as a second server-sent event name, `chat`.

The stream is allowed to lose events. What makes delivery complete is a counter on each conversation that increases by exactly one for every change, inside the transaction that makes the change. A client that receives a number more than one above what it has, or that has just reconnected, asks for everything after its number (`GET /v1/chat/conversations/:id/changes`). A client-chosen id on every send makes a retry return the first result instead of storing a second message. A Tree's voice and text Nests are grouped and ordered through two overlay tables, so the Nest tables are unchanged.

On the desktop, chat state lives in a store outside React (`apps/desktop/src/lib/chat`) built from pure functions, and the message list is virtualized. The design, its invariants and the acceptance criteria are in [chat.md](chat.md); measured results are in [chat-testing.md](chat-testing.md); running it is in [chat-operations.md](chat-operations.md).

## Desktop update system

The desktop updates itself with the official Tauri updater plugin and a fixed public key (`src-tauri/src/updater.rs`). It reads one static manifest, `https://updates.rvn.bluehour.cloud/latest.json`, tells the user when a newer version exists, and downloads and installs only when asked and never during a call. The private key stays on the release workstation. The API's only part is a minimum-client-version gate (`internal/http/compat.go`). See [releasing.md](releasing.md).

The homelab uses one Raven Compose project with PostgreSQL, Redis, LiveKit, the API and a static `releases` container, on a private Raven network plus the existing `proxy` network. `updates.rvn.bluehour.cloud` serves only release files; `mimir.rvn.bluehour.cloud` is the API.
