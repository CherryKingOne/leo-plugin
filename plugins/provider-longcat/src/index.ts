/**
 * leo-plugin-provider-longcat：模型供应商注册层（leo-plugin-provider）的 LongCat（美团）子插件。
 *
 * 注册驱动 `longcat`：保存密钥（`leo auth set longcat` 或 `LONGCAT_API_KEY`）后自动接入。
 *
 * 对照 LongCat 官方文档（longcat.chat/platform/docs，2026-10-31）：
 * - 端点：`https://api.longcat.chat/openai/v1`（OpenAI Chat Completions 兼容，`/chat/completions`、`/models`）
 * - 模型：`LongCat-2.5-Preview`，上下文 1048576（1M），`max_tokens` 上限 262144（256K）；
 *   `GET /models` 只给 id / owned_by，下面的内置信息补上限与价格
 * - 思考模式：`thinking: { type: enabled | disabled }`，默认开启；思考内容在 `reasoning_content`；
 *   Chat Completions 没有推理强度参数（`reasoning_effort`），只有思考预算 `thinking_budget`（最大 262144），
 *   所以推理强度在这里换算成思考预算：low 8192 / medium 32768 / high 131072（默认）/ max 262144（拉满）
 * - `temperature` 由服务端固定（思考 1.0 / 非思考 0.7），传入会被覆盖 → 不发送
 * - `messages[].content` 必须是纯文本字符串 → 助手消息的 `null` 内容改成空字符串
 *
 * 思考设置的优先级：宿主每次请求的 `reasoning`（--thinking / --effort none、/think、配置 agent.reasoning）
 * > provider.json 的 `thinking` / `reasoningEffort` > 默认开启；预算见 prepareLongCatBody
 *
 * 依赖服务 `providers`（inject），注册层先加载、后加载都可以；注册层热重载时本插件自动重新注册
 */
import type { LlmRequest, ModelInfo, PluginDefinition } from 'leo-agents'
import type { ProviderDriver, ProviderRegistryLike, ProviderSettings } from './contract.js'

export type * from './contract.js'

export const LONGCAT_BASE_URL = 'https://api.longcat.chat/openai/v1'
export const LONGCAT_DEFAULT_MODEL = 'LongCat-2.5-Preview'
/** thinking_budget 的上限（文档：最大 262144） */
export const LONGCAT_MAX_THINKING_BUDGET = 262_144

/** 推理强度 → thinking_budget（LongCat Chat Completions 没有强度参数，用思考预算实现；max 拉满到上限） */
export const LONGCAT_THINKING_BUDGETS = { low: 8_192, medium: 32_768, high: 131_072, max: LONGCAT_MAX_THINKING_BUDGET } as const
export type LongCatEffort = keyof typeof LONGCAT_THINKING_BUDGETS
const EFFORTS: LongCatEffort[] = ['low', 'medium', 'high', 'max']
const ALL_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
/** 宿主的 7 档 → LongCat 的 4 档：minimal → low，xhigh → max */
export function normalizeLongCatEffort(e: string | undefined): LongCatEffort | 'none' | undefined {
  if (e === 'none') return 'none'
  if (e === 'minimal') return 'low'
  if (e === 'xhigh') return 'max'
  return EFFORTS.includes(e as LongCatEffort) ? (e as LongCatEffort) : undefined
}

const REASONING = { supported: true, canDisable: true, defaultEnabled: true, efforts: EFFORTS, defaultEffort: 'high' } satisfies ModelInfo['reasoning']

/**
 * 内置模型信息（离线、没密钥、/models 获取失败时用，也给实时列表补上限与价格）。
 * 价格为限时折扣价（美元 / 百万 token），以 https://longcat.chat/platform/docs/zh/pricing/longcat-2.5 为准，可在 provider.json 的 models 里覆盖
 */
export const LONGCAT_MODELS: ModelInfo[] = [
  {
    id: LONGCAT_DEFAULT_MODEL,
    name: 'LongCat-2.5-Preview',
    contextWindow: 1_048_576,
    maxOutputTokens: 262_144,
    inputModalities: ['text'],
    outputModalities: ['text'],
    reasoning: REASONING,
    ownedBy: 'LongCat',
    pricing: { inputPerMTok: 0.3, cachedInputPerMTok: 0.006, outputPerMTok: 1.2 },
  },
]

/** 配置错误：带 Symbol.for('leo.error') 标记，宿主按 invalid_request 处理（不重试） */
const configError = (message: string) =>
  Object.assign(new Error(message), { name: 'LeoError', code: 'invalid_request', [Symbol.for('leo.error')]: true })

/** 驱动特有的 provider.json 字段 */
export interface LongCatSettings {
  /** 思考模式默认值；不写默认开启。true / false 与 "enabled" / "disabled" 同义 */
  thinking?: 'enabled' | 'disabled'
  /** 推理强度：none（关闭思考）/ low / medium / high（默认）/ max，翻译成 thinking_budget；兼容 minimal、xhigh */
  reasoningEffort?: LongCatEffort | 'none'
  /** 思考预算（token），1 ~ 262144：写了就不按强度换算（交互中 /effort 仍然优先） */
  thinkingBudget?: number
}

function settingsOf(s: ProviderSettings): LongCatSettings {
  const out: LongCatSettings = {}
  if (s.thinking === 'enabled' || s.thinking === true) out.thinking = 'enabled'
  else if (s.thinking === 'disabled' || s.thinking === false) out.thinking = 'disabled'
  else if (s.thinking !== undefined) throw configError('longcat: "thinking" must be "enabled" / "disabled" (or true / false) in provider.json')
  if (s.reasoningEffort !== undefined) {
    const e = ALL_EFFORTS.includes(s.reasoningEffort as never) ? normalizeLongCatEffort(s.reasoningEffort as string) : undefined
    if (!e) throw configError(`longcat: "reasoningEffort" must be one of none / low / medium / high / max in provider.json, got "${String(s.reasoningEffort)}"`)
    out.reasoningEffort = e
  }
  if (s.thinkingBudget !== undefined) {
    const b = s.thinkingBudget
    if (typeof b !== 'number' || !Number.isInteger(b) || b < 1 || b > LONGCAT_MAX_THINKING_BUDGET) {
      throw configError(`longcat: "thinkingBudget" must be an integer between 1 and ${LONGCAT_MAX_THINKING_BUDGET} in provider.json`)
    }
    out.thinkingBudget = b
  }
  return out
}

/** LongCat 请求体改写：思考开关与预算、去掉无效的 temperature、助手消息内容转字符串、reasoning_content 回传 */
export function prepareLongCatBody(body: Record<string, unknown>, input: { request: LlmRequest; settings: ProviderSettings; model?: ModelInfo }): Record<string, unknown> {
  const s = settingsOf(input.settings)
  const out = { ...body }

  // 开关：1) 宿主每次请求的 reasoning；2) provider.json 的 thinking / reasoningEffort: none；3) 默认开启
  const r = (input.request as LlmRequest & { reasoning?: { enabled?: boolean; effort?: string } }).reasoning
  const reqEffort = normalizeLongCatEffort(r?.effort)
  let enabled: boolean | undefined
  if (r?.enabled !== undefined) enabled = r.enabled
  else if (reqEffort === 'none') enabled = false
  if (enabled === undefined && s.thinking) enabled = s.thinking === 'enabled'
  if (enabled === undefined && s.reasoningEffort === 'none') enabled = false
  enabled ??= true

  out.thinking = { type: enabled ? 'enabled' : 'disabled' }
  delete out.reasoning_effort
  delete out.thinking_budget
  if (enabled) {
    // 预算：1) 宿主的推理强度（/effort、--effort）；2) provider.json 的 thinkingBudget；3) provider.json 的 reasoningEffort；4) 默认 high
    const fileEffort = s.reasoningEffort && s.reasoningEffort !== 'none' ? s.reasoningEffort : undefined
    out.thinking_budget =
      reqEffort && reqEffort !== 'none' ? LONGCAT_THINKING_BUDGETS[reqEffort] : (s.thinkingBudget ?? LONGCAT_THINKING_BUDGETS[fileEffort ?? 'high'])
  }
  // 服务端固定 temperature，传了也会被覆盖
  delete out.temperature

  if (Array.isArray(out.messages)) {
    out.messages = (out.messages as Record<string, unknown>[]).map((m) => {
      if (m.role !== 'assistant') return m
      let next = m
      if (next.content === null || next.content === undefined) next = { ...next, content: '' }
      if (!enabled && 'reasoning_content' in next) {
        const { reasoning_content: _drop, ...rest } = next
        next = rest
      }
      return next
    })
  }
  return out
}

/** 解析 GET /models（或 /models/{id}）的一项：认识 name、context_length、architecture 的模态；价格沿用内置（接口给的是人民币） */
export function mapLongCatModel(raw: Record<string, unknown> & { id: string }, builtin?: ModelInfo): ModelInfo {
  const n = (v: unknown) => (typeof v === 'number' && v > 0 ? v : undefined)
  const arr = (v: unknown) => (Array.isArray(v) ? (v.filter((x) => typeof x === 'string') as string[]) : undefined)
  const arch = (raw.architecture ?? {}) as Record<string, unknown>
  const base = builtin ?? { ...LONGCAT_MODELS[0]!, name: raw.id }
  const name = typeof raw.name === 'string' ? raw.name : base.name
  const input = arr(arch.input_modalities) ?? arr(raw.input_modalities) ?? base.inputModalities
  const output = arr(arch.output_modalities) ?? arr(raw.output_modalities) ?? base.outputModalities
  return {
    ...base,
    id: raw.id,
    ...(name ? { name } : {}),
    contextWindow: n(raw.context_length) ?? n(raw.context_window) ?? base.contextWindow,
    ...(input ? { inputModalities: input } : {}),
    ...(output ? { outputModalities: output } : {}),
    reasoning: base.reasoning ?? REASONING,
    ...(typeof raw.owned_by === 'string' ? { ownedBy: raw.owned_by } : {}),
    source: 'remote',
  }
}

export function createLongCatDriver(): ProviderDriver {
  return {
    id: 'longcat',
    name: 'LongCat',
    plugin: 'provider-longcat',
    baseURL: LONGCAT_BASE_URL,
    envKeys: ['LONGCAT_API_KEY'],
    defaultModel: LONGCAT_DEFAULT_MODEL,
    models: LONGCAT_MODELS,
    maxTokensField: 'max_tokens',
    // 思考 + 工具调用时回传历史思考内容（与 DeepSeek 同类协议）；非思考模式由 prepare 去掉
    sendReasoning: true,
    fetchModels: true,
    mapModel: mapLongCatModel,
    prepare: prepareLongCatBody,
    // provider ≥ 0.3.0：provider.json 里没有 longcat 条目时写入，/think、/effort 切换后同步这些字段
    settingsTemplate: { defaultModel: LONGCAT_DEFAULT_MODEL, thinking: 'enabled', reasoningEffort: 'high' },
  }
}

export function createProviderLongCatPlugin(): PluginDefinition {
  return {
    name: 'leo-plugin-provider-longcat',
    inject: ['providers' as never],
    async apply(ctx) {
      const registry = ctx.get('providers' as never) as unknown as ProviderRegistryLike
      try {
        await ctx.effect(() => registry.registerDriver(createLongCatDriver()))
      } catch (err) {
        throw new Error(`provider-longcat: ${(err as Error).message}（需要 leo-plugin-provider ≥ 0.2.0）`)
      }
    },
  }
}

const plugin = createProviderLongCatPlugin()
export default plugin
