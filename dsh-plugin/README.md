# dsh-qqbot-bridge（DSH Host 插件）

DSH（Cordis）插件包：让 Agent 通过桥接连接 QQ 机器人。

- 注册工具：`qqbot_status` / `qqbot_send` / `qqbot_poll` / `qqbot_inbound`
- 在 DSH Web 服务器暴露同协议 HTTP 路由：`/plugins/dsh-qqbot-bridge/bridge/*`
- 配置（`cordis.patch.yml` 行）：`backend: mock|bridge`、`bridgeUrl`、`timeoutMs`

安装：在 DSH 会话中执行 `plugin_manager(action="install_bundle", target="<本目录>")`。
独立桥接服务与验证脚本见仓库根目录（`../bridge`、`../test`）。
