# Raven Development

## API

Start LiveKit for local RTC:

```powershell
livekit-server --dev
```

`livekit-server` is a separate LiveKit media server process. It can be run from any directory as long as the executable is on `PATH`; it does not run from inside `services/api` or `apps/desktop`.

The API defaults to `LIVEKIT_URL=ws://127.0.0.1:7880`, `LIVEKIT_API_KEY=devkey`, and `LIVEKIT_API_SECRET=secret`.

```powershell
cd services/api
go mod tidy
go run ./cmd/raven-api
```

Create the first admin:

```powershell
cd services/api
go run ./cmd/raven-api user create --username admin --display-name "Raven Admin" --password "a-long-admin-password" --role admin
```

Provision users, Spaces, Rooms, and Space membership against the API's configured PostgreSQL or SQLite database:

```powershell
go run ./cmd/raven-api user create --username alice --display-name "Alice Example" --password "a-long-password"
go run ./cmd/raven-api space create --name "Raven Core" --creator alice
go run ./cmd/raven-api room create --name "Daily Room" --space "Raven Core"
go run ./cmd/raven-api space add-user --space "Raven Core" --username admin
go run ./cmd/raven-api space add-user --space "Raven Core" --username alice --role owner
```

`--display-name` is optional and falls back to the username. `--space` accepts an active Space ID or an exact, unique name. The optional membership role is `owner`, `moderator`, or `member`, with `member` used for new/restored memberships when omitted. A built binary uses the same interface:

```powershell
raven-api room create --name "Daily Room" --space "<space-id>"
```

Run tests:

```powershell
cd services/api
go test ./...
```

Run the desktop updater and UI suites:

```powershell
cd apps\desktop
bun install --frozen-lockfile
bun test
bun run build

cd src-tauri
cargo fmt --all -- --check
cargo check
cargo test
```

Releases are built and published with `release.ps1`; see `docs/releasing.md`. Never copy the updater private key off the release workstation.

## Desktop

On Windows, the desktop native build requires LLVM for bindgen. Install it once
with `winget install LLVM.LLVM` (or use another local LLVM installation); the
Tauri wrapper discovers the local `libclang.dll` and ignores stale absolute LLVM
paths inherited from another synced machine.

```powershell
cd apps/desktop
bun install
bun run tauri dev
```

Build:

```powershell
cd apps/desktop
bun run build
bun run tauri build
```

## Android (MobileNative)

The Android app builds from this same frontend and Rust crate. Desktop-only Rust code is
`#[cfg(not(mobile))]`, Android-only code `#[cfg(mobile)]`; `isAndroid`
(`src/mobileNative/platform.ts`) picks the phone shell in `App.tsx`. The local plugin
`src-tauri/plugins/raven-mobile-native` holds all Kotlin, Gradle, manifest and resources;
the `src-tauri/gen/android` project is generated and ignored. The WebRTC JAR and native
libraries are staged from the locked `webrtc-sys-build` archive at build time, so no
binaries are checked in.

Toolchain: Rust with the `aarch64-linux-android` target, JDK 17, SDK platform 36,
build tools 35.0.0, NDK 27.2.12479018, Gradle 8.14.3. From `apps/desktop`:

```sh
bun install --frozen-lockfile
bun run mobile-native:init    # generates src-tauri/gen/android
bun run mobile-native:check   # frontend tests, then an arm64 debug APK
```

Set `RAVEN_MOBILE_NATIVE_API_URL` or `VITE_RAVEN_API_URL` to an API the phone can reach.
`scripts/tauri.ts` loads the repository `.env` by plain assignment, so a value there wins
over the shell. Release builds need an `https:` URL and allow cleartext only to the
loopback frame service; debug builds also allow a LAN API. The debug APK is written under
`src-tauri/gen/android/app/build/outputs/apk/universal/debug/` (arm64 only, debug signed).

On Windows, Android commands use the TypeScript wrapper directly so flags such as
`--debug` reach Tauri; desktop commands still use the PowerShell/MSVC wrapper. Keep the
JDK, NDK and Rust on `PATH`, and use a short `CARGO_TARGET_DIR` when the checkout path is
long.

Known limits: a foreground service keeps audio calls running in the background, but
heartbeat and rejoin still run in the WebView, which Android may throttle, so presence can
lapse during a long background call. The camera works only in the foreground. Swiping the
app away ends the call. Device lists are matched by name, and choosing an output may not
change the route while `MODE_IN_COMMUNICATION` is set. Not built yet: screen and playback
capture, audio route selection, picture-in-picture, push, iOS.

## Notes

- Use Bun for all JavaScript and TypeScript package operations.
- The desktop app is not a browser meeting interface.
- Do not add public registration.
- Product UI should say Nest or Nests, not Room or Rooms.
