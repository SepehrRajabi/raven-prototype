# Releasing Raven

Raven's desktop app updates itself with Tauri's signed updater. There is no update
server and no dashboard: one file on the Raven host, `latest.json`, says which version is current,
and one script, `release.ps1`, builds, signs and publishes.

```
release.ps1 (this PC)                    raven: /srv/raven/releases/          a friend's Raven
  build Windows (here)                     0.1.0/Raven_0.1.0_x64-setup.exe     reads latest.json,
  build Linux (Docker in WSL)   scp ──►    0.1.0/Raven_0.1.0_amd64.AppImage    says "update available",
  build Android (here)                     0.1.0/Raven_0.1.0.apk               downloads and restarts
  sign and verify all (here)               0.1.0/latest.json                   when the person asks
  write latest.json last                   latest.json
```

The Android app can be released with desktop: the same version, the same commands, and a
download on the same page. It is off until `$ReleaseAndroid = $true` near the top of
`release.ps1`; while it is off, nothing about Android is built or published. It does not
update itself; people download the new APK.

The files are served at `https://updates.rvn.bluehour.cloud`.

## Releasing a version

1. Set the same version in `apps/desktop/package.json`,
   `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/Cargo.toml` and
   `packages/shared/package.json`.
2. Optionally write `docs/release-notes/<version>.md`. The app shows it as "What's new". `build`
   also puts the notes of every older file in `docs/release-notes/` in `latest.json`, so someone
   several versions behind sees everything they are getting.
3. Regenerate the licence notices and commit them with the version:

   ```powershell
   cd apps\desktop; bun scripts/third-party-notices.ts
   ```

   The installer bundles `src-tauri/THIRD-PARTY-NOTICES.md` and Settings › About shows it.
   `release.ps1` does not run the script yet.
4. Commit.
5. Build and sign both installers:

   ```powershell
   .\release.ps1 build -Version 0.1.1
   ```

   They land in `.release\0.1.1\`. These are the files to send a friend for a first
   install. Try them yourself before the next step.
6. Publish:

   ```powershell
   .\release.ps1 publish -Version 0.1.1
   ```

   This uploads the installers, checks their hashes on the Raven host, switches `latest.json`, then
   downloads everything back through the public address and compares it with what was
   built. Every Raven that is open notices within six hours, or at once with **Settings →
   Updates → Check now**. The same switch rewrites the download page at
   `https://updates.rvn.bluehour.cloud/` for first installs; `repoint` rewrites it too.

   Two optional flags publish to the outside services too, for a PC that can reach them:

   ```powershell
   .\release.ps1 publish -Version 0.1.1 -Docker -GitHub
   ```

   `-Docker` pushes the [server images](#server-images) before the update host switches.
   `-GitHub` creates the [GitHub release](#github-release) after it. Without the flags only
   Vala is touched. If a flagged step fails, run `images` or `github` on its own afterwards.

`.\release.ps1 status` shows what is on the server and what is being offered.

A fresh install signs in to `https://mimir.rvn.bluehour.cloud` by default; `-ApiUrl` on
`build` changes that.

## Web app

The phone app also runs in a browser, for iPhones: `https://updates.rvn.bluehour.cloud/app/`.
In Safari, Share → Add to Home Screen gives it an icon and a full screen. Calls end when
the phone locks or the app is in the background; chat is not affected. It is uploaded by
hand, not by `release.ps1`:

```powershell
cd apps\desktop; bun run web:build
ssh raven "rm -rf /srv/raven/releases/app.new"
scp -r web\dist raven:/srv/raven/releases/app.new
ssh raven "cd /srv/raven/releases && rm -rf app.old && { [ ! -d app ] || mv app app.old; } && mv app.new app"
```

The releases container never caches `/app/` itself (`releases-nginx.conf`), and the API
allows the page's origin (`RAVEN_CORS_ALLOWED_ORIGINS` in `compose.yaml`).

## Server images

People who host their own Raven server run it from Docker Hub images
(`soroushtaheri/raven-api`, `soroushtaheri/raven-admin`; guide: `docs/self-hosting.md`).
Publish them with `publish -Docker`, or on their own:

```powershell
.\release.ps1 images -Version X.Y.Z            # :X.Y.Z and :latest, linux/amd64 + linux/arm64
.\release.ps1 images -Version X.Y.Z -DryRun     # builds both platforms, pushes nothing
```

It builds with buildx in WSL, from the commit this version's installers were built from.
With no build of that version on this PC it builds the last commit instead, which needs a
clean tree. `-DryRun` always builds the last commit. `-NoLatest` skips `:latest`. Run
`docker login` inside WSL once; the password stays in WSL's Docker config. It prints each
pushed image's digest. Paste `infra/self-host/DOCKERHUB-api.md` and `DOCKERHUB-admin.md`
into their Docker Hub repository pages when it changes.

## GitHub release

The installers can also be downloaded from
[GitHub](https://github.com/raven-collective/raven-prototype/releases). Publish them with
`publish -GitHub`, or on their own from a PC that has this version's build:

```powershell
.\release.ps1 github -Version X.Y.Z
```

The release holds the Windows installer, the AppImage and `SHA256SUMS`, with the release
notes and install steps as its text. The server is not attached: self-hosters use the
Docker images, and the text links to them. Raven does not update from GitHub; it only ever
reads `latest.json` on the Raven host.

This makes code public, because the repository is. The command tags the commit the
installers were built from as `vX.Y.Z` and pushes the tag. It also moves GitHub's `main`
forward to that commit, and stops if GitHub's `main` has diverged. Commits after the
release commit stay local. Rehearsal builds are refused. It needs `gh auth login` once.

A release that already exists is left alone and compared with this build. It downloads
the release back and stops if a file differs: bump the version instead. If an upload died
half way, the command names the draft to delete before running it again.

## What a friend sees

Raven checks about ten seconds after it starts and every six hours. When a newer version
exists, "Update available" appears in the title bar and in Settings → Updates. Nothing is
downloaded until they press **Download**, and nothing restarts until they press **Restart
to update**. Raven refuses to restart during a call.

## When a release is bad

The usual fix is to ship the next version.

To stop a bad version spreading in the meantime, point `latest.json` back at an older one:

```powershell
.\release.ps1 repoint -Version 0.1.0
```

Raven only installs versions newer than the one it is running, so this downgrades nobody.
Someone already on the bad version reinstalls the older installer by hand; `repoint`
prints its links. The newest five versions are kept on the Raven host for this.

A published version never changes. If a build was wrong, bump the version.

## Making old versions update

When a server change breaks older clients, raise `RAVEN_MINIMUM_CLIENT_VERSION` in
`/srv/raven/.env` on the Raven host and recreate the `api` container
(`cd /srv/raven && docker compose up -d api`). Older clients then get
a "Raven needs an update" screen with the update controls, instead of failing in odd ways.
That is the only server-side update setting.

## Why it is safe

- Raven installs nothing unless its signature matches the public key built into the app
  (`apps/desktop/src-tauri/updater/raven-updater.key.pub`). A cut-off or altered download
  fails that check and is thrown away.
- A failed check, download or install leaves the running version untouched. The app then
  offers the installer as a plain download.
- Installers are uploaded and hash-checked before `latest.json` moves, and `latest.json`
  is swapped by a rename, so a client never reads a half-published release.
- The signing key (`%USERPROFILE%\.raven\updater\raven-updater.key`, password in the
  DPAPI file beside it) never leaves this PC. The same goes for the Android key
  (`%USERPROFILE%\.raven\android\raven-android.keystore`): Android installs a new APK over
  an old one only when both carry the same key, so without it everyone uninstalls first. The Raven host only stores files. If the key is lost,
  existing installs can no longer be updated and everyone reinstalls by hand, so keep a
  backup of that folder somewhere safe.

## One-time setup on the release PC

- The usual desktop build tools (see `development.md`), and `ssh raven` working (root login with your key).
- Docker inside the WSL distro (`Ubuntu` by default; `-WslDistro` picks another), with
  your user in the `docker` group:

  ```bash
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker $USER
  ```

  Then restart WSL (`wsl --shutdown`). If Docker Hub is unreachable, add a registry mirror
  to `/etc/docker/daemon.json`, as on Saye.
- For Android: JDK 21 (`JAVA_HOME`) and the Android SDK (`ANDROID_HOME`, with build-tools),
  and the Android signing key, made once. Back up the folder; a lost key cannot be replaced.

  ```powershell
  $dir = "$env:USERPROFILE\.raven\android"; New-Item -ItemType Directory -Force $dir | Out-Null
  $password = Read-Host -AsSecureString "Android key password"
  $password | ConvertFrom-SecureString | Set-Content "$dir\raven-android.password.dpapi"
  & "$env:JAVA_HOME\bin\keytool" -genkeypair -keystore "$dir\raven-android.keystore" -alias raven -keyalg RSA -keysize 4096 -validity 36500 -dname "CN=Raven" -storepass ([Net.NetworkCredential]::new("", $password).Password)
  ```

The Linux build runs in a pinned Ubuntu 22.04 image
(`infra/release/Dockerfile.linux-appimage`), so the AppImage works on Ubuntu 22.04,
Debian 12 and anything newer. The first build takes a while; later ones reuse
`~/raven-build/cache` inside WSL.

## Rehearsing an update

To watch an update happen without publishing a real version, publish into a scratch
folder and point a debug build at it:

```powershell
.\release.ps1 build   -Version 0.1.1 -AllowDirty -Scratch test
.\release.ps1 publish -Version 0.1.1 -Scratch test
$env:RAVEN_UPDATE_ENDPOINT = "https://updates.rvn.bluehour.cloud/test/latest.json"
bun run tauri dev
```

Only debug builds read `RAVEN_UPDATE_ENDPOINT`. Delete
`/srv/raven/releases/test` on the Raven host afterwards.

## On the Raven host

Production runs on its own machine, SSH host `raven` (95.38.188.65), in `/srv/raven`.
The Compose file, edge config and firewall scripts are kept in `infra/raven/`.

- Compose service `releases` serves `/srv/raven/releases` read-only. `release.ps1` writes
  there as root over SSH.
- The `edge` service (nginx, `/srv/raven/edge-nginx.conf`) proxies `updates.rvn.bluehour.cloud`
  to it, and `mimir`, `admin` and `rtc` to the API, the dashboard and LiveKit.
- `latest.json` is served with `Cache-Control: no-cache`; versioned files are cacheable.
- Port 80 is open only to ArvanCloud's CDN ranges, and 7881/tcp and 50002-50100/udp to
  everyone. The rules are `raven-firewall.service`; see `infra/raven/firewall/`.
- Profile pictures and chat images are files in `/srv/raven/media` (no object store).
- A nightly backup (04:41 UTC, 14 days) of the database and media is in `/srv/raven/backups`.
  It is on the same machine, so it is not protection against losing the host.
- The data as it was when Raven left Vala is in `/srv/raven/pre-migration/` (root only).

### Deploying the API and these services

Secrets are in `/srv/raven/.env` (mode 600):

```bash
ssh raven
cd /srv/raven && docker compose <command>
```

Back up the database before deploying an API image: the API applies its migrations when
it starts, and migrations may not be reversible (`systemctl start raven-backup.service`).
The images are loaded from a tarball (`docker save ... | ssh raven docker load`), not
built on the host. Load the new image, then `docker compose up -d api admin`, and verify
the API and update endpoints. Edge changes: edit `/srv/raven/edge-nginx.conf`, then
`docker compose exec edge nginx -t && docker compose exec edge nginx -s reload`.

## Vala

Vala (`prod-core-01`) runs a separate, empty Raven server for testing, at
`mimir.rvn.valapmis.com`, `rtc.rvn.valapmis.com` and `admin.rvn.valapmis.com`. It has no
updates host; releases are never published there.
