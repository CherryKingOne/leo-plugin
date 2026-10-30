/**
 * 微信公众号机器人（服务号 / 订阅号的「服务器配置」消息推送）。
 *
 * 机器人配置：
 * 1. 微信公众平台 → 设置与开发 → 基本配置：记下 AppID、AppSecret，把服务器 IP 加入 IP 白名单。
 * 2. 服务器配置：URL 填 `<公网地址><basePath>/<account>`（80/443 端口），Token 自定，
 *    消息加解密方式选「明文」或「安全模式」（安全模式需填 EncodingAESKey）。
 *    点击提交时微信会发 GET 校验请求，本驱动自动应答。
 * 3. 回复方式：收到消息立即回 `success`，Agent 处理完后用「客服消息」接口异步发送，
 *    因此需要公众号具备客服消息权限（认证服务号），且只能在用户最近一次发消息后 48 小时内回复。
 *
 * 只支持私聊（公众号没有群聊）。
 */
import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { ChannelHttpError, requestJson, TokenCache } from '../../http.js'
import type { ChannelConnection, ChannelDriver, ChannelInit, InboundMessage, WebhookRequest, WebhookResponse } from '../../types.js'

export const WechatOptions = z.object({
  appId: z.string().min(1).describe('公众号 AppID（wx 开头）'),
  appSecret: z.string().min(1).describe('公众号 AppSecret，写 $WECHAT_APP_SECRET 这样的引用'),
  token: z.string().min(1).describe('服务器配置里的 Token，写引用'),
  encodingAESKey: z.string().optional().describe('安全模式的 EncodingAESKey（43 位），写引用；明文模式不填'),
  apiBase: z.url().default('https://api.weixin.qq.com').describe('接口地址'),
  requestTimeoutMs: z.number().int().positive().default(15_000),
})
export type WechatOptions = z.infer<typeof WechatOptions>

const sha1 = (parts: string[]) => createHash('sha1').update([...parts].sort().join('')).digest('hex')
const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** 明文模式签名：sha1(sort(token, timestamp, nonce)) */
export const signWechat = (token: string, timestamp: string, nonce: string, encrypt?: string) => sha1(encrypt === undefined ? [token, timestamp, nonce] : [token, timestamp, nonce, encrypt])

/** 安全模式解密：AES-256-CBC，key = base64(EncodingAESKey + '=')，IV = key 前 16 字节，PKCS#7（块大小 32） */
export function decryptWechat(encrypt: string, encodingAESKey: string, appId: string): string {
  const key = Buffer.from(`${encodingAESKey}=`, 'base64')
  if (key.length !== 32) throw new Error('invalid EncodingAESKey')
  const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16))
  decipher.setAutoPadding(false)
  let buf = Buffer.concat([decipher.update(Buffer.from(encrypt, 'base64')), decipher.final()])
  const pad = buf[buf.length - 1] ?? 0
  if (pad < 1 || pad > 32) throw new Error('bad padding')
  buf = buf.subarray(0, buf.length - pad)
  const len = buf.readUInt32BE(16)
  const msg = buf.subarray(20, 20 + len).toString('utf8')
  const from = buf.subarray(20 + len).toString('utf8')
  if (from !== appId) throw new Error('appId mismatch')
  return msg
}

/** 读取微信 XML 的一层字段（<Tag><![CDATA[..]]></Tag> 或 <Tag>..</Tag>） */
export function parseXml(xml: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /<(\w+)>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/\1>/g
  for (let m = re.exec(xml); m; m = re.exec(xml)) out[m[1]!] = m[2] ?? m[3] ?? ''
  return out
}

export function toInbound(account: string, x: Record<string, string>): InboundMessage | undefined {
  if (x.MsgType !== 'text' || !x.FromUserName) return undefined
  return {
    channel: 'wechat',
    account,
    id: x.MsgId ?? `${x.FromUserName}-${x.CreateTime}`,
    chat: { id: x.FromUserName, type: 'direct' },
    sender: { id: x.FromUserName },
    text: x.Content ?? '',
    mentioned: true,
    timestamp: x.CreateTime ? Number(x.CreateTime) * 1000 : Date.now(),
    raw: x,
  }
}

async function create(init: ChannelInit<WechatOptions>): Promise<ChannelConnection> {
  const o = init.options
  const appSecret = init.secret('appSecret')
  const token = init.secret('token')
  const aesKey = o.encodingAESKey ? init.secret('encodingAESKey') : undefined
  if (!appSecret) throw new Error('wechat: appSecret is not configured')
  if (!token) throw new Error('wechat: token is not configured')
  if (o.encodingAESKey && !aesKey) throw new Error('wechat: encodingAESKey could not be resolved')

  const tokens = new TokenCache(async () => {
    // stable_token 不会让其他地方已获取的 token 失效
    const r = await requestJson<{ access_token?: string; expires_in?: number; errcode?: number; errmsg?: string }>(init.fetch, `${o.apiBase}/cgi-bin/stable_token`, {
      body: { grant_type: 'client_credential', appid: o.appId, secret: appSecret },
      timeoutMs: o.requestTimeoutMs,
      label: 'wechat stable_token',
      signal: init.signal,
    })
    if (!r.access_token) throw new ChannelHttpError(`wechat stable_token: errcode ${r.errcode}: ${r.errmsg}`)
    return { token: r.access_token, expiresInSec: r.expires_in ?? 7200 }
  })
  // 启动时取一次 token，尽早发现 AppSecret / IP 白名单错误
  await tokens.get()

  const seen = new Set<string>()
  const remember = (id: string) => {
    if (seen.has(id)) return false
    seen.add(id)
    if (seen.size > 2000) seen.delete(seen.values().next().value as string)
    return true
  }

  const handler = (req: WebhookRequest): WebhookResponse => {
    const q = req.query
    const timestamp = q.get('timestamp') ?? ''
    const nonce = q.get('nonce') ?? ''
    // 服务器地址校验
    if (req.method === 'GET') {
      if (!safeEqual(signWechat(token, timestamp, nonce), q.get('signature') ?? '')) return { status: 401 }
      return { status: 200, body: q.get('echostr') ?? '' }
    }
    let xml = req.body.toString('utf8')
    if (q.get('encrypt_type') === 'aes') {
      if (!aesKey) return { status: 400, body: 'encodingAESKey not configured' }
      const encrypt = parseXml(xml).Encrypt ?? ''
      if (!safeEqual(signWechat(token, timestamp, nonce, encrypt), q.get('msg_signature') ?? '')) return { status: 401 }
      try {
        xml = decryptWechat(encrypt, aesKey, o.appId)
      } catch {
        return { status: 400 }
      }
    } else if (!safeEqual(signWechat(token, timestamp, nonce), q.get('signature') ?? '')) {
      return { status: 401 }
    }
    const fields = parseXml(xml)
    const m = toInbound(init.account, fields)
    if (m && remember(m.id)) init.dispatch(m)
    // 必须 5 秒内应答；回复走客服消息接口
    return { status: 200, body: 'success' }
  }

  await init.webhook(handler)

  return {
    async send(target, message, signal) {
      const call = async () => {
        const at = await tokens.get()
        return requestJson<{ errcode: number; errmsg: string }>(init.fetch, `${o.apiBase}/cgi-bin/message/custom/send?access_token=${encodeURIComponent(at)}`, {
          body: { touser: target.chatId, msgtype: 'text', text: { content: message.text } },
          timeoutMs: o.requestTimeoutMs,
          label: 'wechat custom send',
          signal,
        })
      }
      let r = await call()
      if (r.errcode === 40001 || r.errcode === 42001 || r.errcode === 40014) {
        tokens.invalidate()
        r = await call()
      }
      if (r.errcode !== 0) throw new ChannelHttpError(`wechat custom send: errcode ${r.errcode}: ${r.errmsg}`)
      return { messageIds: [] }
    },
  }
}

export const wechat: ChannelDriver<WechatOptions> = {
  id: 'wechat',
  name: '微信公众号',
  description: '微信公众号服务器配置：明文 / 安全模式收消息，客服消息接口回复',
  options: WechatOptions,
  secretFields: ['appSecret', 'token', 'encodingAESKey'],
  // 客服文本消息按 UTF-8 约 2048 字节计，中文约 600 字
  textLimit: 600,
  receive: 'webhook',
  create,
}
