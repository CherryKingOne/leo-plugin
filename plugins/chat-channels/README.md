# leo-plugin-chat-channels

> 实验性 0.1.0

## 用途

聊天渠道注册层（Chat Channel Registry Layer）：让 leo Agent 通过 QQ、飞书、Telegram 等聊天软件的机器人收发消息。

**聊天渠道插件 = 渠道注册层 + 渠道子插件体系。** 可以把它想成一个大箱子里装着几个小盒子：

```text
leo-plugin-chat-channels            ← 大箱子：唯一可安装、可配置的 leo 插件
├── 注册层 registry                  注册、发现、配置校验、启动/停止、共享 webhook、收发分发
└── src/channels/                    小盒子：渠道驱动（不是插件，不能单独使用）
    ├── qq/        QQ 开放平台官方机器人
    ├── feishu/    飞书 / Lark 自建应用机器人
    └── telegram/  Telegram Bot
```

- 这几个渠道是**内置的渠道驱动**，没有自己的插件入口、npm 包和 `leo-plugin.json`，不能写进 `.leo/config.json` 的 `plugins`，只能装在本插件里、由注册层注册后使用。
- 每个渠道只关心**自家机器人的配置方式与收发协议**；过滤、排队、分段、重试、生命周期、与 Agent 对接都由注册层统一完成。
- 上层业务只面向服务 `chatChannels` 与 `chat-channels/*` 事件，不与具体渠道耦合。新增渠道不需要改上层任何代码。

## 安装

```bash
leo plugin add chat-channels
# 或
npm install leo-plugin-chat-channels
```

机器人写在 `.leo/chat-channels/` 目录里，**一个渠道一个文件，文件名就是渠道**：

```text
.leo/
├── config.json            ← 只放全局项（Agent、webhook）
└── chat-channels/
    ├── qq.json
    ├── feishu.json
    └── telegram.json
```

`.leo/chat-channels/feishu.json`（一个机器人，账号 id 就是 `feishu`）：

```jsonc
{
  // 长连接，不需要公网地址
  "appId": "cli_xxx",
  "appSecret": "$FEISHU_APP_SECRET"
}
```

`.leo/config.json`：

```jsonc
{
  "plugins": [
    ["leo-plugin-chat-channels", { "agent": { "enabled": true, "model": "deepseek/deepseek-chat" } }]
  ]
}
```

其他安装方式见 [docs/install.md](../../docs/install.md)。

## 配置

### 机器人配置文件 `.leo/chat-channels/<渠道>.json`

| 位置 | 说明 |
| --- | --- |
| `~/.leo/chat-channels/` | 用户级 |
| `<项目>/.leo/chat-channels/` | 项目级，同名机器人覆盖用户级 |
| 插件配置 `botsDir` | 额外目录，优先级最高 |

- 文件名必须是渠道 id：`qq.json`、`feishu.json`、`telegram.json`；`_` 开头的文件和非 `.json` 文件被忽略。支持 `//` 注释和尾随逗号。
- **单个机器人**：直接写这个渠道的机器人配置，账号 id = 渠道 id。
- **多个机器人**：写在 `bots` 下，账号 id = `<渠道>-<名称>`：

```jsonc
// .leo/chat-channels/qq.json
{
  "bots": {
    "main": { "appId": "102000001", "appSecret": "$QQ_MAIN_SECRET" },
    "test": { "appId": "102000002", "appSecret": "$QQ_TEST_SECRET", "sandbox": true, "allowFrom": ["开发者 openid"] }
  }
}
```

- 机器人对象里 `enabled`、`allowFrom`、`allowChats`、`requireMention`、`autoReply` 是注册层的通用字段（见下表「账号」），**其余字段都是这个渠道自己的机器人配置**，由该渠道的 schema 校验。
- 某个文件写错只会让对应机器人进入 `failed`，不影响其他机器人和插件加载。

### 顶层（插件配置）

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `builtin` | string[] | `["qq","feishu","telegram"]` | 装进注册层的内置渠道。只注册驱动，不会启动机器人 |
| `loadBotFiles` | boolean | `true` | 读取 `~/.leo/chat-channels/` 与项目 `.leo/chat-channels/` |
| `botsDir` | string | — | 额外的机器人配置目录（相对路径基于项目根） |
| `accounts` | Record<id, Account> | `{}` | 也可以直接在插件配置里写机器人（需带 `channel` 和 `options`），与目录中同名时以这里为准 |
| `webhook.host` | string | `"127.0.0.1"` | webhook 监听地址。默认只听本机，用反向代理或内网穿透暴露 HTTPS |
| `webhook.port` | number | `8790` | webhook 端口，所有 webhook 型账号共用 |
| `webhook.basePath` | string | `"/leo/chat"` | 回调路径前缀；账号的回调路径是 `<basePath>/<账号 id>` |
| `webhook.maxBodyBytes` | number | `1048576` | 请求体上限 |
| `agent.enabled` | boolean | `false` | 收到消息自动交给 Agent 回复 |
| `agent.model` | string | — | `provider/model`，开启 agent 时必填 |
| `agent.systemPrompt` | string | — | 聊天 Agent 的系统提示（会附加一段聊天场景说明） |
| `agent.tools` | string[] | `[]` | 聊天 Agent 可用的工具。默认**一个都不给** |
| `agent.maxConcurrent` | number | `4` | 全局同时运行的 turn 上限 |
| `agent.maxQueuePerChat` | number | `5` | 每个会话排队上限，超出丢弃 |
| `agent.maxSessions` | number | `200` | 保留的会话 Agent 上限（LRU） |
| `agent.turnTimeoutMs` | number | `120000` | 单个 turn 超时 |
| `agent.maxSteps` | number | `10` | 单个 turn 最大步数 |
| `agent.errorReply` | string | `"抱歉，处理消息时出错了…"` | 出错时回给用户的话；空字符串不回 |
| `requestTimeoutMs` | number | `15000` | 出站 HTTP 超时 |
| `tools` | boolean | `true` | 注册 `chat_channels` / `chat_send` 工具 |

### 账号（Account，插件配置 `accounts` 中的写法）

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `channel` | string | — | `qq` / `feishu` / `telegram` |
| `enabled` | boolean | `true` | |
| `options` | object | `{}` | **各渠道自己的机器人配置**，见下文；由对应渠道的 schema 校验（配置文件里直接平铺在机器人对象上） |
| `allowFrom` | string[] | `[]` | 发送者白名单（渠道侧用户 id），空为不限 |
| `allowChats` | string[] | `[]` | 会话白名单（渠道侧 chat id），空为不限 |
| `requireMention` | boolean | `true` | 群聊里必须 @机器人 才处理 |
| `autoReply` | boolean | `true` | 是否交给 Agent 自动回复（还需 `agent.enabled`） |

密钥字段一律写引用，不要写明文：`"$ENV_NAME"`、`"${ENV_NAME}"`、`"!op read op://vault/item"`。也可以写进 `.leo/credentials.json`，键为 `chat-channels/<账号 id>/<字段名>`（优先级更高）。

## 各渠道的机器人配置

每个渠道的机器人在各自平台上配置方式不同，配置字段也各不相同。下面的示例都是 `.leo/chat-channels/<渠道>.json` 的内容。

### Telegram（`telegram`）

1. 在 Telegram 找 @BotFather，`/newbot` 创建机器人，拿到 bot token。
2. 想在群里收到所有消息，在 BotFather 里 `/setprivacy` → Disable；否则只会收到 @机器人 和命令。
3. 默认用长轮询，不需要公网地址。

| options | 必填 | 说明 |
| --- | --- | --- |
| `botToken` | 是 | bot token 引用 |
| `mode` | | `polling`（默认）或 `webhook` |
| `publicUrl` | webhook 时 | 公网 HTTPS 基地址，插件启动时自动 `setWebhook` |
| `webhookSecret` | webhook 时 | 校验 `X-Telegram-Bot-Api-Secret-Token` |
| `apiBase` | | 自建 Bot API 服务器地址 |
| `pollTimeoutSec` / `parseMode` | | 长轮询等待秒数 / 回复格式（默认纯文本） |

```jsonc
// .leo/chat-channels/telegram.json
{ "botToken": "$TELEGRAM_BOT_TOKEN" }
```

### 飞书 / Lark（`feishu`）

收消息两种方式，默认长连接：

| 模式 | 公网地址 | 说明 |
| --- | --- | --- |
| `websocket`（默认） | 不需要 | 机器人主动连到飞书，自动心跳、断线重连，事件逐条 ACK；本地、内网直接可用 |
| `webhook` | 需要 HTTPS | 飞书推送到 `<basePath>/<账号 id>`，校验 Verification Token，设置 Encrypt Key 时解密并校验签名 |

1. 飞书开放平台 → 创建企业自建应用 → 添加「机器人」能力，记下 App ID、App Secret。
2. 开通权限：`im:message`、`im:message.p2p_msg`、`im:message.group_at_msg`（需要群内所有消息再加 `im:message.group_msg`）。
3. 事件与回调 → 订阅方式：
   - 长连接：选「使用长连接接收事件」。先把 leo 跑起来（账号状态为 running）再保存，平台会检测连接。
   - webhook：选「将事件发送至开发者服务器」，请求地址填 `https://<你的域名><basePath>/<账号 id>`，记下 Verification Token，建议设置 Encrypt Key。
4. 添加事件 `im.message.receive_v1`，发布版本，把机器人拉进群。

| 配置项 | 必填 | 说明 |
| --- | --- | --- |
| `appId` | 是 | `cli_` 开头 |
| `appSecret` | 是 | 引用 |
| `mode` | | `websocket`（默认）或 `webhook` |
| `verificationToken` | webhook 时 | 引用 |
| `encryptKey` | | 引用；webhook 模式下解密并校验 `X-Lark-Signature` |
| `domain` | | `feishu`（默认）或 `lark`（国际版） |

```jsonc
// .leo/chat-channels/feishu.json —— 长连接
{ "appId": "cli_xxx", "appSecret": "$FEISHU_APP_SECRET" }
```

```jsonc
// .leo/chat-channels/feishu.json —— webhook
{
  "mode": "webhook",
  "appId": "cli_xxx",
  "appSecret": "$FEISHU_APP_SECRET",
  "verificationToken": "$FEISHU_VERIFICATION_TOKEN",
  "encryptKey": "$FEISHU_ENCRYPT_KEY"
}
```

### QQ（`qq`）

收消息两种方式，默认长连接：

| 模式 | 公网地址 | 说明 |
| --- | --- | --- |
| `websocket`（默认） | 不需要 | 机器人主动连 QQ 网关：Identify 鉴权、按服务端周期心跳、断线后 Resume 补发遗漏事件、重连退避；被封禁 / 下架 / intent 无权限时账号进入 `failed` 并给出原因 |
| `webhook` | 需要 HTTPS | 回调地址 `https://<你的域名><basePath>/<账号 id>`（端口仅支持 80/443/8080/8443），op=13 校验与每个回调都用 AppSecret 派生的 Ed25519 密钥签名 / 验签 |

1. QQ 开放平台（q.qq.com）创建机器人，开发设置里记下 AppID、AppSecret。
2. 把服务器出口 IP 加入 IP 白名单；调试期可 `sandbox: true`（机器人未上架时只能连沙箱）。
3. webhook 模式才需要：回调配置里填地址并勾选 `C2C_MESSAGE_CREATE`、`GROUP_AT_MESSAGE_CREATE`、`AT_MESSAGE_CREATE`、`DIRECT_MESSAGE_CREATE`。
4. 自动回复都是带原消息 id 的**被动回复**（单聊 60 分钟、群 5 分钟内有效）；`chat_send` 不带 `reply_to` 时是主动消息，有严格的月度额度。

| 配置项 | 必填 | 说明 |
| --- | --- | --- |
| `appId` | 是 | |
| `appSecret` | 是 | 引用 |
| `mode` | | `websocket`（默认）或 `webhook` |
| `events` | | 长连接订阅的事件，默认 `["c2c_group", "guild_at"]`：`c2c_group` 单聊与群 @，`guild_at` 频道 @，`guild_dm` 频道私信（需申请权限，没权限会被网关以 4014 拒绝） |
| `sandbox` | | 使用沙箱环境 |

```jsonc
// .leo/chat-channels/qq.json —— 长连接
{ "appId": "102xxxxxx", "appSecret": "$QQ_BOT_SECRET" }
```

```jsonc
// .leo/chat-channels/qq.json —— webhook
{ "mode": "webhook", "appId": "102xxxxxx", "appSecret": "$QQ_BOT_SECRET" }
```

## 提供的能力

| 类型 | 名称 | 说明 |
| --- | --- | --- |
| 服务 | `chatChannels` | `drivers()`、`accounts()`、`addAccount()`、`restart()`、`send()`、`inject()`、`registerDriver()` |
| 工具 | `chat_channels` | 列出渠道与账号状态（只读） |
| 工具 | `chat_send` | 通过某个机器人账号主动发消息，权限 `{ kind: 'chat.send', sideEffect: true }` |
| 事件 | `chat-channels/driver-registered` | emit，渠道驱动注册 |
| 事件 | `chat-channels/status` | emit，账号状态变化 |
| 事件 | `chat-channels/received` | emit，通过过滤的入站消息 |
| 事件 | `chat-channels/inbound` | waterfall `{ message, autoReply } → OutboundMessage \| undefined`，终点是 Agent 桥接；中间件可拦截（指令、关键词、风控）或改写回复 |
| 事件 | `chat-channels/sent` | emit，消息已发送 |

示例：用中间件做一个 `/ping` 指令，不经过 Agent：

```ts
ctx.on('chat-channels/inbound', (p, next) => (p.message.text === '/ping' ? { text: 'pong' } : next()))
```

## 新增一个渠道

新渠道和内置的几个一样，是放进大箱子的小盒子：

1. 新建 `src/channels/<id>/index.ts`，导出一个 `ChannelDriver`：
   - `options`：这个渠道自己的机器人配置 zod schema（每个字段带 `describe`，密钥字段写进 `secretFields`）；
   - `create(init)`：用 `init.secret()` 取密钥、`init.webhook()` 挂回调，或在 `start()` 里起长轮询 / 长连接（用 `init.WebSocket`，不可恢复的错误调用 `init.fail()`）、收到消息调用 `init.dispatch()`、出站请求一律用 `init.fetch` 并监听 `init.signal`；
   - 返回 `{ start?, send, stop? }`。`send` 每次只发一段，分段由注册层负责。
2. 在 `src/channels/index.ts` 的 `BUILTIN_DRIVERS` 和 `src/config.ts` 的 `BUILTIN_CHANNELS` 里登记 id。
3. 在 `test/channels.test.ts` 补上收发与验签测试，在本 README 补「机器人配置」一节。用户就可以写 `.leo/chat-channels/<id>.json` 了。

运行时也可以通过 `ctx.get('chatChannels').registerDriver(driver)` 追加驱动（驱动只是对象，不是插件），供私有渠道使用。

## 安全说明

- **默认不自动回复**；开启后聊天 Agent 默认**没有任何工具**（聊天对象是外部用户），需要时在 `agent.tools` 显式列出。工具过滤由核心工具管线强制执行。
- 所有回调都校验来源：飞书 Verification Token + 签名（webhook 模式设置 Encrypt Key 时）、QQ Ed25519 签名、Telegram secret token；QQ / 飞书长连接与 Telegram 长轮询由机器人主动发起，无需对外开放端口；比较使用常量时间。
- 群聊默认需要 @机器人；可用 `allowFrom` / `allowChats` 白名单收紧。
- webhook 默认只监听 `127.0.0.1`，请求体大小有上限；重推事件按 id 去重。
- 密钥只接受引用或 credentials，不会出现在日志、状态、错误信息与工具输出中。
- 并发、每会话队列、会话数、步数、超时均有上限。
- `chat_send` 声明 `sideEffect: true`，沿用用户的审批模式（ask / auto / deny）。
