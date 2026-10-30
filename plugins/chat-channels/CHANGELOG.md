# Changelog

## 0.1.0

- 首个版本：聊天渠道注册层 `chatChannels`
- 内置渠道驱动：
  - QQ 开放平台机器人：长连接（WebSocket 网关，默认）或 Webhook + Ed25519 验签
  - 飞书 / Lark：长连接（WebSocket，默认）或事件订阅 webhook
  - Telegram：长轮询 / webhook
- 机器人配置目录 `.leo/chat-channels/<渠道>.json`（用户级 + 项目级，支持单个或多个机器人）
- 共享 webhook 服务器、白名单与 @ 过滤、长文本分段、可选 Agent 自动回复
- 工具 `chat_channels`、`chat_send`
- 驱动接口 `init.fail()`：后台连接遇到不可恢复错误时让账号进入 failed
