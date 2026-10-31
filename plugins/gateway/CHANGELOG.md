# 更新日志

## 0.1.0 — 2026-10-31

首个版本（实验性）。

- 消息网关：常驻接入 Telegram（长轮询 / webhook）、飞书 / Lark（长连接 / webhook）、QQ 官方机器人（WebSocket / webhook），平台驱动可由其他插件通过 `gateway.registerChannel()` 扩展。
- 会话路由：每个聊天一个 leo 会话，会话键与 leo 会话 id 持久化，重启后继续；群聊默认每人一个上下文（`groupPerUser`），话题默认共享。
- 会话车道：同一会话串行，忙时 `queue` / `steer` / `interrupt`；全局并发上限、排队上限、会话 Agent LRU。
- 授权：默认拒绝；管理员、白名单、DM 配对码（聊天 `/pair`、控制面、`gateway_pair` 工具批准）。
- 指令：`/new` `/stop` `/status` `/approve` `/deny` `/whoami` `/pair` `/unpair`。
- 聊天内审批：网关会话里的副作用工具改为在聊天里请求 `/approve`，超时拒绝；`leo serve` 下网关兜底提供审批服务。
- 投递：`gateway_send` 工具与 `gateway.send()`，支持 `<账号>:<会话>`、`<账号>:home`、`home`。
- 控制面（单端口）：HTTP API、SSE、WebSocket（connect 握手 + req/res/event 帧）、OpenAI 兼容 `/v1/chat/completions` 与 `/v1/models`、平台 webhook 回调；令牌鉴权，非本机监听必须设令牌。
- 配置 `gateway.json`（用户级 + 项目级 + 插件配置合并），安装时自动生成模板，修改后热加载重启网关。
- 优先使用宿主的 `agentFactory`（leo 默认模型与提示词），旧版宿主退回 `agentLoop` + `agent.model`。
