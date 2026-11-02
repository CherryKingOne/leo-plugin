// 用同仓库网关的源码做集成测试（只在测试里；插件代码不 import 网关）
import { createLeo, type LlmRequest, MockProvider } from 'leo-agents'
import { createGatewayPlugin, type ChannelDriver, type GatewayService, type InboundMessage } from 'leo-plugin-gateway'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createSpeakUpPlugin, type SpeakUp } from '../src/index.js'

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

function fakeDriver() {
  const sent: { chatId: string; text: string; replyTo?: string; image?: string }[] = []
  let dispatch: ((m: InboundMessage) => void) | undefined
  const driver: ChannelDriver<{ token?: string }> = {
    id: 'fake',
    name: 'Fake',
    options: z.object({ token: z.string().optional() }),
    textLimit: 4000,
    images: true,
    create(init) {
      dispatch = init.dispatch
      return {
        async send(target, msg) {
          sent.push({ chatId: target.chatId, text: msg.text, ...(msg.replyTo ? { replyTo: msg.replyTo } : {}), ...(msg.image ? { image: msg.image.url } : {}) })
          return { messageIds: [String(sent.length)] }
        },
      }
    },
  }
  return { driver, sent, dispatch: (m: InboundMessage) => dispatch!(m) }
}

const lastUser = (req: LlmRequest) => {
  const u = req.messages.filter((m) => m.role === 'user').at(-1)
  return u ? u.content.map((b) => (b.type === 'text' ? b.text : '')).join('') : ''
}

describe('与网关一起运行', () => {
  it('对方发过消息后，主动搭话在原会话里跑一轮，并作为主动消息（不带 replyTo）发出', async () => {
    const prompts: string[] = []
    let silent = false
    const mock = new MockProvider({
      script: Array.from({ length: 20 }, () => (req: LlmRequest) => {
        const text = lastUser(req)
        prompts.push(text)
        if (text.startsWith('【系统提醒')) return { text: silent ? '[沉默]' : '想你啦，在忙吗？' }
        return { text: `echo:${text}` }
      }),
    })
    const f = fakeDriver()
    const leo = await createLeo({
      logLevel: 'silent',
      providers: [mock],
      plugins: [
        [createGatewayPlugin(), { server: { enabled: false }, agent: { model: 'm' }, auth: { allowAll: true }, channels: { bot: { channel: 'fake' } } }],
        [createSpeakUpPlugin({ tickMs: 0 }), { loadConfigFiles: false }],
      ],
    })
    try {
      const gw = leo.ctx.get('gateway' as never) as unknown as GatewayService
      gw.registerChannel(f.driver)
      await tick(20)
      f.dispatch({ channel: 'fake', account: 'bot', id: 'm1', chat: { id: 'u1', type: 'direct' }, sender: { id: 'u1', name: '小王' }, text: '你好', mentioned: true, timestamp: Date.now() })
      for (let i = 0; i < 100 && f.sent.length < 1; i++) await tick(10)
      expect(f.sent[0]).toMatchObject({ chatId: 'u1', text: 'echo:你好', replyTo: 'm1' })

      const sp = leo.ctx.get('speakup' as never) as unknown as SpeakUp
      const [target] = sp.targets()
      expect(target?.key).toBe('fake:bot:direct:u1')
      expect(sp.state[target!.key]).toMatchObject({ lastBotText: 'echo:你好' })

      const r = await sp.fire(target!)
      expect(r).toMatchObject({ status: 'sent', text: '想你啦，在忙吗？' })
      expect(prompts.at(-1)).toMatch(/^【系统提醒，不是小王发的消息】/)
      expect(f.sent[1]).toEqual({ chatId: 'u1', text: '想你啦，在忙吗？' })
      expect(sp.state[target!.key]?.lastBotText).toBe('想你啦，在忙吗？')

      silent = true
      expect((await sp.fire(sp.targets()[0]!)).status).toBe('silent')
      expect(f.sent.length).toBe(2)
    } finally {
      await leo.dispose()
    }
  })
})
