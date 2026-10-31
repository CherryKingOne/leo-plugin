/**
 * 飞书 / Lark 机器人渠道驱动，移植自 leo-plugin-gateway 内置 feishu 驱动，增加「扫码一键创建应用」。
 *
 * 凭据来源（按顺序）：
 * 1. 本进程刚扫码得到的凭据；
 * 2. credentials.json 中的 `gateway/<账号>/appId`、`gateway/<账号>/appSecret`（以及国际版的 `gateway/<账号>/domain`），每次启动重新读文件；
 * 3. 账号配置里的 `appId` / `appSecret`（0.1.x 写法，支持 `$ENV` / `!command`）。
 * 都没有、且 `bind` 为 `qr`（默认）时进入扫码：账号状态 `waiting_bind` 并给出链接（leo serve 下终端直接打印二维码），
 * 用飞书扫码、确认创建应用后保存凭据并连接；扫码人自动成为网关管理员。`restartAccount(id, { rebind: true })` 忽略已有凭据重新扫码。
 *
 * 扫码创建的应用已预置机器人能力、收发消息权限和长连接事件订阅（im.message.receive_v1），不用再进开发者后台配置。
 *
 * 收消息两种方式：
 * - `websocket`（默认，长连接）：机器人主动连到飞书，不需要公网地址、不需要验签和解密。
 * - `webhook`：飞书把事件推送到 `<公网 HTTPS><basePath>/<account>`，需要 Verification Token，建议设置 Encrypt Key。
 */
import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { ChannelConnection, ChannelDriver, ChannelInit, InboundMessage, WebhookRequest, WebhookResponse } from '../contract.js'
import type { AppCredentials, CredentialStore } from '../credentials.js'
import { ChannelHttpError, requestJson, TokenCache } from '../http.js'
import { FeishuRegisterError, registerFeishuApp } from './register.js'
import { FeishuWsClient } from './ws.js'

export const FeishuOptions = z.object({
  appId: z.string().min(1).optional().describe('App ID（cli_ 开头）；不填时扫码创建应用'),
  appSecret: z.string().min(1).optional().describe('App Secret，写 $FEISHU_APP_SECRET 这样的引用；不填时扫码创建应用'),
  /** 没有凭据时：qr = 扫码创建应用（默认），off = 直接报错（与内置驱动一致） */
  bind: z.enum(['qr', 'off']).default('qr').describe('没有 appId/appSecret 时的处理：qr = 飞书扫码一键创建应用（默认），off = 报错'),
  mode: z.enum(['websocket', 'webhook']).default('websocket').describe('收消息方式：websocket = 长连接（默认，无需公网），webhook = HTTP 回调'),
  verificationToken: z.string().min(1).optional().describe('webhook 模式必填：事件订阅的 Verification Token，写引用'),
  encryptKey: z.string().optional().describe('事件订阅的 Encrypt Key（设置后事件体加密，webhook 模式还会校验签名），写引用'),
  domain: z.enum(['feishu', 'lark']).optional().describe('feishu = 飞书（open.feishu.cn），lark = 国际版（open.larksuite.com）；不填时扫码自动识别，默认 feishu'),
  requestTimeoutMs: z.number().int().positive().default(15_000),
})
export type FeishuOptions = z.infer<typeof FeishuOptions>

const BASE = { feishu: 'https://open.feishu.cn', lark: 'https://open.larksuite.com' } as const

export interface FeishuDriverDeps {
  store: CredentialStore
  /** 链接上的来源标识 */
  source: string
  /** 预填的应用名称 / 描述 / 头像 */
  app?: { name?: string; desc?: string; avatar?: string[] }
  createOnly: boolean
  /** 同时在终端打印二维码 */
  qrConsole: boolean
  /** 打印二维码（测试时替换） */
  printQr(url: string): void
  /** 扫码成功后把扫码者授权为网关管理员 */
  authorizeScanner: boolean
  /** 本插件实例里扫码得到的凭据（凭据文件写入失败时也能用） */
  bound: Map<string, AppCredentials>
  /** 旧版网关没有 init.notify 时的提示出口 */
  notify(message: string, level?: 'info' | 'warn' | 'error'): void
  /** 测试用：缩短轮询间隔 */
  pollIntervalMs?: number
}

/** 解析凭据；没有时按 bind 选项扫码创建应用 */
async function credentialsFor(init: ChannelInit<FeishuOptions>, deps: FeishuDriverDeps): Promise<AppCredentials> {
  const say = (m: string, level?: 'info' | 'warn' | 'error') => (init.notify ? init.notify(m, level) : deps.notify(`${init.account}：${m}`, level))
  if (!init.rebind) {
    const mem = deps.bound.get(init.account)
    if (mem) return mem
    const stored = await deps.store.get(init.account)
    const appId = stored.appId ?? init.secret('appId')
    const appSecret = stored.appSecret ?? init.secret('appSecret')
    if (appId && appSecret) return { appId, appSecret, ...(stored.domain ? { domain: stored.domain } : {}) }
    if (init.options.bind === 'off') throw new Error(`feishu: ${appId ? 'appSecret' : 'appId'} is not configured (set "bind": "qr" to create an app by scanning a QR code)`)
  }
  init.logger.info({ account: init.account }, 'feishu: no credentials, starting QR app registration')
  let r
  try {
    r = await registerFeishuApp({
      fetch: init.fetch,
      signal: init.signal,
      source: deps.source,
      ...(deps.app ? { app: deps.app } : {}),
      createOnly: deps.createOnly,
      ...(deps.pollIntervalMs ? { intervalMs: deps.pollIntervalMs } : {}),
      timeoutMs: init.options.requestTimeoutMs,
      onUrl(url) {
        init.logger.info({ account: init.account }, 'feishu: registration link ready')
        if (deps.qrConsole) deps.printQr(url)
        if (init.report) init.report({ state: 'waiting_bind', bindUrl: url, detail: '用飞书扫码，一键创建机器人应用' })
        else say(`等待扫码：用飞书扫描 ${url}`, 'warn')
      },
      onExpired() {
        init.logger.info({ account: init.account }, 'feishu: registration link expired, refreshing')
      },
    })
  } catch (err) {
    if (err instanceof FeishuRegisterError && err.code === 'abort') throw new Error('feishu: QR registration cancelled')
    throw new Error(`feishu: QR registration failed: ${(err as Error).message}`)
  }
  const creds: AppCredentials = { appId: r.appId, appSecret: r.appSecret, ...(r.domain === 'lark' ? { domain: 'lark' as const } : {}) }
  deps.bound.set(init.account, creds)
  try {
    const file = await deps.store.save(init.account, creds)
    say(`扫码创建应用成功（App ID ${creds.appId}${r.domain === 'lark' ? '，Lark 国际版' : ''}），凭据已保存到 ${file}`)
  } catch (err) {
    init.logger.warn({ account: init.account, err: (err as Error).message }, 'feishu: failed to save credentials')
    say(`扫码创建应用成功（App ID ${creds.appId}），但凭据保存失败：${(err as Error).message}；重启后需要重新扫码`, 'warn')
  }
  if (deps.authorizeScanner && r.openId) {
    if (init.authorize) {
      init.authorize(r.openId, { admin: true, name: '扫码创建者' })
      say(`已授权扫码人为管理员（feishu:${r.openId}），可以直接私聊机器人`)
    } else say(`网关版本较旧，不能自动授权扫码人：在 gateway.json 的 auth.admins 里加上 "feishu:${r.openId}"`, 'warn')
  }
  init.report?.()
  return creds
}

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

async function create(init: ChannelInit<FeishuOptions>, deps: FeishuDriverDeps): Promise<ChannelConnection> {
  const o = init.options
  const creds = await credentialsFor(init, deps)
  const appId = creds.appId
  const appSecret = creds.appSecret
  const base = BASE[o.domain ?? creds.domain ?? 'feishu']
  const verificationToken = o.verificationToken ? init.secret('verificationToken') : undefined
  const encryptKey = o.encryptKey ? init.secret('encryptKey') : undefined
  if (o.mode === 'webhook' && !verificationToken) throw new Error('feishu: mode "webhook" requires options.verificationToken')
  if (o.encryptKey && !encryptKey) throw new Error('feishu: encryptKey could not be resolved')

  const tokens = new TokenCache(async () => {
    const r = await requestJson<{ code: number; msg: string; tenant_access_token: string; expire: number }>(init.fetch, `${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      body: { app_id: appId, app_secret: appSecret },
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

  /** 处理一个已解密的事件（两种模式共用） */
  const onEvent = (payload: any) => {
    const header = payload?.header
    if (header?.event_type !== 'im.message.receive_v1' || !remember(String(header.event_id))) return
    const ev = payload.event as FeishuMessageEvent
    if (ev?.sender?.sender_type === 'app') return
    const m = toInbound(init.account, ev, botOpenId)
    if (m) init.dispatch(m)
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
      if (!safeEqual(String(payload.token ?? ''), verificationToken!)) return { status: 401 }
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
    if (!header || !safeEqual(String(header.token ?? ''), verificationToken!)) return { status: 401 }
    onEvent(payload)
    // 3 秒内必须应答，处理是异步的
    return json({})
  }

  let ws: FeishuWsClient | undefined
  if (o.mode === 'webhook') await init.webhook(handler)
  else {
    ws = new FeishuWsClient(init, {
      base,
      appId,
      appSecret,
      timeoutMs: o.requestTimeoutMs,
      onEvent: (payload: any) => {
        if (typeof payload?.encrypt === 'string') {
          if (!encryptKey) throw new Error('received an encrypted event but options.encryptKey is not set')
          payload = JSON.parse(decryptFeishu(payload.encrypt, encryptKey))
        }
        onEvent(payload)
      },
    })
  }

  return {
    async start() {
      await ws?.start()
    },
    async stop() {
      await ws?.stop()
    },
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

export function createFeishuDriver(deps: FeishuDriverDeps): ChannelDriver<FeishuOptions> {
  return {
    id: 'feishu',
    name: '飞书 / Lark（扫码创建）',
    description: '飞书自建应用机器人（leo-plugin-gateway-feishu）：飞书扫码一键创建应用或 App ID/App Secret；长连接（默认）或 webhook 收消息',
    options: FeishuOptions,
    secretFields: ['appSecret', 'verificationToken', 'encryptKey'],
    textLimit: 4000,
    receive: 'websocket',
    create: (init) => create(init, deps),
  }
}
