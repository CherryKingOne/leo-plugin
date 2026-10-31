import { createCipheriv, createHash, randomBytes, sign, verify } from 'node:crypto'
import { createLeo } from 'leo-agents'
import { afterEach, describe, expect, it } from 'vitest'
import { decryptFeishu, extractText, signFeishu } from '../src/channels/feishu/index.js'
import { decodeFrame, encodeFrame, type Frame } from '../src/channels/feishu/frame.js'
import { qqKeys, signQq, toInbound as qqInbound } from '../src/channels/qq/index.js'
import { toInbound as tgInbound } from '../src/channels/telegram/index.js'
import { createGatewayPlugin, type InboundMessage } from '../src/index.js'

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

async function boot(fetchImpl: typeof fetch, accounts: Record<string, unknown>, WebSocketImpl?: typeof WebSocket) {
  port++
  const leo = await createLeo({
    logLevel: 'silent',
    plugins: [
      [
        createGatewayPlugin({ fetch: fetchImpl, ...(WebSocketImpl ? { WebSocket: WebSocketImpl } : {}) }),
        { channels: accounts, server: { port, hooksPath: '/hook' }, auth: { allowAll: true }, agent: { errorReply: '' } },
      ],
    ],
  })
  const received: InboundMessage[] = []
  leo.ctx.on('gateway/message', ({ message }) => void received.push(message))
  await tick(30)
  const url = (account: string, q = '') => `http://127.0.0.1:${port}/hook/${account}${q}`
  const gw = leo.ctx.get('gateway')
  // 测试辅助：与 chat-channels 时代的 send(account, target, message) 同形
  const svc = {
    accounts: () => gw.accounts(),
    send: (account: string, target: { chatId: string; chatType?: 'direct' | 'group' | 'channel'; extra?: Record<string, string> }, m: { text: string; replyTo?: string }) =>
      gw.send({ account, ...target, ...(m.replyTo ? { replyTo: m.replyTo } : {}) }, m.text),
  }
  return { leo, svc, received, url }
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
    const { leo, svc, received } = await boot(f.impl, { tg: { channel: 'telegram', botToken: '$TG_TEST_TOKEN', pollTimeoutSec: 1 } })
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
      fs: { channel: 'feishu', options: { mode: 'webhook', appId: 'cli_x', appSecret: 's', verificationToken: 'vt', encryptKey } },
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


/** 测试用 WebSocket：模拟飞书长连接服务端 */
class FakeWS {
  static instances: FakeWS[] = []
  binaryType = 'blob'
  readyState = 0
  sent: Frame[] = []
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null
  onclose: ((ev: { code: number }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  constructor(readonly url: string) {
    FakeWS.instances.push(this)
    setTimeout(() => {
      this.readyState = 1
      this.onopen?.({})
    }, 0)
  }
  send(data: Uint8Array) {
    this.sent.push(decodeFrame(data))
  }
  close(code = 1000) {
    if (this.readyState === 3) return
    this.readyState = 3
    setTimeout(() => this.onclose?.({ code }), 0)
  }
  push(f: Frame) {
    const bytes = encodeFrame(f)
    this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer })
  }
}

describe('feishu 长连接', () => {
  it('帧编解码往返（含 uint64）', () => {
    const f: Frame = { seqId: 2n ** 63n + 5n, logId: 1n, service: 7, method: 1, headers: { type: 'event', sum: '1' }, payload: new TextEncoder().encode('{}') }
    const back = decodeFrame(encodeFrame(f))
    expect(back).toMatchObject({ seqId: f.seqId, logId: 1n, service: 7, method: 1, headers: { type: 'event', sum: '1' } })
    expect(new TextDecoder().decode(back.payload)).toBe('{}')
  })

  it('无需公网：取 endpoint、ping、分片事件合并、ACK、断线重连', async () => {
    FakeWS.instances = []
    const f = fakeFetch({
      '/callback/ws/endpoint': (body) => {
        expect(body).toEqual({ AppID: 'cli_x', AppSecret: 's' })
        return { code: 0, msg: 'ok', data: { URL: `wss://ws.feishu.test/ws?device_id=d&service_id=7&n=${FakeWS.instances.length}`, ClientConfig: { PingInterval: 120 } } }
      },
      '/tenant_access_token/internal': () => ({ code: 0, msg: 'ok', tenant_access_token: 't-1', expire: 7200 }),
      '/bot/v3/info': () => ({ code: 0, msg: 'ok', bot: { open_id: 'ou_bot', app_name: 'Leo' } }),
    })
    const { leo, svc, received } = await boot(f.impl, { fsws: { channel: 'feishu', options: { appId: 'cli_x', appSecret: 's' } } }, FakeWS as unknown as typeof WebSocket)
    cleanup.push(() => leo.dispose())
    expect(svc.accounts()[0]).toMatchObject({ state: 'running' })
    expect(svc.accounts()[0]!.webhookPath).toBeUndefined()
    const ws = FakeWS.instances[0]!
    expect(ws.sent[0]).toMatchObject({ method: 0, service: 7, headers: { type: 'ping' } })

    const event = JSON.stringify({
      schema: '2.0',
      header: { event_id: 'e-ws-1', event_type: 'im.message.receive_v1' },
      event: { sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' }, message: { message_id: 'om_9', chat_id: 'oc_p', chat_type: 'p2p', message_type: 'text', content: '{"text":"长连接你好"}' } },
    })
    const bytes = new TextEncoder().encode(event)
    const half = Math.floor(bytes.length / 2)
    const frame = (seq: number, payload: Uint8Array): Frame => ({ seqId: 3n, logId: 4n, service: 7, method: 1, headers: { type: 'event', message_id: 'mid', sum: '2', seq: String(seq) }, payload })
    ws.push(frame(1, bytes.slice(half)))
    expect(received).toHaveLength(0)
    ws.push(frame(0, bytes.slice(0, half)))
    await tick()
    expect(received[0]).toMatchObject({ channel: 'feishu', chat: { id: 'oc_p', type: 'direct' }, text: '长连接你好' })
    const ack = ws.sent.find((s) => s.method === 1)!
    expect(ack.headers.message_id).toBe('mid')
    expect(JSON.parse(new TextDecoder().decode(ack.payload))).toEqual({ code: 200 })

    // 服务端断开：重新取 endpoint 再连
    ws.close(1006)
    await tick(1700)
    expect(FakeWS.instances).toHaveLength(2)
    expect(f.calls.filter((c) => c.url.includes('/callback/ws/endpoint'))).toHaveLength(2)
    expect(svc.accounts()[0]!.state).toBe('running')
  })

  it('endpoint 拒绝（未开启长连接）时账号 failed', async () => {
    const f = fakeFetch({
      '/callback/ws/endpoint': () => ({ code: 1000040343, msg: 'app has not enabled long connection' }),
      '/tenant_access_token/internal': () => ({ code: 0, msg: 'ok', tenant_access_token: 't-1', expire: 7200 }),
      '/bot/v3/info': () => ({ code: 0, msg: 'ok', bot: { open_id: 'ou_bot' } }),
    })
    const { leo, svc } = await boot(f.impl, { fsws: { channel: 'feishu', options: { appId: 'cli_x', appSecret: 's' } } }, FakeWS as unknown as typeof WebSocket)
    cleanup.push(() => leo.dispose())
    expect(svc.accounts()[0]).toMatchObject({ state: 'failed' })
    expect(svc.accounts()[0]!.error).toMatch(/long connection/)
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
    const { leo, svc, received, url } = await boot(f.impl, { qqbot: { channel: 'qq', options: { mode: 'webhook', appId: '1', appSecret: secret } } })
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

// ------------------------------------------------------------------ QQ 长连接

/** 测试用 WebSocket：模拟 QQ 网关（Hello → Identify/Resume → READY/RESUMED） */
class QqFakeWS {
  static instances: QqFakeWS[] = []
  /** 收到 Identify 时用这个关闭码断开（模拟 4014 / 4914） */
  static rejectIdentify: number | undefined
  readyState = 0
  sent: any[] = []
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: ((ev: { code: number }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  constructor(readonly url: string) {
    QqFakeWS.instances.push(this)
    setTimeout(() => {
      this.readyState = 1
      this.onopen?.({})
      this.push({ op: 10, d: { heartbeat_interval: 30_000 } })
    }, 0)
  }
  send(data: string) {
    const p = JSON.parse(data)
    this.sent.push(p)
    setTimeout(() => {
      if (p.op === 2) {
        if (QqFakeWS.rejectIdentify) return this.close(QqFakeWS.rejectIdentify)
        this.push({ op: 0, s: 1, t: 'READY', d: { session_id: 'sess-1', user: { username: 'leo' } } })
      }
      if (p.op === 6) this.push({ op: 0, s: p.d.seq + 1, t: 'RESUMED', d: '' })
    }, 0)
  }
  close(code = 1000) {
    if (this.readyState === 3) return
    this.readyState = 3
    setTimeout(() => this.onclose?.({ code }), 0)
  }
  push(p: unknown) {
    this.onmessage?.({ data: JSON.stringify(p) })
  }
}

describe('QQ 长连接', () => {
  const qqFetch = () =>
    fakeFetch({
      'bots.qq.com/app/getAppAccessToken': () => ({ access_token: 'QT', expires_in: '7200' }),
      '/gateway': () => ({ url: 'wss://api.sgroup.qq.com/websocket' }),
    })
  const qqWs = QqFakeWS as unknown as typeof WebSocket

  it('identify、收事件、断线后 resume 补发', async () => {
    QqFakeWS.instances = []
    QqFakeWS.rejectIdentify = undefined
    const f = qqFetch()
    const { leo, svc, received } = await boot(f.impl, { qqws: { channel: 'qq', options: { appId: '1', appSecret: 's' } } }, qqWs)
    cleanup.push(() => leo.dispose())
    expect(svc.accounts()[0]).toMatchObject({ state: 'running' })
    expect(svc.accounts()[0]!.webhookPath).toBeUndefined()
    const ws = QqFakeWS.instances[0]!
    expect(ws.sent[0]).toEqual({
      op: 2,
      d: expect.objectContaining({ token: 'QQBot QT', intents: ((1 << 25) | (1 << 30)) >>> 0, shard: [0, 1] }),
    })

    ws.push({ op: 0, s: 2, t: 'GROUP_AT_MESSAGE_CREATE', id: 'ev', d: { id: 'm-1', content: ' 你好', group_openid: 'G', author: { member_openid: 'U' } } })
    await tick()
    expect(received[0]).toMatchObject({ channel: 'qq', chat: { id: 'G', type: 'group' }, sender: { id: 'U' }, text: '你好' })

    // 服务端要求重连：保留 session，新连接发 Resume 带最近的 seq
    ws.push({ op: 7 })
    await tick(1700)
    const ws2 = QqFakeWS.instances[1]!
    expect(ws2.sent[0]).toEqual({ op: 6, d: { token: 'QQBot QT', session_id: 'sess-1', seq: 2 } })
    expect(svc.accounts()[0]!.state).toBe('running')
  })

  it('无权限的 intent（4014）：启动失败并给出原因', async () => {
    QqFakeWS.instances = []
    QqFakeWS.rejectIdentify = 4014
    const { leo, svc } = await boot(qqFetch().impl, { qqws: { channel: 'qq', options: { appId: '1', appSecret: 's', events: ['guild_dm'] } } }, qqWs)
    cleanup.push(() => leo.dispose())
    expect(svc.accounts()[0]).toMatchObject({ state: 'failed' })
    expect(svc.accounts()[0]!.error).toMatch(/4014/)
    expect(QqFakeWS.instances[0]!.sent[0].d.intents).toBe(1 << 12)
    QqFakeWS.rejectIdentify = undefined
  })

  it('运行中被下架（4914）：账号进入 failed，不再重连', async () => {
    QqFakeWS.instances = []
    QqFakeWS.rejectIdentify = undefined
    const { leo, svc } = await boot(qqFetch().impl, { qqws: { channel: 'qq', options: { appId: '1', appSecret: 's' } } }, qqWs)
    cleanup.push(() => leo.dispose())
    QqFakeWS.instances[0]!.close(4914)
    await tick(50)
    expect(svc.accounts()[0]).toMatchObject({ state: 'failed' })
    expect(svc.accounts()[0]!.error).toMatch(/sandbox/)
    await tick(1700)
    expect(QqFakeWS.instances).toHaveLength(1)
  })
})
