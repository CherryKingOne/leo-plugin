import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Context, createLeo, type PluginLike } from 'leo-agents'
import { createGatewayPlugin, type GatewayService } from 'leo-plugin-gateway'
import { afterEach, describe, expect, it } from 'vitest'
import plugin, { createGatewayQqPlugin, CredentialStore, escapeStored, type QrConnector, resolveStored, toInbound } from '../src/index.js'

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition')
    await tick(10)
  }
}

/** 假 QQ 开放平台：记录 token 请求用的 appId */
function qqFetch() {
  const tokenCalls: { appId: string; clientSecret: string }[] = []
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('bots.qq.com/app/getAppAccessToken')) {
      tokenCalls.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ access_token: 'QT', expires_in: '7200' }))
    }
    if (url.endsWith('/gateway')) return new Response(JSON.stringify({ url: 'wss://api.sgroup.qq.com/websocket' }))
    return new Response('{}', { status: 404 })
  }) as typeof fetch
  return { impl, tokenCalls }
}

class QqFakeWS {
  static instances: QqFakeWS[] = []
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
      if (p.op === 2) this.push({ op: 0, s: 1, t: 'READY', d: { session_id: 'sess-1', user: { username: 'leo' } } })
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

type Callbacks = Parameters<QrConnector['startQrConnect']>[0]
type Options = NonNullable<Parameters<QrConnector['startQrConnect']>[1]>

/** 假扫码 SDK：测试里手动触发显示 / 过期 / 成功 / 失败 */
function fakeConnector() {
  const sessions: { cb: Callbacks; opts: Options; stopped: boolean }[] = []
  let n = 0
  const connector: QrConnector = {
    startQrConnect(cb, opts = {}) {
      const s = { cb, opts, stopped: false }
      sessions.push(s)
      setTimeout(() => !s.stopped && cb.onQrDisplayed?.(`https://q.qq.com/qqbot/openclaw/connect.html?task_id=t${++n}&source=${opts.source}`), 0)
      return () => {
        s.stopped = true
        // 与真实 SDK 一样：取消后回调 onFailure("已取消")
        cb.onFailure(new Error('已取消'))
      }
    },
  }
  const last = () => sessions.at(-1)!
  return {
    connector,
    sessions,
    last,
    expire: () => {
      last().cb.onQrExpired?.()
      last().cb.onQrDisplayed?.(`https://q.qq.com/qqbot/openclaw/connect.html?task_id=t${++n}&source=${last().opts.source}`)
    },
    succeed: (appId = '102000001', appSecret = 'S3cretFromQr') => last().cb.onSuccess([{ appId, appSecret }]),
    fail: (msg: string) => last().cb.onFailure(new Error(msg)),
  }
}

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
})

interface BootOptions {
  channels?: Record<string, unknown>
  builtin?: string[]
  order?: 'qq-first' | 'gateway-first'
  credentialsFile?: string
  connector?: QrConnector
  extra?: PluginLike[]
}

async function boot(o: BootOptions = {}) {
  QqFakeWS.instances = []
  const f = qqFetch()
  const dir = await mkdtemp(join(tmpdir(), 'gwqq-'))
  const credentialsFile = o.credentialsFile ?? join(dir, 'credentials.json')
  const sdk = fakeConnector()
  const notices: { plugin: string; message: string; level?: string }[] = []
  const listener = { name: 'notice-listener', apply: (c: Context<any>) => void c.on('plugin/notice' as never, ((n: { plugin: string; message: string; level?: string }) => void notices.push(n)) as never) } as PluginLike
  const gw: [PluginLike, unknown] = [
    createGatewayPlugin({ fetch: f.impl, WebSocket: QqFakeWS as unknown as typeof WebSocket }) as PluginLike,
    { loadConfigFiles: false, server: { port: 0 }, channels: o.channels ?? { qq: { channel: 'qq' } }, ...(o.builtin ? { builtin: o.builtin } : {}) },
  ]
  const qq: [PluginLike, unknown] = [createGatewayQqPlugin({ connector: o.connector ?? sdk.connector }) as PluginLike, { credentialsFile }]
  const leo = await createLeo({ logLevel: 'silent', plugins: [listener, ...(o.extra ?? []), ...(o.order === 'gateway-first' ? [gw, qq] : [qq, gw])] })
  cleanup.push(() => leo.dispose())
  const service = () => leo.ctx.get('gateway') as GatewayService
  const account = (id = 'qq') => service().accounts().find((a) => a.account === id)!
  return { leo, f, sdk, notices, credentialsFile, service, account, dir }
}

describe('加载', () => {
  it('无配置可加载；没有网关时等待 gateway 服务（pending）', async () => {
    const leo = await createLeo({ logLevel: 'silent' })
    const rt = await leo.kernel.root.plugin(plugin)
    expect(rt.state).toBe('pending')
    await leo.dispose()
  })

  it.each(['qq-first', 'gateway-first'] as const)('配置了 appId/appSecret：顶替内置 qq 驱动并正常连接（%s）', async (order) => {
    const { f, service, account } = await boot({ order, channels: { qq: { channel: 'qq', appId: '1001', appSecret: 'cfg-secret' } } })
    await until(() => account().state === 'running')
    expect(service().channels().find((c) => c.id === 'qq')).toMatchObject({ name: 'QQ 机器人（扫码绑定）', builtin: false, overridesBuiltin: true })
    expect(f.tokenCalls.at(-1)).toEqual({ appId: '1001', clientSecret: 'cfg-secret' })
    expect(QqFakeWS.instances.at(-1)!.sent[0].d.properties.$browser).toBe('leo-plugin-gateway-qq')
  })

  it('卸载子插件后恢复内置驱动；再次加载又顶替回来，工具随之注册 / 撤销', async () => {
    const { leo, service, account } = await boot({ channels: { qq: { channel: 'qq', appId: '1001', appSecret: 'cfg-secret' } } })
    await until(() => account().state === 'running')
    expect(leo.ctx.get('tools').get('gateway_qq_bind')).toBeDefined()
    const rt = leo.kernel.plugins.find((p) => p.name === 'leo-plugin-gateway-qq')!
    await rt.dispose()
    expect(leo.ctx.get('tools').get('gateway_qq_bind')).toBeUndefined()
    await until(() => service().channels().find((c) => c.id === 'qq')?.builtin === true)
    await until(() => account().state === 'running') // 内置驱动用同一份配置连上
    await leo.plugin(createGatewayQqPlugin({ connector: fakeConnector().connector }) as PluginLike, { credentialsFile: join(tmpdir(), 'none.json') })
    await until(() => service().channels().find((c) => c.id === 'qq')?.builtin === false)
    await until(() => account().state === 'running')
    expect(leo.ctx.get('tools').get('gateway_qq_bind')).toBeDefined()
  })

  it('事件转换与内置驱动一致', () => {
    expect(toInbound('a', 'C2C_MESSAGE_CREATE', { id: 'm', content: 'hi', author: { user_openid: 'U' } })).toMatchObject({ channel: 'qq', chat: { id: 'U', type: 'direct' }, text: 'hi' })
  })
})

describe('扫码绑定', () => {
  it('没有凭据：waiting_bind + 二维码链接（状态、/v1/channels、提示）；过期刷新；扫码成功后保存凭据（0600）并连接', async () => {
    const { sdk, notices, credentialsFile, service, account, f } = await boot({ builtin: ['telegram', 'feishu'] })
    await until(() => account().state === 'waiting_bind')
    expect(sdk.last().opts).toMatchObject({ displayQrCodeToConsole: false, source: 'leo' })
    expect(sdk.last().opts.signal).toBeInstanceOf(AbortSignal)
    expect(account()).toMatchObject({ state: 'waiting_bind', bindUrl: expect.stringContaining('task_id=t1&source=leo'), detail: expect.stringContaining('扫码') })
    const port = service().address()!.port
    const ch = (await (await fetch(`http://127.0.0.1:${port}/v1/channels`)).json()) as { accounts: { bindUrl?: string }[] }
    expect(ch.accounts[0]!.bindUrl).toContain('task_id=t1')
    expect(notices.some((n) => n.message.includes('qq 等待绑定') && n.message.includes('task_id=t1'))).toBe(true)

    sdk.expire()
    await until(() => account().bindUrl?.includes('task_id=t2') === true)
    expect(notices.some((n) => n.message.includes('task_id=t2'))).toBe(true)

    sdk.succeed('102000001', '$weird!secret')
    await until(() => account().state === 'running')
    expect(account().bindUrl).toBeUndefined()
    expect(f.tokenCalls.at(-1)).toEqual({ appId: '102000001', clientSecret: '$weird!secret' })
    const saved = JSON.parse(await readFile(credentialsFile, 'utf8'))
    expect(saved).toEqual({ 'gateway/qq/appId': '102000001', 'gateway/qq/appSecret': '$$weird!secret' })
    expect((await stat(credentialsFile)).mode & 0o777).toBe(0o600)
    expect(notices.some((n) => n.message.includes('扫码绑定成功（AppID 102000001）') && !n.message.includes('weird'))).toBe(true)
  })

  it('凭据已保存：重启后直接连接，不再扫码；保留文件里的其他凭据', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gwqq-'))
    const file = join(dir, 'credentials.json')
    await writeFile(file, JSON.stringify({ openai: 'sk-x', 'gateway/qq/appId': '2002', 'gateway/qq/appSecret': 'from-file' }))
    const { sdk, account, f } = await boot({ credentialsFile: file })
    await until(() => account().state === 'running')
    expect(sdk.sessions).toHaveLength(0)
    expect(f.tokenCalls.at(-1)).toEqual({ appId: '2002', clientSecret: 'from-file' })
  })

  it('扫码失败：账号 failed 并给出原因', async () => {
    const { sdk, account } = await boot()
    await until(() => account().state === 'waiting_bind')
    sdk.fail('获取绑定任务失败: HTTP 500')
    await until(() => account().state === 'failed')
    expect(account().error).toBe('qq: QR binding failed: 获取绑定任务失败: HTTP 500')
  })

  it('等待扫码时卸载子插件 / 网关：停止 SDK 轮询（signal abort），账号交还内置驱动', async () => {
    const { leo, sdk, account } = await boot()
    await until(() => account().state === 'waiting_bind')
    const s = sdk.last()
    await leo.kernel.plugins.find((p) => p.name === 'leo-plugin-gateway-qq')!.dispose()
    expect(s.stopped).toBe(true)
    expect(s.opts.signal!.aborted).toBe(true)
    // 内置驱动没有扫码：缺 appId 直接失败
    await until(() => account().state === 'failed')
    expect(account().error).toMatch(/invalid options for qq/)

    const b = await boot({ builtin: [] })
    await until(() => b.account().state === 'waiting_bind')
    const s2 = b.sdk.last()
    await b.leo.kernel.plugins.find((p) => p.name === 'leo-plugin-gateway')!.dispose()
    expect(s2.stopped).toBe(true)
  })

  it('bind: "off" 时没有凭据直接失败', async () => {
    const { sdk, account } = await boot({ channels: { qq: { channel: 'qq', bind: 'off' } } })
    await until(() => account().state === 'failed')
    expect(account().error).toMatch(/appId is not configured/)
    expect(sdk.sessions).toHaveLength(0)
  })
})

describe('重新绑定', () => {
  it('gateway_qq_bind 返回二维码链接，扫码后用新凭据连接；控制面 rebind 同样触发', async () => {
    const { leo, sdk, account, f, service, credentialsFile } = await boot({ channels: { qq: { channel: 'qq', appId: '1001', appSecret: 'old' } } })
    await until(() => account().state === 'running')
    const tool = leo.ctx.get('tools').get('gateway_qq_bind')!
    expect(tool.permissions).toEqual([{ kind: 'gateway.bind', sideEffect: true }])
    const out = (await tool.execute({}, { signal: new AbortController().signal } as never)) as { content: string; isError?: boolean }
    expect(out.isError).toBeUndefined()
    expect(out.content).toContain('task_id=t1')
    expect(account().state).toBe('waiting_bind')
    sdk.succeed('3003', 'new-secret')
    await until(() => account().state === 'running')
    expect(f.tokenCalls.at(-1)).toEqual({ appId: '3003', clientSecret: 'new-secret' })
    expect(JSON.parse(await readFile(credentialsFile, 'utf8'))['gateway/qq/appId']).toBe('3003')

    const port = service().address()!.port
    const r = (await (await fetch(`http://127.0.0.1:${port}/v1/channels/qq/restart`, { method: 'POST', body: '{"rebind":true}' })).json()) as { state: string; bindUrl: string }
    expect(r).toMatchObject({ state: 'waiting_bind', bindUrl: expect.stringContaining('task_id=t2') })

    const bad = (await tool.execute({ account: 'nope' }, { signal: new AbortController().signal } as never)) as { isError?: boolean }
    expect(bad.isError).toBe(true)
  })

  it('聊天里的 Agent 不能调用 gateway_qq_bind', async () => {
    const { leo, service } = await boot({ channels: { qq: { channel: 'qq', appId: '1', appSecret: 's' } } })
    const gw = service() as GatewayService & { sessionOfAgent(id: string): string | undefined }
    const original = gw.sessionOfAgent
    gw.sessionOfAgent = (id) => (id === 'chat-agent' ? 'qq:qq:direct:U' : original(id))
    const payload = (agentId: string) => ({ tool: leo.ctx.get('tools').get('gateway_qq_bind')!, args: {}, agentId, callId: 'c', sessionId: 's' }) as never
    expect(await leo.ctx.bail('tools/guard', payload('chat-agent'))).toEqual({ deny: 'QQ binding can only be started by the operator' })
    expect(await leo.ctx.bail('tools/guard', payload('cli-agent'))).toBeUndefined()
  })
})

describe('凭据文件', () => {
  it('转义与解析与 leo credentials.json 一致；项目级已有键时写项目级', async () => {
    expect(escapeStored('abc')).toBe('abc')
    expect(escapeStored('$x')).toBe('$$x')
    expect(escapeStored('!x')).toBe('$!x')
    expect(resolveStored('$$x')).toBe('$x')
    expect(resolveStored('$!x')).toBe('!x')
    process.env.GWQQ_TEST_SECRET = 'env-v'
    expect(resolveStored('$GWQQ_TEST_SECRET')).toBe('env-v')
    const dir = await mkdtemp(join(tmpdir(), 'gwqq-'))
    const project = join(dir, 'p.json')
    const user = join(dir, 'u.json')
    const store = CredentialStore.from({ projectCredentials: project, userCredentials: user })
    expect(await store.save('a', { appId: '1', appSecret: 's1' })).toBe(user)
    await writeFile(project, JSON.stringify({ 'gateway/b/appSecret': 'old' }))
    expect(await store.save('b', { appId: '2', appSecret: 's2' })).toBe(project)
    expect(await store.get('a')).toEqual({ appId: '1', appSecret: 's1' })
    expect(await store.get('b')).toEqual({ appId: '2', appSecret: 's2' })
  })
})

describe('qrConsole auto', () => {
  it('leo serve 下打印二维码，交互式 leo 不打印', async () => {
    const { isLeoServe } = await import('../src/index.js')
    expect(isLeoServe(['serve'])).toBe(true)
    expect(isLeoServe(['-y', 'serve'])).toBe(true)
    expect(isLeoServe([])).toBe(false)
    expect(isLeoServe(['-p', 'hi'])).toBe(false)
  })
})
