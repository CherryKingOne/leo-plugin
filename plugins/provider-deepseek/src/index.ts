/**
 * leo-plugin-provider-deepseek：模型供应商注册层（leo-plugin-provider）的 DeepSeek 子插件。
 *
 * 注册驱动 `deepseek`：保存密钥（`leo auth set deepseek` 或 `DEEPSEEK_API_KEY`）后自动接入。
 *
 * 对照 DeepSeek 官方文档（api-docs.deepseek.com，2026-10-31）：
 * - 模型：`deepseek-flash`（DeepSeek-V4.1-Flash，文本 + 图片输入）、`deepseek-v4-pro`（DeepSeek-V4-Pro，文本输入），
 *   上下文 1M（1048576），最大输出 384K（393216）。模型列表与详情从 `GET /models` 实时获取，下面是离线时用的内置信息
 * - 思考模式：`thinking: { type: enabled | disabled }`，优先于 `reasoning_effort`；都不传时默认开启
 * - 推理强度：`reasoning_effort` = none / low / high / max，默认 high，none 关闭思考；
 *   兼容写法 minimal → low，medium / xhigh → high
 * - 带工具的思考模式必须回传历史 `reasoning_content`，否则 400 → 思考开启时始终回传，关闭时不传
 * - 思考模式不支持 `tool_choice` 为 required 或指定工具（400）
 * - 旧模型名 `deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 下线：请求时自动改写为 `deepseek-flash`
 *   的非思考 / 思考模式，但不作为模型展示
 *
 * 思考设置的优先级：宿主每次请求的 `reasoning`（--thinking / --effort、/think、/effort、配置 agent.reasoning）
 * > provider.json 的 `thinking` / `reasoningEffort` > 旧模型名隐含的模式 > 默认开启（强度由 DeepSeek 决定，默认 high）
 *
 * 依赖服务 `providers`（inject），注册层先加载、后加载都可以；注册层热重载时本插件自动重新注册
 */
import type { LlmRequest, ModelInfo, PluginDefinition, ReasoningEffort } from 'leo-agents'
import type { ProviderDriver, ProviderRegistryLike, ProviderSettings } from './contract.js'

export type * from './contract.js'

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'

/** DeepSeek 接受的推理强度档位（不含 none） */
export const DEEPSEEK_EFFORTS = ['low', 'high', 'max'] as const
export type DeepSeekEffort = (typeof DEEPSEEK_EFFORTS)[number]

const REASONING = { supported: true, canDisable: true, defaultEnabled: true, efforts: [...DEEPSEEK_EFFORTS], defaultEffort: 'high' } satisfies ModelInfo['reasoning']

/**
 * 内置模型信息（离线、没密钥、/models 获取失败时用）。价格按高峰时段（美元 / 百万 token），用于预算估算，偏保守；
 * 以 https://api-docs.deepseek.com/zh-cn/quick_start/pricing 为准，可在 provider.json 的 models 里覆盖
 */
export const DEEPSEEK_MODELS: ModelInfo[] = [
  {
    id: 'deepseek-flash',
    name: 'DeepSeek-V4.1-Flash',
    contextWindow: 1_048_576,
    maxOutputTokens: 393_216,
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    reasoning: REASONING,
    ownedBy: 'deepseek',
    pricing: { inputPerMTok: 0.3, cachedInputPerMTok: 0.006, outputPerMTok: 1.2 },
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek-V4-Pro',
    contextWindow: 1_048_576,
    maxOutputTokens: 393_216,
    inputModalities: ['text'],
    outputModalities: ['text'],
    reasoning: REASONING,
    ownedBy: 'deepseek',
    pricing: { inputPerMTok: 1.32, cachedInputPerMTok: 0.044, outputPerMTok: 3.96 },
  },
]

/** 已下线的旧模型名 → 现在的模型 + 思考开关 */
export const LEGACY_MODELS: Record<string, { model: string; thinking: 'enabled' | 'disabled' }> = {
  'deepseek-chat': { model: 'deepseek-flash', thinking: 'disabled' },
  'deepseek-reasoner': { model: 'deepseek-flash', thinking: 'enabled' },
}

/** DeepSeek 仍接受、已转到 V4.1 Flash 的旧名字：原样发送，只作为别名补模型信息 */
const ROUTED_ALIASES = ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']

/** 配置错误：带 Symbol.for('leo.error') 标记，宿主按 invalid_request 处理（不重试） */
const configError = (message: string) =>
  Object.assign(new Error(message), { name: 'LeoError', code: 'invalid_request', [Symbol.for('leo.error')]: true })

/** 驱动特有的 provider.json 字段 */
export interface DeepSeekSettings {
  /** 思考模式默认值；不写默认开启。true / false 与 "enabled" / "disabled" 同义 */
  thinking?: 'enabled' | 'disabled'
  /** 推理强度默认值：none / low / high / max（兼容 minimal / medium / xhigh） */
  reasoningEffort?: ReasoningEffort
  /** 旧模型名自动改写，默认 true */
  legacyModels?: boolean
}

const ALL_EFFORTS: ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

function settingsOf(s: ProviderSettings): DeepSeekSettings {
  const out: DeepSeekSettings = {}
  if (s.thinking === 'enabled' || s.thinking === true) out.thinking = 'enabled'
  else if (s.thinking === 'disabled' || s.thinking === false) out.thinking = 'disabled'
  else if (s.thinking !== undefined) throw configError('deepseek: "thinking" must be "enabled" / "disabled" (or true / false) in provider.json')
  if (s.reasoningEffort !== undefined) {
    if (!ALL_EFFORTS.includes(s.reasoningEffort as ReasoningEffort)) {
      throw configError(`deepseek: "reasoningEffort" must be one of none / low / high / max in provider.json, got "${String(s.reasoningEffort)}"`)
    }
    out.reasoningEffort = s.reasoningEffort as ReasoningEffort
  }
  if (s.legacyModels === false) out.legacyModels = false
  return out
}

/**
 * 通用档位 → DeepSeek 档位（文档的兼容规则：minimal → low，medium / xhigh → high），
 * 再按该模型实际支持的档位取最接近的一档
 */
export function mapEffort(effort: ReasoningEffort, supported: readonly string[] = DEEPSEEK_EFFORTS): DeepSeekEffort | 'none' {
  if (effort === 'none') return 'none'
  const mapped = effort === 'minimal' ? 'low' : effort === 'medium' || effort === 'xhigh' ? 'high' : effort
  if (!supported.length || supported.includes(mapped)) return mapped as DeepSeekEffort
  const order = ALL_EFFORTS.slice(1)
  const at = order.indexOf(mapped)
  const ranked = supported.filter((l) => order.includes(l as ReasoningEffort)).sort((a, b) => Math.abs(order.indexOf(a as ReasoningEffort) - at) - Math.abs(order.indexOf(b as ReasoningEffort) - at))
  return (ranked[0] ?? mapped) as DeepSeekEffort
}

/** DeepSeek 请求体改写：旧模型名、思考开关与推理强度、reasoning_content 回传 */
export function prepareDeepSeekBody(body: Record<string, unknown>, input: { request: LlmRequest; settings: ProviderSettings; model?: ModelInfo }): Record<string, unknown> {
  const s = settingsOf(input.settings)
  const out = { ...body }
  const legacy = s.legacyModels === false ? undefined : LEGACY_MODELS[String(out.model)]
  if (legacy) out.model = legacy.model

  // 1) 宿主每次请求的 reasoning；2) provider.json；3) 旧模型名隐含的模式；4) 默认开启
  const r = (input.request as LlmRequest & { reasoning?: { enabled?: boolean; effort?: ReasoningEffort } }).reasoning
  let enabled: boolean | undefined
  let effort: ReasoningEffort | undefined
  let explicit = false
  if (r && (r.enabled !== undefined || r.effort !== undefined)) {
    explicit = true
    effort = r.effort
    enabled = r.enabled ?? (effort ? effort !== 'none' : undefined)
    if (effort === 'none') enabled = false
  }
  if (enabled === undefined && s.thinking) {
    explicit = true
    enabled = s.thinking === 'enabled'
  }
  if (effort === undefined && s.reasoningEffort) effort = s.reasoningEffort
  if (effort === 'none' && enabled === undefined) enabled = false
  if (enabled === undefined && legacy) enabled = legacy.thinking === 'enabled'
  enabled ??= true

  // 思考模式不支持 tool_choice = required / 指定工具（DeepSeek 返回 400）
  const tc = out.tool_choice
  if (enabled && tc !== undefined && tc !== 'auto' && tc !== 'none') {
    if (explicit) throw configError('deepseek: tool_choice "required" or a named tool is not supported in thinking mode; turn thinking off (--thinking off, /think off) for this agent')
    enabled = false
  }

  out.thinking = { type: enabled ? 'enabled' : 'disabled' }
  delete out.reasoning_effort
  if (enabled && effort && effort !== 'none') {
    const level = mapEffort(effort, input.model?.reasoning?.efforts ?? DEEPSEEK_EFFORTS)
    if (level !== 'none') out.reasoning_effort = level
  }
  // 非思考模式不回传历史思考内容
  if (!enabled && Array.isArray(out.messages)) {
    out.messages = (out.messages as Record<string, unknown>[]).map((m) => {
      if (m.role !== 'assistant' || !('reasoning_content' in m)) return m
      const { reasoning_content: _drop, ...rest } = m
      return rest
    })
  }
  return out
}

/** 解析 GET /models 的一项：展示名、上下文、最大输出、模态、effort 档位；价格沿用内置 */
export function mapDeepSeekModel(raw: Record<string, unknown> & { id: string }, builtin?: ModelInfo): ModelInfo {
  const n = (v: unknown) => (typeof v === 'number' && v > 0 ? v : undefined)
  const arr = (v: unknown) => (Array.isArray(v) ? (v.filter((x) => typeof x === 'string') as string[]) : undefined)
  const effort = raw.effort as { supported_levels?: unknown; default_level?: unknown } | undefined
  const levels = arr(effort?.supported_levels)?.filter((l) => l !== 'none') as ReasoningEffort[] | undefined
  const def = typeof effort?.default_level === 'string' ? (effort.default_level as ReasoningEffort) : undefined
  const reasoning: NonNullable<ModelInfo['reasoning']> = levels?.length
    ? { supported: true, canDisable: true, defaultEnabled: true, efforts: levels, ...(def && levels.includes(def) ? { defaultEffort: def } : {}) }
    : (builtin?.reasoning ?? REASONING)
  const name = typeof raw.name === 'string' ? raw.name : builtin?.name
  const maxOut = n(raw.max_output_tokens) ?? builtin?.maxOutputTokens
  const input = arr(raw.input_modalities) ?? builtin?.inputModalities
  const output = arr(raw.output_modalities) ?? builtin?.outputModalities
  return {
    ...builtin,
    id: raw.id,
    ...(name ? { name } : {}),
    contextWindow: n(raw.context_window) ?? builtin?.contextWindow ?? DEEPSEEK_MODELS[0]!.contextWindow,
    ...(maxOut ? { maxOutputTokens: maxOut } : {}),
    ...(input ? { inputModalities: input } : {}),
    ...(output ? { outputModalities: output } : {}),
    reasoning,
    ...(typeof raw.owned_by === 'string' ? { ownedBy: raw.owned_by } : {}),
    source: 'remote',
  }
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
      // 旧名字只作为别名：请求时可用、预算按改写后的模型算，但不在模型列表里展示
      ...Object.entries(LEGACY_MODELS).map(([id, l]) => ({ ...DEEPSEEK_MODELS.find((m) => m.id === l.model)!, id, name: `${id}（已下线，改用 ${l.model}）`, alias: true })),
      ...ROUTED_ALIASES.map((id) => ({ ...DEEPSEEK_MODELS[0]!, id, name: `${id}（别名，即 deepseek-flash）`, alias: true })),
    ],
    maxTokensField: 'max_tokens',
    // 思考模式下带工具的请求必须回传全部 reasoning_content；非思考模式由 prepare 去掉
    sendReasoning: true,
    fetchModels: true,
    mapModel: mapDeepSeekModel,
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
