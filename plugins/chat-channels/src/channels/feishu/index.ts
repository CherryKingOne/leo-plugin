/**
 * 飞书 / Lark 机器人（自建应用 + 事件订阅 webhook）。
 *
 * 机器人配置：
 * 1. 飞书开放平台 → 创建企业自建应用 → 添加「机器人」能力，记下 App ID、App Secret。
 * 2. 权限：`im:message`（获取与发送单聊、群组消息）、`im:message.group_at_msg`（接收群聊中 @机器人消息）、
 *    `im:message.p2p_msg`（接收单聊消息），按需加 `im:message.group_msg`（接收群聊所有消息）。
 * 3. 事件与回调 → 加密策略：记下 Verification Token；建议设置 Encrypt Key。
 * 4. 事件订阅方式选「将事件发送至开发者服务器」，请求地址填 `<公网 HTTPS><basePath>/<account>`，
 *    添加事件 `im.message.receive_v1`。保存时飞书会发 url_verification，本驱动自动应答。
 * 5. 发布应用版本，并把机器人拉进群。
 */
import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { ChannelHttpError, requestJson, TokenCache } from '../../http.js'
import type { ChannelConnection, ChannelDriver, ChannelInit, InboundMessage, WebhookRequest, WebhookResponse } from '../../types.js'

export const FeishuOptions = z.object({
  appId: z.string().min(1).describe('App ID（cli_ 开头）'),
  appSecret: z.string().min(1).describe('App Secret，写 $FEISHU_APP_SECRET 这样的引用'),
  verificationToken: z.string().min(1).describe('事件订阅的 Verification Token，写引用'),
  encryptKey: z.string().optional().describe('事件订阅的 Encrypt Key（设置后请求体加密并校验签名），写引用'),
  domain: z.enum(['feishu', 'lark']).default('feishu').describe('feishu = 飞书（open.feishu.cn），lark = 国际版（open.larksuite.com）'),
  requestTimeoutMs: z.number().int().positive().default(15_000),
})
export type FeishuOptions = z.infer<typeof FeishuOptions>

const BASE = { feishu: 'https://open.feishu.cn', lark: 'https://open.larksuite.com' } as const

/** 解密事件体：AES-256-CBC，key = sha256(encryptKey)，前 16 字节为 IV */
export function decryptFeishu(encrypt: string, encryptKey: string): string {
  const key = createHash('sha256').update(encryptKey).digest()
  const buf = Buffer.from(encrypt, 'base64')
  const decipher = createDecipheriv('aes-256-cbc', key, buf.subarray(0, 16))
  return Buffer.concat([decipher.update(buf.subarray(16)), decipher.final()]).toString('utf8')
}

/** 签名：sha256(timestamp + nonce + encryptKey + body) 十六进制 */
export function signFeishu(timestamp: string, nonce: string, encryptKey: string, body: Buffer | string): string {
  return createHash('sha256').update(timestamp + nonce + encryptKey).update(body).digest('hex')
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

interface FeishuMention {
  key: string
  id?: { open_id?: string; user_id?: string; union_id?: string }
  name?: string
}
interface FeishuMessageEvent {
  sender?: { sender_id?: { open_id?: string; user_id?: string }; sender_type?: string }
  message: {
    message_id: string
    chat_id: string
    chat_type: 'p2p' | 'group' | string
    message_type: string
    content: string
    create_time?: string
    mentions?: FeishuMention[]
  }
}

/** 从 text / post 消息内容里提取纯文本 */
export function extractText(type: string, content: string): string | undefined {
  let c: any
  try {
    c = JSON.parse(content)
  } catch {
    return undefined
  }
  if (type === 'text') return typeof c?.text === 'string' ? c.text : undefined
  if (type === 'post') {
    const body = c?.content ? c : (Object.values(c ?? {})[0] as any)
    const lines: string[] = []
    if (body?.title) lines.push(String(body.title))
    for (const para of body?.content ?? []) {
      lines.push((para as any[]).map((el) => (el.tag === 'text' || el.tag === 'a' ? (el.text ?? '') : el.tag === 'at' ? `@${el.user_name ?? ''}` : '')).join(''))
    }
    return lines.join('\n')
  }
  return undefined
}

export function toInbound(account: string, ev: FeishuMessageEvent, botOpenId: string | undefined): InboundMessage | undefined {
  const m = ev.message
  const raw = extractText(m.message_type, m.content)
  if (raw === undefined) return undefined
  const mentions = m.mentions ?? []
  const mentioned = m.chat_type === 'p2p' || mentions.some((x) => (botOpenId ? x.id?.open_id === botOpenId : false))
  let text = raw
  for (const x of mentions) {
    const isBot = botOpenId && x.id?.open_id === botOpenId
    text = text.split(x.key).join(isBot ? '' : `@${x.name ?? ''}`)
  }
  const senderId = ev.sender?.sender_id?.open_id ?? ev.sender?.sender_id?.user_id ?? 'unknown'
  return {
    channel: 'feishu',
    account,
    id: m.message_id,
    chat: { id: m.chat_id, type: m.chat_type === 'p2p' ? 'direct' : 'group' },
    sender: { id: senderId },
    text: text.trim(),
    mentioned,
    timestamp: m.create_time ? Number(m.create_time) : Date.now(),
    raw: ev,
  }
}

async function create(init: ChannelInit<FeishuOptions>): Promise<ChannelConnection> {
  const o = init.options
  const base = BASE[o.domain]
  const appSecret = init.secret('appSecret')
  const verificationToken = init.secret('verificationToken')
  const encryptKey = o.encryptKey ? init.secret('encryptKey') : undefined
  if (!appSecret) throw new Error('feishu: appSecret is not configured')
  if (!verificationToken) throw new Error('feishu: verificationToken is not configured')
  if (o.encryptKey && !encryptKey) throw new Error('feishu: encryptKey could not be resolved')

  const tokens = new TokenCache(async () => {
    const r = await requestJson<{ code: number; msg: string; tenant_access_token: string; expire: number }>(init.fetch, `${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      body: { app_id: o.appId, app_secret: appSecret },
      timeoutMs: o.requestTimeoutMs,
      label: 'feishu tenant_access_token',
      signal: init.signal,
    })
    if (r.code !== 0) throw new ChannelHttpError(`feishu tenant_access_token: code ${r.code}: ${r.msg}`)
    return { token: r.tenant_access_token, expiresInSec: r.expire }
  })

  const api = async <T>(path: string, body: unknown | undefined, signal: AbortSignal, label: string): Promise<T> => {
    const token = await tokens.get()
    const r = await requestJson<{ code: number; msg: string; data: T }>(init.fetch, `${base}${path}`, {
      ...(body === undefined ? {} : { body }),
      headers: { authorization: `Bearer ${token}` },
      timeoutMs: o.requestTimeoutMs,
      label,
      signal,
    })
    if (r.code !== 0) {
      // 99991663 / 99991661：token 失效
      if (r.code === 99991663 || r.code === 99991661) tokens.invalidate()
      throw new ChannelHttpError(`${label}: code ${r.code}: ${r.msg}`)
    }
    return r.data
  }

  // 机器人自己的 open_id：用于判断群聊里是否 @ 了它
  const info = await requestJson<{ code: number; msg: string; bot?: { open_id?: string; app_name?: string } }>(init.fetch, `${base}/open-apis/bot/v3/info`, {
    headers: { authorization: `Bearer ${await tokens.get()}` },
    timeoutMs: o.requestTimeoutMs,
    label: 'feishu bot info',
    signal: init.signal,
  })
  if (info.code !== 0) throw new ChannelHttpError(`feishu bot info: code ${info.code}: ${info.msg}`)
  const botOpenId = info.bot?.open_id
  init.logger.info({ account: init.account, bot: info.bot?.app_name }, 'feishu: bot authorized')

  // 飞书在超时 / 失败时会重推同一事件，按 event_id 去重
  const seen = new Set<string>()
  const remember = (id: string) => {
    if (seen.has(id)) return false
    seen.add(id)
    if (seen.size > 2000) seen.delete(seen.values().next().value as string)
    return true
  }

  const json = (obj: unknown): WebhookResponse => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) })

  const handler = (req: WebhookRequest): WebhookResponse => {
    if (req.method !== 'POST') return { status: 405 }
    let payload: any
    try {
      payload = JSON.parse(req.body.toString('utf8'))
    } catch {
      return { status: 400 }
    }
    if (encryptKey) {
      if (typeof payload?.encrypt !== 'string') return { status: 400, body: 'encrypted body expected' }
      try {
        payload = JSON.parse(decryptFeishu(payload.encrypt, encryptKey))
      } catch {
        return { status: 400, body: 'decrypt failed' }
      }
    }
    // URL 校验（保存回调地址时）：token 正确就原样返回 challenge
    if (payload?.type === 'url_verification') {
      if (!safeEqual(String(payload.token ?? ''), verificationToken)) return { status: 401 }
      return json({ challenge: payload.challenge })
    }
    // 事件签名校验（设置了 Encrypt Key 时飞书会带签名头）
    if (encryptKey) {
      const ts = req.headers['x-lark-request-timestamp'] ?? ''
      const nonce = req.headers['x-lark-request-nonce'] ?? ''
      const sig = req.headers['x-lark-signature'] ?? ''
      if (!sig || !safeEqual(signFeishu(ts, nonce, encryptKey, req.body), sig)) return { status: 401, body: 'bad signature' }
    }
    const header = payload?.header
    if (!header || !safeEqual(String(header.token ?? ''), verificationToken)) return { status: 401 }
    if (header.event_type === 'im.message.receive_v1' && remember(String(header.event_id))) {
      const ev = payload.event as FeishuMessageEvent
      if (ev?.sender?.sender_type !== 'app') {
        const m = toInbound(init.account, ev, botOpenId)
        if (m) init.dispatch(m)
      }
    }
    // 3 秒内必须应答，处理是异步的
    return json({})
  }

  await init.webhook(handler)

  return {
    async send(target, message, signal) {
      const content = JSON.stringify({ text: message.text })
      const data = message.replyTo
        ? await api<{ message_id: string }>(`/open-apis/im/v1/messages/${encodeURIComponent(message.replyTo)}/reply`, { msg_type: 'text', content }, signal, 'feishu reply')
        : await api<{ message_id: string }>(
            `/open-apis/im/v1/messages?receive_id_type=${target.chatType === 'direct' && target.chatId.startsWith('ou_') ? 'open_id' : 'chat_id'}`,
            { receive_id: target.chatId, msg_type: 'text', content },
            signal,
            'feishu send',
          )
      return { messageIds: [data.message_id] }
    },
  }
}

export const feishu: ChannelDriver<FeishuOptions> = {
  id: 'feishu',
  name: '飞书 / Lark',
  description: '飞书自建应用机器人：事件订阅 webhook 收消息，OpenAPI 发消息',
  options: FeishuOptions,
  secretFields: ['appSecret', 'verificationToken', 'encryptKey'],
  // 飞书文本消息上限约 150KB，这里保守分段，便于阅读
  textLimit: 4000,
  receive: 'webhook',
  create,
}
