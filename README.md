# QQ Bot 桥接插件（DSH × QQ Bot Bridge）

让 **DeepSeek Harness（DSH）Agent** 与 **QQ 机器人**直连的插件 + 桥接服务 + 验证工具。

## 组成

| 目录 | 说明 |
|---|---|
| `dsh-plugin/` | DSH（Cordis）Host 插件包：注册 `qqbot_status` / `qqbot_send` / `qqbot_poll` / `qqbot_inbound` 四个 Agent 工具，并在 DSH Web 服务器上暴露同协议的 HTTP 桥接路由 |
| `bridge/` | 零依赖 Node HTTP 桥接服务（mock 模拟 / real 官方 API 两种模式） |
| `test/` | 12 轮（≥10 次）自动验证脚本与结果记录 |
| `docs/` | 架构说明、真实 QQ 机器人接入指引 |

## 工作原理

```
┌────────────┐   qqbot_* tools   ┌──────────────────────────┐   HTTP    ┌─────────────────────┐
│ DSH Agent  │ ───────────────► │ dsh-qqbot-bridge 插件     │ ───────► │ 桥接服务 / QQ 机器人 │
│ (DSH Host) │ ◄─────────────── │ （Host 进程内）           │ ◄─────── │ mock | 官方 Bot API  │
└────────────┘    结果/消息      └──────────────────────────┘          └─────────────────────┘
```

- **mock 模式（默认）**：插件进程内模拟 QQ 机器人，离线可完整验证「发送 → 回执 → 轮询 → 主动消息」全链路，无需任何凭据。
- **bridge 模式**：插件把同样的调用转发到独立 `bridge/qqbot-bridge.mjs` 服务（`bridgeUrl` 可配）。
- **real 模式**（桥接服务侧）：用 `appId + clientSecret` 连接腾讯官方 QQ Bot 平台
  （`bots.qq.com/app/getAppAccessToken` 取 token → `api.sgroup.qq.com/gateway` 建 WS 长连接收事件 →
  `/v2/users/{openid}/messages` 或 `/v2/groups/{group_openid}/messages` 发消息）。

## 手把手讲解（怎么弄）

想从零复现整套链路（跑通 mock → 装插件 → Agent 说话 → 接真实 QQ → 校验 → 发版 → 每日自动化），
见 **[docs/tutorial.md](docs/tutorial.md)**：每步都给出现实命令与预期输出，并附常见问题表。

## 快速开始

### 1. 跑桥接服务（mock）

```powershell
node bridge\qqbot-bridge.mjs --mock --port 8790
```

### 2. 安装 DSH 插件（在 DSH 会话中）

让 Agent 执行：

```
plugin_manager(action="install_bundle", target="<repo>\dsh-plugin")
```

### 3. 验证（12 轮 ≥ 10 次校验）

```powershell
node test\verify.mjs --rounds 12
```

全部通过时退出码为 0，结果写入 `test/verification_results.json` 与 `test/verification.log`。

## 工具一览（Agent 侧）

| 工具 | 作用 |
|---|---|
| `qqbot_status` | 查询桥接状态：模式、连接、消息序号、运行时长 |
| `qqbot_send` | 发送消息：`to` = `c2c:<openid>` 或 `group:<group_openid>` |
| `qqbot_poll` | 轮询新消息（`since` 序号去重） |
| `qqbot_inbound` | 模拟一条入站 QQ 消息（仅 mock，测试钩子） |

## 配置（cordis.patch.yml）

```yaml
- insert:
    - id: qqbot-bridge
      name: '@local/dsh-qqbot-bridge'
      config:
        backend: mock        # mock | bridge
        bridgeUrl: http://127.0.0.1:8790
        timeoutMs: 15000
```

## 真实 QQ 机器人接入

见 [docs/real-qq-setup.md](docs/real-qq-setup.md)：在 <https://q.qq.com> 注册机器人获取
`appId` / `clientSecret`，然后：

```powershell
node bridge\qqbot-bridge.mjs --real --appId <APPID> --clientSecret <SECRET>
```

并把插件配置切到 `backend: bridge`。

## 许可证

MIT
