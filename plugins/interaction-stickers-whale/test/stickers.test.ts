import { createLeo, MockProvider } from 'leo-agents'
import interaction, { type InteractionRegistry } from 'leo-plugin-interaction'
import { describe, expect, it } from 'vitest'
import stickers, { artOf, CATALOG, createWhaleStickerPack, DEFAULT_IMAGE_BASE } from '../src/index.js'

describe('interaction-stickers-whale', () => {
  it('ships 24 stickers (14 public, 10 agent-only) with art for both variants', () => {
    expect(CATALOG).toHaveLength(24)
    expect(CATALOG.filter((s) => s.visibility === 'public')).toHaveLength(14)
    for (const s of CATALOG) {
      for (const v of ['blue', 'black']) {
        const art = artOf(v, s.file)
        expect(art?.length, `${v}/${s.file}`).toBeGreaterThan(5)
        expect(art!.every((l) => l.endsWith('\x1b[0m'))).toBe(true)
      }
    }
    const pack = createWhaleStickerPack({ imageBase: 'https://cdn.example/' , defaultVariant: 'black' })
    expect(pack.defaultVariant).toBe('black')
    expect(pack.stickers[0]!.assets.black!.image).toBe('https://cdn.example/black/01-daily-chat.png')
  })

  it('lets the agent send a whale sticker with terminal art and image', async () => {
    const mock = new MockProvider({
      script: [{ toolCalls: [{ id: 'a', name: 'send_sticker', arguments: { id: 'root-cause', variant: 'black' } }] }, { text: '找到啦' }],
      models: [{ id: 'm', contextWindow: 64_000 }],
    })
    const leo = await createLeo({ logLevel: 'silent', providers: [mock], plugins: [[interaction, { loadConfigFiles: false }], stickers] })
    const agent = leo.createAgent({ model: 'm' })
    const r = await agent.run('为什么挂了')
    expect(mock.requests[0]!.system).toContain('- root-cause：找到原因了')
    expect(mock.requests[0]!.system).toContain('- hot-update：热更新成功，进程没了')
    const tool = r.messages.find((m) => m.role === 'tool')!
    expect(tool.isError).toBe(false)
    const reg = leo.ctx.get('interaction' as never) as unknown as InteractionRegistry & { display(s: unknown): { type: string; url?: string }[]; send(id: string, by: string, v?: string): unknown }
    const blocks = reg.display(reg.send('root-cause', 'agent', 'black'))
    expect(blocks[0]!.type).toBe('ansi')
    expect(blocks[1]).toEqual({ type: 'image', url: `${DEFAULT_IMAGE_BASE}black/22-root-cause.png`, alt: '找到原因了' })
    await leo.dispose()
  })
})
