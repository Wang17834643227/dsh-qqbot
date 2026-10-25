# 接入真实 QQ 机器人

桥接服务的 `--real` 模式对接**腾讯官方 QQ Bot 平台**（<https://q.qq.com>）。

## 1. 注册机器人

1. 打开 <https://q.qq.com>，用 QQ 账号登录「QQ 开放平台（机器人）」。
2. 创建应用 → 机器人，获得 **AppID** 与 **ClientSecret**（机器人凭证）。
3. 在「开发配置」中为机器人开启所需权限/意图（单聊消息、群消息等）。
4. 测试阶段可在「沙箱」中添加自己的 QQ 号作为白名单用户。

## 2. 启动 real 桥接

```powershell
# 方式一：命令行参数
node bridge\qqbot-bridge.mjs --real --appId <APPID> --clientSecret <CLIENT_SECRET>

# 方式二：环境变量
$env:QQBOT_APP_ID="<APPID>"; $env:QQBOT_CLIENT_SECRET="<SECRET>"
node bridge\qqbot-bridge.mjs --real
```

启动后桥接会：

1. `POST https://bots.qq.com/app/getAppAccessToken` 获取 access token（自动续期）；
2. `GET https://api.sgroup.qq.com/gateway` 获取网关地址并建立 WebSocket；
3. 发送 `IDENTIFY`（op=2，intents 默认 `MESSAGE_CREATE` = 33554432，可用 `--intents` 调整）；
4. 收到心跳 `op=11` 后进入 `connected` 状态，之后每 30s 心跳（op=1）；
5. 分发事件（`MESSAGE_CREATE`）进入本地消息队列，`/poll` 增量读取；
6. `/send` 转发到官方 API：
   - 单聊：`POST /v2/users/{openid}/messages`
   - 群聊：`POST /v2/groups/{group_openid}/messages`

## 3. 插件切到 bridge 模式

修改 `dsh-plugin/cordis.patch.yml`（或由 Agent 在会话中用 `plugin_manager` 改配置）：

```yaml
config:
  backend: bridge
  bridgeUrl: http://127.0.0.1:8790   # 指向 real 桥接
```

重新安装/重载插件后，`qqbot_*` 工具即走真实 QQ 链路。

## 4. 与 OpenClaw（EasyClaw）网关的替代链路

本机上 EasyClaw 内置 OpenClaw 2026.4.14 网关，其 `qqbot` 通道插件（`@openclaw/qqbot`）
已在本仓库同目录的 `openclaw-qqbot-enablement/` 说明里启用（`~/.openclaw/openclaw.json`：
`plugins.allow += qqbot`，`plugins.entries.qqbot.enabled = true`）。该通道直接使用
官方 API（appId + clientSecret 写入 `channels.qqbot`），无需本桥接。两条链路可并存：

- **本仓库插件**：DSH Agent 直连（工具 + HTTP 桥接），便于自动化与验证；
- **OpenClaw 通道**：claw bot（automation-rpa 等 Agent）在 QQ 上对话。

## 注意

- ClientSecret 属敏感凭据：不要提交进 git（使用 `.gitignore` 排除的 `.env` 或环境变量）。
- 官方 API 有频控与审核要求；沙箱阶段仅白名单用户可触达。
- 网关断线时桥接每 5s 自动重连；长时间断连需重新 IDENTIFY。
