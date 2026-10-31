/**
 * leo-plugin-provider-deepseek：模型供应商注册层（leo-plugin-provider）的 DeepSeek 子插件。
 *
 * 注册驱动 `deepseek`：保存密钥（`leo auth set deepseek` 或 `DEEPSEEK_API_KEY`）后自动接入，
 * 模型写 `deepseek/deepseek-flash`、`deepseek/deepseek-v4-pro`。
 *
 * DeepSeek 特有的处理（对照 api-docs.deepseek.com，2026-10）：
 * - 思考模式默认开启；带工具的请求必须把之前每一轮的 `reasoning_content` 回传，否则 400 → 始终回传
 * - `thinking`（enabled / disabled）与 `reasoningEffort`（low / high / max）可在 provider.json 里设置
 * - 旧模型名 `deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 下线：自动改写为 `deepseek-flash`
 *   的非思考 / 思考模式，0.1.x 配置不用改
 *
 * - 依赖服务 `providers`（inject），注册层先加载、后加载都可以；注册层热重载时本插件自动重新注册
 */
import type { LlmRequest, ModelInfo, PluginDefinition } from 'leo-agents'
import type { ProviderDriver, ProviderRegistryLike, ProviderSettings } from './contract.js'

export type * from './contract.js'

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'

/**
 * 模型元信息。价格按高峰时段（美元 / 百万 token），用于预算估算，偏保守；非高峰为一半。
 * 以 https://api-docs.deepseek.com/quick_start/pricing 为准，可在 provider.json 的 models 里覆盖
 */
export const DEEPSEEK_MODELS: ModelInfo[] = [
  { id: 'deepseek-flash', contextWindow: 1_000_000, maxOutputTokens: 384_000, pricing: { inputPerMTok: 0.3, cachedInputPerMTok: 0.006, outputPerMTok: 1.2 } },
  { id: 'deepseek-v4-pro', contextWindow: 1_000_000, maxOutputTokens: 384_000, pricing: { inputPerMTok: 1.32, cachedInputPerMTok: 0.044, outputPerMTok: 3.96 } },
]

/** 已下线的旧模型名 → 现在的模型 + 思考开关 */
export const LEGACY_MODELS: Record<string, { model: string; thinking: 'enabled' | 'disabled' }> = {
  'deepseek-chat': { model: 'deepseek-flash', thinking: 'disabled' },
  'deepseek-reasoner': { model: 'deepseek-flash', thinking: 'enabled' },
}

/** DeepSeek 仍接受、已转到 V4.1 Flash 的旧名字：原样发送，只补模型信息 */
const ROUTED_ALIASES = ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']

/** 配置错误：带 Symbol.for('leo.error') 标记，宿主按 invalid_request 处理（不重试） */
const configError = (message: string) =>
  Object.assign(new Error(message), { name: 'LeoError', code: 'invalid_request', [Symbol.for('leo.error')]: true })

const EFFORTS = ['low', 'high', 'max'] as const

/** 驱动特有的 provider.json 字段 */
export interface DeepSeekSettings {
  /** 思考模式；不写由 DeepSeek 决定（默认开启） */
  thinking?: 'enabled' | 'disabled'
  /** 思考强度 */
  reasoningEffort?: (typeof EFFORTS)[number]
  /** 旧模型名自动改写，默认 true */
  legacyModels?: boolean
}

function settingsOf(s: ProviderSettings): DeepSeekSettings {
  const out: DeepSeekSettings = {}
  if (s.thinking === 'enabled' || s.thinking === 'disabled') out.thinking = s.thinking
  else if (s.thinking !== undefined) throw configError('deepseek: "thinking" must be "enabled" or "disabled" (provider.json)')
  if (s.reasoningEffort !== undefined) {
    if (!EFFORTS.includes(s.reasoningEffort as never)) throw configError(`deepseek: "reasoningEffort" must be one of ${EFFORTS.join(' / ')} (provider.json)`)
    out.reasoningEffort = s.reasoningEffort as DeepSeekSettings['reasoningEffort']
  }
  if (s.legacyModels === false) out.legacyModels = false
  return out
}

/** DeepSeek 请求体改写：旧模型名、思考开关与强度 */
export function prepareDeepSeekBody(body: Record<string, unknown>, input: { request: LlmRequest; settings: ProviderSettings }): Record<string, unknown> {
  const s = settingsOf(input.settings)
  const out = { ...body }
  let thinking = s.thinking
  const legacy = s.legacyModels === false ? undefined : LEGACY_MODELS[String(out.model)]
  if (legacy) {
    out.model = legacy.model
    thinking ??= legacy.thinking
  }
  if (thinking) out.thinking = { type: thinking }
  if (s.reasoningEffort && thinking !== 'disabled') out.reasoning_effort = s.reasoningEffort
  return out
}

export function createDeepSeekDriver(): ProviderDriver {
  return {
    id: 'deepseek',
    name: 'DeepSeek',
    plugin: 'provider-deepseek',
    baseURL: DEEPSEEK_BASE_URL,
    envKeys: ['DEEPSEEK_API_KEY'],
    defaultModel: 'deepseek-flash',
    models: [
      ...DEEPSEEK_MODELS,
      // 旧名字也给出模型信息，预算与上下文窗口按改写后的模型算
      ...Object.entries(LEGACY_MODELS).map(([id, l]) => ({ ...DEEPSEEK_MODELS.find((m) => m.id === l.model)!, id })),
      ...ROUTED_ALIASES.map((id) => ({ ...DEEPSEEK_MODELS[0]!, id })),
    ],
    maxTokensField: 'max_tokens',
    // 带工具的请求必须回传全部 reasoning_content；不带工具时 DeepSeek 会忽略，所以始终回传
    sendReasoning: true,
    prepare: prepareDeepSeekBody,
  }
}

export function createProviderDeepSeekPlugin(): PluginDefinition {
  return {
    name: 'leo-plugin-provider-deepseek',
    inject: ['providers' as never],
    async apply(ctx) {
      const registry = ctx.get('providers' as never) as unknown as ProviderRegistryLike
      try {
        await ctx.effect(() => registry.registerDriver(createDeepSeekDriver()))
      } catch (err) {
        throw new Error(`provider-deepseek: ${(err as Error).message}（需要 leo-plugin-provider ≥ 0.1.0）`)
      }
    },
  }
}

const plugin = createProviderDeepSeekPlugin()
export default plugin
