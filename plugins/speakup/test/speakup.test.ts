import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLeo, type PluginDefinition } from 'leo-agents'
import { describe, expect, it } from 'vitest'
import plugin, {
  buildPrompt,
  clock,
  createSpeakUpPlugin,
  DEFAULT_CONFIG,
  type GatewayLike,
  isAwake,
  matchesTarget,
  normalizeConfig,
  type SessionInfoLike,
  SpeakUp,
  type SpeakUpConfig,
  type StateMap,
} from '../src/index.js'

const MIN = 60_000
// 2026-11-02 12:00 北京时间
const NOON = Date.parse('2026-11-02T04:00:00Z')

function session(key = 'qq:main:direct:U1', over: Partial<SessionInfoLike> = {}): SessionInfoLike {
  const [channel, account, chatType, chatId] = key.split(':') as [string, string, 'direct', string]
  return { key, origin: { channel, account, chatType, chatId, userId: chatId, userName: '小王' }, updatedAt: NOON - 300 * MIN, running: false, queued: 0, ...over }
}

function fakeGateway(sessions: SessionInfoLike[], reply: string | ((text: string) => string) = '在干嘛呀？', images: { url: string; alt?: string }[] = []) {
  const prompts: string[] = []
  const sent: { target: unknown; text: string }[] = []
  const sentImages: { target: unknown; url: string }[] = []
  let fail: Error | undefined
  const gw: GatewayLike = {
    sessions: () => sessions,
    async chat({ text, onEvent }) {
      prompts.push(text)
      for (const img of images) onEvent?.({ type: 'image', ...img })
      return { reason: 'completed', text: typeof reply === 'function' ? reply(text) : reply }
    },
    async send(target, text) {
      if (fail) throw fail
      sent.push({ target, text })
      return { messageIds: ['m'] }
    },
    async sendImage(target, image) {
      sentImages.push({ target, url: image.url })
      return { messageIds: ['i'] }
    },
  }
  return { gw, prompts, sent, sentImages, failWith: (e: Error) => (fail = e) }
}

/** 已经到了下次搭话时间的状态 */
const due = (): StateMap => ({ 'qq:main:direct:U1': { day: '', count: 0, nextAt: 1, lastUserAt: 0, lastBotAt: 0, lastBotText: '', nudgedFor: 0, lastFireAt: 0 } })

function make(opts: { config?: Partial<SpeakUpConfig>; sessions?: SessionInfoLike[]; reply?: string; images?: { url: string }[]; random?: number; state?: StateMap } = {}) {
  let now = NOON
  const cfg: SpeakUpConfig = { ...DEFAULT_CONFIG, timezone: 'Asia/Shanghai', ...opts.config }
  const g = fakeGateway(opts.sessions ?? [session()], opts.reply, opts.images)
  const notices: string[] = []
  const sp = new SpeakUp({
    gateway: () => g.gw,
    config: () => cfg,
    state: opts.state ?? due(),
    now: () => now,
    random: () => opts.random ?? 0,
    notice: (m) => notices.push(m),
  })
  return { sp, g, cfg, notices, advance: (m: number) => (now += m * MIN), at: () => now }
}

describe('配置', () => {
  it('默认值与校验', () => {
    expect(normalizeConfig({})).toEqual(DEFAULT_CONFIG)
    expect(normalizeConfig({ targets: 'qq' }).targets).toEqual(['qq'])
    expect(() => normalizeConfig({ idleMinutes: 0 })).toThrow(/idleMinutes/)
    expect(() => normalizeConfig({ minIntervalMinutes: 50, maxIntervalMinutes: 10 })).toThrow(/maxIntervalMinutes/)
    expect(() => normalizeConfig({ timezone: 'Mars/Base' })).toThrow(/timezone/)
    expect(() => normalizeConfig({ maxPerDay: 1.5 })).toThrow(/maxPerDay/)
  })

  it('时区与清醒时段', () => {
    expect(clock(NOON, 'Asia/Shanghai')).toEqual({ day: '2026-11-02', hour: 12 })
    expect(clock(NOON, 'America/Los_Angeles').hour).toBe(20)
    expect(isAwake(12, 9, 23)).toBe(true)
    expect(isAwake(23, 9, 23)).toBe(false)
    expect(isAwake(1, 22, 2)).toBe(true)
    expect(isAwake(12, 22, 2)).toBe(false)
    expect(isAwake(3, 0, 0)).toBe(true)
  })

  it('目标：默认只找私聊，群聊必须写明', () => {
    const dm = session('qq:main:direct:U1')
    const group = { ...session('qq:main:group:G1'), origin: { ...session().origin, chatType: 'group' as const, chatId: 'G1' } }
    const api = { ...session('api:api:direct:x'), origin: { ...session().origin, channel: 'api' } }
    expect(matchesTarget(dm, [])).toBe(true)
    expect(matchesTarget(group, [])).toBe(false)
    expect(matchesTarget(api, [])).toBe(false)
    expect(matchesTarget(dm, ['qq'])).toBe(true)
    expect(matchesTarget(dm, ['telegram'])).toBe(false)
    expect(matchesTarget(group, ['qq'])).toBe(false)
    expect(matchesTarget(group, ['qq:main:group:G1'])).toBe(true)
  })

  it('提示词', () => {
    expect(buildPrompt({ name: '小王', idleMinutes: 200, angle: 'X' })).toMatch(/【系统提醒，不是小王发的消息】你已经3 个多小时没和小王聊天了.*X.*\[沉默\]/)
    expect(buildPrompt({ name: '小王', idleMinutes: 0, angle: '', nudge: { lastText: '吃了吗？', quietMinutes: 20 } })).toMatch(/你刚才跟小王说「吃了吗？」，小王已经 20 分钟没回了/)
  })
})

describe('主动搭话', () => {
  it('空闲够久、在清醒时段、到时间 → 在原会话跑一轮并主动发出去', async () => {
    const { sp, g } = make()
    const [r] = await sp.tick()
    expect(r).toMatchObject({ status: 'sent', text: '在干嘛呀？' })
    expect(g.prompts[0]).toMatch(/系统提醒，不是小王发的消息/)
    expect(g.sent).toEqual([{ target: { account: 'main', chatId: 'U1', chatType: 'direct' }, text: '在干嘛呀？' }])
    expect(sp.state['qq:main:direct:U1']).toMatchObject({ count: 1, day: '2026-11-02' })
  })

  it('第一次见到会话先排期，不立刻发', async () => {
    const { sp, g, advance } = make({ state: {} })
    expect(await sp.tick()).toEqual([])
    advance(DEFAULT_CONFIG.minIntervalMinutes + 1)
    expect((await sp.tick())[0]?.status).toBe('sent')
    expect(g.sent.length).toBe(1)
  })

  it('[沉默] 不发', async () => {
    const { sp, g } = make({ reply: '[沉默]' })
    expect((await sp.tick())[0]?.status).toBe('silent')
    expect(g.sent).toEqual([])
  })

  it('Agent 发的表情图片一起发出', async () => {
    const { sp, g } = make({ reply: '嘿', images: [{ url: 'https://x/a.png' }] })
    await sp.tick()
    expect(g.sent.map((s) => s.text)).toEqual(['嘿'])
    expect(g.sentImages.map((s) => s.url)).toEqual(['https://x/a.png'])
  })

  it('最近有来往、不在清醒时段、正在对话、群聊时都不找', async () => {
    const recent = make()
    recent.sp.onUserMessage('qq:main:direct:U1', NOON - 10 * MIN)
    expect(await recent.sp.tick()).toEqual([])

    const night = make({ config: { awakeFrom: 13, awakeTo: 23 } })
    expect(await night.sp.tick()).toEqual([])

    const busy = make({ sessions: [session(undefined, { running: true })] })
    expect(await busy.sp.tick()).toEqual([])

    const off = make({ config: { enabled: false } })
    expect(await off.sp.tick()).toEqual([])
  })

  it('间隔与每天上限', async () => {
    const { sp, g, advance } = make({ config: { maxPerDay: 2, minIntervalMinutes: 60, maxIntervalMinutes: 60, idleMinutes: 30, nudge: false } })
    await sp.tick()
    advance(30)
    expect(await sp.tick()).toEqual([]) // 还没到下次时间
    advance(31)
    await sp.tick()
    advance(61)
    expect(await sp.tick()).toEqual([]) // 今天满了
    expect(g.sent.length).toBe(2)
  })

  it('第二天次数清零', async () => {
    const { sp, g, advance } = make({ config: { maxPerDay: 1, minIntervalMinutes: 1, maxIntervalMinutes: 1, awakeFrom: 0, awakeTo: 0 } })
    await sp.tick()
    advance(60)
    expect(await sp.tick()).toEqual([])
    advance(24 * 60)
    await sp.tick()
    expect(g.sent.length).toBe(2)
  })

  it('自己发起的那一轮的 turn-end 不覆盖记录；之后的回复照常记录', async () => {
    let ref: SpeakUp | undefined
    const { sp } = make({
      config: { nudge: false },
      reply: undefined,
    })
    ref = sp
    // 网关在 chat() 返回前发 turn-end（带原始回复，含 [沉默] 等）
    const gw = (sp as unknown as { deps: { gateway: () => GatewayLike } }).deps.gateway()
    const chat = gw.chat.bind(gw)
    gw.chat = async (input) => {
      const r = await chat(input)
      ref!.onTurnEnd('qq:main:direct:U1', '原始回复 [沉默]')
      return r
    }
    await sp.tick()
    const s = sp.state['qq:main:direct:U1']!
    expect(s.lastBotText).toBe('在干嘛呀？')
    sp.onTurnEnd('qq:main:direct:U1', '别的')
    expect(s.lastBotText).toBe('别的')
  })
})

describe('追问', () => {
  it('Agent 问了话、对方 15~40 分钟没回 → 一半概率追一句，每句只追一次', async () => {
    const { sp, g, advance } = make({ random: 0.1 })
    sp.onUserMessage('qq:main:direct:U1', NOON - 5 * MIN)
    sp.onTurnEnd('qq:main:direct:U1', '那你今晚吃什么？')
    advance(10)
    expect(await sp.tick()).toEqual([])
    advance(10)
    const [r] = await sp.tick()
    expect(r?.status).toBe('sent')
    expect(g.prompts[0]).toMatch(/你刚才跟小王说「那你今晚吃什么？」/)
    expect(sp.state['qq:main:direct:U1']!.count).toBe(0) // 不占每天次数
    advance(5)
    expect(await sp.tick()).toEqual([])
  })

  it('概率没中或不是问句就不追', async () => {
    const miss = make({ random: 0.9 })
    miss.sp.onUserMessage('qq:main:direct:U1', NOON - 5 * MIN)
    miss.sp.onTurnEnd('qq:main:direct:U1', '吃了吗')
    miss.advance(20)
    expect(await miss.sp.tick()).toEqual([])

    const plain = make({ random: 0.1 })
    plain.sp.onUserMessage('qq:main:direct:U1', NOON - 5 * MIN)
    plain.sp.onTurnEnd('qq:main:direct:U1', '好的，晚安')
    plain.advance(20)
    expect(await plain.sp.tick()).toEqual([])
  })
})

describe('发送失败', () => {
  it('记日志并提醒一次，不重试', async () => {
    const { sp, g, notices, advance } = make({ config: { minIntervalMinutes: 1, maxIntervalMinutes: 1 } })
    g.failWith(new Error('qq send c2c: code 40034105'))
    expect((await sp.tick())[0]).toMatchObject({ status: 'failed' })
    advance(2)
    await sp.tick()
    expect(notices.length).toBe(1)
    expect(notices[0]).toMatch(/允许主动发送/)
    expect(sp.state['qq:main:direct:U1']!.count).toBe(2)
  })
})

describe('插件', () => {
  function fakeHost(sessions: SessionInfoLike[]) {
    const g = fakeGateway(sessions, '好久不见！')
    const cmds = new Map<string, { run(c: unknown): unknown }>()
    const host: PluginDefinition = {
      name: 'fake-host',
      apply(ctx) {
        ctx.provide('gateway' as never, g.gw as never)
        ctx.provide('commands' as never, { register: (d: { name: string; run(c: unknown): unknown }) => (cmds.set(d.name, d), () => cmds.delete(d.name)) } as never)
      },
    }
    const run = async (args = '') => (await cmds.get('speakup')!.run({ args, argv: args ? args.split(/\s+/) : [] })) as { text: string }
    return { host, g, run, cmds }
  }

  it('加载、监听网关事件、/speakup 状态与立刻发送', async () => {
    const h = fakeHost([session()])
    const leo = await createLeo({ logLevel: 'silent', plugins: [h.host, [createSpeakUpPlugin({ tickMs: 0 }), { loadConfigFiles: false, timezone: 'Asia/Shanghai' }]] })
    const sp = leo.ctx.get('speakup' as never) as unknown as SpeakUp
    leo.ctx.emit('gateway/message' as never, { sessionKey: 'qq:main:direct:U1', message: { timestamp: 123 } } as never)
    leo.ctx.emit('gateway/turn-end' as never, { sessionKey: 'qq:main:direct:U1', text: '嗯嗯？', reason: 'completed' } as never)
    expect(sp.state['qq:main:direct:U1']).toMatchObject({ lastUserAt: 123, lastBotText: '嗯嗯？' })

    expect((await h.run()).text).toMatch(/qq:main:direct:U1（小王） · 今天 0\/10/)
    expect((await h.run('now')).text).toBe('已主动发给 qq:main:direct:U1：好久不见！')
    expect(h.g.sent.length).toBe(1)
    expect((await h.run('now telegram')).text).toMatch(/没有匹配/)
    await leo.dispose()
    expect(h.cmds.size).toBe(0)
  })

  it('读 speakup.json，状态写到 speakup.state.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'speakup-'))
    await writeFile(join(dir, 'speakup.json'), '{\n  // 注释\n  "maxPerDay": 5,\n  "timezone": "Asia/Shanghai",\n}\n')
    const h = fakeHost([session()])
    const paths: PluginDefinition = { name: 'paths', apply: (ctx) => void ctx.provide('leoPaths' as never, { userDir: dir } as never) }
    const leo = await createLeo({ logLevel: 'silent', plugins: [paths, h.host, [createSpeakUpPlugin({ tickMs: 0 }), {}]] })
    expect((await h.run()).text).toMatch(/每天最多 5 次/)
    await h.run('now')
    await new Promise((r) => setTimeout(r, 50))
    const saved = JSON.parse(await readFile(join(dir, 'speakup.state.json'), 'utf8')) as StateMap
    expect(saved['qq:main:direct:U1']?.lastBotText).toBe('好久不见！')
    await leo.dispose()
  })

  it('默认导出', () => {
    expect(plugin.name).toBe('leo-plugin-speakup')
  })
})
