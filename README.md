# @kid7st/voicenote

Voice recordings → diarized transcripts → smart Markdown notes → auto-archive.

CLI 命令：`vn`

当前主要适配 PHILIPS VTR6500 录音设备，但工作流通用：扫描某个挂载点下的录音 → 转写并按说话人分离 → GPT 清洗 → GPT 生成智能纪要 → 按内容自动归档。

## 安装

GitHub Packages 公开包，安装前一次性配置：

```bash
cat >> ~/.npmrc <<'EOF'
@kid7st:registry=https://npm.pkg.github.com
EOF
```

然后：

```bash
bun add -g @kid7st/voicenote
# 或
npm i -g @kid7st/voicenote
```

如需 bun 全局 bin 进入 PATH：

```bash
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
export OPENAI_API_KEY="sk-..."
export OPENAI_TRANSCRIBE_MODEL="gpt-4o-transcribe-diarize"
export OPENAI_CLEAN_TRANSCRIPT_MODEL="gpt-5.5"
export OPENAI_SUMMARY_MODEL="gpt-5.5"
```

## 用法

```bash
vn doctor
vn run --once
vn run --latest-only
vn run --latest-only --force
vn run --once --dry-run
vn install-launch-agent
vn status
vn uninstall-launch-agent
```

## 工作流程

1. 扫描 `/Volumes/VTR6500/RECORD/` 下的录音
2. 过滤：忽略 `._*`、小文件（<100KB）、短录音（<60s）、已处理录音
3. 复制原始音频到 `~/Documents/00-Inbox/meetings/_audio/YYYY-MM/`
4. `gpt-4o-transcribe-diarize` 转写，保留 Speaker A/B/C 和时间戳
5. GPT-5.5 清洗 transcript：修正错字、保留说话人、标记不确定词
6. GPT-5.5 直接生成智能纪要 Markdown（结构由模型决定，参考飞书妙记）
7. 根据 metadata 自动归档：高置信度直接移动到目标目录，中置信度写入 pending review，低置信度留 Inbox

## 输出位置

- 会议纪要入口：`~/Documents/00-Inbox/meetings/YYYY-MM/`
- 原始音频：`~/Documents/00-Inbox/meetings/_audio/YYYY-MM/`
- 完整转写：`~/Documents/00-Inbox/meetings/_transcripts/YYYY-MM/`
- metadata：`~/Documents/00-Inbox/meetings/_metadata/YYYY-MM/`
- 状态：`~/Documents/00-Inbox/meetings/_state/processed.json`
- 索引：`~/Documents/00-Inbox/meetings/_index/meetings.jsonl`

## 自动归档阈值

- `archive_confidence >= 0.85` → 自动移动到目标公司/项目目录
- `0.60 <= archive_confidence < 0.85` → 保留 Inbox，写入 `pending-review.md`
- `< 0.60` → 保留 Inbox

可通过环境变量调整：

```bash
export PHILIPS_AUTO_ARCHIVE_THRESHOLD="0.85"
export PHILIPS_PENDING_REVIEW_THRESHOLD="0.60"
```

## 自动化

```bash
vn install-launch-agent
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.kid7st.voicenote.plist
launchctl enable gui/$(id -u)/com.kid7st.voicenote
```

LaunchAgent 每 60 秒调用 `vn run --once`。

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

发布：

```bash
gh auth refresh -s write:packages,read:packages,delete:packages
bun run build
npm publish
```

## License

MIT
