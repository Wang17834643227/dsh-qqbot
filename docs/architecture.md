# 架构说明

## 组件

1. **`dsh-plugin/`（DSH Cordis Host 插件）**
   - `index.js`：`apply(ctx, config)` 形式，`inject: []`（不硬依赖任何服务，惰性发现）。
   - 通过 `ctx.effect` 注册两类资源：
     - **Agent 工具**：`qqbot_status` / `qqbot_send` / `qqbot_poll` / `qqbot_inbound`
       （`ctx.get("tools").register(definition)`，定义即注册形态：JSON-schema `parameters` + `output.render`，
       与 `@deepseek-ai/dsh-tools` 的 `defineTool` 输出结构一致）。
     - **HTTP 路由**：`ctx.get("webServer").register({kind:"exact", path, handler})`，
       把桥接协议挂到 DSH Web 服务器：`/plugins/dsh-qqbot-bridge/bridge/{health,status,poll,send,inbound}`。
   - 惰性发现（500ms × 20 次重试）保证插件在任何激活顺序下都能成功挂载；服务缺失时静默降级，不阻塞激活。

2. **`bridge/qqbot-bridge.mjs`（独立桥接服务，零依赖）**
   - `--mock`：内存模拟 QQ 机器人；`send` 会自动入队一条「对端回执」，便于离线验证往返。
   - `--real`：官方 QQ Bot API 适配层（token → gateway WS → 消息 API）。

3. **`test/verify.mjs`（验证器）**
   - 自动拉起 mock 桥接服务，执行 N 轮（默认 12）× 7 项检查：
     `health / status / send / poll-echo / inbound / poll-inbound / send-error(400)`。
   - 若 DSH Web 服务器可达，额外探测插件进程内路由的同协议端点。
   - 结果落盘 `test/verification_results.json` + `test/verification.log`；全过才退出码 0。

## 消息模型

| 字段 | 含义 |
|---|---|
| `dir` | `out` = Agent → QQ；`in` = QQ → Agent |
| `from` / `to` | 目标语法 `c2c:<openid>`（单聊）或 `group:<group_openid>`（群聊） |
| `seq` | 单调递增序号；`poll?since=<seq>` 做增量去重 |

## 目标语法

- 裸 openid（如 `12345`）→ 规范化为 `c2c:12345`。
- `c2c:<openid>` → 单聊；`group:<group_openid>` → 群聊。

## 错误语义

- 参数缺失/非法 → 工具层返回/抛出带 `detail` 的 Error；HTTP 层 → 400。
- 桥接不可达（bridge 模式） → HTTP 502 + `{ ok:false, error }`。
