#!/usr/bin/env bash
# Installs what building Raven's desktop app needs, on the distro this runs on. Run as
# root (CI runs it inside the distro's container).
#
#   install-build-deps.sh
#
# Supported: Debian/Ubuntu (apt), Fedora and RHEL clones (dnf), openSUSE (zypper) and
# Arch (pacman). The RPM distros are asked for pkg-config names, so one list fits them
# all. Rust comes from rustup, into $CARGO_HOME (~/.cargo by default); build-package.sh
# brings the Tauri CLI, so CI can restore its build cache in between.
set -euo pipefail

rust_toolchain=${RUST_TOOLCHAIN:-1.96.0}

# shellcheck disable=SC1091
. /etc/os-release
family=" ${ID:-} ${ID_LIKE:-} "

# Native libraries the Rust build links against (webkit2gtk-sys, gtk-sys, alsa-sys,
# libdbus-sys through tao, webrtc-sys) and the tray library the Tauri CLI looks for
# when it writes the package's dependencies.
rpm_libs=(
  'pkgconfig(webkit2gtk-4.1)'
  'pkgconfig(gtk+-3.0)'
  'pkgconfig(alsa)'
  'pkgconfig(dbus-1)'
  'pkgconfig(librsvg-2.0)'
  'pkgconfig(glib-2.0)'
)

case "$family" in
  *" debian "* | *" ubuntu "*)
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y --no-install-recommends \
      build-essential ca-certificates clang curl file git libclang-dev nasm pkg-config \
      libasound2-dev libayatana-appindicator3-dev libdbus-1-dev libgtk-3-dev \
      librsvg2-dev libwebkit2gtk-4.1-dev
    ;;

  *" fedora "* | *" rhel "* | *" centos "*)
    if [ "${ID}" != fedora ]; then
      # RHEL clones keep the -devel packages in CRB and nasm/the tray library in EPEL.
      dnf install -y dnf-plugins-core epel-release
      dnf config-manager --set-enabled crb
    fi
    dnf install -y \
      clang clang-devel curl file findutils gcc gcc-c++ git make nasm pkg-config \
      "${rpm_libs[@]}"
    dnf install -y 'pkgconfig(ayatana-appindicator3-0.1)' ||
      dnf install -y 'pkgconfig(appindicator3-0.1)'
    ;;

  *" suse "* | *" opensuse "*)
    zypper --non-interactive refresh
    zypper --non-interactive install --no-recommends \
      clang clang-devel curl file findutils gcc gcc-c++ git gzip linux-glibc-devel make \
      nasm pkg-config tar \
      "${rpm_libs[@]}"
    zypper --non-interactive install --no-recommends 'pkgconfig(ayatana-appindicator3-0.1)' ||
      zypper --non-interactive install --no-recommends 'pkgconfig(appindicator3-0.1)'
    ;;

  *" arch "*)
    pacman -Syu --noconfirm --needed \
      alsa-lib base-devel clang curl dbus file git gtk3 libayatana-appindicator \
      librsvg linux-api-headers nasm webkit2gtk-4.1
    ;;

  *)
    echo "install-build-deps.sh does not know this distro (ID=${ID:-?}, ID_LIKE=${ID_LIKE:-?})." >&2
    exit 2
    ;;
esac

export CARGO_HOME=${CARGO_HOME:-$HOME/.cargo}
export RUSTUP_HOME=${RUSTUP_HOME:-$HOME/.rustup}
export PATH="$CARGO_HOME/bin:$PATH"
if ! command -v rustup >/dev/null; then
  curl --proto '=https' --tlsv1.2 --fail --silent --show-error https://sh.rustup.rs |
    sh -s -- -y --no-modify-path --profile minimal --default-toolchain none
fi
rustup toolchain install "$rust_toolchain" --profile minimal
rustup default "$rust_toolchain"
