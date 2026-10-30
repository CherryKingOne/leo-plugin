import { createLeo } from 'leo-agents'
import { describe, expect, it } from 'vitest'
import plugin from '../src/index.js'

describe('leo-plugin-template', () => {
  it('无配置可加载，并注册工具', async () => {
    const leo = await createLeo({ plugins: [plugin] })
    expect(leo.ctx.get('tools').get('template_echo')).toBeDefined()
    await leo.dispose()
  })

  it('卸载后工具被撤销', async () => {
    const leo = await createLeo()
    const rt = await leo.plugin(plugin, { prefix: '' })
    await rt.dispose()
    expect(leo.ctx.get('tools').get('template_echo')).toBeUndefined()
    await leo.dispose()
  })
})
