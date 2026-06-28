# @kid7st/voicenote

Voice recordings → diarized transcripts → integrated semantic Markdown notes.

CLI 命令:`vn`

当前主要适配 PHILIPS VTR6500 录音设备,但工作流通用:扫描某个挂载点下的录音 → 转写并按说话人分离 → GPT 在纪要生成阶段内部完成必要清理与过程还原 → 生成智能纪要。

**两种用法:**

- 🖥️ **桌面客户端(GUI)** -- 面向不用终端的用户,自包含 `.app`,一键安装:
  ```bash
  curl -fsSL https://raw.githubusercontent.com/kid7st/voicenote/main/scripts/install-app.sh | bash
  ```
  详见下方 [桌面客户端](#桌面客户端guiapp)。
- ⌨️ **CLI(`vn`)** -- 面向终端用户/开发者,见下方「安装(CLI)」。

## 安装(CLI)

推荐使用安装脚本(macOS):

```bash
curl -fsSL https://raw.githubusercontent.com/kid7st/voicenote/main/scripts/install.sh | bash
```

安装脚本默认**不做交互式配置**:先安装/检查 `ffmpeg`、Bun、Node/npm、pi、`vn`,然后生成可编辑的 `config.json` 模板。安装完成后打开配置文件填写密钥和姓名:

```bash
open ~/.config/voicenote/config.json
# 或打开目录
vn open config
```

高级用户也可以用环境变量预填模板:

```bash
VOICENOTE_NAME="李元" \
VOICENOTE_ALIAS="Vincent" \
VOICENOTE_WORKSPACE="$HOME/Documents/meetings" \
VOLCANO_ASR_KEY="..." \
VOLCANO_TOS_BUCKET="..." \
VOLCANO_TOS_ACCESS_KEY="..." \
VOLCANO_TOS_SECRET_KEY="..." \
bash <(curl -fsSL https://raw.githubusercontent.com/kid7st/voicenote/main/scripts/install.sh)
```

首次安装会生成 `~/.config/voicenote/config.json`。旧版本的 `speakers.json` 会被自动兼容读取/迁移到 `config.json.speakers`。配置完成后再运行 `vn doctor` 检查,需要后台自动监控时再运行 `vn install-launch-agent`。

> GitHub Packages 的 npm registry 通常需要 auth token;公开分发目前默认使用 GitHub git ref 安装。

手动安装:

```bash
bun add -g git+https://github.com/kid7st/voicenote.git#main
mkdir -p ~/.local/bin
ln -sf ~/.bun/bin/vn ~/.local/bin/vn
```

### Windows(CLI)

CLI 已跨平台。前置:Bun、ffmpeg(提供 `ffprobe.exe`)、Node + pi。

```powershell
bun add -g git+https://github.com/kid7st/voicenote.git#main
# Windows 无 /Volumes 挂载点,录音盘按盘符设置
setx VOICENOTE_RECORD_DIR "E:\RECORD"
```

- 配置:`%APPDATA%\voicenote\config.json`;日志/锁:`%LOCALAPPDATA%\voicenote\`
- 后台自动化走 **Windows 任务计划程序**:`vn install-launch-agent` 注册 / `vn status` 查看 / `vn uninstall-launch-agent` 移除(命令名与 macOS 一致,内部按平台分派)

## 依赖

- **Bun >= 1.3(运行时必需)** -- 代码用到 `Bun.Glob` / `Bun.file`,纯 Node 无法运行
- Node / npm -- 仅用于安装 pi CLI(pi-codex 后端)
- ffmpeg / ffprobe(音频时长检测):

```bash
brew install ffmpeg
```

安装脚本只会把 `vn` / Bun / Homebrew 的 PATH 写入当前 shell 配置;应用配置写在 `~/.config/voicenote/config.json`。手动配置时至少需要:

```json
{
  "VOICENOTE_WORKSPACE": "/Users/you/Documents/meetings",
  "VOLCANO_ASR_KEY": "...",
  "VOLCANO_ASR_RESOURCE_ID": "volc.seedasr.auc",
  "VOLCANO_TOS_REGION": "cn-guangzhou",
  "VOLCANO_TOS_ENDPOINT": "tos-s3-cn-guangzhou.volces.com",
  "VOLCANO_TOS_BUCKET": "...",
  "VOLCANO_TOS_ACCESS_KEY": "...",
  "VOLCANO_TOS_SECRET_KEY": "...",
  "VOLCANO_TOS_KEEP": "0",
  "speakers": {
    "self": { "name": "你的姓名", "aliases": ["你的别名", "英文名", "昵称"] },
    "known": []
  }
}
```

可选配置:

```json
{
  "VOICENOTE_DEVICE_VOLUME": "VTR6500",
  "VOICENOTE_RECORD_DIR": "/Volumes/VTR6500/RECORD",
  "VOICENOTE_PI_BIN": "pi",
  "VOICENOTE_PI_PROVIDER": "openai-codex,openai",
  "VOICENOTE_PI_MODEL": "gpt-5.5",
  "VOICENOTE_PI_THINKING": "high",
  "VOICENOTE_PI_SUMMARY_TOOLS": "read,grep",
  "VOICENOTE_CONTEXT_DIR": "/Users/you/vault"
}
```

## 用法

```bash
vn doctor                       # 检查环境与配置
vn run                          # 默认:Volcano ASR + pi-codex 纪要
vn run --mode transcript        # 只生成 transcript,跳过语义整理
vn run --latest                 # 只处理最新有效录音
vn run --latest --force         # 重跑最新条
vn run --pdf                    # 生成纪要后额外渲染 PDF
vn run --dry-run                # 仅列出计划
vn list                         # 列出本月笔记
vn list --month 2026-05         # 指定月份
vn last                         # 打印最新处理摘要
vn open                         # Finder 打开笔记目录
vn open config                  # 打开 ~/.config/voicenote/
vn open logs                    # 打开日志目录
vn open <slug>                  # 按文件名片段打开纪要
vn forget <id|filename>         # 让某条录音重新被处理
vn log                          # 打印今天日志末尾(--lines N / -f 跟随 / --err 含 launchd.err / --date YYYY-MM-DD)
vn errors                       # 打印最近 ERROR 日志
vn login                        # 登录 ChatGPT(Codex 设备码流,纪要后端用;无需开 pi TUI)
vn upgrade                      # reinstall latest main from GitHub git ref
vn install-launch-agent
vn status
vn uninstall-launch-agent
```

## 配置文件

安装脚本会生成一个可编辑模板:

```text
~/.config/voicenote/config.json     # workspace、Volcano ASR/TOS、summary 后端、本人姓名/别名等
```

其中 `speakers` 用于把 Speaker A/B/C 还原成真实姓名,`known` 是已知联系人:

```json
{
  "speakers": {
    "self": { "name": "你的姓名", "aliases": ["你的别名", "英文名", "昵称"] },
    "known": []
  }
}
```

修改后下一次 `vn run` 即生效。旧版 `~/.config/voicenote/speakers.json` 仍会作为兼容 fallback 读取。

## 工作流程

1. 扫描 `/Volumes/VTR6500/RECORD/` 下的录音
2. 过滤:忽略 `._*`、小文件(<100KB)、短录音(<60s)、已完成录音;如果上次只是在 summary 阶段失败且 transcript 已保存,则不视为完成,会断点继续
3. 复制原始音频到 `${VOICENOTE_WORKSPACE}/_audio/YYYY-MM/`
4. 转写:火山豆包【大模型录音文件识别标准版 API】,本地音频先传到 TOS,提交任务后轮询结果,完成后默认删除 TOS 对象
5. 转写完成后立刻落盘原始 transcript(不做 lossy 清洗),避免后面步骤失败导致 ASR 费用白付
6. summary 模型(默认 pi codex 走 ChatGPT Plus)直接看原始 transcript,在纪要生成阶段内部完成必要清理、说话人还原、观点/争论/共识形成过程还原;如果 summary 失败,下一次 `vn run` / `vn run --latest` 会复用已保存 transcript,直接重试纪要生成,不需要 `vn forget`
7. 写出 notes / metadata;系统不做任何归档决定,文件留在配置的 workspace 中

## 输出位置

installer 默认设置:`VOICENOTE_WORKSPACE=~/Documents/meetings`。

- 笔记入口:`${VOICENOTE_WORKSPACE}/YYYY-MM/`
- 原始音频:`${VOICENOTE_WORKSPACE}/_audio/YYYY-MM/`
- 完整转写:`${VOICENOTE_WORKSPACE}/_transcripts/YYYY-MM/`
- metadata:`${VOICENOTE_WORKSPACE}/_metadata/YYYY-MM/`
- 状态:`${VOICENOTE_WORKSPACE}/_state/processed.json`
- 索引:`${VOICENOTE_WORKSPACE}/_index/notes.jsonl`

## 自动化

安装脚本可自动安装。手动安装:

```bash
vn install-launch-agent
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.kid7st.voicenote.plist 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.kid7st.voicenote.plist
launchctl enable gui/$(id -u)/com.kid7st.voicenote
vn status
```

LaunchAgent 每 60 秒调用 `vn run`。没插录音笔时安全跳过;插上 VTR6500 后自动处理新录音。

> plist 在安装时快照了配置与 pi 路径。**改了 `~/.zshrc` 里的配置后,重跑 `vn install-launch-agent` 并 reload**,让后台 agent 同步(`vn upgrade` 会自动重生成 plist)。未登录 pi / ASR 未配置时,agent 会跳过处理而不会白烧 ASR。

日志:

```text
~/.local/state/voicenote/logs/launchd.out.log
~/.local/state/voicenote/logs/launchd.err.log
```

## 开发

```bash
git clone https://github.com/kid7st/voicenote.git
cd voicenote
bun install
bun run typecheck
bun run build
./dist/cli.mjs doctor
```

分发:当前公开安装默认走 GitHub git ref:

```bash
curl -fsSL https://raw.githubusercontent.com/kid7st/voicenote/main/scripts/install.sh | bash
```

如需打 tag / 发布 GitHub Packages:

```bash
bun run typecheck
bun run build
npm version patch
git push --follow-tags
```

workflow 位于 `.github/workflows/release.yml`。注意 GitHub Packages npm registry 通常需要 npm auth token,不适合作为无 token 的公开安装入口。

## 桌面客户端(GUI,`app/`)

面向**非终端用户的内部分发**:一个自包含的 macOS `.app`(Tauri v2),目标机器无需预装 bun / pi / ffprobe / 全局 `vn`。

**定位**:GUI 只是「工作状态 dashboard + 产出快捷入口」,**不驱动处理**。真正的全流程由后台 LaunchAgent 用包内引擎每 60s 自主运行(关掉 GUI 也跑)。

- 首次:配置向导(身份 / Volcano keys / 代理)→ ChatGPT 登录(设备无终端,走 `vn login` 的浏览器回调流)
- 之后:主界面显示 agent 活动 + 最近纪要(点开 / 打开文件夹)

### 打包内容

`bun build --compile` 把 `vn` 引擎(含 bun 运行时 + pi-ai)编成单文件 sidecar;pi 不能 compile(运行时读磁盘数据文件),故整包随行,用一个随包的 `bun` 运行:

| 组件 | 形式 | 用途 |
|------|------|------|
| `vn`(编译版) | externalBin | pipeline + ChatGPT 登录 |
| `bun` | externalBin | 跑 pi |
| `ffprobe`(原生 arm64 静态) | externalBin | 音频时长(pi 只用 ffprobe,不用整个 ffmpeg) |
| `pi` + node_modules | resource | 纪要后端(ChatGPT Codex agent) |

运行时 Rust 生成一个 wrapper（`exec <包内bun> <包内pi/cli.js> "$@"`）并给 `vn` 注入 `VOICENOTE_PI_BIN` / `VOICENOTE_FFPROBE_BIN`。发布构建为 **universal**（x86_64 + arm64，vn/bun/ffprobe 各自 `lipo` 合并；pi 是 JS 无需）。

### 构建

前置:Rust + cargo、bun、node/npm、Xcode CLT,且**本机全局装有 pi**(`npm i -g @earendil-works/pi-coding-agent`,构建脚本从这里取 pi 整包)。

```bash
cd app
bun install
bun run tauri build
# 产物:src-tauri/target/release/bundle/macos/VoiceNote.app
```

**Windows**(需在 Windows + Rust + MSVC C++ 生成工具上构建;WebView2 在 Win10/11 已预装,NSIS 由 Tauri 自动下载):

```powershell
cd app
bun install
bun run tauri build --config src-tauri/tauri.windows.conf.json
# 产物:app\src-tauri\target\release\bundle\nsis\VoiceNote_<版本>_x64-setup.exe
```

Windows 用 `scripts/build-vn-sidecar.ps1` 暂存 `vn.exe`(`--windows-hide-console` 无控制台)/`bun.exe`/`ffprobe.exe` + pi;`tauri.windows.conf.json` 出 NSIS(currentUser 免管理员)。

`beforeBuildCommand` 会先跑 `scripts/build-vn-sidecar.sh` 暂存 vn/bun/ffprobe/pi(`binaries/`、`resources/` 均已 gitignore;pi/ffprobe 拷贝幂等)。开发调试用 `bun run tauri dev`(dev 模式直接跑 `../src/cli.ts`,不打包、不装后台 agent)。

### 用户怎么安装(一键,推荐)

> 与上面 CLI 的 `install.sh` 是两套:CLI 面向开发者(装 bun/pi/vn);这里是面向**非技术用户**的桌面 app(下载 .app → /Applications)。

```bash
curl -fsSL https://raw.githubusercontent.com/kid7st/voicenote/main/scripts/install-app.sh | bash
```

**Windows**(一键,免管理员):

```powershell
irm https://raw.githubusercontent.com/kid7st/voicenote/main/scripts/install-app.ps1 | iex
```

`install-app.ps1` 从 GitHub Release 下载 NSIS 安装器(自包含 vn/bun/ffprobe/pi)→ 静默装到 `%LOCALAPPDATA%`(无需管理员)→ 启动。

`install-app.sh` 会:从 GitHub Releases 下载已打包的 `.app` → 装到 `/Applications` → **替用户去掉隔离标记**(未公证时绕过 Gatekeeper)→ 打开。目标机器无需 bun/pi/ffprobe/全局 vn(全内置)。

**首次打开**:应用落在「设置」页 → 填身份 + 自己的火山 ASR/TOS 密钥 + 代理(BYOK)→ 保存 → 「状态」面板点「登录 ChatGPT」(浏览器授权一次)。完成后 GUI 自动安装并加载后台 LaunchAgent(指向包内引擎),插上录音笔即自动转写+生成纪要。

> 后台 agent label 是 `com.kid7st.voicenote`(与 CLI 版同名,机器上只保留一个)。`.app` 换位置后再打开一次即可重新校准 plist。

### 维护者:打包 + 发布

**自动(推荐)**:打 `app-v*` tag,GitHub Actions(`.github/workflows/release-app.yml`)在 macOS runner 上构建 + ad-hoc 签名 + 把 `VoiceNote.zip` 传到 Release:

```bash
git tag app-v0.1.0 && git push --tags
```

**一个 `app-v*` tag = 一个 Release、同时带 mac + Windows 两个安装包**(两个 workflow 都由 `app-v*` 触发，mac runner 传 `VoiceNote.zip`、windows runner 传 `VoiceNote-setup.exe` 到同一 Release)。这样 `install-app.sh` 和 `install-app.ps1` 的 `releases/latest/download/...` 两边都能取到。

> 用 `app-v*`（与 CLI 的 `v*` npm 发布 tag 区分）。产物为 **universal**（x86_64 + arm64），Intel 与 Apple Silicon 通用。

**手动**:

```bash
cd app
bash scripts/package.sh          # → app/release/VoiceNote-<版本>.zip(约 110MB)
gh release create app-v0.1.0 app/release/VoiceNote-<版本>.zip#VoiceNote.zip -t "VoiceNote 0.1.0" -n "桌面客户端"
```

资产名必须是 **`VoiceNote.zip`**(`install-app.sh` 从 `releases/latest/download/VoiceNote.zip` 取)。本地测试可绕过 Release:`VOICENOTE_APP_URL=file:///path/to/VoiceNote.zip bash scripts/install-app.sh`。

### 签名 / 公证(免 `xattr`、双击即用)

JIT entitlements 已就绪(`src-tauri/entitlements.plist`:bun/vn 的 `allow-jit` 等;`tauri.conf.json` 已引用)。`scripts/sign-macos.sh` 做 inside-out 深度签名(hardened runtime + entitlements):

```bash
# 内部 ad-hoc(已验证 JIT 在 hardened runtime 下存活)
bash scripts/sign-macos.sh /Applications/VoiceNote.app

# 正式分发(需 Apple Developer Program $99/年 的 Developer ID 证书)
bash scripts/sign-macos.sh VoiceNote.app "Developer ID Application: NAME (TEAMID)"
xcrun notarytool submit ... && xcrun stapler staple VoiceNote.app
```

## License

MIT
