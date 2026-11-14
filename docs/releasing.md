# Releasing Raven

Raven's desktop app updates itself with Tauri's signed updater. There is no update
server and no dashboard: one file on the Raven host, `latest.json`, says which version is current,
and one script, `release.ps1`, builds, signs and publishes.

```
release.ps1 (this PC)                    raven: /srv/raven/releases/          a friend's Raven
  build Windows (here)                     0.1.0/Raven_0.1.0_x64-setup.exe     reads latest.json,
  build Linux (Docker in WSL)   scp ──►    0.1.0/Raven_0.1.0_amd64.AppImage    says "update available",
  sign and verify both (here)              0.1.0/latest.json                   downloads and restarts
  write latest.json last                   latest.json                         when the person asks
```

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

The release holds the Windows installer, the AppImage and `SHA256SUMS` from this command,
and the [Linux packages](#linux-distribution-packages) and [macOS builds](#macos-builds)
from GitHub Actions, with the release notes and install steps for all of them as its text
(`infra/release/github-release.md`). The server is not attached: self-hosters use the
Docker images, and the text links to them. Raven does not update from GitHub; it only ever
reads `latest.json` on the Raven host.

### Two ways in, one release

Pushing a `v*` tag runs both workflows, and each publishes its files on that tag's GitHub
release when its builds and checks pass. `release.ps1 github` pushes the tag itself, so a
normal release needs nothing more. Whichever gets there first creates the release, with the
same text; the other adds its files to it:

- The command usually creates it, since the workflows take several minutes. They then add
  their files, about 20 minutes later on a cold cache.
- A tag pushed by hand (`git tag -a vX.Y.Z -m "Raven X.Y.Z" && git push origin vX.Y.Z`)
  gets a release with the Linux packages and macOS builds only. Running the command for
  that version later adds the Windows installer, the AppImage and `SHA256SUMS`.

Neither side replaces a file that is already on the release. A workflow skips its files
when its checksum file (`SHA256SUMS-macos`, `SHA256SUMS-linux-packages`) is already
there, and stops if only some of its files are, naming the ones to delete. The command
adds only what is missing and compares the rest with its build.

A tag that doesn't match the app's version (`tauri.conf.json`) builds but is never
published. That catches a forgotten version bump, and makes a test tag safe: for example,
push `v0.0.0-signing-test` to check the macOS release signing, then delete the tag.

A tag on GitHub, from either path, also publishes nothing to the Raven host: `latest.json`,
the updater files and the Docker images still come only from `release.ps1`.

This makes code public, because the repository is. The command tags the commit the
installers were built from as `vX.Y.Z` and pushes the tag. It also moves GitHub's `main`
forward to that commit, and stops if GitHub's `main` has diverged. Commits after the
release commit stay local. Rehearsal builds are refused. It needs `gh auth login` once.

A release that already exists gets only the files it lacks. The command then downloads its
own files back and stops if one differs: bump the version instead. If an upload died half
way, the command names the draft to delete before running it again.

## Linux distribution packages

GitHub Actions (`.github/workflows/linux-packages.yml`) builds native packages next to
the AppImage. Each is built in its family's oldest supported release, then installed with
the distro's package manager on the releases listed, where the binary's libraries are
checked:

| Package | Built on | Install-tested on |
| --- | --- | --- |
| `Raven_X.Y.Z_amd64.deb` | Ubuntu 22.04 | Debian 12, 13; Ubuntu 22.04, 24.04 |
| `Raven_X.Y.Z_x86_64_fedora.rpm` | Fedora 44 | Fedora 44 |
| `Raven_X.Y.Z_x86_64_el10.rpm` | AlmaLinux 10 | AlmaLinux 10, Rocky Linux 10 (EPEL and CRB enabled) |
| `Raven_X.Y.Z_x86_64_opensuse.rpm` | openSUSE Leap 16.0 | Leap 16.0, Tumbleweed |
| `raven-desktop-X.Y.Z-1-x86_64.pkg.tar.zst` | Arch Linux | Arch Linux |

It runs on pushes and pull requests that touch the desktop's Rust side or the packaging,
on every `v*` tag, and by hand. Each run keeps the packages as workflow artifacts. On a
release tag they also go on the GitHub release with `SHA256SUMS-linux-packages` (see
[Two ways in, one release](#two-ways-in-one-release)). If that step failed, run it again on
the tag:

```sh
gh workflow run linux-packages.yml --ref vX.Y.Z -f attach_to_release=true
```

The packages are not signed, and the in-app updater only knows how
to replace the AppImage: Raven installed from one of these packages still says when a
new version is out, but installing it from Raven fails, so people update by installing
the new package.

To build one locally, with Docker, from the repository root (after `bun run build` in
`apps/desktop`):

```sh
docker run --rm -v "$PWD:/src" -w /src fedora:44 sh -c \
  'infra/release/linux/install-build-deps.sh && infra/release/linux/build-package.sh rpm out fedora'
```

## macOS builds

GitHub Actions (`.github/workflows/macos-builds.yml`) builds the app for both kinds of
Mac, each natively on a runner of that kind:

| Build | For | Built on |
| --- | --- | --- |
| `Raven_X.Y.Z_aarch64.dmg` | Apple silicon (M1 and later), macOS 13+ | `macos-26` |
| `Raven_X.Y.Z_x64.dmg` | Intel, macOS 13+ | `macos-26-intel` |

Each build is checked before it is kept: the binary is for that processor only, needs no
macOS newer than 13.0, its signature verifies, and it loads nothing from outside macOS
and the app (no Homebrew libraries). The runners are macOS 26 because screencapturekit's
Metal bridge needs its SDK; what the app runs on is set by the deployment target, not the
runner.

It runs when the same things change as for the Linux packages, on every `v*` tag, and by
hand. The DMGs are kept as workflow artifacts. On a release tag they also go on the GitHub
release with `SHA256SUMS-macos` (see [Two ways in, one release](#two-ways-in-one-release)).
If that step failed, run it again on the tag:

```sh
gh workflow run macos-builds.yml --ref vX.Y.Z -f attach_to_release=true
```

Neither is signed with an Apple Developer ID
or notarized, so macOS refuses the first launch of a downloaded copy: open **System
Settings › Privacy & Security** and choose **Open Anyway** under the message about Raven,
once. There are no macOS updater artifacts either (`latest.json` has no macOS entry), so
people update by installing the new DMG.

### The release signing certificate

Builds of a `v*` tag are signed with Raven's own self-signed certificate, "Raven Release
Signing", when the repository has it; every other build is signed ad hoc. macOS keeps a
permission (microphone, camera, screen recording) for the certificate an app is signed
with, so a new version signed with the same one keeps the permissions people gave the last.
An ad hoc build is identified by the hash of its own code, so each version is asked again.
The certificate does not make Raven trusted: the first launch still needs **Open Anyway**.

Make it once, on a Mac, and keep it:

```sh
apps/desktop/scripts/macos-release-signing-certificate.sh ~/raven-release-signing
base64 -i ~/raven-release-signing/raven-release-signing.p12 | gh secret set MACOS_SIGNING_CERTIFICATE
gh secret set MACOS_SIGNING_CERTIFICATE_PASSWORD < ~/raven-release-signing/password.txt
```

- Keep the folder offline and backed up. Do not make a second one: a new certificate is a
  new identity, so everyone is asked for the permissions again.
- The certificate lasts ten years (`certificate.txt` has its expiry and fingerprint).
- The workflow imports it into a keychain of its own and gives Tauri only the identity's
  name. Do not set `APPLE_CERTIFICATE` instead: Tauri then imports the certificate itself
  and fails to find the identity, because it skips certificates macOS doesn't trust.
- Only release tags get the secret, so branch and pull request runs never see it. The
  workflow fails a tag build that is not signed by the certificate, but only when the
  secret is set: without it a tag build is signed ad hoc and passes.
- It is not in the login keychain. Local builds use "Raven Local Code Signing"
  (`scripts/macos-signing-identity.sh`), so an app built on a developer's Mac never
  inherits the permissions people gave a release.
- Switching to an Apple Developer ID later is also a new identity, and asks everyone once.

To build one locally, on a Mac, from `apps/desktop`:

```sh
bun run tauri build --target aarch64-apple-darwin --bundles app,dmg   # or x86_64-apple-darwin
```

An Intel build needs `nasm` (`brew install nasm`) for mozjpeg's SIMD code.

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
  DPAPI file beside it) never leaves this PC. The Raven host only stores files. If the key is lost,
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
