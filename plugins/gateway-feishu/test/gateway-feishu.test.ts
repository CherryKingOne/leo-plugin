import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Context, createLeo, type PluginLike } from 'leo-agents'
import { createGatewayPlugin, type GatewayService } from 'leo-plugin-gateway'
import { afterEach, describe, expect, it } from 'vitest'
import plugin, { createGatewayFeishuPlugin, isLeoServe, registrationUrl } from '../src/index.js'
import { decodeFrame, encodeFrame, type Frame } from '../src/feishu/frame.js'

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition')
    await tick(10)
  }
}

type Poll = Record<string, unknown>

/** 假飞书：应用注册（设备授权）+ 开放平台 + 长连接 endpoint */
function feishuFetch() {
  const polls: Poll[] = [] // 依次返回；用完后一直 authorization_pending
  const calls: { url: string; body: any }[] = []
  let begins = 0
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    const raw = init?.body === undefined ? undefined : String(init.body)
    if (url.includes('/oauth/v1/app/registration')) {
      const p = Object.fromEntries(new URLSearchParams(raw))
      calls.push({ url, body: p })
      if (p.action === 'begin') {
        begins++
        return new Response(JSON.stringify({ device_code: `dc${begins}`, verification_uri_complete: `https://open.feishu.cn/page/launcher?user_code=CODE-${begins}`, expires_in: 600, interval: 5 }))
      }
      const next = polls.shift() ?? { error: 'authorization_pending' }
      return new Response(JSON.stringify(next), { status: next.error ? 400 : 200 })
    }
    const body = raw ? JSON.parse(raw) : undefined
    calls.push({ url, body })
    if (url.endsWith('/tenant_access_token/internal')) return new Response(JSON.stringify({ code: 0, msg: 'ok', tenant_access_token: 't-1', expire: 7200 }))
    if (url.endsWith('/bot/v3/info')) return new Response(JSON.stringify({ code: 0, msg: 'ok', bot: { open_id: 'ou_bot', app_name: 'Leo' } }))
    if (url.endsWith('/callback/ws/endpoint')) return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { URL: 'wss://ws.feishu.test/ws?device_id=d&service_id=7', ClientConfig: { PingInterval: 120 } } }))
    return new Response('{}', { status: 404 })
  }) as typeof fetch
  return { impl, polls, calls, begins: () => begins }
}

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

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
})

interface BootOptions {
  channels?: Record<string, unknown>
  credentials?: Record<string, string>
  config?: Record<string, unknown>
}

async function boot(o: BootOptions = {}) {
  FakeWS.instances = []
  const f = feishuFetch()
  const dir = await mkdtemp(join(tmpdir(), 'gwfs-'))
  const credentialsFile = join(dir, 'credentials.json')
  if (o.credentials) await writeFile(credentialsFile, JSON.stringify(o.credentials))
  const printed: string[] = []
  const notices: { plugin: string; message: string; level?: string }[] = []
  const listener = { name: 'notice-listener', apply: (c: Context<any>) => void c.on('plugin/notice' as never, ((n: { plugin: string; message: string; level?: string }) => void notices.push(n)) as never) } as PluginLike
  const gw: [PluginLike, unknown] = [
    createGatewayPlugin({ fetch: f.impl, WebSocket: FakeWS as unknown as typeof WebSocket }) as PluginLike,
    { loadConfigFiles: false, server: { port: 0 }, channels: o.channels ?? { feishu: { channel: 'feishu' } }, builtin: ['telegram'] },
  ]
  const fs: [PluginLike, unknown] = [createGatewayFeishuPlugin({ printQr: (u) => void printed.push(u), pollIntervalMs: 10 }) as PluginLike, { credentialsFile, ...(o.config ?? {}) }]
  const leo = await createLeo({ logLevel: 'silent', plugins: [listener, fs, gw] })
  cleanup.push(() => leo.dispose())
  const service = () => leo.ctx.get('gateway') as GatewayService
  const account = (id = 'feishu') => service().accounts().find((a) => a.account === id)!
  return { leo, f, notices, printed, credentialsFile, service, account }
}

describe('扫码一键创建应用', () => {
  it('没有凭据：waiting_bind + 链接；扫码成功后保存凭据（0600）、连接长连接，扫码人自动成为管理员', async () => {
    const { f, notices, printed, credentialsFile, service, account } = await boot()
    await until(() => account().state === 'waiting_bind')
    const url = new URL(account().bindUrl!)
    expect(url.searchParams.get('user_code')).toBe('CODE-1')
    expect(url.searchParams.get('from')).toBe('sdk')
    expect(url.searchParams.get('source')).toBe('node-sdk/leo')
    expect(url.searchParams.get('tp')).toBe('sdk')
    expect(url.searchParams.get('name')).toBe('{user}的 leo 助手')
    expect(account().detail).toContain('飞书扫码')
    expect(printed).toHaveLength(0) // 测试进程不是 leo serve：只给链接
    expect(notices.some((n) => n.message.includes('等待绑定') && n.message.includes('CODE-1'))).toBe(true)
    const begin = f.calls.find((c) => c.body?.action === 'begin')!
    expect(begin.url).toBe('https://accounts.feishu.cn/oauth/v1/app/registration')
    expect(begin.body).toEqual({ action: 'begin', archetype: 'PersonalAgent', auth_method: 'client_secret', request_user_info: 'open_id' })

    f.polls.push({ error: 'authorization_pending' }, { client_id: 'cli_new', client_secret: '$ecret', user_info: { open_id: 'ou_owner', tenant_brand: 'feishu' } })
    await until(() => account().state === 'running')
    expect(account().bindUrl).toBeUndefined()
    expect(f.calls.find((c) => c.url.endsWith('/tenant_access_token/internal'))!.body).toEqual({ app_id: 'cli_new', app_secret: '$ecret' })
    expect(f.calls.find((c) => c.url.endsWith('/callback/ws/endpoint'))!.body).toEqual({ AppID: 'cli_new', AppSecret: '$ecret' })
    expect(FakeWS.instances).toHaveLength(1)
    expect(JSON.parse(await readFile(credentialsFile, 'utf8'))).toEqual({ 'gateway/feishu/appId': 'cli_new', 'gateway/feishu/appSecret': '$$ecret' })
    expect((await stat(credentialsFile)).mode & 0o777).toBe(0o600)
    expect(service().pairedUsers()).toContain('feishu:ou_owner')
    expect(notices.some((n) => n.message.includes('扫码创建应用成功（App ID cli_new）') && !n.message.includes('ecret'))).toBe(true)
    expect(notices.some((n) => n.message.includes('已授权扫码人为管理员'))).toBe(true)
  })

  it('扫码人发消息不需要配对码：/whoami 显示管理员', async () => {
    const { f, service, account } = await boot()
    await until(() => account().state === 'waiting_bind')
    f.polls.push({ client_id: 'cli_new', client_secret: 's', user_info: { open_id: 'ou_owner' } })
    await until(() => account().state === 'running')
    // 收一条单聊 /whoami：回复走 OpenAPI 发消息
    const ws = FakeWS.instances[0]!
    const event = JSON.stringify({
      schema: '2.0',
      header: { event_id: 'e1', event_type: 'im.message.receive_v1' },
      event: { sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' }, message: { message_id: 'om_1', chat_id: 'oc_p', chat_type: 'p2p', message_type: 'text', content: '{"text":"/whoami"}' } },
    })
    ws.push({ seqId: 1n, logId: 1n, service: 7, method: 1, headers: { type: 'event', message_id: 'm1', sum: '1', seq: '0' }, payload: new TextEncoder().encode(event) })
    await until(() => f.calls.some((c) => c.url.includes('/im/v1/messages')))
    const reply = f.calls.find((c) => c.url.includes('/im/v1/messages'))!
    expect(JSON.parse(reply.body.content).text).toContain('（管理员）')
    expect(service().pairing()).toHaveLength(0)
  })

  it('Lark 国际版租户：切换到 accounts.larksuite.com 轮询，凭据记下 domain，OpenAPI 走 open.larksuite.com', async () => {
    const { f, credentialsFile, account } = await boot()
    await until(() => account().state === 'waiting_bind')
    f.polls.push({ error: 'authorization_pending', user_info: { tenant_brand: 'lark' } }, { client_id: 'cli_l', client_secret: 's', user_info: { open_id: 'ou_l', tenant_brand: 'lark' } })
    await until(() => account().state === 'running')
    const polls = f.calls.filter((c) => c.body?.action === 'poll')
    expect(polls.at(-1)!.url).toBe('https://accounts.larksuite.com/oauth/v1/app/registration')
    expect(f.calls.find((c) => c.url.endsWith('/tenant_access_token/internal'))!.url.startsWith('https://open.larksuite.com/')).toBe(true)
    expect(JSON.parse(await readFile(credentialsFile, 'utf8'))).toMatchObject({ 'gateway/feishu/domain': 'lark' })
  })

  it('链接过期：自动重新生成链接', async () => {
    const { f, account } = await boot()
    await until(() => account().state === 'waiting_bind')
    f.polls.push({ error: 'expired_token' })
    await until(() => account().bindUrl?.includes('CODE-2') === true)
    expect(f.begins()).toBe(2)
  })

  it('用户拒绝：账号 failed 并给出原因', async () => {
    const { f, account } = await boot()
    await until(() => account().state === 'waiting_bind')
    f.polls.push({ error: 'access_denied', error_description: 'denied' })
    await until(() => account().state === 'failed')
    expect(account().error).toContain('用户拒绝了授权')
  })

  it('等待扫码时卸载子插件：停止轮询，账号交还内置驱动（builtin 未启用 feishu 时等待驱动）', async () => {
    const { leo, f, account } = await boot()
    await until(() => account().state === 'waiting_bind')
    await leo.kernel.plugins.find((p) => p.name === 'leo-plugin-gateway-feishu')!.dispose()
    await until(() => account().state === 'waiting_driver')
    const n = f.calls.filter((c) => c.body?.action === 'poll').length
    await tick(80)
    expect(f.calls.filter((c) => c.body?.action === 'poll').length).toBe(n)
  })
})

describe('兼容 0.1.x 写法', () => {
  it('gateway.json 里写 appId / appSecret：直接连接，不扫码', async () => {
    const { f, account } = await boot({ channels: { feishu: { channel: 'feishu', appId: 'cli_old', appSecret: 'old-secret' } } })
    await until(() => account().state === 'running')
    expect(f.begins()).toBe(0)
    expect(f.calls.find((c) => c.url.endsWith('/tenant_access_token/internal'))!.body).toEqual({ app_id: 'cli_old', app_secret: 'old-secret' })
  })

  it('凭据已保存：重启后直接连接，不再扫码', async () => {
    const { f, account } = await boot({ credentials: { 'gateway/feishu/appId': 'cli_saved', 'gateway/feishu/appSecret': 'x', other: 'keep' } })
    await until(() => account().state === 'running')
    expect(f.begins()).toBe(0)
    expect(f.calls.find((c) => c.url.endsWith('/tenant_access_token/internal'))!.body).toEqual({ app_id: 'cli_saved', app_secret: 'x' })
  })

  it('bind: "off" 时没有凭据直接失败', async () => {
    const { f, account } = await boot({ channels: { feishu: { channel: 'feishu', bind: 'off' } } })
    await until(() => account().state === 'failed')
    expect(account().error).toContain('appId is not configured')
    expect(f.begins()).toBe(0)
  })
})

describe('其他', () => {
  it('rebind：忽略已保存凭据重新扫码', async () => {
    const { f, service, account } = await boot({ credentials: { 'gateway/feishu/appId': 'cli_saved', 'gateway/feishu/appSecret': 'x' } })
    await until(() => account().state === 'running')
    const s = await service().restartAccount('feishu', { rebind: true })
    expect(s.state).toBe('waiting_bind')
    expect(f.begins()).toBe(1)
  })

  it('registrationUrl：预填信息与 createOnly', () => {
    const u = new URL(registrationUrl('https://open.feishu.cn/page/launcher?user_code=A', { source: 'x', app: { name: 'n', desc: 'd', avatar: ['https://a/1.png', 'https://a/2.png'] }, createOnly: true }))
    expect(u.searchParams.get('source')).toBe('node-sdk/x')
    expect(u.searchParams.getAll('avatar')).toEqual(['https://a/1.png', 'https://a/2.png'])
    expect(u.searchParams.get('createOnly')).toBe('true')
    expect(u.searchParams.get('user_code')).toBe('A')
  })

  it('isLeoServe 与默认导出', () => {
    expect(isLeoServe(['serve'])).toBe(true)
    expect(isLeoServe(['-y', 'hello'])).toBe(false)
    expect(plugin.name).toBe('leo-plugin-gateway-feishu')
  })
})
