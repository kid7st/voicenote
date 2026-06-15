#!/usr/bin/env bash
set -euo pipefail

# One command to produce a shippable VoiceNote.app zip.
#
#   bash scripts/package.sh                                  # ad-hoc (internal)
#   bash scripts/package.sh "Developer ID Application: …"    # for notarization
#
# Builder prerequisites: Rust+cargo, bun, node/npm, Xcode CLT, and pi installed
# globally (npm i -g @earendil-works/pi-coding-agent) — build-vn-sidecar.sh
# stages pi from there. End users need none of this; it's all bundled.

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(dirname "$HERE")"
cd "$APP"
IDENTITY="${1:--}"
VER="$(node -p "require('./src-tauri/tauri.conf.json').version" 2>/dev/null || echo dev)"
BUNDLE="src-tauri/target/release/bundle/macos/VoiceNote.app"
OUT="release/VoiceNote-$VER.zip"

echo "==> Building (stages vn/bun/ffprobe/pi, then bundles) …"
bun install >/dev/null 2>&1 || true
bun run tauri build

echo "==> Signing ($IDENTITY) …"
bash scripts/sign-macos.sh "$BUNDLE" "$IDENTITY"

echo "==> Zipping …"
mkdir -p release
rm -f "$OUT"
ditto -c -k --keepParent "$BUNDLE" "$OUT"

echo
echo "✅ 成品: $APP/$OUT  ($(du -h "$OUT" | cut -f1))"
echo
if [ "$IDENTITY" = "-" ]; then
  cat <<EOF
未公证(内部分发)。把 zip 发给用户,让其在终端粘贴这一行安装:

  unzip -o ~/Downloads/VoiceNote-$VER.zip -d /Applications \\
    && xattr -dr com.apple.quarantine /Applications/VoiceNote.app \\
    && open /Applications/VoiceNote.app

(那条 xattr 是未公证时绕过 Gatekeeper 的唯一手动步骤;做了 Developer ID 公证后即可省略,双击即用。)
EOF
else
  cat <<EOF
已用 Developer ID 签名。下一步公证后即可双击安装:

  xcrun notarytool submit "$OUT" --keychain-profile <profile> --wait
  unzip -o "$OUT" -d /tmp && xcrun stapler staple /tmp/VoiceNote.app
  # 重新 zip 已 staple 的 .app 再分发
EOF
fi
