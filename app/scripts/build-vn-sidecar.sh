#!/usr/bin/env bash
set -euo pipefail

# Stage everything the bundled .app needs as Tauri externalBin / resources.
#
#   build-vn-sidecar.sh            # host arch (for `tauri dev`)
#   build-vn-sidecar.sh universal  # fat x86_64+arm64 (for the shipped build)
#
# Executables (vn/bun/ffprobe) are externalBin named with the build's target
# triple so Tauri picks them up. pi is JS (arch-independent) → a plain resource.

MODE="${1:-host}"
HERE="$(cd "$(dirname "$0")" && pwd)"   # app/scripts
APP="$(dirname "$HERE")"                # app
REPO="$(dirname "$APP")"                # repo root
RES="$APP/src-tauri/binaries"
RESOURCES="$APP/src-tauri/resources"
mkdir -p "$RES" "$RESOURCES"

cd "$REPO"
[ -d node_modules/cac ] || bun install   # vn engine deps (cac/pi-ai)

# ── pi package (JS, same for both arches) ──
stage_pi() {
  if [ ! -f "$RESOURCES/pi/dist/cli.js" ]; then
    PI_SRC="$(npm root -g)/@earendil-works/pi-coding-agent"
    [ -d "$PI_SRC" ] || { echo "ERROR: pi not found at $PI_SRC. npm i -g @earendil-works/pi-coding-agent" >&2; exit 1; }
    rm -rf "$RESOURCES/pi"; mkdir -p "$RESOURCES/pi"
    cp -R "$PI_SRC/." "$RESOURCES/pi/"
    echo "✓ pi: resources/pi ($(du -sh "$RESOURCES/pi" | cut -f1))"
  else
    echo "✓ pi: resources/pi (already staged)"
  fi
}

if [ "$MODE" = "universal" ]; then
  # Tauri's `--target universal-apple-darwin` builds each arch slice and lipos
  # them itself, so we provide BOTH per-arch sidecars (not a pre-merged one).
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

  # Tauri needs the per-arch sidecars (build phase) AND a merged -universal one
  # (bundle phase), so we produce all three for each binary.

  # vn: cross-compile each arch, then lipo
  bun build --compile --target=bun-darwin-arm64 src/cli.ts --outfile "$RES/vn-aarch64-apple-darwin"
  bun build --compile --target=bun-darwin-x64   src/cli.ts --outfile "$RES/vn-x86_64-apple-darwin"
  lipo -create "$RES/vn-aarch64-apple-darwin" "$RES/vn-x86_64-apple-darwin" -output "$RES/vn-universal-apple-darwin"
  echo "✓ vn: aarch64 + x86_64 + universal"

  # bun runtime: download each arch from GitHub releases
  BUNVER="$(bun --version)"
  BASE="https://github.com/oven-sh/bun/releases/download/bun-v$BUNVER"
  curl -fsSL "$BASE/bun-darwin-aarch64.zip" -o "$TMP/bun-arm.zip"
  curl -fsSL "$BASE/bun-darwin-x64.zip"     -o "$TMP/bun-x64.zip"
  ditto -x -k "$TMP/bun-arm.zip" "$TMP/bun-arm"
  ditto -x -k "$TMP/bun-x64.zip" "$TMP/bun-x64"
  cp -f "$(find "$TMP/bun-arm" -name bun -type f | head -1)" "$RES/bun-aarch64-apple-darwin"
  cp -f "$(find "$TMP/bun-x64" -name bun -type f | head -1)" "$RES/bun-x86_64-apple-darwin"
  lipo -create "$RES/bun-aarch64-apple-darwin" "$RES/bun-x86_64-apple-darwin" -output "$RES/bun-universal-apple-darwin"
  chmod +x "$RES/bun-aarch64-apple-darwin" "$RES/bun-x86_64-apple-darwin" "$RES/bun-universal-apple-darwin"
  echo "✓ bun: aarch64 + x86_64 + universal"

  # ffprobe: `npm pack` each per-arch package (tarball download skips the host
  # platform check that `npm install` enforces)
  mkdir -p "$TMP/fp-arm" "$TMP/fp-x64"
  ( cd "$TMP/fp-arm" && npm pack @ffprobe-installer/darwin-arm64 >/dev/null 2>&1 && tar -xzf ./*.tgz )
  ( cd "$TMP/fp-x64" && npm pack @ffprobe-installer/darwin-x64 >/dev/null 2>&1 && tar -xzf ./*.tgz )
  cp -f "$(find "$TMP/fp-arm" -name ffprobe -type f | head -1)" "$RES/ffprobe-aarch64-apple-darwin"
  cp -f "$(find "$TMP/fp-x64" -name ffprobe -type f | head -1)" "$RES/ffprobe-x86_64-apple-darwin"
  lipo -create "$RES/ffprobe-aarch64-apple-darwin" "$RES/ffprobe-x86_64-apple-darwin" -output "$RES/ffprobe-universal-apple-darwin"
  chmod +x "$RES/ffprobe-aarch64-apple-darwin" "$RES/ffprobe-x86_64-apple-darwin" "$RES/ffprobe-universal-apple-darwin"
  echo "✓ ffprobe: aarch64 + x86_64 + universal"

else
  SUF="$(rustc -vV | sed -n 's/host: //p')"

  bun build --compile src/cli.ts --outfile "$RES/vn-$SUF"
  echo "✓ vn: binaries/vn-$SUF"

  cp -f "$(realpath "$(command -v bun)")" "$RES/bun-$SUF"; chmod +x "$RES/bun-$SUF"
  echo "✓ bun: binaries/bun-$SUF"

  if [ ! -f "$RES/ffprobe-$SUF" ]; then
    STAGE="$(mktemp -d)"
    ( cd "$STAGE" && npm install --no-save --no-package-lock @ffprobe-installer/ffprobe >/dev/null 2>&1 )
    cp -f "$(cd "$STAGE" && node -e 'console.log(require("@ffprobe-installer/ffprobe").path)')" "$RES/ffprobe-$SUF"
    chmod +x "$RES/ffprobe-$SUF"; rm -rf "$STAGE"
  fi
  echo "✓ ffprobe: binaries/ffprobe-$SUF"
fi

stage_pi
