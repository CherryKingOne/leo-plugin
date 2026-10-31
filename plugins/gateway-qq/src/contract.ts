/**
 * leo-plugin-gateway（≥ 0.2.0）渠道驱动契约中本插件用到的部分。
 *
 * 插件之间不互相 import（PROTOCOL.md 第 10 节），所以这里按结构复制一份；
 * 以 plugins/gateway/src/types.ts 为准，两边修改时要同步。
 */
import type { Context, Disposer, Logger } from 'leo-agents'
import type { z } from 'zod'

export type ChatType = 'direct' | 'group' | 'channel'

export interface InboundMessage {
  channel: string
  account: string
  id: string
  chat: { id: string; type: ChatType; extra?: Record<string, string> }
  sender: { id: string; name?: string }
  text: string
  mentioned: boolean
  timestamp: number
  raw?: unknown
}

export interface ChannelTarget {
  chatId: string
  chatType?: ChatType
  extra?: Record<string, string>
}

export interface OutboundMessage {
  text: string
  replyTo?: string
}

export interface SendResult {
  messageIds: string[]
}

export interface WebhookRequest {
  method: string
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

export interface ChannelReport {
  state: 'waiting_bind'
  bindUrl?: string
  detail?: string
}

export interface ChannelInit<O> {
  account: string
  options: O
  secret(field: string): string | undefined
  dispatch(message: InboundMessage): void
  webhook(handler: WebhookHandler): Promise<string>
  fetch: typeof fetch
  WebSocket: typeof WebSocket
  fail(error: string): void
  /** 网关 0.2.0 起提供；旧版网关没有，调用前要判断 */
  report?(update?: ChannelReport): void
  /** 网关 0.2.0 起提供 */
  notify?(message: string, level?: 'info' | 'warn' | 'error'): void
  /** 网关 0.2.0 起提供：运维要求重新绑定 */
  rebind?: boolean
  /** 网关 0.2.2 起提供：直接授权本渠道用户（admin 时同时成为管理员） */
  authorize?(userId: string, opts?: { admin?: boolean; name?: string }): void
  signal: AbortSignal
  logger: Logger
  ctx: Context<any>
}

export interface ChannelConnection {
  start?(): void | Promise<void>
  send(target: ChannelTarget, message: OutboundMessage, signal: AbortSignal): Promise<SendResult>
  stop?(): void | Promise<void>
}

export interface ChannelDriver<O = any> {
  id: string
  name: string
  description?: string
  options: z.ZodType<O>
  secretFields?: readonly string[]
  textLimit?: number
  receive?: 'webhook' | 'polling' | 'websocket' | 'none'
  create(init: ChannelInit<O>): ChannelConnection | Promise<ChannelConnection>
}

export interface AccountStatus {
  account: string
  channel: string
  state: string
  bindUrl?: string
  detail?: string
  error?: string
}

/** `ctx.get('gateway')` 中本插件用到的部分 */
export interface GatewayLike {
  registerChannel(driver: ChannelDriver): Disposer
  accounts(): AccountStatus[]
  restartAccount(account: string, opts?: { rebind?: boolean }): Promise<AccountStatus>
  /** 网关 0.2.0 起提供 */
  sessionOfAgent?(agentId: string): string | undefined
}
