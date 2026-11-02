import { createLeo, MockProvider, type MockStep, type PluginDefinition } from 'leo-agents'
import { describe, expect, it } from 'vitest'
import interaction, { Interaction, interpolate, normalizeConfig, type InteractionRegistry, type StickerPack } from '../src/index.js'

const pack: StickerPack = {
  id: 'whale',
  name: '鲸鱼娘表情',
  variants: [
    { id: 'blue', name: '蓝鲸娘' },
    { id: 'black', name: '黑鲸娘' },
  ],
  stickers: [
    { id: 'tests-passed', text: '测试通过！', triggers: ['测试通过'], assets: { blue: { image: 'https://x/b.png', ansi: ['B'] }, black: { image: 'https://x/k.png', ansi: () => ['K'] } } },
    { id: 'hot-update', text: '热更新成功，进程没了', visibility: 'agent', assets: { blue: { ansi: ['H'] } } },
  ],
}

const child = (persona = true): PluginDefinition => ({
  name: 'child',
  inject: ['interaction' as never],
  async apply(ctx) {
    const reg = ctx.get('interaction' as never) as unknown as InteractionRegistry
    if (persona) await ctx.effect(() => reg.registerPersona({ id: 'whale', name: '鲸鱼娘', prompt: '你是鲸鱼娘，模型 {{model}}，目录 {{cwd}}' }))
    await ctx.effect(() => reg.registerStickerPack(pack))
  },
})

/** 假的 commands 服务（leo-agents ≥ 0.2.1 才有真的） */
function fakeCommands() {
  const defs = new Map<string, { run(c: unknown): unknown }>()
  const plugin: PluginDefinition = {
    name: 'fake-commands',
    apply(ctx) {
      ctx.provide('commands' as never, { register: (d: { name: string; run(c: unknown): unknown }) => (defs.set(d.name, d), () => defs.delete(d.name)) } as never)
    },
  }
  const run = async (name: string, args = '') =>
    (await defs.get(name)!.run({ args, argv: args ? args.split(/\s+/) : [], surface: 'cli' })) as { text?: string; display?: unknown[]; prompt?: string }
  return { plugin, run, defs }
}

async function setup(script: MockStep[], options: Record<string, unknown> = {}, withPersona = true) {
  const mock = new MockProvider({ script, models: [{ id: 'm', contextWindow: 32_000 }] })
  const cmds = fakeCommands()
  const leo = await createLeo({
    logLevel: 'silent',
    providers: [mock],
    plugins: [cmds.plugin, [interaction, { loadConfigFiles: false, ...options }], child(withPersona)],
  })
  return { leo, mock, cmds }
}

describe('interaction registry', () => {
  it('validates config and fills defaults', () => {
    expect(normalizeConfig({})).toEqual({
      persona: 'auto',
      stickers: { enabled: true, variant: '', hidden: true, maxPerTurn: 1, display: 'art', userPrompt: true },
    })
    expect(() => normalizeConfig({ stickers: { display: 'gif' } })).toThrow(/stickers.display/)
    expect(() => normalizeConfig({ stickers: { maxPerTurn: -1 } })).toThrow(/maxPerTurn/)
  })

  it('resolves refs, visibility and variants', () => {
    const reg = new Interaction(normalizeConfig({}))
    reg.registerStickerPack(pack)
    expect(reg.send('tests-passed', 'user')).toMatchObject({ text: '测试通过！', variant: 'blue', image: 'https://x/b.png', sender: 'user' })
    expect(reg.send('whale:tests-passed', 'agent', 'black')).toMatchObject({ variant: 'black', image: 'https://x/k.png' })
    expect(() => reg.send('hot-update', 'user')).toThrow(/不能由用户发送/)
    expect(reg.send('hot-update', 'agent')).toMatchObject({ id: 'hot-update' })
    expect(() => reg.send('tests-passed', 'agent', 'red')).toThrow(/未知的角色/)
    // 同名表情：用 pack:id 区分
    reg.registerStickerPack({ ...pack, id: 'other', stickers: [pack.stickers[0]!] })
    expect(reg.stickers().map((s) => s.ref)).toEqual(['whale:tests-passed', 'hot-update', 'other:tests-passed'])
    expect(interpolate('{{model}} {{x}}', { model: 'm' })).toBe('m {{x}}')
  })

  it('builds display blocks per mode', () => {
    const reg = new Interaction(normalizeConfig({}))
    reg.registerStickerPack(pack)
    const sent = reg.send('tests-passed', 'agent', 'black')
    expect(reg.display(sent)).toEqual([
      { type: 'ansi', lines: ['K'], fallback: '🐋 [表情] 测试通过！' },
      { type: 'image', url: 'https://x/k.png', alt: '测试通过！' },
    ])
    reg.config = normalizeConfig({ stickers: { display: 'image' } })
    expect(reg.display(sent)).toEqual([{ type: 'image', url: 'https://x/k.png', alt: '测试通过！' }])
    reg.config = normalizeConfig({ stickers: { display: 'off' } })
    expect(reg.display(sent)).toEqual([{ type: 'text', text: '🐋 [表情] 测试通过！' }])
  })
})

describe('interaction plugin in a leo host', () => {
  it('injects the persona and sticker guidance, and the agent sends a sticker on its own', async () => {
    const { leo, mock } = await setup([{ toolCalls: [{ id: 'a', name: 'send_sticker', arguments: { id: 'tests-passed' } }] }, { text: '哼，测试通过啦' }])
    const agent = leo.createAgent({ model: 'm', systemPrompt: 'You are leo.' })
    const results: { display?: unknown; content: unknown }[] = []
    for await (const ev of agent.prompt('跑一下测试')) if (ev.type === 'tool_result') results.push(ev.result as never)
    const first = mock.requests[0]!
    expect(first.system).toContain('You are leo.')
    expect(first.system).toContain('## 人设：鲸鱼娘')
    expect(first.system).toContain('你是鲸鱼娘，模型 m，目录')
    expect(first.system!.indexOf('You are leo.')).toBeLessThan(first.system!.indexOf('## 人设'))
    expect(first.system).toContain('- tests-passed：测试通过！（适合：测试通过）')
    expect(first.system).toContain('- hot-update：热更新成功，进程没了')
    expect(first.system).toContain('发表情的唯一方式是调用 send_sticker 工具')
    const tool = first.tools!.find((t) => t.name === 'send_sticker')!
    expect((tool.parameters as { properties: { id: { enum: string[] } } }).properties.id.enum).toEqual(['tests-passed', 'hot-update'])
    expect(results[0]!.content).toEqual([{ type: 'text', text: '已发送表情「测试通过！」（tests-passed · blue），用户已经看到。' }])
    await leo.dispose()
  })

  it('limits stickers per turn', async () => {
    const { leo } = await setup([
      {
        toolCalls: [
          { id: 'a', name: 'send_sticker', arguments: { id: 'tests-passed' } },
          { id: 'b', name: 'send_sticker', arguments: { id: 'hot-update' } },
        ],
      },
      { text: 'ok' },
    ])
    const agent = leo.createAgent({ model: 'm' })
    const r = await agent.run('go')
    const tools = r.messages.filter((m) => m.role === 'tool')
    expect(tools.map((m) => m.isError)).toEqual([false, true])
    await leo.dispose()
  })

  it('hides the tool and guidance when stickers are disabled, and drops agent-only stickers when hidden is false', async () => {
    const a = await setup([{ text: 'hi' }], { stickers: { enabled: false } })
    await a.leo.createAgent({ model: 'm' }).run('x')
    expect(a.mock.requests[0]!.tools?.some((t) => t.name === 'send_sticker') ?? false).toBe(false)
    expect(a.mock.requests[0]!.system).not.toContain('## 表情包')
    await a.leo.dispose()
    const b = await setup([{ text: 'hi' }], { stickers: { hidden: false } })
    await b.leo.createAgent({ model: 'm' }).run('x')
    expect(b.mock.requests[0]!.system).not.toContain('hot-update')
    await b.leo.dispose()
  })

  it('persona off / auto / explicit', async () => {
    const off = await setup([{ text: 'hi' }], { persona: 'off' })
    await off.leo.createAgent({ model: 'm' }).run('x')
    expect(off.mock.requests[0]!.system ?? '').not.toContain('人设')
    await off.leo.dispose()
    const none = await setup([{ text: 'hi' }], {}, false)
    await none.leo.createAgent({ model: 'm' }).run('x')
    expect(none.mock.requests[0]!.system ?? '').not.toContain('## 人设')
    await none.leo.dispose()
  })

  it('registers /persona, /sticker and /stickers when the host has a commands service', async () => {
    const { leo, cmds } = await setup([])
    expect([...cmds.defs.keys()].sort()).toEqual(['persona', 'sticker', 'stickers'])
    expect((await cmds.run('persona')).text).toContain('● whale  鲸鱼娘')
    expect((await cmds.run('stickers')).text).toContain('tests-passed')
    expect((await cmds.run('stickers')).text).toContain('另有 1 张彩蛋')
    const r = await cmds.run('sticker', 'tests-passed black')
    expect(r.display).toEqual([
      { type: 'ansi', lines: ['K'], fallback: '🐋 [表情] 测试通过！' },
      { type: 'image', url: 'https://x/k.png', alt: '测试通过！' },
    ])
    expect(r.prompt).toBe('[我发了一个表情：「测试通过！」（tests-passed · black）]')
    await expect(cmds.run('sticker', 'hot-update')).rejects.toThrow(/不能由用户发送/)
    const reg = leo.ctx.get('interaction' as never) as unknown as InteractionRegistry
    await reg.setPersona('off')
    expect(reg.activePersona()).toBeUndefined()
    await leo.dispose()
  })
})
