# VoiceNote 桌面客户端

自包含的 macOS GUI（Tauri v2）。定位:工作状态 dashboard + 纪要快捷入口;真正的转写/纪要由后台 LaunchAgent 用**包内引擎**自主运行。

完整说明(架构 / 打包内容 / 安装 / 分发 / 签名)见仓库根 `README.md` 的「桌面客户端」一节。

```bash
bun install
bun run tauri dev          # 开发(直接跑 ../src/cli.ts,不打包、不装后台 agent)
bun run tauri build        # 仅构建 .app
bash scripts/package.sh    # 构建 + 签名 + 压缩 → release/VoiceNote-<版本>.zip(发这个)
```

- `scripts/build-vn-sidecar.sh` — 暂存 vn(编译版)/bun/ffprobe/pi 到 `binaries/`、`resources/`(已 gitignore)
- `scripts/sign-macos.sh` — inside-out 深度签名(hardened runtime + JIT entitlements)
- `src-tauri/entitlements.plist` — bun/vn 的 JIT entitlements
