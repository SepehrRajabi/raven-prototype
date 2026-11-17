#!/usr/bin/env bash
# Builds a native Linux package of Raven's desktop app on the distro this runs on.
# Run install-build-deps.sh first, and build the frontend into apps/desktop/dist (CI
# builds it once and hands it to every distro).
#
#   build-package.sh <deb|rpm|pacman> <output directory> [label]
#
# deb and rpm are Tauri's own bundles. pacman builds Tauri's deb layout against this
# system's libraries and wraps it with makepkg (arch/PKGBUILD). The label goes into the
# rpm's file name, so the builds for different distros can sit side by side.
#
# Locally, from the repository root, with Docker:
#
#   docker run --rm -v "$PWD:/src" -w /src fedora:44 \
#     sh -c 'infra/release/linux/install-build-deps.sh && infra/release/linux/build-package.sh rpm out fedora'
set -euo pipefail

format=${1:?format is required: deb, rpm or pacman}
out=${2:?output directory is required}
label=${3:-}

root=$(cd "$(dirname "$0")/../../.." && pwd)
here="$root/infra/release/linux"
desktop="$root/apps/desktop"
rust_toolchain=${RUST_TOOLCHAIN:-1.96.0}
tauri_cli_version=${TAURI_CLI_VERSION:-2.11.2}

case "$format" in
  deb | rpm | pacman) ;;
  *) echo "unknown format: $format (expected deb, rpm or pacman)" >&2; exit 2 ;;
esac
case "$label" in
  *[!0-9A-Za-z.-]*) echo "invalid label: $label" >&2; exit 2 ;;
esac
test -f "$desktop/dist/index.html" || {
  echo "apps/desktop/dist is missing: build the frontend first (cd apps/desktop && bun run build)." >&2
  exit 1
}

version=$(sed -n 's/^  "version": "\([^"]*\)",$/\1/p' "$desktop/src-tauri/tauri.conf.json")
test -n "$version" || { echo "could not read the version from tauri.conf.json" >&2; exit 1; }

export CARGO_HOME=${CARGO_HOME:-$HOME/.cargo}
export RUSTUP_HOME=${RUSTUP_HOME:-$HOME/.rustup}
export PATH="$CARGO_HOME/bin:$PATH"
if ! command -v rustup >/dev/null; then
  curl --proto '=https' --tlsv1.2 --fail --silent --show-error https://sh.rustup.rs |
    sh -s -- -y --no-modify-path --profile minimal --default-toolchain none
fi
rustup toolchain install "$rust_toolchain" --profile minimal
rustup default "$rust_toolchain"
if ! cargo tauri --version 2>/dev/null | grep -qx "tauri-cli $tauri_cli_version"; then
  cargo install tauri-cli --version "$tauri_cli_version" --locked --force
fi

mkdir -p "$out"
out=$(cd "$out" && pwd)
target_dir=${CARGO_TARGET_DIR:-$desktop/src-tauri/target}
bundle_dir="$target_dir/release/bundle"
rm -rf "$bundle_dir/deb" "$bundle_dir/rpm"

bundle=$format
[ "$format" = pacman ] && bundle=deb
(cd "$desktop" && cargo tauri build --ci --bundles "$bundle" --config "$here/tauri.packages.conf.json")

built() {
  local found
  mapfile -t found < <(find "$bundle_dir/$1" -maxdepth 1 -type f -name "*.$1")
  if [ "${#found[@]}" -ne 1 ]; then
    echo "expected exactly one .$1 in $bundle_dir/$1, found ${#found[@]}" >&2
    exit 1
  fi
  printf '%s\n' "${found[0]}"
}

case "$format" in
  deb)
    cp "$(built deb)" "$out/"
    ;;
  rpm)
    arch=$(uname -m)
    cp "$(built rpm)" "$out/Raven_${version}_${arch}${label:+_$label}.rpm"
    ;;
  pacman)
    work=$(mktemp -d)
    cp "$here/arch/PKGBUILD" "$work/"
    cp "$(built deb)" "$work/raven.deb"
    # shellcheck disable=SC2016 # expanded by the inner bash, from its arguments
    makepkg_in_work='cd "$1" && RAVEN_VERSION="$2" PKGDEST="$1" makepkg --force --nodeps --noconfirm'
    # makepkg refuses to run as root, which is what containers usually are.
    if [ "$(id -u)" -eq 0 ]; then
      id builder >/dev/null 2>&1 || useradd --system --create-home builder
      chown -R builder "$work"
      runuser -u builder -- bash -c "$makepkg_in_work" _ "$work" "$version"
    else
      bash -c "$makepkg_in_work" _ "$work" "$version"
    fi
    cp "$work"/*.pkg.tar.zst "$out/"
    rm -rf "$work"
    ;;
esac

ls -l "$out"
