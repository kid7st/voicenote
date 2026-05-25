#!/usr/bin/env bash
set -euo pipefail

# voicenote installer for macOS
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/kid7st/voicenote/main/scripts/install.sh | bash
#
# Non-interactive example:
#   VOICENOTE_NAME="李元" \
#   VOICENOTE_ALIAS="Vincent" \
#   VOICENOTE_WORKSPACE="$HOME/Documents/meetings" \
#   VOLCANO_ASR_KEY="..." \
#   VOLCANO_TOS_BUCKET="..." \
#   VOLCANO_TOS_ACCESS_KEY="..." \
#   VOLCANO_TOS_SECRET_KEY="..." \
#   bash scripts/install.sh

REPO_URL="${VOICENOTE_REPO_URL:-https://github.com/kid7st/voicenote.git}"
INSTALL_REF="${VOICENOTE_INSTALL_REF:-main}"
WORKSPACE="${VOICENOTE_WORKSPACE:-$HOME/Documents/meetings}"
INSTALL_LAUNCH_AGENT="${VOICENOTE_INSTALL_LAUNCH_AGENT:-}"

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\n\033[1;33mWARN: %s\033[0m\n' "$*"; }
err() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; }

can_prompt() { [[ -t 1 && -r /dev/tty ]]; }

prompt_default() {
  local var_name="$1"
  local prompt="$2"
  local default_value="$3"
  local current_value="${!var_name:-}"
  if [[ -n "$current_value" ]]; then
    printf -v "$var_name" '%s' "$current_value"
    return
  fi
  if can_prompt; then
    local answer
    read -r -p "$prompt [$default_value]: " answer </dev/tty || true
    printf -v "$var_name" '%s' "${answer:-$default_value}"
  else
    printf -v "$var_name" '%s' "$default_value"
  fi
}

prompt_secret() {
  local var_name="$1"
  local prompt="$2"
  local current_value="${!var_name:-}"
  if [[ -n "$current_value" ]]; then
    return
  fi
  if can_prompt; then
    local answer
    read -r -s -p "$prompt: " answer </dev/tty || true
    echo
    printf -v "$var_name" '%s' "$answer"
  fi
}

prompt_yes_no() {
  local var_name="$1"
  local prompt="$2"
  local default_value="$3"
  local current_value="${!var_name:-}"
  if [[ -n "$current_value" ]]; then
    return
  fi
  if can_prompt; then
    local answer
    read -r -p "$prompt [$default_value]: " answer </dev/tty || true
    answer="${answer:-$default_value}"
    case "${answer,,}" in
      y|yes|true|1) printf -v "$var_name" '%s' "1" ;;
      *) printf -v "$var_name" '%s' "0" ;;
    esac
  else
    case "${default_value,,}" in
      y|yes|true|1) printf -v "$var_name" '%s' "1" ;;
      *) printf -v "$var_name" '%s' "0" ;;
    esac
  fi
}

append_once() {
  local file="$1"
  local marker="$2"
  local content="$3"
  mkdir -p "$(dirname "$file")"
  touch "$file"
  if grep -qF "$marker" "$file"; then
    log "Env block already exists in $file"
  else
    {
      echo ""
      echo "$marker"
      printf '%s\n' "$content"
      echo "# === /voicenote ==="
    } >> "$file"
    log "Wrote env block to $file"
  fi
}

collect_inputs() {
  log "Collecting setup values"
  prompt_default VOICENOTE_NAME "中文名 / display name" ""
  prompt_default VOICENOTE_ALIAS "英文名或别名 / alias (optional)" ""
  prompt_default VOICENOTE_WORKSPACE "Output workspace" "$WORKSPACE"
  WORKSPACE="$VOICENOTE_WORKSPACE"

  export VOLCANO_ASR_RESOURCE_ID="${VOLCANO_ASR_RESOURCE_ID:-volc.seedasr.auc}"
  export VOLCANO_TOS_REGION="${VOLCANO_TOS_REGION:-cn-guangzhou}"
  export VOLCANO_TOS_ENDPOINT="${VOLCANO_TOS_ENDPOINT:-tos-s3-cn-guangzhou.volces.com}"
  export VOLCANO_TOS_KEEP="${VOLCANO_TOS_KEEP:-0}"

  prompt_secret VOLCANO_ASR_KEY "Volcano ASR key"
  prompt_default VOLCANO_TOS_BUCKET "Volcano TOS bucket" "${VOLCANO_TOS_BUCKET:-}"
  prompt_secret VOLCANO_TOS_ACCESS_KEY "Volcano TOS access key"
  prompt_secret VOLCANO_TOS_SECRET_KEY "Volcano TOS secret key"
  prompt_yes_no INSTALL_LAUNCH_AGENT "Install LaunchAgent auto watcher?" "Y"

  export VOICENOTE_WORKSPACE="$WORKSPACE"
}

configure_shell_env() {
  log "Configuring shell environment"
  local shell_name="$(basename "${SHELL:-}")"
  local block
  block="export PATH=\"\$HOME/.local/bin:\$HOME/.bun/bin:/opt/homebrew/bin:/opt/homebrew/sbin:\$PATH\"
export VOICENOTE_WORKSPACE=\"$WORKSPACE\"
export VOLCANO_ASR_KEY=\"${VOLCANO_ASR_KEY:-}\"
export VOLCANO_ASR_RESOURCE_ID=\"${VOLCANO_ASR_RESOURCE_ID:-volc.seedasr.auc}\"
export VOLCANO_TOS_REGION=\"${VOLCANO_TOS_REGION:-cn-guangzhou}\"
export VOLCANO_TOS_ENDPOINT=\"${VOLCANO_TOS_ENDPOINT:-tos-s3-cn-guangzhou.volces.com}\"
export VOLCANO_TOS_BUCKET=\"${VOLCANO_TOS_BUCKET:-}\"
export VOLCANO_TOS_ACCESS_KEY=\"${VOLCANO_TOS_ACCESS_KEY:-}\"
export VOLCANO_TOS_SECRET_KEY=\"${VOLCANO_TOS_SECRET_KEY:-}\"
export VOLCANO_TOS_KEEP=\"${VOLCANO_TOS_KEEP:-0}\""

  case "$shell_name" in
    fish)
      if command -v fish >/dev/null 2>&1; then
        fish -lc "set -Ux PATH \$HOME/.local/bin \$HOME/.bun/bin /opt/homebrew/bin /opt/homebrew/sbin \$PATH; \
          set -Ux VOICENOTE_WORKSPACE '$WORKSPACE'; \
          set -Ux VOLCANO_ASR_KEY '${VOLCANO_ASR_KEY:-}'; \
          set -Ux VOLCANO_ASR_RESOURCE_ID '${VOLCANO_ASR_RESOURCE_ID:-volc.seedasr.auc}'; \
          set -Ux VOLCANO_TOS_REGION '${VOLCANO_TOS_REGION:-cn-guangzhou}'; \
          set -Ux VOLCANO_TOS_ENDPOINT '${VOLCANO_TOS_ENDPOINT:-tos-s3-cn-guangzhou.volces.com}'; \
          set -Ux VOLCANO_TOS_BUCKET '${VOLCANO_TOS_BUCKET:-}'; \
          set -Ux VOLCANO_TOS_ACCESS_KEY '${VOLCANO_TOS_ACCESS_KEY:-}'; \
          set -Ux VOLCANO_TOS_SECRET_KEY '${VOLCANO_TOS_SECRET_KEY:-}'; \
          set -Ux VOLCANO_TOS_KEEP '${VOLCANO_TOS_KEEP:-0}'"
        log "Configured fish universal variables"
      else
        append_once "$HOME/.profile" "# === voicenote ===" "$block"
      fi
      ;;
    zsh) append_once "$HOME/.zshrc" "# === voicenote ===" "$block" ;;
    bash)
      if [[ -f "$HOME/.bash_profile" ]]; then
        append_once "$HOME/.bash_profile" "# === voicenote ===" "$block"
      else
        append_once "$HOME/.bashrc" "# === voicenote ===" "$block"
      fi
      ;;
    *) append_once "$HOME/.profile" "# === voicenote ===" "$block" ;;
  esac

  export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"
}

install_deps() {
  log "Checking dependencies"
  if [[ "$(uname -s)" != "Darwin" ]]; then
    err "This installer currently supports macOS only."
    exit 1
  fi
  if ! command -v brew >/dev/null 2>&1; then
    err "Homebrew is required. Install it first: https://brew.sh/"
    exit 1
  fi
  if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
    brew install ffmpeg
  else
    log "ffmpeg/ffprobe already installed"
  fi
  if ! command -v bun >/dev/null 2>&1; then
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
  else
    log "bun already installed: $(bun --version)"
  fi
  if ! command -v npm >/dev/null 2>&1; then
    brew install node
  else
    log "npm already installed: $(npm --version)"
  fi
  if ! command -v pi >/dev/null 2>&1; then
    log "Installing pi CLI"
    npm i -g @earendil-works/pi-coding-agent
  fi
  if command -v pi >/dev/null 2>&1; then
    log "pi found: $(command -v pi)"
  else
    warn "pi not found. Install or add it to PATH before using pi-codex."
  fi
}

install_voicenote() {
  log "Installing voicenote from $REPO_URL#$INSTALL_REF"
  # bun can report a dependency loop when upgrading an existing global git install
  # of the same package. Removing first makes installs/upgrades idempotent.
  bun remove -g @kid7st/voicenote >/dev/null 2>&1 || true
  bun add -g "git+$REPO_URL#$INSTALL_REF"
  mkdir -p "$HOME/.local/bin"
  ln -sf "$HOME/.bun/bin/vn" "$HOME/.local/bin/vn"
  vn --version || true
}

configure_speakers() {
  log "Configuring speakers"
  mkdir -p "$HOME/.config/voicenote"
  local speakers_path="$HOME/.config/voicenote/speakers.json"
  if [[ -f "$speakers_path" && "${VOICENOTE_OVERWRITE_SPEAKERS:-0}" != "1" ]]; then
    log "Preserving existing speakers.json: $speakers_path"
    return
  fi
  VOICENOTE_NAME="${VOICENOTE_NAME:-}" VOICENOTE_ALIAS="${VOICENOTE_ALIAS:-}" node <<'NODE'
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const home = process.env.HOME
const name = process.env.VOICENOTE_NAME || null
const alias = process.env.VOICENOTE_ALIAS || ''
const config = {
  self: { name, aliases: alias ? [alias] : [] },
  known: [],
}
writeFileSync(join(home, '.config/voicenote/speakers.json'), JSON.stringify(config, null, 2) + '\n')
NODE
}

run_doctor() {
  log "Running vn doctor"
  mkdir -p "$WORKSPACE"
  vn doctor || warn "vn doctor reported issues. Check output above."
}

install_launch_agent() {
  if [[ "$INSTALL_LAUNCH_AGENT" != "1" ]]; then
    log "Skipping LaunchAgent installation"
    return
  fi
  log "Installing LaunchAgent"
  vn install-launch-agent
  local plist="$HOME/Library/LaunchAgents/com.kid7st.voicenote.plist"
  launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  launchctl enable "gui/$(id -u)/com.kid7st.voicenote"
  vn status || true
}

main() {
  collect_inputs
  configure_shell_env
  install_deps
  install_voicenote
  configure_speakers
  run_doctor
  install_launch_agent

  log "Done"
  cat <<EOF

Next steps:
  1. If pi needs login, run: pi
  2. Insert PHILIPS VTR6500.
  3. Test:
       vn run --latest --dry-run
       vn run --latest
       vn list

Output:
  $WORKSPACE/YYYY-MM/

Logs:
  ~/.local/state/voicenote/logs/launchd.out.log
  ~/.local/state/voicenote/logs/launchd.err.log
EOF
}

main "$@"
