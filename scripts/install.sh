#!/usr/bin/env bash
set -euo pipefail

# voicenote installer for macOS
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/kid7st/voicenote/main/scripts/install.sh | bash
#
# Optional preseed example (otherwise the installer writes editable templates):
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

# Only PATH goes into the shell rc (so the interactive shell finds vn/bun/brew).
# All app config lives in ~/.config/voicenote/config.json (see write_config_json),
# which vn reads with precedence: process.env > config.json > ~/.zshrc.
configure_shell_env() {
  log "Configuring PATH"
  local shell_name="$(basename "${SHELL:-}")"
  local path_line="export PATH=\"\$HOME/.local/bin:\$HOME/.bun/bin:/opt/homebrew/bin:/opt/homebrew/sbin:\$PATH\""
  case "$shell_name" in
    fish)
      if command -v fish >/dev/null 2>&1; then
        fish -lc "set -Ux PATH \$HOME/.local/bin \$HOME/.bun/bin /opt/homebrew/bin /opt/homebrew/sbin \$PATH"
        log "Configured fish PATH"
      else
        append_once "$HOME/.profile" "# === voicenote ===" "$path_line"
      fi
      ;;
    zsh) append_once "$HOME/.zshrc" "# === voicenote ===" "$path_line" ;;
    bash)
      if [[ -f "$HOME/.bash_profile" ]]; then
        append_once "$HOME/.bash_profile" "# === voicenote ===" "$path_line"
      else
        append_once "$HOME/.bashrc" "# === voicenote ===" "$path_line"
      fi
      ;;
    *) append_once "$HOME/.profile" "# === voicenote ===" "$path_line" ;;
  esac
  export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"
}

# Write the canonical config template to ~/.config/voicenote/config.json. Existing
# values win; environment variables can preseed/override values during install.
write_config_json() {
  log "Preparing ~/.config/voicenote/config.json"
  VOICENOTE_WORKSPACE="$WORKSPACE" \
  VOICENOTE_PI_MODEL="${VOICENOTE_PI_MODEL:-gpt-5.5}" \
  VOLCANO_ASR_KEY="${VOLCANO_ASR_KEY:-}" \
  VOLCANO_ASR_RESOURCE_ID="${VOLCANO_ASR_RESOURCE_ID:-volc.seedasr.auc}" \
  VOLCANO_TOS_REGION="${VOLCANO_TOS_REGION:-cn-guangzhou}" \
  VOLCANO_TOS_ENDPOINT="${VOLCANO_TOS_ENDPOINT:-tos-s3-cn-guangzhou.volces.com}" \
  VOLCANO_TOS_BUCKET="${VOLCANO_TOS_BUCKET:-}" \
  VOLCANO_TOS_ACCESS_KEY="${VOLCANO_TOS_ACCESS_KEY:-}" \
  VOLCANO_TOS_SECRET_KEY="${VOLCANO_TOS_SECRET_KEY:-}" \
  VOLCANO_TOS_KEEP="${VOLCANO_TOS_KEEP:-0}" \
  node <<'NODE'
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')
const configDir = join(process.env.HOME, '.config/voicenote')
const path = join(configDir, 'config.json')
const legacySpeakersPath = join(configDir, 'speakers.json')
const keys = ['VOICENOTE_WORKSPACE','VOICENOTE_PI_MODEL','VOLCANO_ASR_KEY','VOLCANO_ASR_RESOURCE_ID','VOLCANO_TOS_REGION','VOLCANO_TOS_ENDPOINT','VOLCANO_TOS_BUCKET','VOLCANO_TOS_ACCESS_KEY','VOLCANO_TOS_SECRET_KEY','VOLCANO_TOS_KEEP']
const defaults = {
  VOICENOTE_WORKSPACE: process.env.VOICENOTE_WORKSPACE,
  VOICENOTE_PI_MODEL: process.env.VOICENOTE_PI_MODEL,
  VOLCANO_ASR_KEY: '',
  VOLCANO_ASR_RESOURCE_ID: process.env.VOLCANO_ASR_RESOURCE_ID,
  VOLCANO_TOS_REGION: process.env.VOLCANO_TOS_REGION,
  VOLCANO_TOS_ENDPOINT: process.env.VOLCANO_TOS_ENDPOINT,
  VOLCANO_TOS_BUCKET: '',
  VOLCANO_TOS_ACCESS_KEY: '',
  VOLCANO_TOS_SECRET_KEY: '',
  VOLCANO_TOS_KEEP: process.env.VOLCANO_TOS_KEEP,
}
const normalizeSpeakers = (value) => {
  const raw = value && typeof value === 'object' ? value : {}
  return {
    self: {
      name: typeof raw.self?.name === 'string' ? raw.self.name : null,
      aliases: Array.isArray(raw.self?.aliases) ? raw.self.aliases.filter((a) => typeof a === 'string') : [],
    },
    known: Array.isArray(raw.known) ? raw.known : [],
  }
}
let cfg = {}
try { cfg = JSON.parse(readFileSync(path, 'utf8')) } catch {}
for (const k of keys) {
  if (cfg[k] == null) cfg[k] = defaults[k] ?? ''
  if (process.env[k]) cfg[k] = process.env[k]
}
if (!cfg.speakers) {
  let legacy = null
  try { legacy = JSON.parse(readFileSync(legacySpeakersPath, 'utf8')) } catch {}
  cfg.speakers = normalizeSpeakers(legacy)
}
if (process.env.VOICENOTE_NAME) cfg.speakers.self.name = process.env.VOICENOTE_NAME
if (process.env.VOICENOTE_ALIAS) cfg.speakers.self.aliases = [process.env.VOICENOTE_ALIAS]
mkdirSync(configDir, { recursive: true })
writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
NODE
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

run_doctor() {
  if [[ "${VOICENOTE_RUN_DOCTOR:-0}" != "1" ]]; then
    log "Skipping vn doctor (run it after editing config.json)"
    return
  fi
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
  configure_shell_env
  install_deps
  install_voicenote
  write_config_json
  run_doctor
  install_launch_agent

  log "Done"
  cat <<EOF

Next steps:
  1. Edit config:
       open ~/.config/voicenote/config.json
       # or open the directory: vn open config
     Fill Volcano ASR/TOS keys and your name/aliases in config.json.
  2. Log in to ChatGPT (REQUIRED for the default pi-codex summary backend —
     without it transcription will run but note generation will fail):
       vn login                 # device-code flow; or run \`pi\` and use /login
     Then confirm: vn doctor   # expect pi.auth=logged-in and Volcano config present
  3. Optional: install background watcher after config is ready:
       vn install-launch-agent
  4. Insert PHILIPS VTR6500 and test:
       vn run --latest --dry-run
       vn run --latest
       vn list

Config lives in ~/.config/voicenote/config.json. Env vars still override it.
Optional knobs (then re-run \`vn install-launch-agent\`):
  VOICENOTE_PI_THINKING=high          # summary reasoning effort
  VOICENOTE_PI_SUMMARY_TOOLS=""       # empty to disable read/grep cross-reference
  VOICENOTE_CONTEXT_DIR="\$HOME/vault" # read/grep root + agent cwd (default: workspace)
  See README for the full list.

Output:
  $WORKSPACE/YYYY-MM/

Logs:
  ~/.local/state/voicenote/logs/launchd.out.log
  ~/.local/state/voicenote/logs/launchd.err.log
EOF
}

main "$@"
