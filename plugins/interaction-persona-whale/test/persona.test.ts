import { createLeo, MockProvider } from 'leo-agents'
import interaction from 'leo-plugin-interaction'
import { describe, expect, it } from 'vitest'
import persona, { WHALE_PERSONA } from '../src/index.js'

describe('interaction-persona-whale', () => {
  it('registers the whale persona and it becomes active with persona "auto"', async () => {
    const mock = new MockProvider({ script: [{ text: '哼' }], models: [{ id: 'm', contextWindow: 32_000 }] })
    const leo = await createLeo({ logLevel: 'silent', providers: [mock], plugins: [[interaction, { loadConfigFiles: false }], persona] })
    await leo.createAgent({ model: 'm' }).run('你好')
    const system = mock.requests[0]!.system!
    expect(system).toContain('## 人设：鲸鱼娘·大肥鱼')
    expect(system).toContain('由 m 模型驱动的编码助手')
    expect(system).not.toContain('{{model}}')
    expect(system).toContain('思考过程（推理、思维链、工具调用前的分析）一律使用中文描述')
    await leo.dispose()
  })

  it('keeps the original persona text', () => {
    expect(WHALE_PERSONA.prompt.startsWith('你是住在 DeepSeek 数据海洋里的「鲸鱼娘·大肥鱼」')).toBe(true)
    expect(WHALE_PERSONA.prompt).toContain('【回复风格（必须遵守）】')
    expect(WHALE_PERSONA.prompt).toContain('【工作准则】')
  })
})
