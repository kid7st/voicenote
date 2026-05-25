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

脚本会安装/检查 `ffmpeg`、Bun、Node/npm、pi、`vn`，写入配置，生成 `speakers.json`，并可安装 LaunchAgent 定时监控录音笔。

手动安装（GitHub Packages 通常需要 npm auth；无 token 时推荐直接从 GitHub ref 安装）：

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

环境变量：

```bash
# Default ASR provider: volcano | openai
export VOICENOTE_ASR_PROVIDER="volcano"

# Default LLM backend for clean/summary: openai | pi-codex
# pi-codex routes through pi (https://pi.earendil.works) which uses your
# ChatGPT Plus/Pro OAuth (~/.pi/agent/auth.json), bypassing OpenAI API quota.
export VOICENOTE_LLM_PROVIDER="pi-codex"
export VOICENOTE_PI_BIN="/opt/homebrew/bin/pi"
export VOICENOTE_PI_MODEL="gpt-5.5"

# OpenAI (used for summary when VOICENOTE_LLM_PROVIDER=openai; for ASR when provider=openai)
export OPENAI_API_KEY="sk-..."
export OPENAI_TRANSCRIBE_MODEL="gpt-4o-transcribe-diarize"
export OPENAI_CLEAN_TRANSCRIPT_MODEL="gpt-5.5"
export OPENAI_SUMMARY_MODEL="gpt-5.5"

# Volcano (豆包 ASR + TOS upload)
export VOLCANO_ASR_KEY="..."               # X-Api-Key from Volcano speech console
export VOLCANO_ASR_RESOURCE_ID="volc.bigasr.auc"   # or volc.seedasr.auc
export VOLCANO_TOS_REGION="cn-hongkong"
export VOLCANO_TOS_ENDPOINT="tos-s3-cn-hongkong.volces.com"
export VOLCANO_TOS_BUCKET="..."
export VOLCANO_TOS_ACCESS_KEY="..."
export VOLCANO_TOS_SECRET_KEY="..."
export VOLCANO_TOS_KEEP="0"                 # 1 to keep uploaded audio on TOS
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
vn upgrade                      # bun add -g @kid7st/voicenote@latest
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
3. 复制原始音频到 `~/Documents/00-Inbox/meetings/_audio/YYYY-MM/`
4. 转写：默认使用火山豆包【大模型录音文件识别标准版 API】，本地音频先传到 TOS，提交任务后轮询结果，完成后默认删除 TOS 对象。切到 OpenAI 下：`gpt-4o-transcribe-diarize` 转写 + `--transcribe auto` 长录音分块并行 + chunk reconciliation
5. 转写完成后立刻落盘原始 transcript（不做 lossy 清洗），避免后面步骤失败导致 ASR 费用白付
6. summary 模型（默认 pi codex 走 ChatGPT Plus）直接看原始 transcript，在纪要生成阶段内部完成必要清理、说话人还原、观点/争论/共识形成过程还原
7. 写出 notes / metadata；系统不做任何归档决定，文件永远留在 `00-Inbox/`

## 输出位置

- 会议纪要入口：`~/Documents/00-Inbox/meetings/YYYY-MM/`
- 原始音频：`~/Documents/00-Inbox/meetings/_audio/YYYY-MM/`
- 完整转写：`~/Documents/00-Inbox/meetings/_transcripts/YYYY-MM/`
- metadata：`~/Documents/00-Inbox/meetings/_metadata/YYYY-MM/`
- 状态：`~/Documents/00-Inbox/meetings/_state/processed.json`
- 索引：`~/Documents/00-Inbox/meetings/_index/meetings.jsonl`

## 自动化

```bash
vn install-launch-agent
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.kid7st.voicenote.plist
launchctl enable gui/$(id -u)/com.kid7st.voicenote
```

LaunchAgent 每 60 秒调用 `vn run`。

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

发布（手动）：

```bash
gh auth refresh -s write:packages,read:packages,delete:packages
bun run build
npm publish
```

发布（推荐，通过 tag 触发 GitHub Actions）：

```bash
npm version patch
git push --follow-tags
```

workflow 位于 `.github/workflows/release.yml`，使用 `GITHUB_TOKEN` 自动发布到 GitHub Packages。

## License

MIT
