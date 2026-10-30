import { createLeo, type LlmRequest, MockProvider } from 'leo-agents'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import plugin, { type ChannelDriver, type InboundMessage, type OutboundMessage, splitText } from '../src/index.js'

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

/** 测试用渠道驱动：记录发送内容，暴露 dispatch */
function fakeDriver(id = 'fake') {
  const sent: { chatId: string; text: string; replyTo?: string }[] = []
  let dispatch: ((m: InboundMessage) => void) | undefined
  let stopped = 0
  const driver: ChannelDriver<{ token: string; limit?: number }> = {
    id,
    name: 'Fake',
    options: z.object({ token: z.string().min(1), limit: z.number().optional() }),
    textLimit: 10,
    create(init) {
      if (!init.secret('token')) throw new Error('no token')
      dispatch = init.dispatch
      return {
        async send(target, msg) {
          sent.push({ chatId: target.chatId, text: msg.text, ...(msg.replyTo ? { replyTo: msg.replyTo } : {}) })
          return { messageIds: [String(sent.length)] }
        },
        stop: () => void stopped++,
      }
    },
  }
  return { driver, sent, dispatch: (m: InboundMessage) => dispatch?.(m), stopped: () => stopped }
}

const msg = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  channel: 'fake',
  account: 'bot',
  id: 'm1',
  chat: { id: 'c1', type: 'direct' },
  sender: { id: 'u1' },
  text: 'hello',
  mentioned: true,
  timestamp: Date.now(),
  ...over,
})

describe('加载与卸载', () => {
  it('无配置可加载：注册 3 个内置渠道、服务与工具', async () => {
    const leo = await createLeo({ logLevel: 'silent', plugins: [plugin] })
    const svc = leo.ctx.get('chatChannels')
    expect(svc.drivers().map((d) => d.id).sort()).toEqual(['feishu', 'qq', 'telegram'])
    expect(svc.drivers().every((d) => d.builtin)).toBe(true)
    expect(svc.accounts()).toEqual([])
    expect(leo.ctx.get('tools').get('chat_send')?.permissions?.[0]).toMatchObject({ kind: 'chat.send', sideEffect: true })
    expect(leo.ctx.get('tools').get('chat_channels')).toBeDefined()
    await leo.dispose()
  })

  it('卸载后服务与工具被撤销', async () => {
    const leo = await createLeo({ logLevel: 'silent' })
    const rt = await leo.plugin(plugin, {} as never)
    await rt.dispose()
    expect(leo.ctx.has('chatChannels')).toBe(false)
    expect(leo.ctx.get('tools').get('chat_send')).toBeUndefined()
    await leo.dispose()
  })

  it('builtin 可裁剪；tools=false 不注册工具', async () => {
    const leo = await createLeo({ logLevel: 'silent', plugins: [[plugin, { builtin: ['telegram'], tools: false }]] })
    expect(leo.ctx.get('chatChannels').drivers().map((d) => d.id)).toEqual(['telegram'])
    expect(leo.ctx.get('tools').get('chat_send')).toBeUndefined()
    await leo.dispose()
  })

  it('非法配置在加载时报错', async () => {
    const leo = await createLeo({ logLevel: 'silent' })
    await expect(leo.plugin(plugin, { accounts: { Bad_Id: { channel: 'qq' } } } as never)).rejects.toThrow()
    await expect(leo.plugin(plugin, { builtin: ['msn'] } as never)).rejects.toThrow()
    await leo.dispose()
  })

  it('小盒子不是插件：包只默认导出注册层', async () => {
    const mod = await import('../src/index.js')
    expect(mod.default.name).toBe('leo-plugin-chat-channels')
    expect(Object.keys(mod)).not.toContain('telegram')
  })
})

describe('账号生命周期', () => {
  it('配置账号等待驱动注册后自动启动；驱动撤销后回到 waiting_driver', async () => {
    const f = fakeDriver()
    const leo = await createLeo({ logLevel: 'silent', plugins: [[plugin, { builtin: [], accounts: { bot: { channel: 'fake', options: { token: 'x' } } } }]] })
    const svc = leo.ctx.get('chatChannels')
    expect(svc.accounts()[0]).toMatchObject({ account: 'bot', state: 'waiting_driver' })
    const off = svc.registerDriver(f.driver)
    await tick()
    expect(svc.accounts()[0]).toMatchObject({ state: 'running' })
    await off()
    expect(svc.accounts()[0]).toMatchObject({ state: 'waiting_driver' })
    expect(f.stopped()).toBe(1)
    await leo.dispose()
  })

  it('机器人配置不符合渠道 schema 时账号 failed，并指出字段', async () => {
    const f = fakeDriver()
    const leo = await createLeo({ logLevel: 'silent', plugins: [[plugin, { builtin: [] }]] })
    const svc = leo.ctx.get('chatChannels')
    svc.registerDriver(f.driver)
    await svc.addAccount('bot', { channel: 'fake', options: { token: '' } })
    expect(svc.accounts()[0]).toMatchObject({ state: 'failed' })
    expect(svc.accounts()[0]!.error).toMatch(/options\.token/)
    await leo.dispose()
  })

  it('密钥引用从环境变量解析；未设置时启动失败且不泄露值', async () => {
    const f = fakeDriver()
    const leo = await createLeo({ logLevel: 'silent', plugins: [[plugin, { builtin: [] }]] })
    const svc = leo.ctx.get('chatChannels')
    svc.registerDriver(f.driver)
    process.env.CHAT_TEST_TOKEN = 'secret-value'
    await svc.addAccount('ok', { channel: 'fake', options: { token: '$CHAT_TEST_TOKEN' } })
    await svc.addAccount('missing', { channel: 'fake', options: { token: '$CHAT_TEST_MISSING' } })
    const [ok, missing] = svc.accounts()
    expect(ok!.state).toBe('running')
    expect(missing!.state).toBe('failed')
    expect(JSON.stringify(svc.accounts())).not.toContain('secret-value')
    delete process.env.CHAT_TEST_TOKEN
    await leo.dispose()
  })

  it('enabled=false 的账号不启动', async () => {
    const f = fakeDriver()
    const leo = await createLeo({ logLevel: 'silent', plugins: [[plugin, { builtin: [] }]] })
    const svc = leo.ctx.get('chatChannels')
    svc.registerDriver(f.driver)
    await svc.addAccount('bot', { channel: 'fake', enabled: false, options: { token: 'x' } })
    expect(svc.accounts()[0]!.state).toBe('disabled')
    await leo.dispose()
  })
})

describe('收发', () => {
  async function running(account: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
    const f = fakeDriver()
    const leo = await createLeo({ logLevel: 'silent', plugins: [[plugin, { builtin: [], ...extra }]] })
    const svc = leo.ctx.get('chatChannels')
    svc.registerDriver(f.driver)
    await svc.addAccount('bot', { channel: 'fake', options: { token: 'x' }, ...account })
    const received: InboundMessage[] = []
    leo.ctx.on('chat-channels/received', (m) => void received.push(m))
    return { leo, svc, f, received }
  }

  it('发送按渠道 textLimit 分段，只有第一段带 replyTo', async () => {
    const { leo, svc, f } = await running()
    const r = await svc.send('bot', { chatId: 'c1' }, { text: 'aaaa bbbb cccc dddd', replyTo: 'm1' })
    expect(f.sent.map((s) => s.text)).toEqual(['aaaa bbbb', 'cccc dddd'])
    expect(f.sent[0]!.replyTo).toBe('m1')
    expect(f.sent[1]!.replyTo).toBeUndefined()
    expect(r.messageIds).toEqual(['1', '2'])
    await expect(svc.send('nope', { chatId: 'c1' }, { text: 'x' })).rejects.toThrow(/unknown account/)
    await leo.dispose()
  })

  it('群聊默认要求 @机器人；白名单过滤', async () => {
    const { leo, f, received } = await running({ allowFrom: ['u1'] })
    f.dispatch(msg({ id: 'a', chat: { id: 'g', type: 'group' }, mentioned: false }))
    f.dispatch(msg({ id: 'b', chat: { id: 'g', type: 'group' }, mentioned: true }))
    f.dispatch(msg({ id: 'c', sender: { id: 'stranger' } }))
    f.dispatch(msg({ id: 'd', text: '   ' }))
    expect(received.map((m) => m.id)).toEqual(['b'])
    await leo.dispose()
  })

  it('inbound 中间件可以直接回复（不经过 Agent）', async () => {
    const { leo, f } = await running()
    leo.ctx.on('chat-channels/inbound', (p, next) => (p.message.text === '/ping' ? ({ text: 'pong' } satisfies OutboundMessage) : next()))
    f.dispatch(msg({ text: '/ping', id: 'm9' }))
    await tick()
    expect(f.sent).toEqual([{ chatId: 'c1', text: 'pong', replyTo: 'm9' }])
    await leo.dispose()
  })

  it('Agent 桥接：自动回复到原会话，同一会话复用 Agent，默认不给工具', async () => {
    const requests: LlmRequest[] = []
    const mock = new MockProvider({
      script: Array.from({ length: 5 }, () => (req: LlmRequest) => {
        requests.push(req)
        return { text: `echo ${requests.length}` }
      }),
    })
    const f = fakeDriver()
    const leo = await createLeo({ logLevel: 'silent', providers: [mock], plugins: [[plugin, { builtin: [], agent: { enabled: true, model: 'm' } }]] })
    const svc = leo.ctx.get('chatChannels')
    svc.registerDriver(f.driver)
    await svc.addAccount('bot', { channel: 'fake', options: { token: 'x' } })
    f.dispatch(msg({ id: 'x1', text: 'hi' }))
    f.dispatch(msg({ id: 'x2', text: 'again' }))
    await tick(100)
    expect(f.sent).toEqual([
      { chatId: 'c1', text: 'echo 1', replyTo: 'x1' },
      { chatId: 'c1', text: 'echo 2', replyTo: 'x2' },
    ])
    // 第二轮能看到第一轮的历史（同一个会话）
    expect(requests[1]!.messages.filter((m) => m.role === 'user')).toHaveLength(2)
    expect(requests[0]!.tools ?? []).toEqual([])
    expect(requests[0]!.system).toContain('instant-messaging')
    await leo.dispose()
  })

  it('autoReply=false 的账号不交给 Agent', async () => {
    const mock = new MockProvider({ script: [{ text: 'should not happen' }] })
    const f = fakeDriver()
    const leo = await createLeo({ logLevel: 'silent', providers: [mock], plugins: [[plugin, { builtin: [], agent: { enabled: true, model: 'm' } }]] })
    const svc = leo.ctx.get('chatChannels')
    svc.registerDriver(f.driver)
    await svc.addAccount('bot', { channel: 'fake', options: { token: 'x' }, autoReply: false })
    f.dispatch(msg())
    await tick(50)
    expect(f.sent).toEqual([])
    await leo.dispose()
  })
})

describe('splitText', () => {
  it('优先在换行处断开，不切断代理对', () => {
    expect(splitText('ab\ncd\nef', 5)).toEqual(['ab\ncd', 'ef'])
    expect(splitText('😀😀😀', 2)).toEqual(['😀😀', '😀'])
    expect(splitText('', 5)).toEqual([])
  })
})
