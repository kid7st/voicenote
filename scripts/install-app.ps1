# VoiceNote 桌面客户端 一键安装 (Windows)
#
#   irm https://raw.githubusercontent.com/kid7st/voicenote/main/scripts/install-app.ps1 | iex
#
# 下载已打包的 NSIS 安装器(自包含:vn/bun/ffprobe/pi 全内置)→ 静默装到当前用户
# (%LOCALAPPDATA%,免管理员)→ 启动。目标机器无需 bun / pi / ffprobe / Rust。
#
# 覆盖下载地址(测试或私有分发):$env:VOICENOTE_APP_URL = "file:///C:/path/VoiceNote-setup.exe"

$ErrorActionPreference = "Stop"

$Repo = if ($env:VOICENOTE_REPO) { $env:VOICENOTE_REPO } else { "kid7st/voicenote" }
$Url  = if ($env:VOICENOTE_APP_URL) { $env:VOICENOTE_APP_URL } else {
  "https://github.com/$Repo/releases/latest/download/VoiceNote-setup.exe"
}

$Tmp = Join-Path $env:TEMP ("VoiceNote-setup-" + [guid]::NewGuid().ToString("N") + ".exe")

Write-Host "==> 下载 VoiceNote..." -ForegroundColor Cyan
Invoke-WebRequest -Uri $Url -OutFile $Tmp

Write-Host "==> 安装(当前用户,免管理员)..." -ForegroundColor Cyan
# NSIS silent install (/S). currentUser mode -> no UAC prompt.
Start-Process -FilePath $Tmp -ArgumentList "/S" -Wait
Remove-Item -Force $Tmp -ErrorAction SilentlyContinue

# Locate the installed exe (Tauri NSIS currentUser install dir varies by version).
$Candidates = @(
  (Join-Path $env:LOCALAPPDATA "Programs\VoiceNote\VoiceNote.exe"),
  (Join-Path $env:LOCALAPPDATA "VoiceNote\VoiceNote.exe")
)
$Exe = $Candidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($Exe) {
  Write-Host "==> 启动..." -ForegroundColor Cyan
  Start-Process $Exe
} else {
  Write-Host "已安装,但未在默认路径找到 VoiceNote.exe — 请从开始菜单启动 VoiceNote。" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "✅ 安装完成。首次使用:" -ForegroundColor Green
Write-Host "  1. 应用停在「设置」页 —— 填名字 + 火山 ASR/TOS 密钥 + 代理,保存"
Write-Host "  2. 「状态」面板点「登录 ChatGPT」(浏览器授权一次)"
Write-Host "  3. 完成后后台计划任务自动启用;插上录音笔即自动转写并生成纪要"
