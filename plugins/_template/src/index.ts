/**
 * 插件模板。复制本目录后：
 * 1. 把 template 换成你的插件 id（目录名、package.json、leo-plugin.json、下面的 name）
 * 2. 删掉示例工具，写你自己的能力
 *
 * 规则见仓库根目录 PROTOCOL.md。要点：对 leo-agents 只用 `import type`。
 */
import type { PluginDefinition, ToolDefinition } from 'leo-agents'
import { z } from 'zod'

export const Config = z.object({
  /** 示例配置：回显前缀 */
  prefix: z.string().default(''),
})
export type TemplateConfig = z.infer<typeof Config>

const plugin: PluginDefinition<TemplateConfig> = {
  name: 'leo-plugin-template',
  inject: ['tools'],
  config: Config,
  async apply(ctx, config) {
    const echo: ToolDefinition<{ text: string }> = {
      name: 'template_echo',
      description: '示例工具：原样返回输入文本。',
      parameters: z.object({ text: z.string().describe('要回显的文本') }),
      execute: ({ text }) => `${config.prefix}${text}`,
    }
    // 通过 ctx 注册，插件卸载时自动撤销
    await ctx.effect(() => ctx.get('tools').register(echo))
  },
}

export default plugin
