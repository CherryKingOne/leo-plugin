/**
 * 聊天渠道注册层的公共契约。
 *
 * 结构：一个大箱子 + 若干小盒子。
 *
 * - 大箱子：本插件 `leo-plugin-chat-channels`，是唯一可以被 leo 安装、加载、配置的插件，
 *   对外提供服务 `chatChannels` 与 `chat-channels/*` 事件。
 * - 小盒子：渠道驱动 {@link ChannelDriver}（QQ / 微信 / 飞书 / Telegram），放在 `src/channels/<id>/`。
 *   它们**不是** leo 插件：没有 PluginDefinition、没有独立的 npm 包和 leo-plugin.json，
 *   不能写进 `.leo/config.json` 的 plugins，只能由注册层注册后使用。
 * - 注册层负责：注册驱动、按账号实例化机器人、用各渠道自己的 schema 校验机器人配置、
 *   启动 / 停止 / 重启、共享 webhook 服务器、入站过滤与分发、出站分段发送、状态与诊断。
 * - 上层业务（Agent、其他插件）只面向 `chatChannels` 服务与事件，不感知具体渠道。
 *
 * 新增渠道：在 `src/channels/<id>/` 实现一个 ChannelDriver，并加入 `src/channels/index.ts` 的 BUILTIN_DRIVERS。
 */
import type { Context, Disposer, Logger } from 'leo-agents'
import type { z } from 'zod'

/** 会话类型：私聊 / 群聊 / 频道（如 QQ 频道子频道） */
export type ChatType = 'direct' | 'group' | 'channel'

/** 渠道统一后的入站消息 */
export interface InboundMessage {
  /** 渠道驱动 id，如 `telegram` */
  channel: string
  /** 账号（机器人实例）id，即配置 `accounts` 的键 */
  account: string
  /** 渠道侧消息 id（回复时作为 replyTo） */
  id: string
  chat: {
    /** 发送目标 id：Telegram chat_id、飞书 chat_id、QQ openid / group_openid / channel_id、微信 openid */
    id: string
    type: ChatType
    /** 渠道附加路由信息（如 QQ 频道私信的 guild_id），发送时原样带回 */
    extra?: Record<string, string>
  }
  sender: {
    id: string
    name?: string
  }
  /** 纯文本内容（已去掉 @机器人 的提及） */
  text: string
  /** 群聊中是否 @ 了机器人；私聊恒为 true */
  mentioned: boolean
  /** 毫秒时间戳 */
  timestamp: number
  /** 渠道原始载荷（只给程序用，不要发给模型） */
  raw?: unknown
}

/** 发送目标 */
export interface ChannelTarget {
  chatId: string
  chatType?: ChatType
  extra?: Record<string, string>
}

/** 出站消息。当前只定义文本；渠道不支持的字段应忽略 */
export interface OutboundMessage {
  text: string
  /** 回复哪条消息（渠道侧消息 id）。QQ 被动回复必须带上 */
  replyTo?: string
}

export interface SendResult {
  /** 渠道侧消息 id（可能有多条：超长文本被分段） */
  messageIds: string[]
}

/** webhook 请求（已读完 body） */
export interface WebhookRequest {
  method: string
  /** 小写 header 名 */
  headers: Record<string, string | undefined>
  query: URLSearchParams
  body: Buffer
}

export interface WebhookResponse {
  status?: number
  headers?: Record<string, string>
  body?: string | Buffer
}

export type WebhookHandler = (req: WebhookRequest) => WebhookResponse | Promise<WebhookResponse>

/** 驱动创建连接时拿到的一切。全部由注册层提供，驱动不应自行创建全局副作用 */
export interface ChannelInit<O> {
  /** 账号 id */
  account: string
  /** 已经过驱动 schema 校验的机器人配置（密钥字段仍是引用，用 secret() 解析） */
  options: O
  /**
   * 解析密钥字段：支持 `$ENV` / `${ENV}` / `!command`，以及 `.leo/credentials.json`
   * 中键为 `chat-channels/<account>/<field>` 的凭据。未配置时返回 undefined。
   * 解析结果不得写入日志或错误信息。
   */
  secret(field: string): string | undefined
  /** 收到消息后调用；注册层负责过滤、排队与分发，不会抛错 */
  dispatch(message: InboundMessage): void
  /**
   * 在共享 webhook 服务器上挂载本账号的路由（服务器按需启动），返回回调路径（如 `/leo/chat/feishu-bot`）。
   * 每个账号只能挂载一次；卸载由注册层负责。
   */
  webhook(handler: WebhookHandler): Promise<string>
  /** 可注入的 fetch（测试用），所有出站 HTTP 请求都应使用它 */
  fetch: typeof fetch
  /** 账号停止时 abort：长轮询、重连循环必须监听它 */
  signal: AbortSignal
  logger: Logger
  /** 本插件作用域的 Context（一般不需要） */
  ctx: Context<any>
}

/** 一个运行中的机器人连接 */
export interface ChannelConnection {
  /** 开始收消息（长轮询、WebSocket 等）。webhook 型渠道可以不实现 */
  start?(): void | Promise<void>
  /** 发送一条消息（文本已被注册层按 textLimit 分段，每次调用只发一段） */
  send(target: ChannelTarget, message: OutboundMessage, signal: AbortSignal): Promise<SendResult>
  /** 停止并释放资源 */
  stop?(): void | Promise<void>
}

/**
 * 渠道驱动：一个聊天渠道的“子插件实现”。
 * 每个渠道定义自己的机器人配置 schema（各家机器人的配置方式不同）。
 */
export interface ChannelDriver<O = any> {
  /** kebab-case，全局唯一，如 `qq`、`wechat`、`feishu`、`telegram` */
  id: string
  /** 显示名 */
  name: string
  description?: string
  /** 该渠道的机器人配置 schema（zod）；每个字段应带 describe */
  options: z.ZodType<O>
  /** options 中属于密钥的字段名（只用于诊断展示时打码） */
  secretFields?: readonly string[]
  /** 单条消息的最大字符数，超出由注册层分段 */
  textLimit?: number
  /** 收消息方式，仅用于诊断展示 */
  receive?: 'webhook' | 'polling' | 'websocket' | 'none'
  create(init: ChannelInit<O>): ChannelConnection | Promise<ChannelConnection>
}

export type AccountState = 'waiting_driver' | 'starting' | 'running' | 'stopped' | 'failed' | 'disabled'

export interface AccountStatus {
  account: string
  channel: string
  state: AccountState
  /** webhook 型渠道的回调路径 */
  webhookPath?: string
  error?: string
  /** 统计 */
  received: number
  sent: number
}

export interface DriverInfo {
  id: string
  name: string
  description?: string
  receive?: ChannelDriver['receive']
  textLimit?: number
  /** 是否为本插件内置的子插件 */
  builtin: boolean
}

/** 账号配置（与 config.ts 中的 AccountSchema 一致） */
export interface AccountConfig {
  channel: string
  enabled: boolean
  options: Record<string, unknown>
  /** 只接受这些发送者 id 的消息；为空表示不限制 */
  allowFrom: string[]
  /** 只接受这些会话 id 的消息；为空表示不限制 */
  allowChats: string[]
  /** 群聊里必须 @ 机器人才处理 */
  requireMention: boolean
  /** 是否交给 Agent 自动回复（需同时开启全局 agent.enabled） */
  autoReply: boolean
}

/** `ctx.get('chatChannels')`：聊天渠道注册层 */
export interface ChatChannelService {
  /**
   * 向注册层注册一个渠道驱动。内置的 QQ / 微信 / 飞书 / Telegram 由注册层自己注册；
   * 这里也是运行时追加渠道的扩展点（驱动只是对象，不是插件）。返回撤销函数
   */
  registerDriver(driver: ChannelDriver): Disposer
  /** 已注册的驱动 */
  drivers(): DriverInfo[]
  /** 动态添加账号（与配置中的 accounts 等价）。返回撤销函数：停止并移除账号 */
  addAccount(account: string, config: Partial<AccountConfig> & { channel: string; options?: Record<string, unknown> }): Promise<Disposer>
  /** 所有账号的状态 */
  accounts(): AccountStatus[]
  /** 重启某个账号 */
  restart(account: string): Promise<AccountStatus>
  /** 发送消息（自动分段）。账号不存在或未运行时抛错 */
  send(account: string, target: ChannelTarget, message: OutboundMessage, signal?: AbortSignal): Promise<SendResult>
  /** 以编程方式注入一条入站消息（测试、或自定义接入） */
  inject(message: InboundMessage): void
}
