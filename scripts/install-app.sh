#!/usr/bin/env bash
set -euo pipefail

# VoiceNote 桌面客户端 一键安装（macOS）
#
#   curl -fsSL https://raw.githubusercontent.com/kid7st/voicenote/main/scripts/install-app.sh | bash
#
# 下载已打包的 .app（自包含:bun/pi/ffprobe/全部内置）→ 装到 /Applications →
# 去掉隔离标记（未公证时绕过 Gatekeeper 的唯一手动步骤，这里替用户做了）→ 打开。
# 目标机器无需 bun / pi / ffprobe / 全局 vn。
#
# 覆盖下载地址（测试或私有分发）：VOICENOTE_APP_URL=file:///path/to/VoiceNote.zip

REPO="${VOICENOTE_REPO:-kid7st/voicenote}"
URL="${VOICENOTE_APP_URL:-https://github.com/$REPO/releases/latest/download/VoiceNote.zip}"
APP_NAME="VoiceNote.app"
LABEL="com.kid7st.voicenote"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

log()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
err()  { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; }

[ "$(uname -s)" = "Darwin" ] || { err "仅支持 macOS。"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

log "下载 VoiceNote…"
curl -fSL "$URL" -o "$TMP/VoiceNote.zip"

log "解压…"
ditto -x -k "$TMP/VoiceNote.zip" "$TMP/out"
APP_SRC="$(find "$TMP/out" -maxdepth 2 -name "$APP_NAME" -type d | head -1)"
[ -n "$APP_SRC" ] || { err "压缩包里没找到 $APP_NAME"; exit 1; }

# 优先 /Applications；无写权限则退回 ~/Applications
DEST_DIR="/Applications"
if [ ! -w "$DEST_DIR" ]; then DEST_DIR="$HOME/Applications"; mkdir -p "$DEST_DIR"; fi
DEST="$DEST_DIR/$APP_NAME"

# Upgrade-safe: stop the running agent/GUI so the existing bundle isn't locked
# while we replace it (a fresh install just no-ops these).
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
pkill -f "$APP_NAME" 2>/dev/null || true
sleep 1

log "安装到 $DEST …"
rm -rf "$DEST"
ditto "$APP_SRC" "$DEST"

log "去除隔离标记…"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

# Re-load the background agent if it was already installed (upgrade); a fresh
# install has no plist yet — the GUI installs+loads it on first launch.
if [ -f "$PLIST" ] && [ "$DEST_DIR" = "/Applications" ]; then
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || true
fi

log "打开…"
open "$DEST"

cat <<EOF

✅ 安装完成:$DEST

首次使用:
  1. 应用会停在「设置」页 —— 填名字 + 你的火山 ASR/TOS 密钥 + 代理，保存
  2. 在「状态」面板点「登录 ChatGPT」(浏览器授权一次)
  3. 完成后后台 agent 自动启用；插上录音笔即自动转写并生成纪要
EOF
