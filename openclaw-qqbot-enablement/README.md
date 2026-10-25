# OpenClaw（EasyClaw）qqbot 通道启用说明

本仓库同时记录了「让本机 OpenClaw/EasyClaw claw bot 连接 QQ」的启用工作。

## 背景

- 本机 EasyClaw 内置 OpenClaw 2026.4.14 网关（`C:\Program Files (x86)\easyclaw\`，配置 `C:\Users\1\.openclaw\openclaw.json`）。
- 网关内置 **`@openclaw/qqbot`（id: `qqbot`）通道插件**：官方 QQ Bot API（appId + clientSecret），
  支持单聊/群聊、富媒体（图片/语音/视频/文件）、cron 定时、主动消息、approval 交互。
- 该插件默认 **disabled**。启用后通道会注册到网关 `health` 的 `channels.qqbot`。

## 已做的改动（本仓库交付）

1. 在 `openclaw.json` 中：
   - `plugins.allow` 追加 `"qqbot"`；
   - `plugins.entries.qqbot.enabled = true`；
   - 已做备份 `openclaw.json.bak.qqbot-enable`。
2. 启动网关 `openclaw gateway run --port 10089`。
3. 验证 `gateway call health --json`：
   - `channels.qqbot` 已出现，`channelOrder` 含 `qqbot`；
   - 当前 `configured: false, tokenSource: "none"`（尚未填 appId/clientSecret，属预期）。

## 填上凭据后即可连接

```jsonc
// openclaw.json
"channels": {
  "qqbot": {
    "enabled": true,
    "appId": "<APPID>",
    "clientSecret": "<CLIENT_SECRET>",
    "allowFrom": ["*"]
  }
}
```

重启网关后 `health` 的 `channels.qqbot` 应变为 `configured: true / connected: true`。
也可通过通道 RPC 或 `channels status --probe` 查看。

> 注意：OpenClaw 的 config-guard 在网关运行中可能回滚配置；建议在网关停止时改配置再启动。

## 与本仓库 DSH 插件的关系

- **本仓库 DSH 插件（`dsh-plugin/`）**：让 **DSH Agent**（DeepSeek Harness 里的 agent）通过
  `qqbot_*` 工具直连桥接，做自动化/验证。
- **OpenClaw qqbot 通道**：让 **claw bot**（automation-rpa 等 OpenClaw agent）在 QQ 上对话。
- 二者互不冲突，可并存；凭据都来自 <https://q.qq.com> 的同一个（或多个）机器人。
