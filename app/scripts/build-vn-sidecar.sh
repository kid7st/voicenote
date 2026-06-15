#!/usr/bin/env bash
set -euo pipefail

# Assemble everything the bundled .app needs:
#   1. vn engine  -> sidecar binary (bun --compile; embeds bun + pi-ai)
#   2. bun        -> resource (runtime used to run the pi CLI)
#   3. pi package -> resource (summary backend; can't be --compile'd because it
#                    reads data files from disk, so we ship it intact + bun)

HERE="$(cd "$(dirname "$0")" && pwd)"   # app/scripts
APP="$(dirname "$HERE")"                # app
REPO="$(dirname "$APP")"                # repo root
TRIPLE="$(rustc -vV | sed -n 's/host: //p')"
RES="$APP/src-tauri/binaries"
RESOURCES="$APP/src-tauri/resources"

# 1) vn sidecar
mkdir -p "$RES"
cd "$REPO"
bun build --compile src/cli.ts --outfile "$RES/vn-$TRIPLE"
echo "✓ vn sidecar: binaries/vn-$TRIPLE"

# bun + ffprobe are EXECUTABLES, so they ship as externalBin sidecars (like vn),
# named with the target triple. (Tauri `resources` are for data files; binaries
# belong in externalBin so they get exec perms / signing handled correctly.)

# 2) bun runtime (resolve the Homebrew symlink to the real Mach-O binary)
rm -f "$RESOURCES/bun" "$RESOURCES/ffprobe" 2>/dev/null || true
BUN_BIN="$(realpath "$(command -v bun)")"
cp -f "$BUN_BIN" "$RES/bun-$TRIPLE"
chmod +x "$RES/bun-$TRIPLE"
echo "✓ bun runtime: binaries/bun-$TRIPLE ($(du -sh "$RES/bun-$TRIPLE" | cut -f1))"

# 3) ffprobe (native, portable static binary; duration detection). pi only uses
#    ffprobe, never full ffmpeg. Sourced from @ffprobe-installer (arm64 native).
if [ ! -f "$RES/ffprobe-$TRIPLE" ]; then
  STAGE="$(mktemp -d)"
  ( cd "$STAGE" && npm install --no-save --no-package-lock @ffprobe-installer/ffprobe >/dev/null 2>&1 )
  FFPROBE="$(cd "$STAGE" && node -e 'console.log(require("@ffprobe-installer/ffprobe").path)')"
  cp -f "$FFPROBE" "$RES/ffprobe-$TRIPLE"
  chmod +x "$RES/ffprobe-$TRIPLE"
  rm -rf "$STAGE"
  echo "✓ ffprobe: binaries/ffprobe-$TRIPLE ($(du -sh "$RES/ffprobe-$TRIPLE" | cut -f1))"
else
  echo "✓ ffprobe: binaries/ffprobe-$TRIPLE (already staged)"
fi

# 4) pi package (idempotent: skip the 152MB copy if already staged)
PI_SRC="$(npm root -g)/@earendil-works/pi-coding-agent"
if [ ! -f "$RESOURCES/pi/dist/cli.js" ]; then
  if [ ! -d "$PI_SRC" ]; then
    echo "ERROR: pi not found at $PI_SRC. Install it: npm i -g @earendil-works/pi-coding-agent" >&2
    exit 1
  fi
  rm -rf "$RESOURCES/pi"
  mkdir -p "$RESOURCES/pi"
  # Copy contents (dist + node_modules + package.json), follow nothing weird.
  cp -R "$PI_SRC/." "$RESOURCES/pi/"
  echo "✓ pi package: resources/pi ($(du -sh "$RESOURCES/pi" | cut -f1))"
else
  echo "✓ pi package: resources/pi (already staged)"
fi
