/**
 * leo-plugin-gateway 的公共契约。
 *
 * 网关（Gateway）是一个常驻在 leo 进程里的“总机”，参考 OpenClaw Gateway 与 Hermes Messaging Gateway：
 *
 * - **渠道（channels）**：网关独占所有聊天平台连接（Telegram / 飞书 / QQ …），每个平台一个驱动 {@link ChannelDriver}，
 *   入站消息统一成 {@link InboundMessage}，出站统一用 {@link OutboundMessage}。
 * - **会话路由（sessions）**：按“平台 + 账号 + 会话类型 + 会话 id [+ 话题] [+ 用户]”生成稳定的会话键，
 *   每个会话键对应一个 leo 会话（历史持久化），同一会话串行执行（会话车道），忙时按 busy 策略排队 / 打断 / 插话。
 * - **授权（auth）**：默认拒绝；白名单、管理员、DM 配对码。
 * - **指令（commands）**：/new /stop /status /approve /deny /pair … 在 Agent 之外由网关直接处理。
 * - **审批（approvals）**：网关会话里的副作用工具改为在聊天里请求 /approve，而不是在终端里问。
 * - **投递（delivery）**：回复原会话、主动发到任意会话或 home 会话（工具 `gateway_send`）。
 * - **控制面（control plane）**：同一个端口提供 HTTP API（含 OpenAI 兼容接口）、SSE 与 WebSocket，
 *   也承载渠道 webhook 回调。
 */
import type { Context, Disposer, Logger } from 'leo-agents'
import type { z } from 'zod'

// ———————————————————————————————————————————— 渠道驱动 ————————————————————————————————————————————

/** 会话类型：私聊 / 群聊 / 频道 */
export type ChatType = 'direct' | 'group' | 'channel'

/** 平台统一后的入站消息 */
export interface InboundMessage {
  /** 渠道驱动 id，如 `telegram`；控制面进来的消息为 `api` */
  channel: string
  /** 账号（机器人实例）id，即 gateway.json `channels` 的键 */
  account: string
  /** 平台侧消息 id（回复时作为 replyTo） */
  id: string
  chat: {
    /** 发送目标 id：Telegram chat_id、飞书 chat_id、QQ openid / group_openid / channel_id */
    id: string
    type: ChatType
    /** 平台附加路由信息（如 Telegram 话题 threadId、QQ guild_id），发送时原样带回 */
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
  /** 平台原始载荷（只给程序用，不要发给模型） */
  raw?: unknown
}

/** 发送目标 */
export interface ChannelTarget {
  chatId: string
  chatType?: ChatType
  extra?: Record<string, string>
}

/** 出站消息。当前只定义文本；平台不支持的字段应忽略 */
export interface OutboundMessage {
  text: string
  /** 回复哪条消息（平台侧消息 id）。QQ 被动回复必须带上 */
  replyTo?: string
}

export interface SendResult {
  /** 平台侧消息 id（超长文本会被分段，可能有多条） */
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

/** 驱动创建连接时拿到的一切，全部由网关提供；驱动不应自行创建全局副作用 */
export interface ChannelInit<O> {
  /** 账号 id */
  account: string
  /** 已经过驱动 schema 校验的机器人配置（密钥字段仍是引用，用 secret() 解析） */
  options: O
  /**
   * 解析密钥字段：支持 `$ENV` / `${ENV}` / `!command`，以及 `.leo/credentials.json`
   * 中键为 `gateway/<account>/<field>` 的凭据。未配置时返回 undefined。解析结果不得写入日志或错误信息。
   */
  secret(field: string): string | undefined
  /** 收到消息后调用；网关负责授权、路由、排队与回复，不会抛错 */
  dispatch(message: InboundMessage): void
  /**
   * 在网关 HTTP 服务上挂载本账号的 webhook 路由，返回回调路径（如 `/hooks/feishu`）。
   * 每个账号只能挂载一次；卸载由网关负责。
   */
  webhook(handler: WebhookHandler): Promise<string>
  /** 可注入的 fetch（测试用），所有出站 HTTP 请求都应使用它 */
  fetch: typeof fetch
  /** 可注入的 WebSocket 构造器（测试用），长连接平台都应使用它；默认 Node 22 全局 WebSocket */
  WebSocket: typeof WebSocket
  /** 不可恢复的错误（机器人被封禁、凭证失效）时调用：账号进入 failed 并释放资源。可恢复的断线应自行重连 */
  fail(error: string): void
  /** 账号停止时 abort：长轮询、重连循环必须监听它 */
  signal: AbortSignal
  logger: Logger
  /** 网关插件作用域的 Context（一般不需要） */
  ctx: Context<any>
}

/** 一个运行中的机器人连接 */
export interface ChannelConnection {
  /** 开始收消息（长轮询、WebSocket 等）。webhook 型平台可以不实现 */
  start?(): void | Promise<void>
  /** 发送一条消息（文本已按 textLimit 分段，每次调用只发一段） */
  send(target: ChannelTarget, message: OutboundMessage, signal: AbortSignal): Promise<SendResult>
  /** 停止并释放资源 */
  stop?(): void | Promise<void>
}

/** 渠道驱动：一个聊天平台的接入实现。每个平台定义自己的机器人配置 schema */
export interface ChannelDriver<O = any> {
  /** kebab-case，全局唯一，如 `telegram` */
  id: string
  /** 显示名 */
  name: string
  description?: string
  /** 该平台的机器人配置 schema（zod） */
  options: z.ZodType<O>
  /** options 中属于密钥的字段名（只用于诊断展示时打码） */
  secretFields?: readonly string[]
  /** 单条消息的最大字符数，超出由网关分段 */
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
  webhookPath?: string
  error?: string
  received: number
  sent: number
}

export interface ChannelInfo {
  id: string
  name: string
  description?: string
  receive?: ChannelDriver['receive']
  textLimit?: number
  builtin: boolean
}

// ———————————————————————————————————————————— 网关 ————————————————————————————————————————————

/** 消息来源（会话路由的输入） */
export interface SessionSource {
  channel: string
  account: string
  chatId: string
  chatType: ChatType
  threadId?: string
  userId: string
  userName?: string
  extra?: Record<string, string>
}

export interface GatewaySessionInfo {
  /** 会话键，如 `telegram:main:direct:12345` */
  key: string
  /** leo 会话 id（历史存在 leo 的会话存储里） */
  sessionId: string
  origin: SessionSource
  createdAt: number
  updatedAt: number
  /** 是否正在运行 turn */
  running: boolean
  /** 排队中的消息数 */
  queued: number
  /** 等待审批的工具调用 */
  pendingApproval?: { id: string; tool: string }
  turns: number
}

export interface PairingRequest {
  code: string
  /** `channel:userId` */
  user: string
  userName?: string
  account: string
  chatId: string
  createdAt: number
  expiresAt: number
}

/** 一次对话 turn 的结果 */
export interface GatewayTurnResult {
  sessionKey: string
  sessionId: string
  reason: string
  text: string
  error?: string
}

/** 投递目标：`<account>:<chatId>`、`home`、`<account>:home`，或结构化对象 */
export type DeliveryTarget = string | { account: string; chatId: string; chatType?: ChatType; extra?: Record<string, string>; /** 回复引用的平台消息 id（QQ 被动回复需要） */ replyTo?: string }

/** `ctx.get('gateway')` */
export interface GatewayService {
  // —— 渠道 ——
  /** 注册一个平台驱动（内置的 telegram / feishu / qq 由网关自己注册）。返回撤销函数 */
  registerChannel(driver: ChannelDriver): Disposer
  channels(): ChannelInfo[]
  accounts(): AccountStatus[]
  restartAccount(account: string): Promise<AccountStatus>

  // —— 会话 ——
  sessions(): GatewaySessionInfo[]
  /** 给某个会话发一条用户消息并等待回复（控制面、其他插件用）。不经过授权，调用方自行把关 */
  chat(input: { sessionKey?: string; text: string; userName?: string; onEvent?: (ev: GatewayStreamEvent) => void; signal?: AbortSignal }): Promise<GatewayTurnResult>
  /** 结束当前会话、下一条消息开新会话（等价 /new） */
  resetSession(sessionKey: string): Promise<boolean>
  /** 取消会话当前的 turn 并清空排队（等价 /stop） */
  abortSession(sessionKey: string): boolean
  history(sessionKey: string): Promise<{ role: string; text: string }[]>

  // —— 投递 ——
  /** 主动发消息到某个平台会话（自动分段）。不经过授权，调用方自行把关 */
  send(target: DeliveryTarget, text: string, signal?: AbortSignal): Promise<SendResult & { account: string; chatId: string }>
  /** 以编程方式注入一条入站消息（测试、或自定义接入）；走完整的授权 / 指令 / 路由流程 */
  inject(message: InboundMessage): void

  // —— 授权 ——
  pairing(): PairingRequest[]
  approvePairing(code: string): PairingRequest | undefined
  revokeUser(user: string): boolean
  pairedUsers(): string[]

  /** 控制面监听地址（未启动时 undefined） */
  address(): { host: string; port: number } | undefined
}

/** 一个 turn 的流式事件（控制面 SSE / WebSocket 推送的就是它） */
export type GatewayStreamEvent =
  | { type: 'start'; sessionKey: string; sessionId: string; turnId: string }
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string; phase: 'start' | 'end'; error?: string }
  | { type: 'approval'; id: string; tool: string; summary: string }
  | { type: 'done'; reason: string; text: string; error?: string }
