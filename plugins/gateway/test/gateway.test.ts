import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { approvalPolicy, type Context, createLeo, type LlmRequest, MockProvider, type MockResponse, type PluginLike } from 'leo-agents'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import plugin, { type ChannelDriver, createGatewayPlugin, type GatewayService, type GatewayStreamEvent, type InboundMessage, mergeConfig, parseCommand, sessionKey, stripJsonc } from '../src/index.js'

// biome-ignore lint/suspicious/noExplicitAny: 测试里读 JSON 响应
const json = async (p: Promise<Response>): Promise<any> => (await p).json()
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition')
    await tick(10)
  }
}
let port = 19_400 + Math.floor(Math.random() * 400)

/** 测试用平台驱动：记录发出的消息，暴露 dispatch */
function fakeDriver(id = 'fake') {
  const sent: { chatId: string; text: string; replyTo?: string }[] = []
  let dispatch: ((m: InboundMessage) => void) | undefined
  const driver: ChannelDriver<{ token?: string }> = {
    id,
    name: 'Fake',
    options: z.object({ token: z.string().optional() }),
    textLimit: 4000,
    create(init) {
      dispatch = init.dispatch
      return {
        async send(target, msg) {
          sent.push({ chatId: target.chatId, text: msg.text, ...(msg.replyTo ? { replyTo: msg.replyTo } : {}) })
          return { messageIds: [String(sent.length)] }
        },
      }
    },
  }
  return { driver, sent, dispatch: (m: InboundMessage) => dispatch!(m), texts: () => sent.map((s) => s.text) }
}

let seq = 0
const msg = (text: string, over: Partial<InboundMessage> & { user?: string; name?: string } = {}): InboundMessage => {
  const { user, name, ...rest } = over
  return {
    channel: 'fake',
    account: 'bot',
    id: `m${++seq}`,
    chat: { id: user ?? 'u1', type: 'direct' },
    sender: { id: user ?? 'u1', ...(name ? { name } : {}) },
    text,
    mentioned: true,
    timestamp: Date.now(),
    ...rest,
  }
}

const lastUser = (req: LlmRequest) => {
  const u = req.messages.filter((m) => m.role === 'user').at(-1)
  return u ? u.content.map((b) => (b.type === 'text' ? b.text : '')).join('') : ''
}

interface BootOptions {
  config?: Record<string, unknown>
  route?: (req: LlmRequest) => MockResponse
  extraPlugins?: PluginLike[]
  withPolicy?: boolean
  factory?: boolean
}

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
})

async function boot(opts: BootOptions = {}) {
  port++
  const f = fakeDriver()
  const mock = new MockProvider({ script: Array.from({ length: 300 }, () => (req: LlmRequest) => (opts.route ?? ((r) => ({ text: `echo:${lastUser(r)}` })))(req)) })
  const executed: string[] = []
  const tools: PluginLike = {
    name: 'test-tools',
    inject: ['tools'],
    async apply(ctx: Context<any>) {
      await ctx.effect(() =>
        ctx.get('tools').register({
          name: 'danger',
          description: 'does something risky',
          parameters: z.object({ command: z.string() }),
          permissions: [{ kind: 'process.exec' }],
          execute: ({ command }) => {
            executed.push(command)
            return `ran ${command}`
          },
        }),
      )
    },
  } as PluginLike
  const factoryPlugin: PluginLike = {
    name: 'fake-host-factory',
    apply(ctx: Context<any>) {
      ctx.provide('agentFactory' as never, {
        defaultModel: 'm',
        systemPrompt: () => 'HOST DEFAULT PROMPT',
        create: (o: Record<string, unknown>) => ctx.get('agentLoop').create({ model: 'm', ...o } as never),
      } as never)
    },
  } as PluginLike
  const config = {
    server: { port: 0 },
    agent: { model: 'm', errorReply: 'ERR {error}' },
    channels: { bot: { channel: 'fake' } },
    ...opts.config,
  }
  const leo = await createLeo({
    logLevel: 'silent',
    providers: [mock],
    plugins: [
      tools,
      ...(opts.withPolicy ? [[approvalPolicy, { mode: 'ask' }] as [PluginLike, unknown]] : []),
      ...(opts.factory ? [factoryPlugin] : []),
      ...(opts.extraPlugins ?? []),
      [plugin, config],
    ],
  })
  cleanup.push(() => leo.dispose())
  const gw = leo.ctx.get('gateway') as GatewayService
  await ctx(gw).registerChannel(f.driver)
  await tick(10)
  const a = gw.address()
  const base = a ? `http://127.0.0.1:${a.port}` : ''
  return { leo, gw, mock, f, executed, base }
}
// registerChannel 返回撤销函数；包一层方便 await
const ctx = (gw: GatewayService) => ({ registerChannel: async (d: ChannelDriver) => void gw.registerChannel(d) })

describe('基础', () => {
  it('parseCommand / sessionKey / mergeConfig / stripJsonc', () => {
    expect(parseCommand('/new')).toEqual({ name: 'new', args: '' })
    expect(parseCommand('/pair@leo_bot  ABC123 ')).toEqual({ name: 'pair', args: 'ABC123' })
    expect(parseCommand('hello /new')).toBeUndefined()
    const opts = { groupPerUser: true, threadPerUser: false }
    expect(sessionKey({ channel: 'telegram', account: 'tg', chatType: 'direct', chatId: '42', userId: '42' }, opts)).toBe('telegram:tg:direct:42')
    expect(sessionKey({ channel: 'telegram', account: 'tg', chatType: 'group', chatId: '-100', userId: '7' }, opts)).toBe('telegram:tg:group:-100:u7')
    expect(sessionKey({ channel: 'telegram', account: 'tg', chatType: 'group', chatId: '-100', userId: '7' }, { ...opts, groupPerUser: false })).toBe('telegram:tg:group:-100')
    expect(sessionKey({ channel: 'telegram', account: 'tg', chatType: 'group', chatId: '-100', threadId: '9', userId: '7' }, opts)).toBe('telegram:tg:group:-100:t9')
    expect(mergeConfig({ server: { port: 1, host: 'a' }, channels: { tg: { botToken: 'x', allowFrom: ['1'] } } }, { server: { port: 2 }, channels: { tg: { allowFrom: ['2'] }, qq: { appId: '1' } } })).toEqual({
      server: { port: 2, host: 'a' },
      channels: { tg: { botToken: 'x', allowFrom: ['2'] }, qq: { appId: '1' } },
    })
    expect(JSON.parse(stripJsonc('{ // c\n "a": "//not", /* x */ "b": [1,2,], }'))).toEqual({ a: '//not', b: [1, 2] })
  })

  it('无配置可加载：内置三个平台、服务、工具；卸载后端口关闭、服务与工具撤销', async () => {
    port++
    const leo = await createLeo({ logLevel: 'silent', plugins: [[plugin, { server: { port } }]] })
    const gw = leo.ctx.get('gateway')
    expect(gw.channels().map((c) => c.id).sort()).toEqual(['feishu', 'qq', 'telegram'])
    expect(leo.ctx.get('tools').get('gateway_send')).toBeDefined()
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200)
    const rt = leo.kernel.plugins.find((p) => p.name === 'leo-plugin-gateway')!
    await rt.dispose()
    expect(leo.ctx.has('gateway')).toBe(false)
    expect(leo.ctx.get('tools').get('gateway_send')).toBeUndefined()
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow()
    await leo.dispose()
  })

  it('非法配置在加载时报错；enabled=false 时不监听端口、只提供空注册层', async () => {
    const leo = await createLeo({ logLevel: 'silent' })
    await expect(leo.plugin(plugin, { sessions: { busy: 'nope' } } as never)).rejects.toThrow(/invalid configuration/)
    await leo.dispose()
    port++
    const leo2 = await createLeo({ logLevel: 'silent', plugins: [[plugin, { enabled: false, server: { port } }]] })
    // 0.2.0：停用时仍提供空的注册层，依赖 gateway 的渠道插件不会卡住宿主
    const off = leo2.ctx.get('gateway')
    expect(off.channels()).toEqual([])
    expect(typeof off.registerChannel(fakeDriver().driver)).toBe('function')
    await expect(off.restartAccount('x')).rejects.toThrow(/disabled/)
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow()
    await leo2.dispose()
  })

  it('监听非本机地址却没有 token 时拒绝启动', async () => {
    const leo = await createLeo({ logLevel: 'silent' })
    await expect(leo.plugin(plugin, { server: { host: '0.0.0.0', port: 0 } } as never)).rejects.toThrow(/without server.token/)
    await leo.dispose()
  })
})

describe('启动提示', () => {
  it('通过 plugin/notice 告诉用户控制面地址和渠道连接状态', async () => {
    const notices: { message: string; level?: string }[] = []
    const listener: PluginLike = { name: 'notice-listener', apply: (c: Context<any>) => void c.on('plugin/notice' as never, ((n: { message: string; level?: string }) => void notices.push(n)) as never) } as PluginLike
    const { gw } = await boot({ extraPlugins: [listener] })
    const port = gw.address()!.port
    expect(notices[0]!.message).toBe(`控制面 http://127.0.0.1:${port}`)
    expect(notices.some((n) => n.message.includes(`ws://127.0.0.1:${port}/ws`) && n.message.includes('/v1/chat/completions'))).toBe(true)
    expect(notices.some((n) => n.message.includes('未设置令牌'))).toBe(true)
    await until(() => notices.some((n) => n.message === '已连接 bot（fake）'))
  })

  it('通配监听列出本机地址；账号失败、恢复、缺驱动各提示一次', async () => {
    const { accountNotifier, controlPlaneLines } = await import('../src/notice.js')
    const ifaces = { eth0: [{ address: '192.168.1.5', family: 'IPv4', internal: false }], lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] } as never
    const lines = controlPlaneLines({ host: '0.0.0.0', port: 18790 }, true, ifaces)
    expect(lines[0]).toBe('控制面监听 0.0.0.0:18790，可访问 http://127.0.0.1:18790、http://192.168.1.5:18790')
    expect(lines[1]).toContain('http://192.168.1.5:18790/v1')
    expect(lines[2]).toContain('Bearer')
    const out: [string, string | undefined][] = []
    const on = accountNotifier((m, l) => void out.push([m, l]), () => 'https://gw.example.com')
    const st = (state: string, extra = {}) => ({ account: 'tg', channel: 'telegram', state, received: 0, sent: 0, ...extra }) as never
    on(st('starting'))
    on(st('running', { webhookPath: '/hooks/tg' }))
    on(st('running'))
    on(st('failed', { error: '401 Unauthorized' }))
    on(st('running'))
    on({ account: 'x', channel: 'slack', state: 'waiting_driver', received: 0, sent: 0 } as never)
    expect(out.map((o) => o[0])).toEqual([
      '已连接 tg（telegram），webhook https://gw.example.com/hooks/tg（平台要能从公网访问到）',
      'tg（telegram） 连接失败：401 Unauthorized',
      '已恢复 tg（telegram）',
      'x（slack） 等待渠道驱动 "slack"：内置只有 telegram / feishu / qq，其他渠道需要安装对应插件',
    ])
    expect(out.map((o) => o[1])).toEqual([undefined, 'error', undefined, 'warn'])
  })
})

describe('授权与配对', () => {
  it('默认拒绝；陌生人私聊拿到配对码，管理员 /pair 批准后可以对话', async () => {
    const { gw, f, mock } = await boot({ config: { auth: { admins: ['fake:boss'] } } })
    f.dispatch(msg('hi', { user: 'stranger', name: 'Stranger' }))
    await until(() => f.sent.length === 1)
    expect(f.texts()[0]).toMatch(/配对码：([A-Z2-9]{6})/)
    const code = /配对码：([A-Z2-9]{6})/.exec(f.texts()[0]!)![1]!
    expect(mock.requests).toHaveLength(0)
    expect(gw.pairing()).toHaveLength(1)

    // 群里的陌生人不打扰
    f.dispatch(msg('hi', { user: 'x', chat: { id: 'g1', type: 'group' } }))
    // 非管理员不能批准
    f.dispatch(msg(`/pair ${code}`, { user: 'stranger' }))
    await tick(50)
    expect(f.sent).toHaveLength(2) // 第二条：再次提示配对码（未授权用户的指令不执行）

    f.dispatch(msg(`/pair ${code}`, { user: 'boss' }))
    await until(() => f.texts().some((t) => t.startsWith('已批准 fake:stranger')))
    expect(f.texts()).toContain('配对成功，现在可以和我对话了。')
    expect(gw.pairedUsers()).toEqual(['fake:stranger'])

    f.dispatch(msg('你好', { user: 'stranger' }))
    await until(() => f.texts().includes('echo:你好'))
    expect(mock.requests).toHaveLength(1)
  })

  it('/whoami 不需要授权；账号 allowFrom 与 auth.allowFrom 放行', async () => {
    const { f } = await boot({ config: { auth: { allowFrom: ['fake:a'] }, channels: { bot: { channel: 'fake', allowFrom: ['b'] } } } })
    f.dispatch(msg('/whoami', { user: 'zz' }))
    await until(() => f.sent.length === 1)
    expect(f.texts()[0]).toContain('fake:zz（未授权）')
    f.dispatch(msg('one', { user: 'a' }))
    f.dispatch(msg('two', { user: 'b' }))
    await until(() => f.texts().includes('echo:one') && f.texts().includes('echo:two'))
  })

  it('pairing=false 时提示把 id 发给管理员；控制面可批准配对', async () => {
    const { f, base } = await boot({ config: { auth: { pairing: false } } })
    f.dispatch(msg('hi', { user: 'p' }))
    await until(() => f.sent.length === 1)
    expect(f.texts()[0]).toContain('fake:p')
    const r = await fetch(`${base}/v1/pairing/approve`, { method: 'POST', body: JSON.stringify({ code: 'NOPE00' }) })
    expect(r.status).toBe(404)
  })
})

describe('会话路由', () => {
  it('同一聊天续接同一会话；群聊默认每人一个会话、共享模式带发送者名字；/new 开新会话', async () => {
    const { gw, f, mock } = await boot({ config: { auth: { allowAll: true } } })
    f.dispatch(msg('first'))
    await until(() => f.texts().includes('echo:first'))
    f.dispatch(msg('second'))
    await until(() => f.texts().includes('echo:second'))
    // 第二轮请求里带着第一轮的历史
    expect(mock.requests[1]!.messages.filter((m) => m.role === 'user')).toHaveLength(2)
    expect(gw.sessions()).toHaveLength(1)
    const firstSession = gw.sessions()[0]!.sessionId

    f.dispatch(msg('g-a', { user: 'a', name: 'Alice', chat: { id: 'g', type: 'group' } }))
    f.dispatch(msg('g-b', { user: 'b', name: 'Bob', chat: { id: 'g', type: 'group' } }))
    await until(() => f.texts().includes('echo:g-a') && f.texts().includes('echo:g-b'))
    expect(gw.sessions().map((s) => s.key).sort()).toEqual(['fake:bot:direct:u1', 'fake:bot:group:g:ua', 'fake:bot:group:g:ub'])

    f.dispatch(msg('/new'))
    await until(() => f.texts().includes('已开始新会话。'))
    f.dispatch(msg('third'))
    await until(() => f.texts().includes('echo:third'))
    const now = gw.sessions().find((s) => s.key === 'fake:bot:direct:u1')!
    expect(now.sessionId).not.toBe(firstSession)
    expect(mock.requests.at(-1)!.messages.filter((m) => m.role === 'user')).toHaveLength(1)
  })

  it('groupPerUser=false：整个群共用一个会话，消息前加 [发送者]', async () => {
    const { gw, f, mock } = await boot({ config: { auth: { allowAll: true }, sessions: { groupPerUser: false } } })
    f.dispatch(msg('hello', { user: 'a', name: 'Alice', chat: { id: 'g', type: 'group' } }))
    await until(() => f.texts().includes('echo:[Alice] hello'))
    expect(gw.sessions().map((s) => s.key)).toEqual(['fake:bot:group:g'])
    expect(mock.requests[0]!.system).toContain('Multi-user conversation')
  })

  it('忙时 queue：按顺序逐条处理；/status；/stop 取消运行中的任务', async () => {
    const { f } = await boot({ config: { auth: { allowAll: true } }, route: (r) => ({ text: `echo:${lastUser(r)}`, delayMs: lastUser(r) === 'slow' ? 60 : 0 }) })
    f.dispatch(msg('slow'))
    f.dispatch(msg('next'))
    await until(() => f.texts().includes('echo:next'))
    expect(f.texts().indexOf('echo:slow')).toBeLessThan(f.texts().indexOf('echo:next'))
    f.dispatch(msg('/status'))
    await until(() => f.texts().some((t) => t.startsWith('会话：fake:bot:direct:u1')))
    expect(f.texts().find((t) => t.startsWith('会话：'))).toContain('轮次：2')
  })

  it('忙时 interrupt：取消当前 turn，直接处理新消息', async () => {
    const { f } = await boot({ config: { auth: { allowAll: true }, sessions: { busy: 'interrupt' } }, route: (r) => ({ text: `echo:${lastUser(r)}`, delayMs: lastUser(r) === 'slow' ? 200 : 0 }) })
    f.dispatch(msg('slow'))
    await tick(30)
    f.dispatch(msg('urgent'))
    await until(() => f.texts().includes('echo:urgent'))
    await tick(50)
    expect(f.texts()).not.toContain('echo:slow')
  })

  it('/stop 停止运行中的任务；排队满时提示', async () => {
    const { f } = await boot({ config: { auth: { allowAll: true }, sessions: { maxQueue: 1 } }, route: (r) => ({ text: `echo:${lastUser(r)}`, delayMs: lastUser(r) === 'slow' ? 300 : 0 }) })
    f.dispatch(msg('slow'))
    await tick(30)
    f.dispatch(msg('q1'))
    f.dispatch(msg('q2'))
    await until(() => f.texts().some((t) => t.includes('排队已满')))
    f.dispatch(msg('/stop'))
    await until(() => f.texts().includes('已停止。'))
    await tick(100)
    expect(f.texts()).not.toContain('echo:slow')
    expect(f.texts()).not.toContain('echo:q1')
  })

  it('优先使用宿主的 agentFactory（默认模型与提示词），再追加网关说明与会话信息', async () => {
    const { f, mock } = await boot({ factory: true, config: { auth: { allowAll: true }, agent: { errorReply: '' }, channels: { bot: { channel: 'fake', prompt: 'ACCOUNT PROMPT' } } } })
    f.dispatch(msg('hi', { name: 'Ann' }))
    await until(() => f.texts().includes('echo:hi'))
    const sys = mock.requests[0]!.system ?? ''
    expect(sys).toContain('HOST DEFAULT PROMPT')
    expect(sys).toContain('# Messaging gateway')
    expect(sys).toContain('User: Ann')
    expect(sys).toContain('ACCOUNT PROMPT')
  })

  it('没有模型时回复错误提示而不是静默', async () => {
    const { f } = await boot({ config: { auth: { allowAll: true }, agent: { model: undefined, errorReply: 'ERR {error}' } } })
    f.dispatch(msg('hi'))
    await until(() => f.sent.length === 1)
    expect(f.texts()[0]).toMatch(/^ERR .*model/)
  })
})

describe('聊天内审批', () => {
  const route = (r: LlmRequest): MockResponse =>
    r.messages.some((m) => m.role === 'tool') ? { text: 'done' } : { toolCalls: [{ id: 't1', name: 'danger', arguments: { command: 'rm -rf /tmp/x' } }] }

  it('副作用工具在聊天里请求 /approve，批准后执行', async () => {
    const { f, executed, gw } = await boot({ withPolicy: true, route, config: { auth: { allowAll: true } } })
    f.dispatch(msg('clean up'))
    await until(() => f.texts().some((t) => t.startsWith('需要你批准')))
    expect(f.texts().find((t) => t.startsWith('需要你批准'))).toContain('danger rm -rf /tmp/x')
    expect(gw.sessions()[0]!.pendingApproval?.tool).toBe('danger')
    f.dispatch(msg('/approve'))
    await until(() => f.texts().includes('done'))
    expect(executed).toEqual(['rm -rf /tmp/x'])
  })

  it('/deny（或回复“拒绝”）则不执行', async () => {
    const { f, executed, mock } = await boot({ withPolicy: true, route, config: { auth: { allowAll: true } } })
    f.dispatch(msg('clean up'))
    await until(() => f.texts().some((t) => t.startsWith('需要你批准')))
    f.dispatch(msg('拒绝'))
    await until(() => f.texts().includes('done'))
    expect(executed).toEqual([])
    const toolMsg = mock.requests.at(-1)!.messages.find((m) => m.role === 'tool')!
    expect(JSON.stringify(toolMsg)).toContain('rejected')
  })

  it('审批超时视为拒绝', async () => {
    const { f, executed } = await boot({ withPolicy: true, route, config: { auth: { allowAll: true }, approval: { timeoutMs: 80 } } })
    f.dispatch(msg('clean up'))
    await until(() => f.texts().includes('审批超时，已拒绝。'))
    await until(() => f.texts().includes('done'))
    expect(executed).toEqual([])
  })

  it('宿主没有审批服务时（leo serve）网关兜底提供，非网关 Agent 一律拒绝', async () => {
    const { leo } = await boot({ withPolicy: true, route })
    expect(leo.ctx.has('approval')).toBe(true)
    const r = await leo.ctx.get('approval').request({ agentId: 'other', tool: { name: 'x' } } as never, new AbortController().signal)
    expect(r.approved).toBe(false)
  })

  it('聊天里的 Agent 不能调用 gateway_pair', async () => {
    const { f, mock, gw } = await boot({
      config: { auth: { allowAll: true } },
      route: (r) => (r.messages.some((m) => m.role === 'tool') ? { text: 'ok' } : { toolCalls: [{ id: 'p', name: 'gateway_pair', arguments: { code: 'ABCDEF' } }] }),
    })
    f.dispatch(msg('approve ABCDEF'))
    await until(() => f.texts().includes('ok'))
    expect(JSON.stringify(mock.requests.at(-1)!.messages.find((m) => m.role === 'tool'))).toContain('operator')
    expect(gw.pairedUsers()).toEqual([])
  })
})

describe('投递', () => {
  it('gateway.send 支持 <account>:<chatId>、home、<account>:home；未知目标报错', async () => {
    const { gw, f } = await boot({ config: { channels: { bot: { channel: 'fake', home: 'H1' } } } })
    await gw.send('bot:c9', 'hello')
    await gw.send('home', 'to home')
    await gw.send('bot:home', 'to home 2')
    expect(f.sent.map((s) => `${s.chatId}=${s.text}`)).toEqual(['c9=hello', 'H1=to home', 'H1=to home 2'])
    await expect(gw.send('nohost', 'x')).rejects.toThrow(/invalid target/)
    await expect(gw.send('ghost:1', 'x')).rejects.toThrow(/unknown account/)
  })

  it('gateway_send 工具声明副作用权限', async () => {
    const { leo } = await boot()
    const tool = leo.ctx.get('tools').get('gateway_send')!
    expect(tool.permissions).toEqual([{ kind: 'gateway.send', sideEffect: true }])
    expect(leo.ctx.get('tools').get('gateway_status')!.permissions).toBeUndefined()
  })
})

describe('控制面', () => {
  it('HTTP：/v1/chat（普通与 SSE）、会话、历史、OpenAI 兼容、/v1/send、/v1/status', async () => {
    const { base, f } = await boot()
    const chat = await json(fetch(`${base}/v1/chat`, { method: 'POST', body: JSON.stringify({ message: 'ping', session_key: 'web-1' }) }))
    expect(chat).toMatchObject({ reason: 'completed', text: 'echo:ping', sessionKey: 'api:api:direct:web-1' })

    const sse = await (await fetch(`${base}/v1/chat`, { method: 'POST', body: JSON.stringify({ message: 'stream me', session_key: 'web-1', stream: true }) })).text()
    expect(sse).toContain('event: delta')
    expect(sse).toContain('event: result')
    expect(sse).toContain('echo:stream me')

    const sessions = await json(fetch(`${base}/v1/sessions`))
    expect(sessions.sessions[0]).toMatchObject({ key: 'api:api:direct:web-1', turns: 2 })
    const hist = await json(fetch(`${base}/v1/sessions/${encodeURIComponent('api:api:direct:web-1')}/messages`))
    expect(hist.messages.map((m: { text: string }) => m.text)).toEqual(['ping', 'echo:ping', 'stream me', 'echo:stream me'])

    const oa = await json(fetch(`${base}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'leo', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'oa' }] }) }))
    expect(oa.choices[0].message.content).toBe('echo:oa')
    const oaStream = await (await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'text', text: 'oas' }] }], stream: true }) })).text()
    expect(oaStream).toContain('"content":"echo:oas"')
    expect(oaStream).toContain('data: [DONE]')

    const sent = await json(fetch(`${base}/v1/send`, { method: 'POST', body: JSON.stringify({ target: 'bot:c1', text: 'from api' }) }))
    expect(sent).toMatchObject({ account: 'bot', chatId: 'c1' })
    expect(f.texts()).toContain('from api')

    const status = await json(fetch(`${base}/v1/status`))
    expect(status).toMatchObject({ name: 'leo-gateway', protocol: 1, sessions: { total: 2 } })
    expect((await fetch(`${base}/v1/nope`)).status).toBe(404)
  })

  it('设置 token 后除 /health 外都要带令牌', async () => {
    process.env.GW_TEST_TOKEN = 's3cret'
    const { base: b } = await boot({ config: { server: { port: 0, token: '$GW_TEST_TOKEN' } } })
    expect((await fetch(`${b}/health`)).status).toBe(200)
    expect((await fetch(`${b}/v1/status`)).status).toBe(401)
    expect((await fetch(`${b}/v1/status`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
    expect((await fetch(`${b}/v1/status`, { headers: { authorization: 'Bearer s3cret' } })).status).toBe(200)
  })

  it('WebSocket：connect 握手、chat.send 推送流式事件、subscribe 收到网关事件', async () => {
    const { base, f } = await boot({ config: { auth: { allowAll: true } } })
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`)
    const frames: any[] = []
    ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)))
    await new Promise((r) => (ws.onopen = r))
    ws.send(JSON.stringify({ type: 'req', id: '1', method: 'connect', params: { client: 'test' } }))
    await until(() => frames.some((x) => x.id === '1'))
    expect(frames.find((x) => x.id === '1')).toMatchObject({ ok: true, payload: { protocol: 1 } })
    ws.send(JSON.stringify({ type: 'req', id: '2', method: 'subscribe' }))
    ws.send(JSON.stringify({ type: 'req', id: '3', method: 'chat.send', params: { message: 'over ws', sessionKey: 'ws-1' } }))
    await until(() => frames.some((x) => x.type === 'event' && x.event === 'chat' && x.payload.type === 'result'))
    const chatEvents = frames.filter((x) => x.event === 'chat').map((x) => x.payload.type)
    expect(chatEvents).toContain('delta')
    expect(frames.find((x) => x.event === 'chat' && x.payload.type === 'result').payload.text).toBe('echo:over ws')
    // 平台消息也会广播给订阅者
    f.dispatch(msg('from platform'))
    await until(() => frames.some((x) => x.event === 'gateway' && x.payload.event === 'gateway/turn-end'))
    ws.send(JSON.stringify({ type: 'req', id: '4', method: 'nope' }))
    await until(() => frames.some((x) => x.id === '4'))
    expect(frames.find((x) => x.id === '4')).toMatchObject({ ok: false, error: { code: 'unknown_method' } })
    ws.close()
  })

  it('WebSocket 第一帧不是 connect、或令牌错误时断开', async () => {
    process.env.GW_TEST_TOKEN = 's3cret'
    const { base } = await boot({ config: { server: { port: 0, token: '$GW_TEST_TOKEN' } } })
    const url = `${base.replace('http', 'ws')}/ws`
    for (const first of [{ type: 'req', id: '1', method: 'status' }, { type: 'req', id: '1', method: 'connect', params: { auth: { token: 'bad' } } }]) {
      const ws = new WebSocket(url)
      await new Promise((r) => (ws.onopen = r))
      const closed = new Promise<number>((r) => (ws.onclose = (e) => r(e.code)))
      ws.send(JSON.stringify(first))
      expect(await closed).toBe(1008)
    }
  })

  it('控制面审批：/v1/sessions/:key/approve', async () => {
    const route = (r: LlmRequest): MockResponse => (r.messages.some((m) => m.role === 'tool') ? { text: 'done' } : { toolCalls: [{ id: 't1', name: 'danger', arguments: { command: 'ls' } }] })
    const { base, f, executed } = await boot({ withPolicy: true, route, config: { auth: { allowAll: true } } })
    f.dispatch(msg('go'))
    await until(() => f.texts().some((t) => t.startsWith('需要你批准')))
    const r = await json(fetch(`${base}/v1/sessions/${encodeURIComponent('fake:bot:direct:u1')}/approve`, { method: 'POST' }))
    expect(r.ok).toBe(true)
    await until(() => f.texts().includes('done'))
    expect(executed).toEqual(['ls'])
  })
})

describe('配置文件与状态', () => {
  it('合并 ~/.leo/gateway.json < .leo/gateway.json < 插件配置；会话映射与配对持久化', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gw-home-'))
    const proj = await mkdtemp(join(tmpdir(), 'gw-proj-'))
    await mkdir(join(proj, '.leo'), { recursive: true })
    port++
    await writeFile(join(home, 'gateway.json'), `// user\n{ "server": { "port": ${port}, "host": "127.0.0.1" }, "auth": { "allowFrom": ["fake:u1"] }, "channels": { "bot": { "channel": "fake", "home": "H" } }, }`)
    await writeFile(join(proj, '.leo', 'gateway.json'), '{ "channels": { "bot": { "home": "H2" } }, "agent": { "model": "m" } }')
    const paths: PluginLike = { name: 'paths', apply: (c: Context<any>) => void c.provide('leoPaths' as never, { cwd: proj, projectRoot: proj, projectDir: join(proj, '.leo'), userDir: home } as never) } as PluginLike
    const f = fakeDriver()
    const mock = new MockProvider({ script: Array.from({ length: 20 }, () => (r: LlmRequest) => ({ text: `echo:${lastUser(r)}` })) })
    const leo = await createLeo({ logLevel: 'silent', providers: [mock], plugins: [paths, [createGatewayPlugin(), { sessions: { busy: 'steer' } }]] })
    const gw = leo.ctx.get('gateway')
    gw.registerChannel(f.driver)
    await tick(10)
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200)
    await gw.send('home', 'x')
    expect(f.sent[0]!.chatId).toBe('H2')
    f.dispatch(msg('persist me'))
    await until(() => f.texts().includes('echo:persist me'))
    await leo.dispose()
    const state = JSON.parse(await readFile(join(proj, '.leo', 'gateway', 'state.json'), 'utf8'))
    expect(Object.keys(state.sessions)).toEqual(['fake:bot:direct:u1'])

    // 重启后同一个聊天继续同一个 leo 会话 id
    const leo2 = await createLeo({ logLevel: 'silent', providers: [mock], plugins: [paths, createGatewayPlugin()] })
    expect(leo2.ctx.get('gateway').sessions()[0]!.sessionId).toBe(state.sessions['fake:bot:direct:u1'].sessionId)
    await leo2.dispose()
  })
})

describe('流式事件', () => {
  it('gateway.chat 的 onEvent 依次收到 start / delta / done', async () => {
    const { gw } = await boot()
    const events: GatewayStreamEvent['type'][] = []
    const r = await gw.chat({ text: 'evt', onEvent: (e) => events.push(e.type) })
    expect(r.text).toBe('echo:evt')
    expect(events[0]).toBe('start')
    expect(events).toContain('delta')
    expect(events.at(-1)).toBe('done')
  })
})
