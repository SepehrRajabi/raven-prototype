#!/usr/bin/env bash
# Creates "Raven Local Code Signing", a self-signed code signing identity in the login
# keychain, so local macOS builds keep their permissions from one build to the next.
#
#   apps/desktop/scripts/macos-signing-identity.sh
#
# macOS remembers a permission (microphone, camera, screen recording) for an app's
# designated requirement. An unsigned build's requirement is the hash of its own code,
# so every rebuild looks like a new app and is asked again. Signed with this identity,
# the requirement becomes "app.raven.desktop, signed by this certificate", which a
# rebuild keeps. `bun run tauri build` uses it when it is present.
#
# It is for this Mac only: the certificate is not trusted anywhere, so a build signed
# with it is still "from an unidentified developer" on other Macs. Remove it with
#   security delete-identity -c "Raven Local Code Signing"
set -euo pipefail

name="Raven Local Code Signing"
keychain="$HOME/Library/Keychains/login.keychain-db"

if security find-certificate -c "$name" "$keychain" >/dev/null 2>&1; then
  echo "\"$name\" is already in the login keychain."
  exit 0
fi

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

# The system LibreSSL writes a PKCS#12 file the keychain can import; OpenSSL 3's
# default ciphers it cannot.
password=$(/usr/bin/openssl rand -hex 16)
/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -config "$work/cert.cnf" -keyout "$work/key.pem" -out "$work/cert.pem" 2>/dev/null
/usr/bin/openssl pkcs12 -export -name "$name" -passout "pass:$password" \
  -inkey "$work/key.pem" -in "$work/cert.pem" -out "$work/identity.p12"
# -T lets codesign use the key. macOS may still ask once; choose "Always Allow".
security import "$work/identity.p12" -k "$keychain" -P "$password" -T /usr/bin/codesign

echo "Created \"$name\". Builds made with 'bun run tauri build' are now signed with it."
