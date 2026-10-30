import { createCipheriv, createHash, randomBytes, sign, verify } from 'node:crypto'
import { createLeo } from 'leo-agents'
import { afterEach, describe, expect, it } from 'vitest'
import { decryptFeishu, extractText, signFeishu } from '../src/channels/feishu/index.js'
import { qqKeys, signQq, toInbound as qqInbound } from '../src/channels/qq/index.js'
import { toInbound as tgInbound } from '../src/channels/telegram/index.js'
import { decryptWechat, parseXml, signWechat } from '../src/channels/wechat/index.js'
import { createChatChannelsPlugin, type InboundMessage } from '../src/index.js'

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
let port = 18_900 + Math.floor(Math.random() * 500)

/** 按 URL 路由的假 fetch，记录请求 */
function fakeFetch(routes: Record<string, (body: any, url: string) => unknown | Promise<unknown>>) {
  const calls: { url: string; body: any; headers: Record<string, string> }[] = []
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, body, headers: (init?.headers ?? {}) as Record<string, string> })
    const key = Object.keys(routes).find((k) => url.includes(k))
    if (!key) return new Response('{"error":"no route"}', { status: 404 })
    const out = await routes[key]!(body, url)
    if (out instanceof Response) return out
    return new Response(JSON.stringify(out), { status: 200 })
  }) as typeof fetch
  return { impl, calls }
}

async function boot(fetchImpl: typeof fetch, accounts: Record<string, unknown>) {
  port++
  const leo = await createLeo({
    logLevel: 'silent',
    plugins: [[createChatChannelsPlugin({ fetch: fetchImpl }), { accounts, webhook: { port, basePath: '/hook' } }]],
  })
  const received: InboundMessage[] = []
  leo.ctx.on('chat-channels/received', (m) => void received.push(m))
  await tick(30)
  const url = (account: string, q = '') => `http://127.0.0.1:${port}/hook/${account}${q}`
  return { leo, svc: leo.ctx.get('chatChannels'), received, url }
}

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
})

// ------------------------------------------------------------------ Telegram

describe('telegram', () => {
  it('群聊识别 @机器人 并去掉提及；私聊恒为 mentioned', () => {
    const bot = { id: 99, username: 'leo_bot' }
    const g = tgInbound('tg', { message_id: 1, date: 1, chat: { id: -5, type: 'supergroup' }, from: { id: 7, first_name: 'Ann' }, text: '@leo_bot hi', entities: [{ type: 'mention', offset: 0, length: 8 }] }, bot)
    expect(g).toMatchObject({ chat: { id: '-5', type: 'group' }, sender: { id: '7', name: 'Ann' }, text: 'hi', mentioned: true })
    const plain = tgInbound('tg', { message_id: 2, date: 1, chat: { id: -5, type: 'group' }, from: { id: 7 }, text: 'just chatting' }, bot)
    expect(plain?.mentioned).toBe(false)
    const dm = tgInbound('tg', { message_id: 3, date: 1, chat: { id: 7, type: 'private' }, from: { id: 7 }, text: 'yo' }, bot)
    expect(dm).toMatchObject({ chat: { type: 'direct' }, mentioned: true })
  })

  it('长轮询收消息并用 sendMessage 回复；token 不出现在状态里', async () => {
    let served = false
    const f = fakeFetch({
      '/getMe': () => ({ ok: true, result: { id: 99, username: 'leo_bot' } }),
      '/deleteWebhook': () => ({ ok: true, result: true }),
      '/getUpdates': async () => {
        if (served) {
          await tick(50)
          return { ok: true, result: [] }
        }
        served = true
        return { ok: true, result: [{ update_id: 10, message: { message_id: 5, date: 1, chat: { id: 42, type: 'private' }, from: { id: 42, first_name: 'Bo' }, text: 'hello' } }] }
      },
      '/sendMessage': () => ({ ok: true, result: { message_id: 6 } }),
    })
    process.env.TG_TEST_TOKEN = '123:SECRET'
    const { leo, svc, received } = await boot(f.impl, { tg: { channel: 'telegram', options: { botToken: '$TG_TEST_TOKEN', pollTimeoutSec: 1 } } })
    cleanup.push(() => leo.dispose())
    await tick(80)
    expect(svc.accounts()[0]).toMatchObject({ state: 'running' })
    expect(received[0]).toMatchObject({ channel: 'telegram', chat: { id: '42' }, text: 'hello' })
    expect(f.calls.find((c) => c.url.includes('/getUpdates') && c.body.offset === 11)).toBeDefined()
    await svc.send('tg', { chatId: '42' }, { text: 'hi back', replyTo: '5' })
    const sent = f.calls.find((c) => c.url.includes('/sendMessage'))!
    expect(sent.url).toContain('/bot123:SECRET/sendMessage')
    expect(sent.body).toMatchObject({ chat_id: '42', text: 'hi back', reply_parameters: { message_id: 5 } })
    expect(JSON.stringify(svc.accounts())).not.toContain('SECRET')
    delete process.env.TG_TEST_TOKEN
  })
})

// ------------------------------------------------------------------ 飞书

function encryptFeishu(plain: string, key: string): string {
  const k = createHash('sha256').update(key).digest()
  const iv = randomBytes(16)
  const c = createCipheriv('aes-256-cbc', k, iv)
  return Buffer.concat([iv, c.update(plain, 'utf8'), c.final()]).toString('base64')
}

describe('feishu', () => {
  it('加解密与消息内容解析', () => {
    expect(decryptFeishu(encryptFeishu('{"a":1}', 'k'), 'k')).toBe('{"a":1}')
    expect(extractText('text', '{"text":"@_user_1 hi"}')).toBe('@_user_1 hi')
    expect(extractText('post', JSON.stringify({ title: 'T', content: [[{ tag: 'text', text: 'line' }]] }))).toBe('T\nline')
    expect(extractText('image', '{}')).toBeUndefined()
  })

  it('url_verification、签名校验、事件去重、回复', async () => {
    const f = fakeFetch({
      '/tenant_access_token/internal': () => ({ code: 0, msg: 'ok', tenant_access_token: 't-1', expire: 7200 }),
      '/bot/v3/info': () => ({ code: 0, msg: 'ok', bot: { open_id: 'ou_bot', app_name: 'Leo' } }),
      '/reply': () => ({ code: 0, msg: 'ok', data: { message_id: 'om_reply' } }),
    })
    const encryptKey = 'enc-key'
    const { leo, svc, received, url } = await boot(f.impl, {
      fs: { channel: 'feishu', options: { appId: 'cli_x', appSecret: 's', verificationToken: 'vt', encryptKey } },
    })
    cleanup.push(() => leo.dispose())
    expect(svc.accounts()[0]).toMatchObject({ state: 'running', webhookPath: '/hook/fs' })

    const post = async (payload: unknown, sign = true) => {
      const body = JSON.stringify({ encrypt: encryptFeishu(JSON.stringify(payload), encryptKey) })
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (sign) {
        headers['x-lark-request-timestamp'] = '1700000000'
        headers['x-lark-request-nonce'] = 'n1'
        headers['x-lark-signature'] = signFeishu('1700000000', 'n1', encryptKey, body)
      }
      return fetch(url('fs'), { method: 'POST', body, headers })
    }

    const v = await post({ type: 'url_verification', token: 'vt', challenge: 'c-123' }, false)
    expect(await v.json()).toEqual({ challenge: 'c-123' })
    expect((await post({ type: 'url_verification', token: 'wrong', challenge: 'x' }, false)).status).toBe(401)

    const event = {
      schema: '2.0',
      header: { event_id: 'e1', event_type: 'im.message.receive_v1', token: 'vt' },
      event: {
        sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
        message: { message_id: 'om_1', chat_id: 'oc_g', chat_type: 'group', message_type: 'text', content: '{"text":"@_user_1 你好"}', mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Leo' }] },
      },
    }
    expect((await post(event, false)).status).toBe(401)
    expect((await post(event)).status).toBe(200)
    expect((await post(event)).status).toBe(200) // 重推
    await tick()
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ chat: { id: 'oc_g', type: 'group' }, sender: { id: 'ou_user' }, text: '你好', mentioned: true })

    await svc.send('fs', { chatId: 'oc_g', chatType: 'group' }, { text: 'hi', replyTo: 'om_1' })
    const reply = f.calls.find((c) => c.url.includes('/messages/om_1/reply'))!
    expect(reply.body).toEqual({ msg_type: 'text', content: '{"text":"hi"}' })
    expect(reply.headers.authorization).toBe('Bearer t-1')
  })
})

// ------------------------------------------------------------------ 微信公众号

function encryptWechat(msg: string, aesKey: string, appId: string): string {
  const key = Buffer.from(`${aesKey}=`, 'base64')
  const body = Buffer.from(msg)
  const len = Buffer.alloc(4)
  len.writeUInt32BE(body.length)
  let buf = Buffer.concat([randomBytes(16), len, body, Buffer.from(appId)])
  const pad = 32 - (buf.length % 32)
  buf = Buffer.concat([buf, Buffer.alloc(pad, pad)])
  const c = createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
  c.setAutoPadding(false)
  return Buffer.concat([c.update(buf), c.final()]).toString('base64')
}

describe('wechat', () => {
  const aesKey = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'

  it('XML 解析与安全模式解密', () => {
    expect(parseXml('<xml><A><![CDATA[x<y]]></A><B>12</B></xml>')).toEqual({ A: 'x<y', B: '12' })
    expect(decryptWechat(encryptWechat('<xml/>', aesKey, 'wxapp'), aesKey, 'wxapp')).toBe('<xml/>')
    expect(() => decryptWechat(encryptWechat('<xml/>', aesKey, 'other'), aesKey, 'wxapp')).toThrow(/appId/)
  })

  it('服务器校验、明文与安全模式收消息、客服消息回复', async () => {
    const f = fakeFetch({
      '/cgi-bin/stable_token': () => ({ access_token: 'AT', expires_in: 7200 }),
      '/cgi-bin/message/custom/send': () => ({ errcode: 0, errmsg: 'ok' }),
    })
    const { leo, svc, received, url } = await boot(f.impl, { wx: { channel: 'wechat', options: { appId: 'wxapp', appSecret: 's', token: 'tok', encodingAESKey: aesKey } } })
    cleanup.push(() => leo.dispose())
    expect(svc.accounts()[0]!.state).toBe('running')

    const ts = '1700000000'
    const nonce = 'n'
    const sig = signWechat('tok', ts, nonce)
    const echo = await fetch(url('wx', `?signature=${sig}&timestamp=${ts}&nonce=${nonce}&echostr=E1`))
    expect(await echo.text()).toBe('E1')
    expect((await fetch(url('wx', `?signature=bad&timestamp=${ts}&nonce=${nonce}&echostr=E1`))).status).toBe(401)

    const xml = (id: string, text: string) => `<xml><ToUserName><![CDATA[gh]]></ToUserName><FromUserName><![CDATA[openid-1]]></FromUserName><CreateTime>1700000000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${text}]]></Content><MsgId>${id}</MsgId></xml>`
    const plain = await fetch(url('wx', `?signature=${sig}&timestamp=${ts}&nonce=${nonce}`), { method: 'POST', body: xml('1', '明文') })
    expect(await plain.text()).toBe('success')

    const enc = encryptWechat(xml('2', '加密'), aesKey, 'wxapp')
    const msig = signWechat('tok', ts, nonce, enc)
    const safe = await fetch(url('wx', `?signature=${sig}&timestamp=${ts}&nonce=${nonce}&encrypt_type=aes&msg_signature=${msig}`), { method: 'POST', body: `<xml><ToUserName><![CDATA[gh]]></ToUserName><Encrypt><![CDATA[${enc}]]></Encrypt></xml>` })
    expect(await safe.text()).toBe('success')
    await tick()
    expect(received.map((m) => m.text)).toEqual(['明文', '加密'])

    await svc.send('wx', { chatId: 'openid-1' }, { text: '收到' })
    const send = f.calls.find((c) => c.url.includes('/custom/send'))!
    expect(send.url).toContain('access_token=AT')
    expect(send.body).toEqual({ touser: 'openid-1', msgtype: 'text', text: { content: '收到' } })
  })
})

// ------------------------------------------------------------------ QQ

describe('qq', () => {
  it('事件转换：单聊 / 群 @ / 频道', () => {
    expect(qqInbound('q', 'C2C_MESSAGE_CREATE', { id: 'm', content: 'hi', author: { user_openid: 'U' } })).toMatchObject({ chat: { id: 'U', type: 'direct', extra: { kind: 'c2c' } } })
    expect(qqInbound('q', 'GROUP_AT_MESSAGE_CREATE', { id: 'm', content: ' hi', group_openid: 'G', author: { member_openid: 'M' } })).toMatchObject({ chat: { id: 'G', type: 'group' }, sender: { id: 'M' }, text: 'hi' })
    expect(qqInbound('q', 'AT_MESSAGE_CREATE', { id: 'm', content: '<@!123> hi', channel_id: 'C', author: { id: 'A' } })?.text).toBe('hi')
    expect(qqInbound('q', 'GUILD_CREATE', { id: 'm' })).toBeUndefined()
  })

  it('op=13 回调校验、Ed25519 签名校验、被动回复带 msg_id/msg_seq', async () => {
    const secret = 'naOC0ocQE3shWLAfffVLB1rhYPG7'
    const f = fakeFetch({
      'bots.qq.com/app/getAppAccessToken': () => ({ access_token: 'QT', expires_in: '7200' }),
      '/v2/groups/G/messages': () => ({ id: 'sent-1', timestamp: 1 }),
    })
    const { leo, svc, received, url } = await boot(f.impl, { qqbot: { channel: 'qq', options: { appId: '1', appSecret: secret } } })
    cleanup.push(() => leo.dispose())
    expect(svc.accounts()[0]!.state).toBe('running')
    const { privateKey, publicKey } = qqKeys(secret)

    const v = await fetch(url('qqbot'), { method: 'POST', body: JSON.stringify({ op: 13, d: { plain_token: 'P', event_ts: '1725442341' } }) })
    const vr = (await v.json()) as { plain_token: string; signature: string }
    expect(vr.plain_token).toBe('P')
    expect(verify(null, Buffer.from('1725442341P'), publicKey, Buffer.from(vr.signature, 'hex'))).toBe(true)

    const body = JSON.stringify({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', id: 'ev1', d: { id: 'msg-1', content: ' 在吗', group_openid: 'G', author: { member_openid: 'M' }, timestamp: '2026-10-30T10:00:00+08:00' } })
    const ts = '1725442341'
    const good = await fetch(url('qqbot'), { method: 'POST', body, headers: { 'x-signature-ed25519': signQq(privateKey, ts + body), 'x-signature-timestamp': ts } })
    expect(await good.json()).toEqual({ op: 12 })
    const forged = await fetch(url('qqbot'), { method: 'POST', body, headers: { 'x-signature-ed25519': sign(null, Buffer.from('x'), privateKey).toString('hex'), 'x-signature-timestamp': ts } })
    expect(forged.status).toBe(401)
    await tick()
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ chat: { id: 'G', type: 'group' }, text: '在吗' })

    const m = received[0]!
    await svc.send('qqbot', { chatId: m.chat.id, chatType: m.chat.type, ...(m.chat.extra ? { extra: m.chat.extra } : {}) }, { text: 'a', replyTo: 'msg-1' })
    await svc.send('qqbot', { chatId: m.chat.id, chatType: m.chat.type, ...(m.chat.extra ? { extra: m.chat.extra } : {}) }, { text: 'b', replyTo: 'msg-1' })
    const sends = f.calls.filter((c) => c.url.includes('/v2/groups/G/messages'))
    expect(sends.map((s) => s.body)).toEqual([
      { content: 'a', msg_type: 0, msg_id: 'msg-1', msg_seq: 1 },
      { content: 'b', msg_type: 0, msg_id: 'msg-1', msg_seq: 2 },
    ])
    expect(sends[0]!.headers.authorization).toBe('QQBot QT')
  })
})
