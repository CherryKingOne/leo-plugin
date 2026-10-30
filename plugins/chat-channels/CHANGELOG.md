# Changelog

## 0.1.0 (unreleased)

- 首个版本：聊天渠道注册层 `chatChannels`
- 内置渠道驱动：QQ 开放平台机器人（Webhook + Ed25519）、微信公众号（明文 / 安全模式 + 客服消息）、飞书 / Lark（事件订阅 + 加密签名）、Telegram（长轮询 / webhook）
- 共享 webhook 服务器、白名单与 @ 过滤、长文本分段、可选 Agent 自动回复
- 工具 `chat_channels`、`chat_send`
