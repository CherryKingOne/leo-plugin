# leo-plugin-chat-channels

> 实验性 0.1.0

## 用途

聊天渠道注册层（Chat Channel Registry Layer）：让 leo Agent 通过 QQ、微信、飞书、Telegram 等聊天软件的机器人收发消息。

**聊天渠道插件 = 渠道注册层 + 渠道子插件体系。** 可以把它想成一个大箱子里装着几个小盒子：

```text
leo-plugin-chat-channels            ← 大箱子：唯一可安装、可配置的 leo 插件
├── 注册层 registry                  注册、发现、配置校验、启动/停止、共享 webhook、收发分发
└── src/channels/                    小盒子：渠道驱动（不是插件，不能单独使用）
    ├── qq/        QQ 开放平台官方机器人
    ├── wechat/    微信公众号
    ├── feishu/    飞书 / Lark 自建应用机器人
    └── telegram/  Telegram Bot
```

- 四个渠道是**内置的渠道驱动**，没有自己的插件入口、npm 包和 `leo-plugin.json`，不能写进 `.leo/config.json` 的 `plugins`，只能装在本插件里、由注册层注册后使用。
- 每个渠道只关心**自家机器人的配置方式与收发协议**；过滤、排队、分段、重试、生命周期、与 Agent 对接都由注册层统一完成。
- 上层业务只面向服务 `chatChannels` 与 `chat-channels/*` 事件，不与具体渠道耦合。新增渠道不需要改上层任何代码。

## 安装

```bash
leo plugin add chat-channels
# 或
npm install leo-plugin-chat-channels
```

`.leo/config.json`：

```jsonc
{
  "plugins": [
    ["leo-plugin-chat-channels", {
      "accounts": {
        "tg-main": { "channel": "telegram", "options": { "botToken": "$TELEGRAM_BOT_TOKEN" } }
      },
      "agent": { "enabled": true, "model": "deepseek/deepseek-chat" }
    }]
  ]
}
```

其他安装方式见 [docs/install.md](../../docs/install.md)。

## 配置

### 顶层

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `builtin` | string[] | `["qq","wechat","feishu","telegram"]` | 装进注册层的内置渠道。只注册驱动，不会启动机器人 |
| `accounts` | Record<id, Account> | `{}` | 机器人账号，键为账号 id（kebab-case），一个渠道可以有多个账号 |
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

### 账号（Account）

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `channel` | string | — | `qq` / `wechat` / `feishu` / `telegram` |
| `enabled` | boolean | `true` | |
| `options` | object | `{}` | **各渠道自己的机器人配置**，见下文；由对应渠道的 schema 校验 |
| `allowFrom` | string[] | `[]` | 发送者白名单（渠道侧用户 id），空为不限 |
| `allowChats` | string[] | `[]` | 会话白名单（渠道侧 chat id），空为不限 |
| `requireMention` | boolean | `true` | 群聊里必须 @机器人 才处理 |
| `autoReply` | boolean | `true` | 是否交给 Agent 自动回复（还需 `agent.enabled`） |

密钥字段一律写引用，不要写明文：`"$ENV_NAME"`、`"${ENV_NAME}"`、`"!op read op://vault/item"`。也可以写进 `.leo/credentials.json`，键为 `chat-channels/<账号 id>/<字段名>`（优先级更高）。

## 各渠道的机器人配置

每个渠道的机器人在各自平台上配置方式不同，`options` 也各不相同。

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

```json
"tg-main": { "channel": "telegram", "options": { "botToken": "$TELEGRAM_BOT_TOKEN" } }
```

### 飞书 / Lark（`feishu`）

1. 飞书开放平台 → 创建企业自建应用 → 添加「机器人」能力，记下 App ID、App Secret。
2. 开通权限：`im:message`、`im:message.p2p_msg`、`im:message.group_at_msg`（需要群内所有消息再加 `im:message.group_msg`）。
3. 事件与回调 → 加密策略：记下 Verification Token，建议设置 Encrypt Key。
4. 订阅方式选「发送至开发者服务器」，请求地址填 `https://<你的域名><basePath>/<账号 id>`，添加事件 `im.message.receive_v1`。保存时的 url_verification 由插件自动应答。
5. 发布版本，把机器人拉进群。

| options | 必填 | 说明 |
| --- | --- | --- |
| `appId` | 是 | `cli_` 开头 |
| `appSecret` | 是 | 引用 |
| `verificationToken` | 是 | 引用 |
| `encryptKey` | | 引用；设置后解密请求体并校验 `X-Lark-Signature` |
| `domain` | | `feishu`（默认）或 `lark`（国际版） |

```json
"feishu-bot": {
  "channel": "feishu",
  "options": { "appId": "cli_xxx", "appSecret": "$FEISHU_APP_SECRET", "verificationToken": "$FEISHU_VERIFICATION_TOKEN", "encryptKey": "$FEISHU_ENCRYPT_KEY" }
}
```

### QQ（`qq`）

1. QQ 开放平台（q.qq.com）创建机器人，开发设置里记下 AppID、AppSecret。
2. 回调配置：地址填 `https://<你的域名><basePath>/<账号 id>`（端口仅支持 80/443/8080/8443），勾选事件 `C2C_MESSAGE_CREATE`（单聊）、`GROUP_AT_MESSAGE_CREATE`（群 @）、`AT_MESSAGE_CREATE`（频道 @）、`DIRECT_MESSAGE_CREATE`（频道私信）。保存时平台发 op=13 校验，插件用 AppSecret 派生的 Ed25519 密钥签名应答，之后每个回调都校验签名。
3. 把服务器出口 IP 加入 IP 白名单；调试期可 `sandbox: true`。
4. 自动回复都是带原消息 id 的**被动回复**（单聊 60 分钟、群 5 分钟内有效）；`chat_send` 不带 `reply_to` 时是主动消息，有严格的月度额度。

| options | 必填 | 说明 |
| --- | --- | --- |
| `appId` | 是 | |
| `appSecret` | 是 | 引用 |
| `sandbox` | | 使用沙箱环境 |

```json
"qq-bot": { "channel": "qq", "options": { "appId": "102xxxxxx", "appSecret": "$QQ_BOT_SECRET" } }
```

QQ 官方已逐步下线机器人的 WebSocket 接入，本渠道只实现 Webhook。

### 微信公众号（`wechat`）

1. 微信公众平台 → 设置与开发 → 基本配置：记下 AppID、AppSecret，把服务器 IP 加入 IP 白名单。
2. 服务器配置：URL 填 `http(s)://<你的域名><basePath>/<账号 id>`（80/443 端口），Token 自定，加解密方式选明文或安全模式（安全模式需 EncodingAESKey）。提交时的 GET 校验由插件自动应答。
3. 插件收到消息后立即回 `success`，Agent 处理完再用**客服消息接口**发回去：需要公众号有客服消息权限（认证服务号），且只能在用户最近一次发消息后 48 小时内回复。
4. 公众号只有私聊。

| options | 必填 | 说明 |
| --- | --- | --- |
| `appId` | 是 | `wx` 开头 |
| `appSecret` | 是 | 引用 |
| `token` | 是 | 服务器配置的 Token，引用 |
| `encodingAESKey` | | 安全模式的 43 位密钥，引用 |

```json
"wx-mp": { "channel": "wechat", "options": { "appId": "wx123", "appSecret": "$WECHAT_APP_SECRET", "token": "$WECHAT_TOKEN", "encodingAESKey": "$WECHAT_AES_KEY" } }
```

> 这里的「微信」指公众号。企业微信（WeCom）机器人、个人微信不在本版本内，企业微信可以按下文规范作为新渠道加入。

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

新渠道和内置的四个一样，是放进大箱子的小盒子：

1. 新建 `src/channels/<id>/index.ts`，导出一个 `ChannelDriver`：
   - `options`：这个渠道自己的机器人配置 zod schema（每个字段带 `describe`，密钥字段写进 `secretFields`）；
   - `create(init)`：用 `init.secret()` 取密钥、`init.webhook()` 挂回调或在 `start()` 里起长轮询、收到消息调用 `init.dispatch()`、出站请求一律用 `init.fetch` 并监听 `init.signal`；
   - 返回 `{ start?, send, stop? }`。`send` 每次只发一段，分段由注册层负责。
2. 在 `src/channels/index.ts` 的 `BUILTIN_DRIVERS` 和 `src/config.ts` 的 `BUILTIN_CHANNELS` 里登记 id。
3. 在 `test/channels.test.ts` 补上收发与验签测试，在本 README 补「机器人配置」一节。

运行时也可以通过 `ctx.get('chatChannels').registerDriver(driver)` 追加驱动（驱动只是对象，不是插件），供私有渠道使用。

## 安全说明

- **默认不自动回复**；开启后聊天 Agent 默认**没有任何工具**（聊天对象是外部用户），需要时在 `agent.tools` 显式列出。工具过滤由核心工具管线强制执行。
- 所有回调都校验来源：飞书 Verification Token + 签名（设置 Encrypt Key 时）、QQ Ed25519 签名、微信 SHA1 签名 / 安全模式、Telegram secret token；比较使用常量时间。
- 群聊默认需要 @机器人；可用 `allowFrom` / `allowChats` 白名单收紧。
- webhook 默认只监听 `127.0.0.1`，请求体大小有上限；重推事件按 id 去重。
- 密钥只接受引用或 credentials，不会出现在日志、状态、错误信息与工具输出中。
- 并发、每会话队列、会话数、步数、超时均有上限。
- `chat_send` 声明 `sideEffect: true`，沿用用户的审批模式（ask / auto / deny）。
