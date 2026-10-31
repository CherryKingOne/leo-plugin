/**
 * leo-plugin-provider：模型供应商注册层（大箱子）。
 *
 * leo-agents 底座只保留模型接缝（`llm` 服务与 LlmProvider 接口），不再内置任何厂商。本插件：
 *
 * - 提供服务 `providers`：子插件（provider-deepseek 等，小盒子）在这里注册驱动，注册层统一读配置、取密钥、
 *   挂到 `llm` 服务、选默认模型；子插件卸载时自动撤销
 * - 自带通用协议 `openai-compatible`：还没有子插件的厂商（通义、Kimi、vLLM、Ollama、公司网关……）在
 *   provider.json 里写 baseURL 即可使用；协议不兼容的厂商可以由插件 `registerProtocol()` 注册新协议
 * - 配置 `~/.leo/provider.json` / `.leo/provider.json`（热加载：改完自动重新接入）；0.1.x 写在
 *   `.leo/config.json` 里的 `providers` 照常读取
 * - 自动探测：装了驱动、保存了密钥（leo auth set <id> 或环境变量）就自动接入，不写配置也行
 */
import { join } from 'node:path'
import type { Context, PluginDefinition } from 'leo-agents'
import { type ProviderConfig, ProviderConfigSchema } from './config.js'
import { CONFIG_FILE_NAME, type Obj, isObj, mergeConfig, readConfigFile } from './files.js'
import { createProviderRegistry, type ProviderRegistry } from './registry.js'
import type { ProviderRegistryService } from './types.js'

export type * from './types.js'
export { ProviderConfigSchema, ProviderSettingsSchema, type ProviderConfig } from './config.js'
export { CONFIG_FILE_NAME, mergeConfig, stripJsonc } from './files.js'
export { OpenAICompatibleProvider, type OpenAICompatibleOptions } from './openai.js'
export { parseSSE } from './sse.js'
export { providerError, isProviderError, LEO_ERROR_MARK, type ProviderError, type ProviderErrorCode } from './errors.js'
export { createProviderRegistry, normalizeModels, openaiCompatibleProtocol, OPENAI_COMPATIBLE, type ProviderRegistry, type RegistryDeps } from './registry.js'

declare module 'leo-agents' {
  interface Services {
    /** 模型供应商注册层（leo-plugin-provider） */
    providers: ProviderRegistryService
  }
}

export interface ProviderPluginOptions {
  /** 测试用：替换 fetch */
  fetch?: typeof fetch
  env?: NodeJS.ProcessEnv
}

/** 插件配置只做“原样接收”，与 provider.json、0.1.x 的 providers 合并后再统一校验 */
export function createProviderPlugin(opts: ProviderPluginOptions = {}): PluginDefinition<Record<string, unknown>> & { watch?: readonly string[] } {
  return {
    name: 'leo-plugin-provider',
    inject: ['llm'],
    // provider.json 变化 → 重新加载本插件；credentials.json 变化（leo auth set）→ 重新探测密钥
    watch: [CONFIG_FILE_NAME, 'credentials.json'],
    async apply(ctx, raw) {
      if (ctx.maybe('providerKinds' as never)) {
        throw new Error('provider: 当前 leo-agents 仍内置模型供应商（0.1.x），与本插件冲突。需要 leo-agents ≥ 0.2.0（开发中：feat/provider-plugin 分支）')
      }
      const notify = (message: string, level: 'info' | 'warn' | 'error' = 'info') =>
        void ctx.emit('plugin/notice' as never, { plugin: 'provider', message, ...(level === 'info' ? {} : { level }) } as never)
      const config = await loadConfig(ctx, isObj(raw) ? raw : {})
      const host = ctx.maybe('leoConfig' as never) as { model?: string } | undefined
      const registry: ProviderRegistry = createProviderRegistry({
        llm: () => ctx.get('llm'),
        credentials: () => ctx.maybe('credentials' as never) as never,
        config,
        ...(host?.model ? { hostModel: host.model } : {}),
        logger: ctx.logger,
        notify,
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      })
      await ctx.effect(() => () => registry.dispose())
      ctx.provide('providers' as never, registry as never)
      // 没有任何驱动时也要接入通用端点 / 报告状态
      registry.sync()
    },
  }
}

/**
 * 合并 0.1.x 的 config.json providers < ~/.leo/provider.json < .leo/provider.json < 插件配置，再统一校验。
 * `.leo/config.json` 的 `model` 也作为 0.1.x 的默认模型写法读取（registry 里优先使用）
 */
export async function loadConfig(ctx: Context<any>, raw: Obj): Promise<ProviderConfig> {
  const paths = ctx.maybe('leoPaths')
  const host = ctx.maybe('leoConfig' as never) as { providers?: Record<string, unknown> } | undefined
  const layers: Obj[] = []
  if (host?.providers && Object.keys(host.providers).length) layers.push({ providers: host.providers })
  if (raw.loadConfigFiles !== false && paths) {
    for (const dir of [paths.userDir, paths.projectDir]) {
      if (!dir) continue
      const f = await readConfigFile(dir)
      if (f) {
        layers.push(f.data)
        ctx.logger.debug({ file: f.file }, 'provider: config file loaded')
      }
    }
  }
  layers.push(raw)
  const parsed = ProviderConfigSchema.safeParse(mergeConfig(...layers))
  if (!parsed.success) {
    const where = paths ? `（${join(paths.userDir, CONFIG_FILE_NAME)} 或项目 .leo/${CONFIG_FILE_NAME}）` : ''
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new Error(`provider: invalid configuration${where}: ${issues}`)
  }
  return parsed.data
}

const plugin = createProviderPlugin()
export default plugin
