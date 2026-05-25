# @kid7st/voicenote

Voice recordings → diarized transcripts → integrated semantic Markdown notes → archive suggestions.

CLI 命令：`vn`

当前主要适配 PHILIPS VTR6500 录音设备，但工作流通用：扫描某个挂载点下的录音 → 转写并按说话人分离 → GPT 在纪要生成阶段内部完成必要清理与过程还原 → 生成智能纪要与归档建议。

## 安装

推荐使用安装脚本（macOS）：

```bash
curl -fsSL https://raw.githubusercontent.com/kid7st/voicenote/main/scripts/install.sh | bash
```

非交互安装示例：

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

脚本会安装/检查 `ffmpeg`、Bun、Node/npm、pi、`vn`，写入配置，生成 `speakers.json`，并可安装 LaunchAgent 每 60 秒自动监控录音笔。

> GitHub Packages 的 npm registry 通常需要 auth token；公开分发目前默认使用 GitHub git ref 安装。

手动安装：

```bash
bun add -g git+https://github.com/kid7st/voicenote.git#main
mkdir -p ~/.local/bin
ln -sf ~/.bun/bin/vn ~/.local/bin/vn
```

## 依赖

- Bun >= 1.3 或 Node >= 20
- ffmpeg（用于音频时长检测）：

```bash
brew install ffmpeg
```

安装脚本会把常用环境变量写入当前 shell 配置。手动配置时至少需要：

```bash
# 输出 workspace；installer 默认使用 ~/Documents/meetings
export VOICENOTE_WORKSPACE="$HOME/Documents/meetings"

# ASR 默认 volcano；LLM 默认 pi-codex
export VOICENOTE_ASR_PROVIDER="volcano"
export VOICENOTE_LLM_PROVIDER="pi-codex"

# Volcano (豆包 ASR + TOS upload)
export VOLCANO_ASR_KEY="..."                       # X-Api-Key from Volcano speech console
export VOLCANO_ASR_RESOURCE_ID="volc.seedasr.auc"  # or volc.bigasr.auc
export VOLCANO_TOS_REGION="cn-guangzhou"
export VOLCANO_TOS_ENDPOINT="tos-s3-cn-guangzhou.volces.com"
export VOLCANO_TOS_BUCKET="..."
export VOLCANO_TOS_ACCESS_KEY="..."
export VOLCANO_TOS_SECRET_KEY="..."
export VOLCANO_TOS_KEEP="0"                        # 1 to keep uploaded audio on TOS
```

可选配置：

```bash
# Recording source defaults
export VOICENOTE_DEVICE_VOLUME="VTR6500"
export VOICENOTE_RECORD_DIR="/Volumes/VTR6500/RECORD"

# pi-codex routes through pi (https://pi.earendil.works) using your
# ChatGPT Plus/Pro OAuth (~/.pi/agent/auth.json), bypassing OpenAI API quota.
export VOICENOTE_PI_BIN="pi"
export VOICENOTE_PI_MODEL="gpt-5.5"

# OpenAI only needed when using --asr openai or --llm openai
export OPENAI_API_KEY="sk-..."
export OPENAI_TRANSCRIBE_MODEL="gpt-4o-transcribe-diarize"
export OPENAI_CLEAN_TRANSCRIPT_MODEL="gpt-5.5"
export OPENAI_SUMMARY_MODEL="gpt-5.5"
```

## 用法

```bash
vn doctor                       # 检查环境与配置
vn run                          # 默认：--mode notes --transcribe auto --asr volcano --llm pi-codex
vn run --mode transcript        # 只生成 transcript，跳过语义整理
vn run --asr openai             # 临时切回 OpenAI 转写
vn run --llm openai             # summary 走 OpenAI API
vn run --llm pi-codex           # summary 走 pi codex / ChatGPT Plus，不消耗 OpenAI API quota
vn run --latest                 # 只处理最新有效录音
vn run --latest --force         # 重跑最新条
vn run --transcribe single      # 强制单次转写
vn run --transcribe turbo       # 强制分块并行转写 + chunk reconciliation (仅 OpenAI)
vn run --pdf                    # 生成纪要后额外渲染 PDF
vn run --dry-run                # 仅列出计划
vn watch --interval 60          # 前台轮询
vn list                         # 列出本月会议纪要
vn list --month 2026-05         # 指定月份
vn last                         # 打印最新处理摘要
vn open                         # Finder 打开会议目录
vn open config                  # 打开 ~/.config/voicenote/
vn open logs                    # 打开日志目录
vn open <slug>                  # 按文件名片段打开纪要
vn forget <id|filename>         # 让某条录音重新被处理
vn errors                       # 打印最近 ERROR 日志
vn upgrade                      # reinstall latest main from GitHub git ref
vn install-launch-agent
vn status
vn uninstall-launch-agent
```

## 配置文件

首次运行会生成：

```text
~/.config/voicenote/speakers.json   # 本人姓名 + 别名、已知联系人
```

```json
{
  "self": { "name": "石洋", "aliases": ["yangshi", "Alex", "石总"] },
  "known": []
}
```

speakers 修改后下一次 `vn run` 即生效。

## 工作流程

1. 扫描 `/Volumes/VTR6500/RECORD/` 下的录音
2. 过滤：忽略 `._*`、小文件（<100KB）、短录音（<60s）、已处理录音
3. 复制原始音频到 `${VOICENOTE_WORKSPACE}/_audio/YYYY-MM/`
4. 转写：默认使用火山豆包【大模型录音文件识别标准版 API】，本地音频先传到 TOS，提交任务后轮询结果，完成后默认删除 TOS 对象。切到 OpenAI 下：`gpt-4o-transcribe-diarize` 转写 + `--transcribe auto` 长录音分块并行 + chunk reconciliation
5. 转写完成后立刻落盘原始 transcript（不做 lossy 清洗），避免后面步骤失败导致 ASR 费用白付
6. summary 模型（默认 pi codex 走 ChatGPT Plus）直接看原始 transcript，在纪要生成阶段内部完成必要清理、说话人还原、观点/争论/共识形成过程还原
7. 写出 notes / metadata；系统不做任何归档决定，文件留在配置的 workspace 中

## 输出位置

installer 默认设置：`VOICENOTE_WORKSPACE=~/Documents/meetings`。

- 会议纪要入口：`${VOICENOTE_WORKSPACE}/YYYY-MM/`
- 原始音频：`${VOICENOTE_WORKSPACE}/_audio/YYYY-MM/`
- 完整转写：`${VOICENOTE_WORKSPACE}/_transcripts/YYYY-MM/`
- metadata：`${VOICENOTE_WORKSPACE}/_metadata/YYYY-MM/`
- 状态：`${VOICENOTE_WORKSPACE}/_state/processed.json`
- 索引：`${VOICENOTE_WORKSPACE}/_index/meetings.jsonl`

## 自动化

安装脚本可自动安装。手动安装：

```bash
vn install-launch-agent
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.kid7st.voicenote.plist 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.kid7st.voicenote.plist
launchctl enable gui/$(id -u)/com.kid7st.voicenote
vn status
```

LaunchAgent 每 60 秒调用 `vn run`。没插录音笔时安全跳过；插上 VTR6500 后自动处理新录音。

日志：

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

分发：当前公开安装默认走 GitHub git ref：

```bash
curl -fsSL https://raw.githubusercontent.com/kid7st/voicenote/main/scripts/install.sh | bash
```

如需打 tag / 发布 GitHub Packages：

```bash
bun run typecheck
bun run build
npm version patch
git push --follow-tags
```

workflow 位于 `.github/workflows/release.yml`。注意 GitHub Packages npm registry 通常需要 npm auth token，不适合作为无 token 的公开安装入口。

## License

MIT
