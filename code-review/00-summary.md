# Raven code review: summary

**Date:** 2026-11-13
**Branch:** `settings-search-upstream` at commit `1bb5da4`
**Method:** read-only review by six parallel reviewers, one per deployable part. LiveKit was not reviewed. The API, the desktop's native Rust core and the desktop UI were reviewed with Fable 5.2; the admin dashboard, the Telegram bot, the release pipeline and the infra configs with Opus 5.5.

Findings are marked **CONFIRMED** (checked in the code, sometimes reproduced) or **PLAUSIBLE** by the reviewer who found them. They were not independently re-checked afterwards, so verify a finding before you fix it.

## Reports

| # | File | Part | Grade |
|---|---|---|---|
| 1 | [01-api-security-core.md](01-api-security-core.md) | API: auth, sessions, admin, relay | B- |
| 2 | [02-api-chat-library-media.md](02-api-chat-library-media.md) | API: chat, library, board, media | B |
| 3 | [03-desktop-native-rust.md](03-desktop-native-rust.md) | Desktop native (Rust/Tauri) | B |
| 4 | [04-desktop-react-ui.md](04-desktop-react-ui.md) | Desktop UI (React) | B |
| 5 | [05-admin-dashboard.md](05-admin-dashboard.md) | Admin dashboard | B+ |
| 6 | [06-telegram-bot-release-infra.md](06-telegram-bot-release-infra.md) | Telegram bot, release pipeline, infra | B+ / B / B- |

## Test status

| Part | Result |
|---|---|
| API | `go vet` clean; `go test ./...` passes. `go test -race` on `internal/http` timed out after 10 minutes, so whether that package is race-free is unknown. |
| Desktop native | `cargo test --lib`: 353 passed, 5 ignored. Clippy: 31 warnings, all style-level. Built only on macOS. |
| Desktop UI | `tsc --noEmit` clean; `bun test`: 823 pass. |
| Admin dashboard | `tsc --noEmit` clean; `bun test`: 13 pass. |
| Telegram bot | `go vet` clean; `go test -race` passes. |
| Release signature verifier | Builds; has no unit tests. |

Authorization holds up well throughout. No reviewer found an IDOR (one user acting on another's data), SQL injection or XSS. The problems are in how credentials are handled, in resource limits, and in the places where the parts meet.

## What to fix first

1. **Session ids are bearer tokens, and the API exposes them.** They're stored in plaintext and returned by `GET /v1/admin/users/:id` and `GET /v1/auth/sessions`, so an admin can copy one and act as that user without leaving an audit entry. The desktop also keeps every account's token in `localStorage`. Fix: store a hash of the token, give sessions a separate public id, and keep tokens in the OS keychain. (`admin_users.go:270`, `auth_sessions.go:50`, `lib/api.ts:665`)
2. **The desktop has no CSP and no per-window command scoping** (`tauri.conf.json:28`). Any script injection in any window can start the camera or a screen share, publish a local port through Workshop, read files through `library_stage`/`attachment_prepare` (which accept any path), and read every saved account's token.
3. **Removed users keep call access.** LiveKit tokens last 2 hours and removal is a single kick, so a user who is removed, suspended or server-muted can reconnect with the cached token (`auth/livekit.go:87`). Fix: tokens of a few minutes, plus a reconcile loop or a webhook that checks each join.
4. **The client IP is spoofable.** The edge nginx passes the client's `X-Forwarded-For` through and Fiber takes the leftmost address, which bypasses sign-in throttling. The throttle also never sweeps old entries, so its memory grows. Separately, Fiber routes case-insensitively, so `/v1/ADMIN/...` skips nginx's case-sensitive admin block; an admin session is still required.
5. **`release.ps1` can publish a rehearsal build.** It only checks for a real commit when `-GitHub` is passed, so `build -AllowDirty` followed by `publish` ships uncommitted code to every client's auto-updater. (`release.ps1:314`)
6. **The HTTP server has no limits on slow or crashing requests.** There are no read, write or idle timeouts, a 20 MB body limit applies before authentication, and there is no panic recovery, so one handler panic takes down the whole process with every live connection. (`server.go:254`)

## Confirmed bugs

- **Monthly recurrence is wrong.** For long-running monthly events, the fast-forward step jumps to the wrong month, so reminders never fire. Reproduced by the reviewer. (`event_recurrence.go:222`)
- **Library uploads between 10 and 20 MB always fail.** Uploads up to 20 MB are accepted, but the media store won't read objects over 10 MB, so those files fail conversion and stay marked failed for 24 hours.
- **Quiz answers leak.** Saving or forwarding an unanswered quiz shows you the correct answers. (`chat_polls.go:229`)
- **One failed request disables chat and calls.** If fetching the server properties fails once, the desktop tears down chat and points calls at `ws://127.0.0.1:7880`. (`useRavenShellData.ts:155`)
- **Signing out loses or leaks data.** Signing out of one account deletes every account's unsent messages. Sign-out doesn't reload the app, so the previous user's drafts carry over to the next one.
- **Library previews are blocked in production.** The admin dashboard's CSP doesn't allow `blob:` images.
- **Deleted accounts look active in the admin dashboard,** with every action available, though each one then fails.

## Medium-priority themes

- **No storage quotas.** Chat attachments, the library and the Telegram bot's disk use are all unbounded per user. Uploaded images can be up to 100 megapixels and avatars have no dimension check, so clients may allocate hundreds of MB to show one.
- **Expensive per-member work.** Reacting to a forwarded message, or a board edit sent to a whole large space, can run tens of thousands of queries while a conversation lock is held.
- **Desktop audio:** the capture and playback callbacks allocate memory and take locks, which risks dropouts. Network connect and close calls have no timeout while the engine's command lock is held, and device enumeration blocks the main thread.
- **Unbounded connections:** nothing limits unauthenticated relay connections or SSE streams per user.
- **Supply chain:** `rustup-init` and the ffmpeg source are downloaded without a checksum check.
- **Backups and transport:** backups stay on the same host, unencrypted, with nothing alerting on failure. The CDN reaches the origin server over plain HTTP.

## Structural

- `services/api/internal/http` is about 40k lines in one package. Split it into accounts, spaces, calls, chat, admin and realtime packages.
- Split the largest files: `AudioMixerPanel.tsx` (3.9k lines), `useRavenMediaAdapter.ts` (one 1.3k-line hook), `audio/state.rs` (5.3k lines) and `audio/capture.rs` (4.9k lines).
- The repo has no CI and no ESLint config. Neither `tsconfig` typechecks test files. The Windows and Linux Rust code, which holds most of the `unsafe` code, was never compiled during this review.
- `@raven/shared` isn't imported anywhere and its types have drifted. Delete it, or generate the client types from the Go structs.
