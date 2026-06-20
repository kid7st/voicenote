# Stage everything the bundled Windows app needs as Tauri externalBin / resources.
# Windows counterpart of build-vn-sidecar.sh (host mode). Run on Windows with
# bun + node/npm + a global pi install. externalBin files are named with the
# MSVC target triple + .exe so Tauri picks them up; pi is JS -> a plain resource.
$ErrorActionPreference = "Stop"

$Here      = Split-Path -Parent $MyInvocation.MyCommand.Path   # app/scripts
$App       = Split-Path -Parent $Here                          # app
$Repo      = Split-Path -Parent $App                           # repo root
$Res       = Join-Path $App "src-tauri\binaries"
$Resources = Join-Path $App "src-tauri\resources"
$Triple    = "x86_64-pc-windows-msvc"
New-Item -ItemType Directory -Force -Path $Res, $Resources | Out-Null

# --- vn engine: compile to a single Windows exe ---
Push-Location $Repo
if (-not (Test-Path "node_modules\cac")) { bun install }
$VnOut = Join-Path $Res "vn-$Triple.exe"
bun build --compile --target=bun-windows-x64 src/cli.ts --outfile $VnOut
Pop-Location
Write-Host "vn: binaries/vn-$Triple.exe"

# --- bun runtime: copy the bun.exe on PATH (used to run pi) ---
$BunSrc = (Get-Command bun).Source
Copy-Item -Force $BunSrc (Join-Path $Res "bun-$Triple.exe")
Write-Host "bun: binaries/bun-$Triple.exe"

# --- ffprobe: pull the win32-x64 static build via npm (only ffprobe, not ffmpeg) ---
$FfTarget = Join-Path $Res "ffprobe-$Triple.exe"
if (-not (Test-Path $FfTarget)) {
  $Stage = Join-Path $env:TEMP ("vnff_" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $Stage | Out-Null
  Push-Location $Stage
  npm install --no-save --no-package-lock "@ffprobe-installer/ffprobe" | Out-Null
  $FfPath = node -e "console.log(require('@ffprobe-installer/ffprobe').path)"
  Pop-Location
  Copy-Item -Force $FfPath $FfTarget
  Remove-Item -Recurse -Force $Stage
}
Write-Host "ffprobe: binaries/ffprobe-$Triple.exe"

# --- pi package (JS, arch-independent) -> resource ---
$PiDest = Join-Path $Resources "pi"
if (-not (Test-Path (Join-Path $PiDest "dist\cli.js"))) {
  $NpmRoot = (npm root -g).Trim()
  $PiSrc = Join-Path $NpmRoot "@earendil-works\pi-coding-agent"
  if (-not (Test-Path $PiSrc)) {
    throw "pi not found at $PiSrc. Run: npm i -g @earendil-works/pi-coding-agent"
  }
  if (Test-Path $PiDest) { Remove-Item -Recurse -Force $PiDest }
  New-Item -ItemType Directory -Force -Path $PiDest | Out-Null
  Copy-Item -Recurse -Force (Join-Path $PiSrc "*") $PiDest
}
Write-Host "pi: resources/pi"
