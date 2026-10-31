# leo-plugin-gateway

> 实验性 0.1.1

## 用途

leo 的**消息网关**：一个常驻在 leo 进程里的总机，参考 [OpenClaw Gateway](https://docs.openclaw.ai/concepts/architecture) 与 [Hermes Messaging Gateway](https://hermes-agent.nousresearch.com/docs/developer-guide/gateway-internals)。

- **接入聊天平台**：Telegram、飞书 / Lark、QQ 官方机器人（长轮询 / 长连接，无需公网；也支持 webhook）。在 Telegram 里给机器人发消息，leo 的 Agent 回复你。
- **会话路由**：每个聊天对应一个独立的 leo 会话，历史持久化，重启后继续；群聊默认每人一个上下文，可改为全群共享。
- **会话车道**：同一会话串行执行；回复期间又来消息时排队（queue）、插话（steer）或打断（interrupt）。
- **授权**：默认谁都不能用。管理员、白名单、**配对码**（陌生人私聊拿到配对码，管理员批准后可用）。
- **聊天内审批**：网关会话里的写文件、执行命令等副作用工具，在聊天里请求 `/approve`，不再卡在终端上。
- **指令**：`/new` `/stop` `/status` `/approve` `/deny` `/whoami` `/pair` `/unpair`，由网关直接处理，不经过模型。
- **主动投递**：Agent 可以用 `gateway_send` 把消息发到任意会话或 home 会话（定时任务结果、通知）。
- **控制面**：同一个端口提供 HTTP API、SSE、WebSocket 与 **OpenAI 兼容接口**（`/v1/chat/completions`），也承载平台 webhook 回调。

```text
Telegram ─┐                                   ┌─ HTTP / SSE  /v1/chat、/v1/sessions …
飞书 ─────┼─→  leo-plugin-gateway（leo 进程内）─┼─ WebSocket   /ws
QQ ───────┘   授权 → 指令 → 会话路由 → 车道      └─ OpenAI 兼容 /v1/chat/completions
                         ↓
                 leo Agent（工具、审批、会话存储）
```

## 安装与运行

```bash
leo plugin add gateway          # 全局安装，自动生成 ~/.leo/gateway.json
# 编辑 ~/.leo/gateway.json：填入机器人凭证、管理员
leo serve                       # 后台常驻运行网关（Ctrl+C 停止）
```

- `leo serve` 只加载配置与插件并保持在线，不进入对话；需要 leo-agents main `921b284` 及以后。
- 启动后会打印控制面地址和每个渠道的连接状态，例如：

  ```text
  [gateway] 控制面 http://127.0.0.1:18790
  [gateway]   HTTP http://127.0.0.1:18790/v1 · WebSocket ws://127.0.0.1:18790/ws · OpenAI 兼容 http://127.0.0.1:18790/v1/chat/completions
  [gateway]   未设置令牌，只接受本机访问
  [gateway] 已连接 tg（telegram）
  ```
- 也可以直接用交互式 `leo`：对话的同时网关也在线。
- 网关里的 Agent 默认使用 leo 的默认模型与系统提示词（宿主的 `agentFactory` 服务）；旧版 leo 没有这个服务时，必须在 `gateway.json` 写 `agent.model`。
- 修改 `gateway.json` 后正在运行的 leo 会自动重启网关，不用手动重启。

其他安装方式见 [docs/install.md](../../docs/install.md)。

## 配置 `gateway.json`

| 位置 | 说明 |
| --- | --- |
| `~/.leo/gateway.json` | 用户级（`leo plugin add gateway` 生成模板） |
| `<项目>/.leo/gateway.json` | 项目级，按段覆盖用户级；`channels` 按账号覆盖 |
| `.leo/config.json` 中的插件配置 | 优先级最高，写法相同 |

支持 `//` 注释与尾随逗号。密钥写 `$ENV` 或 `!command`，也可以 `leo auth set gateway/<账号>/<字段>` 存进 `credentials.json`（优先级高于配置值）。

```jsonc
{
  "channels": {
    "telegram": { "channel": "telegram", "botToken": "$TELEGRAM_BOT_TOKEN", "home": "123456789" },
    "feishu":   { "channel": "feishu", "appId": "cli_xxx", "appSecret": "$FEISHU_APP_SECRET" },
    "qq":       { "channel": "qq", "appId": "102xxxxx", "appSecret": "$QQ_BOT_SECRET" }
  },
  "auth": { "admins": ["telegram:123456789"], "pairing": true },
  "sessions": { "busy": "queue", "groupPerUser": true },
  "agent": { "tools": "all" },
  "server": { "host": "127.0.0.1", "port": 18790, "token": "$LEO_GATEWAY_TOKEN" }
}
```

### channels：机器人账号

键是账号 id（kebab-case），`channel` 是平台（省略时等于账号 id）。下列通用字段由网关处理，其余字段是该平台的机器人配置：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `channel` | 账号 id | `telegram` / `feishu` / `qq`，或第三方驱动 id |
| `enabled` | `true` | |
| `allowFrom` | `[]` | 直接放行的该平台用户 id（不带平台前缀） |
| `allowChats` | `[]` | 只处理这些会话 id；空表示不限 |
| `requireMention` | `true` | 群聊里必须 @ 机器人（私聊总是处理） |
| `home` | — | 主动消息默认投递的会话 id（`gateway_send` 的 `home`） |
| `prompt` | — | 该账号会话的额外系统提示词 |

各平台字段：

| 平台 | 必填 | 常用可选 |
| --- | --- | --- |
| telegram | `botToken` | `mode`（`polling` 默认 / `webhook`）、`publicUrl` + `webhookSecret`（webhook）、`apiBase`、`parseMode` |
| feishu | `appId`、`appSecret` | `mode`（`websocket` 默认 / `webhook`）、`verificationToken`、`encryptKey`、`domain`（`feishu` / `lark`） |
| qq | `appId`、`appSecret` | `mode`（`websocket` 默认 / `webhook`）、`events`、`sandbox` |

webhook 模式的回调地址是 `<公网地址><server.hooksPath>/<账号>`，默认 `/hooks/<账号>`，由反向代理转发到网关端口。

### auth：谁能用

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `admins` | `[]` | 管理员 `<平台>:<用户 id>`，自动有权限，可在聊天里 `/pair` 批准新用户 |
| `allowFrom` | `[]` | 放行的用户 `<平台>:<用户 id>` |
| `allowAll` | `false` | 放行所有人（只建议在 `agent.tools` 为 `none` 的公开机器人上用） |
| `pairing` | `true` | 陌生人私聊时发配对码；管理员 `/pair <码>`、控制面 `POST /v1/pairing/approve` 或让 leo 调 `gateway_pair` 批准 |
| `pairingTtlMs` | 1 小时 | 配对码有效期 |

不知道自己的 id：私聊机器人发 `/whoami`。群里的陌生人不会收到任何回复。

### sessions：会话策略

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `busy` | `queue` | 回复期间收到新消息：`queue` 排队、`steer` 作为插话注入当前任务、`interrupt` 取消当前任务处理新消息 |
| `groupPerUser` | `true` | 群聊每人一个上下文；`false` 全群共享，消息前加 `[发送者]` |
| `threadPerUser` | `false` | 话题（Telegram forum topic）默认全话题共享 |
| `maxQueue` | 5 | 每个会话最多排队几条 |
| `maxConcurrent` | 4 | 全局同时运行的任务数 |
| `maxCached` | 128 | 内存中保留的会话 Agent（LRU；淘汰后从历史恢复，不丢上下文） |

会话键：`<平台>:<账号>:<direct|group|channel>:<会话 id>[:t<话题>][:u<用户>]`。会话键与 leo 会话 id 的映射、配对记录存在 `<项目 .leo 或 ~/.leo>/gateway/state.json`（权限 600）。

### agent：网关里的 Agent

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `model` | leo 默认模型 | `provider/model` |
| `tools` | `all` | `all`、`none` 或工具名列表；只有授权用户能对话，副作用工具在聊天里请求批准 |
| `systemPrompt` | — | 追加在 leo 默认提示词之后 |
| `maxSteps` / `turnTimeoutMs` | leo 默认 / 30 分钟 | |
| `toolProgress` | `false` | 把“⏳ bash”这类工具进度发到聊天里 |
| `errorReply` | `抱歉，处理消息时出错了：{error}` | 出错时的回复；空字符串表示不回 |

### approval、server

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `approval.timeoutMs` | 5 分钟 | 等待 `/approve` 的时间，超时视为拒绝 |
| `server.enabled` | `true` | 关闭后没有控制面，webhook 模式的账号也无法启动 |
| `server.host` / `server.port` | `127.0.0.1` / `18790` | 监听非本机地址时**必须**设置 `token`，否则拒绝启动 |
| `server.token` | — | 控制面令牌引用，如 `$LEO_GATEWAY_TOKEN` |
| `server.hooksPath` | `/hooks` | 平台 webhook 回调路径前缀 |
| `server.corsOrigins` | `[]` | 允许浏览器跨域访问的来源 |

其他：`enabled`（总开关）、`builtin`（要注册的内置平台）、`tools`（是否注册网关工具）、`stateDir`、`loadConfigFiles`。

## 聊天里的用法

| 指令 | 作用 |
| --- | --- |
| `/new`（`/reset`） | 开始新会话 |
| `/stop` | 停止当前任务并清空排队 |
| `/status` | 会话状态、轮次、模型、忙时策略 |
| `/approve` / `/deny`（或直接回“同意” / “拒绝”） | 批准或拒绝工具调用 |
| `/whoami` | 查看自己的 id（不需要授权） |
| `/pair [码]` | 管理员：列出 / 批准配对请求 |
| `/unpair <平台:用户 id>` | 管理员：撤销配对授权 |

不认识的 `/xxx` 当作普通消息交给 Agent。

## 控制面 API

默认 `http://127.0.0.1:18790`。设置了 `server.token` 时，除 `/health` 与平台 webhook 外都要带 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 存活检查 |
| GET | `/v1/status` | 账号状态、会话数、配对数 |
| GET | `/v1/channels` | 平台驱动与账号 |
| POST | `/v1/channels/{account}/restart` | 重启账号 |
| GET | `/v1/sessions` | 会话列表（含运行中、排队、待审批） |
| GET | `/v1/sessions/{key}/messages` | 会话历史 |
| POST | `/v1/sessions/{key}/reset` \| `abort` \| `approve` \| `deny` | 新会话 / 停止 / 审批 |
| POST | `/v1/chat` | `{message, session_key?, stream?}`；`stream: true` 返回 SSE（`start` / `delta` / `tool` / `approval` / `done` / `result`） |
| POST | `/v1/send` | `{target, text}` 主动发消息，target 同 `gateway_send` |
| GET | `/v1/pairing` | 待批准与已配对用户 |
| POST | `/v1/pairing/approve` \| `revoke` | `{code}` / `{user}` |
| GET | `/v1/models` | OpenAI 兼容模型列表 |
| POST | `/v1/chat/completions` | OpenAI 兼容对话（支持 `stream`）；会话用 `user` 字段或 `X-Session-Key` 头 |

```bash
curl -s localhost:18790/v1/chat -d '{"message":"今天有什么安排？","session_key":"web"}'
curl -N localhost:18790/v1/chat -d '{"message":"写一首诗","stream":true}'
```

任何 OpenAI 客户端把 Base URL 设成 `http://127.0.0.1:18790/v1` 即可接入同一套会话与工具。

### WebSocket `/ws`

JSON 文本帧，第一帧必须是 `connect`：

```json
→ {"type":"req","id":"1","method":"connect","params":{"auth":{"token":"..."}}}
← {"type":"res","id":"1","ok":true,"payload":{"protocol":1,"methods":[...],"events":["chat","gateway"]}}
→ {"type":"req","id":"2","method":"chat.send","params":{"message":"你好","sessionKey":"web"}}
← {"type":"res","id":"2","ok":true,"payload":{"runId":"run-..."}}
← {"type":"event","event":"chat","payload":{"runId":"run-...","type":"delta","text":"你"}}
← {"type":"event","event":"chat","payload":{"runId":"run-...","type":"result","text":"你好！",...}}
```

方法：`health` `status` `channels.list` `channels.restart` `sessions.list` `sessions.history` `sessions.reset` `sessions.abort` `approval.resolve` `chat.send` `chat.abort` `send` `pairing.list` `pairing.approve` `pairing.revoke` `subscribe` `unsubscribe`。
`subscribe` 后会收到 `gateway` 事件（平台消息、任务开始 / 结束、发送、账号状态、配对）。

## 工具

| 工具 | 权限 | 说明 |
| --- | --- | --- |
| `gateway_status` | 只读 | 平台账号、会话、待批准配对 |
| `gateway_send` | `gateway.send`（副作用，走审批） | 主动发消息：`<账号>:<会话 id>`、`<账号>:home`、`home` |
| `gateway_pair` | `gateway.pair`（副作用，走审批） | 批准配对码；聊天里的 Agent 不能调用 |

## 服务与事件

```ts
const gw = ctx.get('gateway')
gw.registerChannel(myDriver)                 // 接入新平台（ChannelDriver，见 src/types.ts）
await gw.send('telegram:home', '每日简报…')  // 主动投递
const r = await gw.chat({ sessionKey: 'cron', text: '总结今天的邮件' })
```

| 事件 | 模式 | 载荷 |
| --- | --- | --- |
| `gateway/message` | emit | 通过授权的入站消息与会话键 |
| `gateway/turn-start` / `gateway/turn-end` | emit | 任务开始 / 结果 |
| `gateway/sent` | emit | 发出的消息 |
| `gateway/status` | emit | 账号状态变化 |
| `gateway/pairing-requested` / `gateway/paired` | emit | 配对 |
| `gateway/session-reset` | emit | `/new` 或控制面重置 |

## 新增平台

实现一个 `ChannelDriver`（zod 配置 schema + `create(init)` 返回 `{ start, send, stop }`），放进 `src/channels/<id>/` 并登记到 `BUILTIN_DRIVERS` 与 `BUILTIN_CHANNELS`；或者在你自己的插件里 `ctx.get('gateway').registerChannel(driver)`。驱动只负责平台协议，授权、路由、排队、分段、重试、审批都由网关完成。

## 安全

- 默认拒绝所有人；默认只监听 127.0.0.1；对外监听必须设置令牌。
- 网关会话的副作用工具按 leo 的审批模式处理：`ask` 时在聊天里问，`auto`（或 `leo serve -y`）直接执行，`deny` 一律拒绝。
- 聊天内容视为不可信输入写进系统提示词说明；聊天里的 Agent 不能自己批准配对。
- 日志不记录消息正文与密钥；状态文件权限 600。
- **这不是沙箱**：给外部用户开放工具前，请在容器里运行 leo。

## 兼容性

- leo-agents `>=0.1.0`；`leo serve` 与 `agentFactory` 需要 leo-agents main `921b284` 及以后，旧版本可在交互式 `leo` 中运行并写 `agent.model`。
- Node.js `>=22`（WebSocket 客户端、`AbortSignal.any`）。
- 支持热加载：卸载时停止所有平台连接、取消进行中的任务、关闭端口；改 `gateway.json` 自动重启。
