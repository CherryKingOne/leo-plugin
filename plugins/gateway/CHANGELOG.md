# 更新日志

## 0.2.3 — 2026-10-31

- `gateway.json` 模板：飞书默认声明 `"feishu": { "channel": "feishu" }`，由新的飞书子插件 gateway-feishu 扫码创建应用；`builtin` 默认改为 `["telegram"]`（QQ、飞书都由子插件提供），旧版 `appId` / `appSecret` 写法保留在注释里，并说明要在 `builtin` 加上对应渠道。
- 缺飞书驱动时提示安装 `gateway-feishu`（或启用内置飞书 / 删除该账号）。

## 0.2.2 — 2026-10-31

- 驱动可直接授权用户：`ChannelInit.authorize(userId, { admin?, name? })`，不经过配对码；授权持久化在网关状态里，`admin: true` 的用户与 `auth.admins` 等效（可 `/pair` 批准他人），`/unpair` / `revokeUser()` 可撤销。gateway-qq 用它把扫码绑定机器人的人设为管理员。
- `/whoami` 区分“管理员”与“已授权”。

## 0.2.1 — 2026-10-31

- 配置模板 `gateway.json` 按 0.2.0 起的用法重写：默认声明 QQ 账号 `"qq": { "channel": "qq" }`（不填 appId / appSecret，配合 gateway-qq 扫码绑定），`builtin` 默认 `["telegram", "feishu"]`；0.1.x 的 appId / appSecret 写法保留在注释里，说明需要在 `builtin` 加上 `"qq"`。
- 账号缺驱动的提示更具体：QQ 账号会提示安装 `gateway-qq` 或在 `builtin` 启用内置 qq；并有 3 秒宽限期，插件驱动紧跟网关注册时不再误报。

## 0.2.0 — 2026-10-31（未发布）

网关改为**注册层**：授权、会话、路由、审批、控制面归网关，聊天平台是注册进来的驱动。

- 插件驱动顶替内置驱动：其他插件 `registerChannel()` 的驱动与内置驱动同 id 时，插件驱动生效、内置驱动停用，该渠道账号自动改由插件驱动重启；插件卸载后自动恢复内置驱动。注册顺序任意（渠道插件 `inject: ['gateway']` 即可），网关热重载后插件驱动自动重新注册。两个插件注册同一 id 时后者报错。
- QQ 二选一：内置 `qq` 驱动保留为旧版；新的 [leo-plugin-gateway-qq](../gateway-qq/) 子插件（支持手机 QQ 扫码绑定）安装后自动顶替它，也可以在 `builtin` 里去掉 `"qq"` 只用子插件。账号配置不用改。
- 等待绑定：新账号状态 `waiting_bind`，驱动通过 `init.report()` 汇报绑定链接（`bindUrl`），出现在账号状态、`GET /v1/channels`、`gateway/status` 事件与启动提示里；二维码刷新后再提示一次。
- 驱动可用 `init.notify()` 发提示、读 `init.rebind`；`restartAccount(id, { rebind: true })` / `POST /v1/channels/<账号>/restart {"rebind":true}` / WebSocket `channels.restart` 要求重新绑定，账号进入 `waiting_bind` 时立即返回。
- 重启、驱动切换、卸载会立即取消账号正在进行的启动（如等待扫码），不再排在它后面卡住。
- `gateway.sessionOfAgent(agentId)`：判断调用者是不是聊天会话里的 Agent，供渠道插件在 `tools/guard` 里保护运维工具。
- `GET /v1/channels` 的驱动多了 `overridesBuiltin`；`builtin` 表示当前生效的是不是内置驱动。
- `enabled: false` 时仍提供空的 `gateway` 服务（不连平台、不开端口），依赖它的渠道插件不会卡住 leo 启动。

## 0.1.1 — 2026-10-31

- 启动时显示控制面地址：`[gateway] 控制面 http://127.0.0.1:18790`，以及 HTTP / WebSocket / OpenAI 兼容接口地址和是否需要令牌；监听 `0.0.0.0` 时列出本机各网卡地址。
- 渠道账号连上、失败、恢复、缺驱动时各提示一行（webhook 账号附完整回调地址）；没有配置渠道时提示去编辑 `gateway.json`。
- 通过宿主的 `plugin/notice` 事件输出（需要支持该事件的 leo-agents；旧版宿主只记日志）。

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
