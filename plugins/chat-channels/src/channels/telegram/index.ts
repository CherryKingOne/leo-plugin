/**
 * Telegram 机器人（Bot API）。
 *
 * 机器人配置：
 * 1. 在 Telegram 里找 @BotFather，`/newbot` 创建机器人，拿到 bot token。
 * 2. 群聊使用：在 BotFather 里 `/setprivacy` → Disable，或者只处理 @机器人 的消息（默认 requireMention=true）。
 * 3. 收消息两种方式：
 *    - `polling`（默认）：getUpdates 长轮询，不需要公网地址，适合本地与内网。
 *    - `webhook`：Telegram 推送到 `<publicUrl><basePath>/<account>`，需公网 HTTPS；插件启动时自动 setWebhook，
 *      并用 secret_token 校验请求来源。
 */
import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { ChannelHttpError, requestJson } from '../../http.js'
import type { ChannelConnection, ChannelDriver, ChannelInit, InboundMessage } from '../../types.js'

export const TelegramOptions = z.object({
  botToken: z.string().min(1).describe('BotFather 给的 bot token，写 $TELEGRAM_BOT_TOKEN 这样的引用'),
  mode: z.enum(['polling', 'webhook']).default('polling').describe('收消息方式'),
  /** webhook 模式：对外可访问的 HTTPS 基地址（不含路径），如 https://bot.example.com */
  publicUrl: z.url().optional().describe('webhook 模式的公网 HTTPS 基地址'),
  /** webhook 模式：校验 X-Telegram-Bot-Api-Secret-Token，写引用 */
  webhookSecret: z.string().optional().describe('webhook secret_token（1-256 位 A-Za-z0-9_-），写引用'),
  /** 自建 Bot API 服务器时修改 */
  apiBase: z.url().default('https://api.telegram.org').describe('Bot API 地址'),
  /** 长轮询等待秒数 */
  pollTimeoutSec: z.number().int().min(1).max(50).default(30),
  /** 回复格式；默认纯文本最稳妥 */
  parseMode: z.enum(['none', 'MarkdownV2', 'HTML']).default('none'),
  requestTimeoutMs: z.number().int().positive().default(15_000),
})
export type TelegramOptions = z.infer<typeof TelegramOptions>

interface TgUser {
  id: number
  is_bot?: boolean
  first_name?: string
  last_name?: string
  username?: string
}
interface TgMessage {
  message_id: number
  date: number
  chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel'; title?: string }
  from?: TgUser
  text?: string
  caption?: string
  entities?: { type: string; offset: number; length: number; user?: TgUser }[]
  reply_to_message?: { from?: TgUser }
  message_thread_id?: number
}
interface TgUpdate {
  update_id: number
  message?: TgMessage
  channel_post?: TgMessage
}
interface TgResponse<T> {
  ok: boolean
  result: T
  description?: string
}

/** 把 Telegram 消息转成统一入站消息；不是文本消息时返回 undefined */
export function toInbound(account: string, msg: TgMessage, bot: { id: number; username?: string }): InboundMessage | undefined {
  const raw = msg.text ?? msg.caption
  if (raw === undefined) return undefined
  const type = msg.chat.type === 'private' ? 'direct' : msg.chat.type === 'channel' ? 'channel' : 'group'
  const handle = bot.username ? `@${bot.username}` : undefined
  const mentionedByEntity = (msg.entities ?? []).some(
    (e) => (e.type === 'mention' && handle && raw.slice(e.offset, e.offset + e.length).toLowerCase() === handle.toLowerCase()) || (e.type === 'text_mention' && e.user?.id === bot.id),
  )
  const repliedToBot = msg.reply_to_message?.from?.id === bot.id
  const isCommandForBot = /^\/\w+@(\w+)/.exec(raw)?.[1]?.toLowerCase() === bot.username?.toLowerCase()
  let text = raw
  if (handle) text = text.replace(new RegExp(`${handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), '').trim()
  const from = msg.from
  const name = from ? [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username : msg.chat.title
  return {
    channel: 'telegram',
    account,
    id: String(msg.message_id),
    chat: {
      id: String(msg.chat.id),
      type,
      ...(msg.message_thread_id ? { extra: { threadId: String(msg.message_thread_id) } } : {}),
    },
    sender: { id: String(from?.id ?? msg.chat.id), ...(name ? { name } : {}) },
    text,
    mentioned: type === 'direct' || mentionedByEntity || repliedToBot || isCommandForBot,
    timestamp: msg.date * 1000,
    raw: msg,
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

async function create(init: ChannelInit<TelegramOptions>): Promise<ChannelConnection> {
  const o = init.options
  const token = init.secret('botToken')
  if (!token) throw new Error('telegram: botToken is not configured')
  const api = async <T>(method: string, body: unknown, signal?: AbortSignal, timeoutMs = o.requestTimeoutMs): Promise<T> => {
    const r = await requestJson<TgResponse<T>>(init.fetch, `${o.apiBase}/bot${token}/${method}`, {
      body,
      timeoutMs,
      label: `telegram ${method}`,
      ...(signal ? { signal } : {}),
    })
    if (!r.ok) throw new ChannelHttpError(`telegram ${method}: ${r.description ?? 'not ok'}`)
    return r.result
  }

  const me = await api<TgUser>('getMe', {}, init.signal)
  const bot = { id: me.id, ...(me.username ? { username: me.username } : {}) }
  init.logger.info({ account: init.account, bot: me.username }, 'telegram: bot authorized')

  const handleUpdate = (u: TgUpdate) => {
    const msg = u.message ?? u.channel_post
    if (!msg || msg.from?.is_bot) return
    const m = toInbound(init.account, msg, bot)
    if (m) init.dispatch(m)
  }

  let loop: Promise<void> | undefined

  if (o.mode === 'webhook') {
    if (!o.publicUrl) throw new Error('telegram: mode "webhook" requires options.publicUrl')
    const secret = init.secret('webhookSecret')
    if (!secret) throw new Error('telegram: mode "webhook" requires options.webhookSecret')
    const path = await init.webhook((req) => {
      if (req.method !== 'POST') return { status: 405 }
      if (!safeEqual(req.headers['x-telegram-bot-api-secret-token'] ?? '', secret)) return { status: 401, body: 'unauthorized' }
      try {
        handleUpdate(JSON.parse(req.body.toString('utf8')) as TgUpdate)
      } catch {
        return { status: 400 }
      }
      return { status: 200, body: 'ok' }
    })
    await api('setWebhook', { url: `${o.publicUrl.replace(/\/+$/, '')}${path}`, secret_token: secret, allowed_updates: ['message', 'channel_post'] }, init.signal)
  }

  return {
    async start() {
      if (o.mode !== 'polling') return
      // 长轮询与 webhook 互斥：先删除可能残留的 webhook
      await api('deleteWebhook', { drop_pending_updates: false }, init.signal)
      let offset = 0
      loop = (async () => {
        let backoff = 1000
        while (!init.signal.aborted) {
          try {
            const updates = await api<TgUpdate[]>('getUpdates', { offset, timeout: o.pollTimeoutSec, allowed_updates: ['message', 'channel_post'] }, init.signal, (o.pollTimeoutSec + 10) * 1000)
            backoff = 1000
            for (const u of updates) {
              offset = Math.max(offset, u.update_id + 1)
              handleUpdate(u)
            }
          } catch (err) {
            if (init.signal.aborted) break
            init.logger.warn({ account: init.account, err: (err as Error).message, retryInMs: backoff }, 'telegram: polling failed')
            await sleep(backoff, init.signal)
            backoff = Math.min(backoff * 2, 60_000)
          }
        }
      })()
    },
    async send(target, message, signal) {
      const thread = target.extra?.threadId
      const r = await api<{ message_id: number }>(
        'sendMessage',
        {
          chat_id: target.chatId,
          text: message.text,
          ...(o.parseMode !== 'none' ? { parse_mode: o.parseMode } : {}),
          ...(thread ? { message_thread_id: Number(thread) } : {}),
          ...(message.replyTo ? { reply_parameters: { message_id: Number(message.replyTo), allow_sending_without_reply: true } } : {}),
        },
        signal,
      )
      return { messageIds: [String(r.message_id)] }
    },
    async stop() {
      await loop
      if (o.mode === 'webhook') await api('deleteWebhook', {}).catch(() => {})
    },
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms)
    function done() {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

export const telegram: ChannelDriver<TelegramOptions> = {
  id: 'telegram',
  name: 'Telegram',
  description: 'Telegram Bot API：长轮询或 webhook',
  options: TelegramOptions,
  secretFields: ['botToken', 'webhookSecret'],
  textLimit: 4096,
  receive: 'polling',
  create,
}
