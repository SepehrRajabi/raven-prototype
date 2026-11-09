# Raven

Raven is a desktop-first RTC meeting application MVP. The meeting concept is a **Nest**: authenticated users create Nests, invite users, and approve Join Requests from uninvited users.

This repository is a monorepo:

```text
apps/desktop   Tauri v2 + React + TypeScript desktop app
apps/admin     Web dashboard for the server's administrator (docs/permissions.md)
services/api   Go 1.26.3 + Fiber API with PostgreSQL or SQLite
packages/shared shared TypeScript domain types
docs           architecture and development notes
```

## Requirements

- Windows, or macOS 13+ (see [Running on macOS](#running-on-macos))
- Go `1.26.3`
- Bun
- Rust toolchain
- LiveKit server for RTC

Do not use npm, pnpm, or yarn in this repository.

## Running on macOS

The commands below are written for PowerShell; on macOS the same steps work from a normal shell. You need the Xcode Command Line Tools (`xcode-select --install`) or Xcode, plus:

```sh
brew install go bun livekit
curl https://sh.rustup.rs -sSf | sh
```

Then, from the repository root:

```sh
cp .env.example .env
# For a local setup: comment out DATABASE_URL to use SQLite, and set
# RAVEN_MEDIA_DIR=data/media to keep media on disk instead of S3.
# LIVEKIT_API_SECRET must be "secret" to match `livekit-server --dev`.

livekit-server --dev                                   # terminal 1
cd services/api && go run ./cmd/raven-api              # terminal 2
cd apps/desktop && bun install && bun run tauri dev    # terminal 3
```

`bun run tauri build` produces `apps/desktop/src-tauri/target/release/bundle/macos/Raven.app` and a `.dmg` next to it. Without the release signing key it skips the signed updater artifacts. Screen sharing asks for the Screen & System Audio Recording permission.

macOS remembers permissions for an app's code signature, and an unsigned build's signature changes with every rebuild, so each new build asks for the microphone, camera and screen recording again. Run `apps/desktop/scripts/macos-signing-identity.sh` once: it adds a self-signed "Raven Local Code Signing" identity to your login keychain, and `bun run tauri build` then signs with it, so rebuilds keep their permissions. The certificate is only trusted on your Mac, so on another Mac right-click the app and choose **Open** the first time.

## Start LiveKit for RTC

For local development, run LiveKit in dev mode:

```powershell
livekit-server --dev
```

If PowerShell says `livekit-server` is not found, install the LiveKit server first and make sure it is on `PATH`. Raven's RTC button will not connect until something is listening on the configured LiveKit URL.

`livekit-server` is a separate LiveKit media server process. Run it from any directory; it does not run from inside the Raven API or desktop app.

Raven defaults to LiveKit's local dev settings:

```powershell
$env:LIVEKIT_URL="ws://127.0.0.1:7880"
$env:LIVEKIT_API_KEY="devkey"
$env:LIVEKIT_API_SECRET="secret"
```

For LiveKit Cloud or another deployment, set those three variables before starting the API.

## Start the API

Copy the example env file and fill in real secrets/connection settings:

```powershell
Copy-Item .env.example .env
```

```powershell
cd services/api
go mod tidy
go run ./cmd/raven-api
```

The API listens on `http://127.0.0.1:6977` by default.

Optional environment variables:

```powershell
$env:RAVEN_API_ADDR="127.0.0.1:6977"
$env:RAVEN_SERVER_NAME="Raven"
$env:RAVEN_SERVER_DESCRIPTION="Desktop RTC for private Nests"
$env:RAVEN_SERVER_AVATAR=""
$env:DATABASE_URL="postgres://raven:change-me@127.0.0.1:5432/raven?sslmode=disable"
$env:LIVEKIT_URL="ws://127.0.0.1:7880"
$env:LIVEKIT_API_KEY="devkey"
$env:LIVEKIT_API_SECRET="secret"
```

User, Tree/Space, and server profile pictures use the configured S3 bucket under the `profile-images/` namespace. Set `RAVEN_MEDIA_PREFIX` to change that namespace. Dedicated `RAVEN_MEDIA_S3_*` settings may override the shared `S3_*` endpoint, bucket, region, credentials, and path-style settings.

When `DATABASE_URL` or `RAVEN_DATABASE_URL` is set, Raven uses PostgreSQL. You can also set `RAVEN_DATABASE_DRIVER=postgres` with `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_SSLMODE`. If no PostgreSQL settings are present, the API falls back to SQLite at `RAVEN_DATABASE_PATH` or `data/raven.db`.

## Create the first admin user

```powershell
cd services/api
go run ./cmd/raven-api user create --username admin --display-name "Raven Admin" --password "a-long-admin-password" --role admin
```

The provisioning commands use the same database selection as the API: configured PostgreSQL when its environment variables are present, otherwise the configured/default SQLite database. `--display-name` is optional and falls back to the username.

```powershell
go run ./cmd/raven-api user create --username alice --display-name "Alice Example" --password "a-long-password"
go run ./cmd/raven-api space create --name "Raven Core" --creator alice
go run ./cmd/raven-api room create --name "Daily Room" --space "Raven Core"
go run ./cmd/raven-api space add-user --space "Raven Core" --username admin --role moderator
```

`--space` accepts an active Space ID or an exact, unique Space name. Space membership defaults to `member`; `--role` may be `owner`, `moderator`, or `member`. A built `raven-api` binary accepts the same commands, for example:

```powershell
raven-api room create --name "Daily Room" --space "<space-id>"
```

Passwords need at least 10 characters. Asking for `--role owner` transfers the Space to that user: a Space has one owner, and the previous one becomes a moderator.

Day to day, users, their permissions, Spaces and Rooms are managed from the admin dashboard in `apps/admin`. [docs/permissions.md](docs/permissions.md) describes the permission model, the dashboard and how it is deployed.

## Start the desktop app

Run the Go API and LiveKit yourself first. Then, in another PowerShell window:

```powershell
cd apps/desktop
bun install
bun run tauri dev
```

Run `bun install` again whenever `apps/desktop/package.json` changes. The LiveKit RTC client is provided by the `livekit-client` dependency.

Desktop dev loads the repository `.env`, sets the default `VITE_RAVEN_API_URL` from `RAVEN_API_ADDR`, and does not start the Go API or RTC server. For example:

```env
RAVEN_API_ADDR=192.168.28.172:6977
LIVEKIT_URL=ws://192.168.28.172:7880
```

The desktop app lets logged-out users enter or pick the Raven API server URL. The app fetches server properties from that API and uses the returned realtime server URL for RTC, so users do not enter the RTC URL manually. Make sure the API host has matching `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` settings.

Raven authentication is stateful. The API stores 30-day rolling sessions in the configured SQLite or PostgreSQL database and the desktop app sends the opaque session ID in `X-Session-ID`. Users can review and terminate active sign-ins from **Settings → Sessions**. JWTs are used only for short-lived LiveKit media access, not Raven account authentication.

If you explicitly want to build the optional Go API sidecar binary, run:

```powershell
cd apps/desktop
bun run build:sidecars
```

That generated `.exe` is intentionally not synced by Syncthing. If Go reports `error obtaining VCS status`, the synced `.git` directory is incomplete. Use a normal Git clone on that machine, or remove the broken `.git` directory from the synced copy if you are using Syncthing only for files.

The desktop app defaults to `RAVEN_API_ADDR` from `.env`. You can also choose a Raven API server from the logged-out screen. Override the default manually with:

```powershell
$env:VITE_RAVEN_API_URL="http://127.0.0.1:6977"
```

## MVP Capabilities

- Login is the first normal-user screen.
- Public registration is not visible.
- Developers can create users through the Go CLI.
- Admins can create users through an authenticated API/UI flow.
- Authenticated users can create Nests.
- Every Nest has a `raven://nest/<joinCode>` share link.
- Creators can invite users by username.
- Invited users can join immediately.
- Uninvited users using a Nest link create a pending Join Request.
- Creators or moderators can accept or reject Join Requests.
- Users can be joined to multiple Nests at once.
- Active Nest UI includes admitted participant presence, Raven RTC controls, and realtime media.
- Admitted Nest participants can connect camera, microphone, and display sharing through the configured RTC server.

## Build Commands

```powershell
cd apps/desktop
bun install
bun run build
bun run tauri build
```

```powershell
cd services/api
go test ./...
```

## Desktop updates

Raven updates itself with Tauri's signed updater. One static file, `latest.json` on `updates.rvn.bluehour.cloud`, says which version is current; the app tells the user and installs only when asked. The signing key lives under `%USERPROFILE%\.raven\updater` and never leaves the release workstation.

```powershell
.\release.ps1 build -Version 0.1.1     # Windows installer + Linux AppImage, signed
.\release.ps1 publish -Version 0.1.1   # upload and make it the current version
```

See [docs/releasing.md](docs/releasing.md).
