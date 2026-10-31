/**
 * QQ 官方机器人（QQ 开放平台 q.qq.com）渠道驱动，移植自 leo-plugin-gateway 0.1.x 内置 qq 驱动，增加扫码绑定。
 *
 * 凭据来源（按顺序）：
 * 1. 本进程刚扫码得到的凭据；
 * 2. credentials.json 中的 `gateway/<账号>/appId`、`gateway/<账号>/appSecret`（每次启动重新读文件）；
 * 3. 账号配置里的 `appId` / `appSecret`（支持 `$ENV` / `!command`）。
 * 都没有、且 `bind` 为 `qr`（默认）时进入扫码绑定：账号状态 `waiting_bind` 并给出二维码链接，
 * 手机 QQ 扫码后保存凭据并正常连接。`restartAccount(id, { rebind: true })` 忽略已有凭据重新扫码。
 *
 * 收消息两种方式：
 *
 * - `websocket`（默认，长连接）：机器人主动连 QQ 网关，不需要公网地址、回调配置和 IP 白名单之外的东西。
 *   自动心跳、断线 resume 补发遗漏事件、重连退避。
 * - `webhook`：开发设置 → 回调配置，回调地址填 `<公网 HTTPS><basePath>/<account>`（仅支持 80/443/8080/8443），
 *   勾选事件。保存时平台发 op=13 校验请求，本驱动用 AppSecret 派生的 Ed25519 密钥签名应答；之后每个回调都校验签名。
 *
 * 机器人配置：
 * 1. QQ 开放平台创建机器人，开发设置里记下 AppID、AppSecret（ClientSecret）。
 * 2. 把服务器出口 IP 加入 IP 白名单；上线前可设 sandbox=true 走沙箱环境。
 * 3. 回复：带上原消息 id 的「被动回复」不占主动消息额度（单聊 60 分钟、群聊 5 分钟内有效）；
 *    不带 replyTo 的主动消息有严格的月度额度限制。
 */
import { createPrivateKey, createPublicKey, type KeyObject, sign, verify } from 'node:crypto'
import { z } from 'zod'
import type { ChannelConnection, ChannelDriver, ChannelInit, InboundMessage, WebhookRequest, WebhookResponse } from '../contract.js'
import type { CredentialStore, QqCredentials } from '../credentials.js'
import { ChannelHttpError, requestJson, TokenCache } from '../http.js'
import { type QrConnector, qrBind } from './bind.js'
import { intentsOf, QQ_INTENTS, QqGateway, type QqIntent } from './gateway.js'

export const QqOptions = z.object({
  appId: z.string().min(1).optional().describe('机器人 AppID；不填时扫码绑定'),
  appSecret: z.string().min(1).optional().describe('机器人 AppSecret（ClientSecret），写 $QQ_BOT_SECRET 这样的引用；不填时扫码绑定'),
  /** 没有凭据时：qr = 扫码绑定（默认），off = 直接报错（与内置驱动一致） */
  bind: z.enum(['qr', 'off']).default('qr').describe('没有 appId/appSecret 时的处理：qr = 手机 QQ 扫码绑定（默认），off = 报错'),
  mode: z.enum(['websocket', 'webhook']).default('websocket').describe('收消息方式：websocket = 长连接（默认，无需公网），webhook = HTTP 回调'),
  /**
   * websocket 模式订阅的事件：c2c_group = 单聊与群 @（默认），guild_at = 频道 @（默认），guild_dm = 频道私信（需申请权限）。
   * 订阅了没有权限的事件，网关会以 4014 关闭连接
   */
  events: z
    .array(z.enum(Object.keys(QQ_INTENTS) as [QqIntent, ...QqIntent[]]))
    .min(1)
    .default(['c2c_group', 'guild_at'])
    .describe('websocket 模式订阅的事件：c2c_group / guild_at / guild_dm'),
  sandbox: z.boolean().default(false).describe('使用沙箱环境 sandbox.api.sgroup.qq.com'),
  requestTimeoutMs: z.number().int().positive().default(15_000),
})
export type QqOptions = z.infer<typeof QqOptions>

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

/** 按 QQ 文档由 AppSecret 派生 Ed25519 密钥：secret 重复拼接到至少 32 字节，取前 32 字节作为种子 */
export function qqKeys(secret: string): { privateKey: KeyObject; publicKey: KeyObject } {
  let seed = secret
  while (seed.length < 32) seed += seed
  const privateKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed.slice(0, 32), 'utf8')]), format: 'der', type: 'pkcs8' })
  return { privateKey, publicKey: createPublicKey(privateKey) }
}

export const signQq = (privateKey: KeyObject, message: string | Buffer) => sign(null, Buffer.from(message), privateKey).toString('hex')

type Kind = 'c2c' | 'group' | 'channel' | 'dms'

interface QqEvent {
  id: string
  content?: string
  timestamp?: string
  author?: { id?: string; user_openid?: string; member_openid?: string; username?: string }
  group_openid?: string
  channel_id?: string
  guild_id?: string
}

export function toInbound(account: string, type: string, d: QqEvent): InboundMessage | undefined {
  let kind: Kind
  let chatId: string | undefined
  let senderId: string | undefined
  switch (type) {
    case 'C2C_MESSAGE_CREATE':
      kind = 'c2c'
      chatId = d.author?.user_openid
      senderId = d.author?.user_openid
      break
    case 'GROUP_AT_MESSAGE_CREATE':
      kind = 'group'
      chatId = d.group_openid
      senderId = d.author?.member_openid
      break
    case 'AT_MESSAGE_CREATE':
      kind = 'channel'
      chatId = d.channel_id
      senderId = d.author?.id
      break
    case 'DIRECT_MESSAGE_CREATE':
      kind = 'dms'
      chatId = d.guild_id
      senderId = d.author?.id
      break
    default:
      return undefined
  }
  if (!chatId || !senderId || d.content === undefined) return undefined
  return {
    channel: 'qq',
    account,
    id: d.id,
    chat: { id: chatId, type: kind === 'group' ? 'group' : kind === 'channel' ? 'channel' : 'direct', extra: { kind } },
    sender: { id: senderId, ...(d.author?.username ? { name: d.author.username } : {}) },
    // 去掉频道消息里的 <@!botid> 提及
    text: d.content.replace(/<@!?\d+>/g, '').trim(),
    // 这几类事件本身就意味着用户在和机器人说话（群 / 频道事件只在 @机器人 时推送）
    mentioned: true,
    timestamp: d.timestamp ? Date.parse(d.timestamp) || Date.now() : Date.now(),
    raw: d,
  }
}

export interface QqDriverDeps {
  store: CredentialStore
  connector: QrConnector
  /** 二维码页面上的来源标识 */
  source: string
  /** 同时在控制台打印二维码（leo serve 时方便直接扫） */
  qrConsole: boolean
  /** 本插件实例里扫码得到的凭据（凭据文件写入失败时也能用） */
  bound: Map<string, QqCredentials>
  /** 旧版网关没有 init.notify 时的提示出口 */
  notify(message: string, level?: 'info' | 'warn' | 'error'): void
}

/** 解析凭据；没有时按 bind 选项扫码 */
async function credentialsFor(init: ChannelInit<QqOptions>, deps: QqDriverDeps): Promise<QqCredentials> {
  const say = (m: string, level?: 'info' | 'warn' | 'error') => (init.notify ? init.notify(m, level) : deps.notify(`${init.account}：${m}`, level))
  if (!init.rebind) {
    const mem = deps.bound.get(init.account)
    if (mem) return mem
    const stored = await deps.store.get(init.account)
    const appId = stored.appId ?? init.secret('appId')
    const appSecret = stored.appSecret ?? init.secret('appSecret')
    if (appId && appSecret) return { appId, appSecret }
    if (init.options.bind === 'off') throw new Error(`qq: ${appId ? 'appSecret' : 'appId'} is not configured (set "bind": "qr" to bind by scanning a QR code)`)
  }
  const creds = await qrBind(init, deps.connector, { source: deps.source, qrConsole: deps.qrConsole, say })
  deps.bound.set(init.account, creds)
  try {
    const file = await deps.store.save(init.account, creds)
    say(`扫码绑定成功（AppID ${creds.appId}），凭据已保存到 ${file}`)
  } catch (err) {
    init.logger.warn({ account: init.account, err: (err as Error).message }, 'qq: failed to save bound credentials')
    say(`扫码绑定成功（AppID ${creds.appId}），但凭据保存失败：${(err as Error).message}；重启后需要重新扫码`, 'warn')
  }
  init.report?.()
  return creds
}

async function create(init: ChannelInit<QqOptions>, deps: QqDriverDeps): Promise<ChannelConnection> {
  const o = init.options
  const { appId, appSecret: secret } = await credentialsFor(init, deps)
  const base = o.sandbox ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.sgroup.qq.com'
  const keys = qqKeys(secret)

  const tokens = new TokenCache(async () => {
    const r = await requestJson<{ access_token?: string; expires_in?: string | number; code?: number; message?: string }>(init.fetch, TOKEN_URL, {
      body: { appId, clientSecret: secret },
      timeoutMs: o.requestTimeoutMs,
      label: 'qq getAppAccessToken',
      signal: init.signal,
    })
    if (!r.access_token) throw new ChannelHttpError(`qq getAppAccessToken: code ${r.code}: ${r.message}`)
    return { token: r.access_token, expiresInSec: Number(r.expires_in ?? 7200) }
  })
  await tokens.get()

  const seen = new Set<string>()
  const remember = (id: string) => {
    if (seen.has(id)) return false
    seen.add(id)
    if (seen.size > 2000) seen.delete(seen.values().next().value as string)
    return true
  }
  /** 同一条原消息的多次被动回复需要递增 msg_seq */
  const seq = new Map<string, number>()
  const nextSeq = (msgId: string) => {
    const n = (seq.get(msgId) ?? 0) + 1
    seq.set(msgId, n)
    if (seq.size > 2000) seq.delete(seq.keys().next().value as string)
    return n
  }

  /** 两种模式共用：事件 → 统一消息 */
  const onEvent = (type: string, d: unknown) => {
    if (!d || typeof d !== 'object') return
    const m = toInbound(init.account, type, d as QqEvent)
    if (m && remember(m.id)) init.dispatch(m)
  }

  const json = (obj: unknown): WebhookResponse => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) })

  const handler = (req: WebhookRequest): WebhookResponse => {
    if (req.method !== 'POST') return { status: 405 }
    let payload: { op?: number; t?: string; d?: any; id?: string }
    try {
      payload = JSON.parse(req.body.toString('utf8'))
    } catch {
      return { status: 400 }
    }
    // 回调地址校验
    if (payload.op === 13) {
      const plain = String(payload.d?.plain_token ?? '')
      const ts = String(payload.d?.event_ts ?? '')
      return json({ plain_token: plain, signature: signQq(keys.privateKey, ts + plain) })
    }
    // 事件签名校验：ed25519(timestamp + body)
    const sigHex = req.headers['x-signature-ed25519'] ?? ''
    const ts = req.headers['x-signature-timestamp'] ?? ''
    let ok = false
    try {
      const sig = Buffer.from(sigHex, 'hex')
      ok = sig.length === 64 && verify(null, Buffer.concat([Buffer.from(ts), req.body]), keys.publicKey, sig)
    } catch {
      ok = false
    }
    if (!ok) return { status: 401, body: 'bad signature' }
    if (payload.op === 0 && payload.t && payload.d) onEvent(payload.t, payload.d)
    // HTTP 回调 ACK
    return json({ op: 12 })
  }

  let gateway: QqGateway | undefined
  if (o.mode === 'webhook') await init.webhook(handler)
  else
    gateway = new QqGateway(init, {
      base,
      intents: intentsOf(o.events),
      timeoutMs: o.requestTimeoutMs,
      token: () => tokens.get(),
      invalidateToken: () => tokens.invalidate(),
      onEvent,
    })

  return {
    async start() {
      await gateway?.start()
    },
    async stop() {
      await gateway?.stop()
    },
    async send(target, message, signal) {
      const kind = (target.extra?.kind as Kind | undefined) ?? (target.chatType === 'group' ? 'group' : target.chatType === 'channel' ? 'channel' : 'c2c')
      const id = encodeURIComponent(target.chatId)
      const path = kind === 'c2c' ? `/v2/users/${id}/messages` : kind === 'group' ? `/v2/groups/${id}/messages` : kind === 'channel' ? `/channels/${id}/messages` : `/dms/${id}/messages`
      const v2 = kind === 'c2c' || kind === 'group'
      const body = v2
        ? { content: message.text, msg_type: 0, ...(message.replyTo ? { msg_id: message.replyTo, msg_seq: nextSeq(message.replyTo) } : {}) }
        : { content: message.text, ...(message.replyTo ? { msg_id: message.replyTo } : {}) }
      const call = async () =>
        requestJson<{ id?: string }>(init.fetch, `${base}${path}`, {
          body,
          headers: { authorization: `QQBot ${await tokens.get()}` },
          timeoutMs: o.requestTimeoutMs,
          label: `qq send ${kind}`,
          signal,
        })
      let r: { id?: string }
      try {
        r = await call()
      } catch (err) {
        if (err instanceof ChannelHttpError && err.status === 401) {
          tokens.invalidate()
          r = await call()
        } else throw err
      }
      return { messageIds: r.id ? [r.id] : [] }
    },
  }
}

export function createQqDriver(deps: QqDriverDeps): ChannelDriver<QqOptions> {
  return {
    id: 'qq',
    name: 'QQ 机器人（扫码绑定）',
    description: 'QQ 开放平台官方机器人（leo-plugin-gateway-qq）：手机 QQ 扫码绑定或 AppID/AppSecret；单聊、群 @、频道；长连接（默认）或 Webhook 回调',
    options: QqOptions,
    secretFields: ['appSecret'],
    textLimit: 2000,
    receive: 'websocket',
    create: (init) => create(init, deps),
  }
}
