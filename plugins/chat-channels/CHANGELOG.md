# Changelog

## 0.2.0

- QQ 新增长连接（WebSocket 网关）模式并设为默认：Identify / 心跳 / Resume 补发 / 重连退避，`events` 选择订阅的事件
- **不兼容**：QQ 默认 `mode` 从 webhook 改为 `websocket`，继续使用回调的机器人请加 `"mode": "webhook"`
- 驱动接口新增 `init.fail()`：后台连接遇到不可恢复错误时让账号进入 failed

## 0.1.0 (unreleased)

- 首个版本：聊天渠道注册层 `chatChannels`
- 内置渠道驱动：QQ 开放平台机器人（Webhook + Ed25519）、飞书 / Lark（长连接 WebSocket 或事件订阅 webhook）、Telegram（长轮询 / webhook）
- 机器人配置目录 `.leo/chat-channels/<渠道>.json`（用户级 + 项目级，支持单个或多个机器人）
- 共享 webhook 服务器、白名单与 @ 过滤、长文本分段、可选 Agent 自动回复
- 工具 `chat_channels`、`chat_send`
