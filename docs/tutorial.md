# 手把手讲解：让 DSH Agent 连接 QQ 机器人（并自动维护发布）

> 本文回答一个问题：**"这套东西是怎么弄起来的？"**
> 每一步都给出实际命令和预期输出，照着做即可复现。全程不需要安装任何 npm 包（桥接与插件都是零依赖）。

---

## 0. 整体架构（30 秒看懂）

```
        QQ 官方平台 (q.qq.com)                    本机
  ┌──────────────────────────┐        ┌──────────────────────────────┐
  │  机器人应用                │        │  DSH (DeepSeek Harness)      │
  │  AppID + ClientSecret    │◄─────► │  宿主插件 dsh-qqbot-bridge    │
  │  官方 Bot API + WebSocket │  ①②   │  注册 4 个 Agent 工具：        │
  └──────────────────────────┘        │  qqbot_status / _send /      │
        ① 取 token + 拉网关            │  _poll / _inbound            │
        ② 收发消息(v2 接口)           │  + HTTP 路由 /plugins/…      │
                                      └──────────────┬───────────────┘
                                                     │ ③ fetch
                                      ┌──────────────▼───────────────┐
                                      │  桥接服务 qqbot-bridge.mjs   │
                                      │  (零依赖 Node ESM, 端口 8790) │
                                      │  mock 模式 = 进程内模拟 QQ 端  │
                                      │  real  模式 = 走 ①② 官方 API  │
                                      └──────────────────────────────┘
```

- **① ② 只有 real 模式走官方链路**；**mock 模式**在桥接进程内模拟一个 QQ 端（发出去的话会被"自动回显"），专门用于离线验证，**不需要任何凭据**。
- **DSH 插件**把桥接包成 Agent 能直接调用的工具（tool）——这就是"让你（Agent）和 QQ 机器人联接"的那一层。
- 另外本机 EasyClaw 内置的 **OpenClaw 网关**有官方 `qqbot` 通道插件，是"让 claw bot 在 QQ 上对话"的并行链路（见 `openclaw-qqbot-enablement/README.md`）。

---

## 1. 第一步：先跑通 mock（不需要 QQ 凭据）

```powershell
# 1) 启动桥接（mock 模式，默认端口 8790）
node bridge\qqbot-bridge.mjs --mock
# 预期输出:
#   [qqbot-bridge] mock mode on http://127.0.0.1:8790
#   [qqbot-bridge] auto-echo enabled (simulated QQ peer replies)

# 2) 手工验证四个端点（另开一个终端）
curl http://127.0.0.1:8790/health     # → {"ok":true,"version":"1.0.0"}
curl http://127.0.0.1:8790/status     # → {"mode":"mock","connected":true,"seq":0,…}
curl -X POST http://127.0.0.1:8790/send -H "Content-Type: application/json" -d '{\"to\":\"c2c:1\",\"message\":\"hi\"}'
curl "http://127.0.0.1:8790/poll?since=0"   # → 能看到刚发的消息 + 模拟回显
```

**关键概念**：消息队列是 `seq` 递增的，`/poll?since=N` 增量拉取；`to` 的写法是 `c2c:<openid>`（单聊）或 `group:<group_openid>`（群聊）。

## 2. 第二步：安装 DSH 插件

插件本体在 `dsh-plugin/`（一个标准 DSH bundle：`package.json` 里 `"dsh.bundle.patch": "./cordis.patch.yml"`）。

在任意一个 DSH Agent 会话里说：

> 安装插件 `C:\...\dsh-qqbot\dsh-plugin`

Agent 实际执行的是：

```
plugin_manager(action="install_bundle", target="C:\\...\\dsh-qqbot\\dsh-plugin")
```

**成功的标志**（本次会话的真实结果）：

```
application: "applied"          ← 已生效（热更新）
+ @local/dsh-qqbot-bridge 1.0.0 ← pnpm 已安装进 DSH 配置文件
warnings: []
```

然后验证工具真的注册了（Agent 用 inspect 工具查询）：

```
Tool listTools  →  能看到 qqbot_status / qqbot_send / qqbot_poll / qqbot_inbound
```

再验证插件 HTTP 路由（DSH Web 服务器 63900）：

```
curl http://127.0.0.1:63900/plugins/dsh-qqbot-bridge/bridge/health
# → {"ok":true,"version":"1.0.0"}
```

**插件怎么工作的**（给想读源码的人）：`dsh-plugin/index.js` 里 `apply(ctx, config)` 同步返回两个延迟任务——一个把 4 个工具注册进 `ctx.get("tools")`，一个把 5 条路由注册进 `ctx.get("webServer")`。工具的执行体都是 fetch 桥接 HTTP 端点（`backend: "bridge"`）或进程内模拟（`backend: "mock"`，即 `cordis.patch.yml` 里的默认配置）。

## 3. 第三步：让 Agent 真的"说"一句话给 QQ 端

在 DSH 会话里让 Agent 调工具（本次会话的真实演示）：

```
qqbot_inbound(from="c2c:10001", message="你好 Agent ✅")  → {ok:true, seq:3}
qqbot_poll(since=0)                                         → 看到 seq:3 这条入站消息
qqbot_send(to="c2c:10001", message="收到！")               → {ok:true, messageId:"mock-4", echoQueued:true}
```

到这一步，**"Agent ↔ QQ 机器人联接"在 mock 链路下已经完全跑通**。

## 4. 第四步：接真实 QQ（需要 q.qq.com 凭据）

1. <https://q.qq.com> 登录 → 创建应用/机器人 → 拿到 **AppID** 和 **ClientSecret**；
2. 启动 real 桥接（二选一）：

```powershell
# 方式 A：命令行
node bridge\qqbot-bridge.mjs --real --appId <APPID> --clientSecret <SECRET>
# 方式 B：环境变量
$env:QQBOT_APP_ID="<APPID>"; $env:QQBOT_CLIENT_SECRET="<SECRET>"
node bridge\qqbot-bridge.mjs --real
```

预期日志（真实链路的关键节点）：

```
[qqbot-bridge] fetching app access token…
[qqbot-bridge] gateway: wss://…/…
[qqbot-bridge] WS connected, IDENTIFY sent
[qqbot-bridge] HEARTBEAT (30s)
```

real 模式内部做的事（`bridge/qqbot-bridge.mjs` 源码里都有）：
- `POST https://bots.qq.com/app/getAppAccessToken` 取 token（自动续期）；
- `GET https://api.sgroup.qq.com/gateway` 拿网关地址，开 WebSocket；
- 发 `IDENTIFY`(op=2，intents 默认 `MESSAGE_CREATE`=33554432)；收到 `op=11` 后每 30s 心跳（op=1）；
- 收 `MESSAGE_CREATE` 事件 → 进消息队列；`/send` → 官方 v2 接口（单聊 `POST /v2/users/{openid}/messages`，群 `POST /v2/groups/{group_openid}/messages`）。

> 想走"claw bot 在 QQ 里聊天"（而不是 DSH Agent 工具），改用 OpenClaw 通道：把 appId/clientSecret 写进 `~/.openclaw/openclaw.json` 的 `channels.qqbot`，重启网关。详见 `openclaw-qqbot-enablement/README.md`。

## 5. 第五步：反复校验（怎么证明"联接"是好的）

仓库自带的验证框架 `test/verify.mjs`，一条命令：

```powershell
node test\verify.mjs --rounds 12
# 可选：同时探测已安装插件的 HTTP 路由
node test\verify.mjs --rounds 12 --plugin-base http://127.0.0.1:63900
```

它做的事：起一个独立的 mock 桥接（随机端口）→ 每轮跑 7 项检查
（health / status / send / poll-回显 / inbound / poll-入站 / 错误 400）→ 全部 PASS 才算过。
输出 `test/verification_results.json` 和 `verification.log`，退出码 0 = 通过。

**本次实测**：12 轮 × 7 项全过（跑了 2 遍，共 24 轮）；插件侧 4 项探测全过。

## 6. 第六步：发布到 GitHub（tag + Release，可重复执行）

发布用的是**本机 Windows 凭据管理器里已存的 GitHub 凭据**（`git credential fill` 协议取出，不回显）：

```powershell
$git = "C:\...\PortableGit\cmd\git.exe"

# 1) 打注解 tag（tag 也需要提交者身份）
& $git -c user.name=Wang17834643227 -c user.email=Wang17834643227@users.noreply.github.com tag -a v1.0.0 -m "v1.0.0: …"
& $git push origin v1.0.0

# 2) 取凭据（只取，不打印密码）
$cred = "protocol=https","host=github.com","" | & $git credential fill
$pw   = ($cred | ? { $_ -match "^password=" }) -replace "^password=",""

# 3) 创建 Release
$body = @{ tag_name="v1.0.0"; name="v1.0.0"; prerelease=$false; body="…版本说明…" } | ConvertTo-Json
Invoke-WebRequest "https://api.github.com/repos/Wang17834643227/dsh-qqbot/releases" `
  -Method POST -Body $body -ContentType "application/json" `
  -Headers @{ Authorization="token $pw"; Accept="application/vnd.github+json" }
# → {"tag_name":"v1.0.0","html_url":"https://github.com/Wang17834643227/dsh-qqbot/releases/tag/v1.0.0",…}
```

**版本规则**：功能新增 → minor（1.1.0），补丁/优化 → patch（1.0.1）。Release 的正文写清楚"这次改了什么"。

## 7. 第七步：每日自动化（检查 → 发现问题才修复 → 才发版）

DSH 的 `schedule_create` 建了一个**每天 07:00（Asia/Shanghai）** 的定时任务，到点自动执行以下流程（任务 id `schedule-f69b61f4…`）：

1. **检查（找问题）**：跑 12 轮验证；`git status`；查 GitHub 仓库/最新 Release 有无异常（乱码、缺文件、断链）；审视代码与文档的缺陷、错误、不一致。
2. **修复（只在发现问题时）**：逐项修复真实问题，修复后重跑 12 轮验证保持 12/12 通过。**没有发现问题就不制造改动**。
3. **发版（条件发版，严格执行）**：**只有"发现并修复了问题"才** bump 补丁版本 → commit → tag → push → API 建 Release → 浏览器验证 release 页；**没发现问题 → 不发版**，只报告"检查通过，无问题"，避免版本号空转。
4. **汇报（带讲解）**：按"检查发现了什么 / 为什么是问题 / 怎么修的（改了哪些文件、关键命令与输出）/ 是否发版（tag + Release 链接，或不发版原因）"结构说明；没问题的日子也说清"查了什么、为何判定无问题"。

管理命令（对 Agent 说即可）：
- 查看：`schedule_list`
- 改时间/改内容：`schedule_update`
- 取消：`schedule_delete`

---

## 常见问题

| 现象 | 原因 / 解决 |
|---|---|
| `qqbot_status` 报 "bridge not running" | 桥接没起：`node bridge\qqbot-bridge.mjs --mock`（或指向已启用的 `bridgeUrl`） |
| 插件装了但工具不出现 | 看 `plugin_manager` 结果里 `application` 是否为 "applied"；重启 DSH 会话再查 `Tool listTools` |
| real 模式起不来 | 凭据错误或机器人未审核；沙箱阶段先加白名单用户 |
| 网关里 qqbot 通道 `configured:false` | 还没在 `channels.qqbot` 填 appId/clientSecret |
| 发版时 "Committer identity unknown" | 打注解 tag/commit 需要身份：加 `-c user.name=… -c user.email=…` |
| GitHub API 401/403 | 凭据过期或 scope 不足（需 repo 类权限），重新在浏览器登录 github.com 刷新 Windows 凭据管理器 |

**文件地图**：`bridge/qqbot-bridge.mjs`（桥接）· `dsh-plugin/`（插件，含 `index.js` 工具/路由实现、`cordis.patch.yml` 配置）· `test/verify.mjs`（验证）· `docs/architecture.md`（架构）· `docs/real-qq-setup.md`（接真实 QQ）· `openclaw-qqbot-enablement/`（OpenClaw 通道链路）
