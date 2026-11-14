{{notes}}

## Install

- **Windows:** `Raven_{{version}}_x64-setup.exe`. Windows may say the publisher is unknown: choose "More info", then "Run anyway".
- **Linux, any distribution:** `Raven_{{version}}_amd64.AppImage`. Run `chmod +x` on it. On newer Ubuntu, install `libfuse2t64` first.
- **Linux packages:** `Raven_{{version}}_amd64.deb` (Debian 12+, Ubuntu 22.04+), `Raven_{{version}}_x86_64_fedora.rpm` (Fedora 44+), `Raven_{{version}}_x86_64_el10.rpm` (RHEL, AlmaLinux and Rocky Linux 10, with EPEL and CRB enabled), `Raven_{{version}}_x86_64_opensuse.rpm` (openSUSE Leap 16, Tumbleweed), `raven-desktop-{{version}}-1-x86_64.pkg.tar.zst` (Arch Linux). Install it with your package manager. The packages are not signed.
- **macOS 13 or later:** `Raven_{{version}}_aarch64.dmg` (Apple silicon) or `Raven_{{version}}_x64.dmg` (Intel). macOS refuses the first launch: open System Settings › Privacy & Security and choose "Open Anyway" under the message about Raven, once.

The Windows installer and the AppImage are built on the release workstation; the other files are built by GitHub Actions and appear when their builds finish. `SHA256SUMS`, `SHA256SUMS-linux-packages` and `SHA256SUMS-macos` list their checksums.

Raven tells you when a newer version is out. The Windows installer and the AppImage update from inside Raven; for the packages and macOS, install the new file.

## Your own server

Server images are on Docker Hub: [soroushtaheri/raven-api](https://hub.docker.com/r/soroushtaheri/raven-api) and [soroushtaheri/raven-admin](https://hub.docker.com/r/soroushtaheri/raven-admin). See the [self-hosting guide](https://github.com/{{repo}}/blob/{{tag}}/docs/self-hosting.md).
