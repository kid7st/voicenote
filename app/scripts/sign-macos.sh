#!/usr/bin/env bash
set -euo pipefail

# Deep-sign the bundled .app inside-out with hardened runtime + JIT entitlements.
#
# Internal use now:   sign-macos.sh <App.app>            # ad-hoc ("-"), validates JIT
# Distribution later: sign-macos.sh <App.app> "Developer ID Application: NAME (TEAMID)"
#                     then: xcrun notarytool submit ... && xcrun stapler staple <App.app>
#
# Why hardened runtime + these entitlements: vn and bun JIT-compile at runtime;
# under the hardened runtime that crashes without com.apple.security.cs.allow-jit
# (+ allow-unsigned-executable-memory). disable-library-validation lets the app
# load the sidecars / pi's .node addons signed by other identities.

APP="${1:?usage: sign-macos.sh <App.app> [signing-identity]}"
IDENTITY="${2:--}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ENT="$HERE/../src-tauri/entitlements.plist"

# Ad-hoc ("-") can't carry a secure timestamp; a real identity should.
if [ "$IDENTITY" = "-" ]; then TS=(--timestamp=none); else TS=(--timestamp); fi

sign()       { codesign --force --options runtime "${TS[@]}" --entitlements "$ENT" -s "$IDENTITY" "$1"; }
sign_plain() { codesign --force --options runtime "${TS[@]}" -s "$IDENTITY" "$1"; }

echo "Signing $APP with identity: $IDENTITY"

# 1) Nested native addons (only the darwin ones are Mach-O; skip win/linux blobs)
while IFS= read -r f; do
  if file "$f" | grep -q 'Mach-O'; then sign_plain "$f"; fi
done < <(find "$APP/Contents/Resources" -name '*.node' 2>/dev/null)

# 2) Sidecar executables (vn & bun JIT -> need entitlements)
sign       "$APP/Contents/MacOS/vn"
sign       "$APP/Contents/MacOS/bun"
sign_plain "$APP/Contents/MacOS/ffprobe"

# 3) The app bundle itself, last (seals everything above)
sign "$APP"

codesign --verify --deep --strict --verbose=2 "$APP"
echo "OK: signed + verified."
