#!/usr/bin/env bash
# Creates "Raven Release Signing", the self-signed certificate the macOS release builds in
# CI are signed with, and writes it as a PKCS#12 file for the repository's secrets.
#
#   apps/desktop/scripts/macos-release-signing-certificate.sh <output-folder>
#
# Why: macOS remembers a permission (microphone, camera, screen recording) for an app's
# designated requirement. An ad hoc build's requirement is the hash of its own code, so
# every new version is asked again. Signed with one certificate, the requirement becomes
# "app.raven.desktop, signed by this certificate", which every later release keeps.
#
# What it does not do: no Mac trusts this certificate and Apple will not notarize with it,
# so a downloaded copy still needs "Open Anyway" once (docs/releasing.md). Only an Apple
# Developer ID removes that.
#
# Make it once and keep it. A new certificate is a new requirement, so everyone is asked
# for the permissions again. Keep the output folder somewhere safe and offline, apart from
# the copy in GitHub. It does not go in the login keychain: local builds use
# "Raven Local Code Signing" (macos-signing-identity.sh), so an app built on a developer's
# Mac never inherits the permissions people gave a release.
set -euo pipefail

name="Raven Release Signing"
out=${1:?Usage: $0 <output-folder>}

if [ -e "$out" ]; then
  echo "$out already exists. Pick a new folder: this never overwrites a certificate." >&2
  exit 1
fi
umask 077
mkdir "$out"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cat > "$work/cert.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $name
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
EOF

# The system LibreSSL writes a PKCS#12 file the keychain can import; OpenSSL 3's default
# ciphers it cannot, and the runner's import would fail.
password=$(/usr/bin/openssl rand -hex 24)
/usr/bin/openssl req -x509 -newkey rsa:3072 -nodes -days 3650 \
  -config "$work/cert.cnf" -keyout "$work/key.pem" -out "$work/cert.pem" 2>/dev/null
/usr/bin/openssl pkcs12 -export -name "$name" -passout "pass:$password" \
  -inkey "$work/key.pem" -in "$work/cert.pem" -out "$out/raven-release-signing.p12"

printf '%s\n' "$password" > "$out/password.txt"
/usr/bin/openssl x509 -in "$work/cert.pem" -noout -subject -enddate -fingerprint -sha256 > "$out/certificate.txt"

cat <<EOF
Created "$name" in $out:
  raven-release-signing.p12   the certificate and its private key
  password.txt                the file's password
  certificate.txt             subject, expiry and SHA-256 fingerprint

Add it to the repository's secrets (from the repository root):
  base64 -i "$out/raven-release-signing.p12" | gh secret set MACOS_SIGNING_CERTIFICATE
  gh secret set MACOS_SIGNING_CERTIFICATE_PASSWORD < "$out/password.txt"

Release tags (v*) are then signed with it; everything else stays ad hoc.
EOF
