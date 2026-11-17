/**
 * leo-plugin-provider-qianfan：模型供应商注册层（leo-plugin-provider）的百度千帆（文心 ERNIE）子插件。
 *
 * 注册驱动 `qianfan`：保存密钥（`leo auth set qianfan` 或 `QIANFAN_API_KEY`）后自动接入。
 * 目前只接文心一言（ERNIE）的文本生成模型。
 *
 * 对照百度千帆官方文档（2026-11-11 更新）：
 * - 端点：`https://qianfan.baidubce.com/v2`（OpenAI Chat Completions 兼容，`POST /chat/completions`），
 *   鉴权 `Authorization: Bearer <API Key>`（控制台创建的 `bce-v3/ALTAK-...`）
 *   https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb
 * - 模型（https://cloud.baidu.com/doc/qianfan/s/rmh4stp0j「文本生成 / ERNIE系列-旗舰模型」）：
 *   `ernie-5.5-flash-preview`（1M / 1M）、`ernie-light-dt-1.0`（1M / 128k）、`ernie-5.1`（128k，最大输入 119k，输出 [1, 65536]）
 * - 深度思考（https://cloud.baidu.com/doc/qianfan-docs/s/Wm95lyynv）：
 *   - `thinking: { type: enabled | disabled }`：`ernie-light-dt-1.0` 可开可关；`ernie-5.5-flash-preview` 只能开启，
 *     但不传 thinking 时不会思考，所以对它始终发送 `{ type: enabled }`
 *   - `reasoning_effort`：只有 high / max 两档真正生效（low、medium 映射为 high，xhigh 映射为 max）；
 *     `ernie-light-dt-1.0` 可调，插件默认发 max；`ernie-5.5-flash-preview` 固定 high、不可调
 *   - `thinking_budget`（思维链最大长度，最小 100，默认为模型支持的最大长度）：`ernie-5.1` 支持；
 *     它不在 thinking 开关清单里，默认就思考，插件不发 thinking，只在 provider.json 写了 `thinkingBudget` 时发
 *   - 思考内容在 `reasoning_content`。多轮对话只在本轮工具调用循环里回传，之前轮次的要删掉（文档要求）
 * - 默认始终开启思考、强度取最大，只有人工关闭（/think off、--thinking off、provider.json）才关
 * - `GET /v2/models` 会列出平台上所有模型（含图像、视频、向量、其它厂商），这里不实时获取，
 *   只展示内置的 ERNIE 模型；其它模型可在 provider.json 的 `models` 里手动加
 *
 * 思考设置的优先级：宿主每次请求的 `reasoning`（--thinking / --effort、/think、/effort、配置 agent.reasoning）
 * > provider.json 的 `thinking` / `reasoningEffort` > 模型默认（开启；强度由千帆决定）
 *
 * 依赖服务 `providers`（inject），注册层先加载、后加载都可以；注册层热重载时本插件自动重新注册
 */
import type { LlmRequest, ModelInfo, PluginDefinition } from 'leo-agents'
import type { ProviderDriver, ProviderRegistryLike, ProviderSettings } from './contract.js'

export type * from './contract.js'

export const QIANFAN_BASE_URL = 'https://qianfan.baidubce.com/v2'
/** Token Plan 个人版的 OpenAI 兼容地址（用专属 API Key 时把 baseURL 改成它） */
export const QIANFAN_TOKEN_PLAN_BASE_URL = 'https://qianfan.baidubce.com/v2/tokenplan/personal'
export const QIANFAN_DEFAULT_MODEL = 'ernie-5.5-flash-preview'

/** 千帆真正生效的推理强度（low / medium 会被映射为 high，xhigh 映射为 max） */
export const QIANFAN_EFFORTS = ['high', 'max'] as const
export type QianfanEffort = (typeof QIANFAN_EFFORTS)[number]
const ALL_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** 宿主的 7 档 → 千帆的 2 档：minimal / low / medium / high → high，xhigh / max → max */
export function normalizeQianfanEffort(e: string | undefined): QianfanEffort | 'none' | undefined {
  if (e === 'none') return 'none'
  if (e === 'minimal' || e === 'low' || e === 'medium' || e === 'high') return 'high'
  if (e === 'xhigh' || e === 'max') return 'max'
  return undefined
}

/** 思维链长度下限（千帆文档） */
export const QIANFAN_MIN_THINKING_BUDGET = 100

/** 每个 ERNIE 模型支持的思考参数 */
export interface ErnieThinkingSpec {
  /**
   * switch：thinking 可开可关；always-on：只能开，且必须发 enabled；
   * implicit：本身就思考、不认 thinking 参数（ernie-5.1）；none：不思考
   */
  toggle: 'switch' | 'always-on' | 'implicit' | 'none'
  /** 能否通过 reasoning_effort 调强度 */
  effort: boolean
  /** 能否通过 thinking_budget 限制思维链长度 */
  budget?: boolean
}

export const ERNIE_THINKING: Record<string, ErnieThinkingSpec> = {
  'ernie-5.5-flash-preview': { toggle: 'always-on', effort: false },
  'ernie-light-dt-1.0': { toggle: 'switch', effort: true },
  'ernie-5.1': { toggle: 'implicit', effort: false, budget: true },
}

/**
 * 内置模型信息。上下文 / 输出取自官方模型列表（2026-11-11）。
 * `ernie-5.5-flash-preview` 文档写的最大输出是 1M（与上下文同长），这里按 128K 预留输出，避免把整个窗口都留给输出；
 * 可在 provider.json 的 models 里覆盖。价格千帆按人民币 / 千 token 计，不在这里换算
 */
export const QIANFAN_MODELS: ModelInfo[] = [
  {
    id: 'ernie-5.5-flash-preview',
    name: 'ERNIE-5.5-Flash-Preview',
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    inputModalities: ['text'],
    outputModalities: ['text'],
    reasoning: { supported: true, canDisable: false, defaultEnabled: true, efforts: ['high'], defaultEffort: 'high' },
    ownedBy: 'Baidu',
  },
  {
    id: 'ernie-light-dt-1.0',
    name: 'ERNIE-Light-DT-1.0',
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    inputModalities: ['text'],
    outputModalities: ['text'],
    reasoning: { supported: true, canDisable: true, defaultEnabled: true, efforts: [...QIANFAN_EFFORTS], defaultEffort: 'max' },
    ownedBy: 'Baidu',
  },
  {
    id: 'ernie-5.1',
    name: 'ERNIE 5.1',
    contextWindow: 131_072,
    maxOutputTokens: 65_536,
    inputModalities: ['text'],
    outputModalities: ['text'],
    reasoning: { supported: true, canDisable: false, defaultEnabled: true, efforts: ['max'], defaultEffort: 'max' },
    ownedBy: 'Baidu',
  },
]

/**
 * 千帆错误码 → leo 错误类别（https://cloud.baidu.com/doc/qianfan-api/s/Om9b4yj3w）。
 * 没列出的按 HTTP 状态码处理（429 限流重试、401/403 鉴权、5xx 过载）
 */
export const QIANFAN_ERROR_CODES: Record<string, 'invalid_request' | 'auth' | 'rate_limit' | 'overloaded' | 'context_overflow'> = {
  tokens_too_long: 'context_overflow',
  characters_too_long: 'context_overflow',
  invalid_model: 'invalid_request',
  model_offline: 'invalid_request',
  invalid_iam_token: 'auth',
  account_overdue: 'auth',
  // 套餐额度用完不是暂时性错误，不重试
  coding_plan_hour_quota_exceeded: 'auth',
  coding_plan_week_quota_exceeded: 'auth',
  coding_plan_month_quota_exceeded: 'auth',
  coding_plan_api_key_required: 'auth',
  coding_plan_api_key_not_allowed: 'auth',
  coding_plan_not_subscribed: 'auth',
  coding_plan_subscription_expired: 'auth',
  coding_plan_cluster_rate_limited: 'overloaded',
}

/** 配置错误：带 Symbol.for('leo.error') 标记，宿主按 invalid_request 处理（不重试） */
const configError = (message: string) =>
  Object.assign(new Error(message), { name: 'LeoError', code: 'invalid_request', [Symbol.for('leo.error')]: true })

/** 驱动特有的 provider.json 字段 */
export interface QianfanSettings {
  /** 思考模式默认值；不写默认开启。true / false 与 "enabled" / "disabled" 同义；只对能开关的模型生效 */
  thinking?: 'enabled' | 'disabled'
  /** 推理强度：none（关闭思考）/ high / max（默认 max）；minimal、low、medium 按 high，xhigh 按 max。只对能调强度的模型生效 */
  reasoningEffort?: QianfanEffort | 'none'
  /** 思维链最大长度（≥ 100）；不写不发，即模型支持的最大长度。只对支持 thinking_budget 的模型（ernie-5.1）生效 */
  thinkingBudget?: number
}

function settingsOf(s: ProviderSettings): QianfanSettings {
  const out: QianfanSettings = {}
  if (s.thinking === 'enabled' || s.thinking === true) out.thinking = 'enabled'
  else if (s.thinking === 'disabled' || s.thinking === false) out.thinking = 'disabled'
  else if (s.thinking !== undefined) throw configError('qianfan: "thinking" must be "enabled" / "disabled" (or true / false) in provider.json')
  if (s.reasoningEffort !== undefined) {
    const e = ALL_EFFORTS.includes(s.reasoningEffort as never) ? normalizeQianfanEffort(s.reasoningEffort as string) : undefined
    if (!e) throw configError(`qianfan: "reasoningEffort" must be one of none / high / max in provider.json, got "${String(s.reasoningEffort)}"`)
    out.reasoningEffort = e
  }
  if (s.thinkingBudget !== undefined) {
    const b = s.thinkingBudget
    if (typeof b !== 'number' || !Number.isInteger(b) || b < QIANFAN_MIN_THINKING_BUDGET) {
      throw configError(`qianfan: "thinkingBudget" must be an integer ≥ ${QIANFAN_MIN_THINKING_BUDGET} in provider.json`)
    }
    out.thinkingBudget = b
  }
  return out
}

/** 模型的思考能力：内置 ERNIE 表优先；其它模型（provider.json 里手动加的）看 ModelInfo.reasoning，否则不发思考参数 */
export function thinkingSpecOf(model: string, info?: ModelInfo): ErnieThinkingSpec {
  const known = ERNIE_THINKING[model.toLowerCase()]
  if (known) return known
  const r = info?.reasoning
  if (!r?.supported) return { toggle: 'none', effort: false }
  return { toggle: r.canDisable === false ? 'always-on' : 'switch', effort: (r.efforts?.length ?? 0) > 1 }
}

/**
 * 千帆请求体改写：按模型发 thinking / reasoning_effort / thinking_budget、助手消息内容转字符串、
 * reasoning_content 只保留本轮（最后一条用户消息之后的工具调用循环），关闭思考时全部去掉
 */
export function prepareQianfanBody(body: Record<string, unknown>, input: { request: LlmRequest; settings: ProviderSettings; model?: ModelInfo }): Record<string, unknown> {
  const s = settingsOf(input.settings)
  const out = { ...body }
  const model = typeof out.model === 'string' ? out.model : (input.request.model ?? '')
  const spec = thinkingSpecOf(model, input.model)

  // 开关：1) 宿主每次请求的 reasoning（人工 /think off、--thinking off）；2) provider.json；3) 默认开启
  const r = (input.request as LlmRequest & { reasoning?: { enabled?: boolean; effort?: string } }).reasoning
  const reqEffort = normalizeQianfanEffort(r?.effort)
  let enabled: boolean | undefined
  if (r?.enabled !== undefined) enabled = r.enabled
  else if (reqEffort === 'none') enabled = false
  if (enabled === undefined && s.thinking) enabled = s.thinking === 'enabled'
  if (enabled === undefined && s.reasoningEffort === 'none') enabled = false
  enabled ??= true

  delete out.thinking
  delete out.reasoning_effort
  delete out.enable_thinking
  delete out.thinking_budget
  if (spec.toggle === 'none') enabled = false
  else if (spec.toggle === 'implicit') {
    // 默认就思考，不认 thinking 开关；只能用 thinking_budget 限长
    enabled = true
    if (spec.budget && s.thinkingBudget) out.thinking_budget = s.thinkingBudget
  }
  else if (spec.toggle === 'always-on') {
    // 只能开启：不明确发 enabled 时服务端不思考（用户实测），所以始终发 enabled；不发关闭（不支持），也不发强度（不可调）
    enabled = true
    out.thinking = { type: 'enabled' }
  } else {
    out.thinking = { type: enabled ? 'enabled' : 'disabled' }
  }
  if (enabled && spec.effort) {
    const fileEffort = s.reasoningEffort && s.reasoningEffort !== 'none' ? s.reasoningEffort : undefined
    // 默认最大强度
    out.reasoning_effort = (reqEffort && reqEffort !== 'none' ? reqEffort : fileEffort) ?? 'max'
  }

  if (Array.isArray(out.messages)) {
    const msgs = out.messages as Record<string, unknown>[]
    let lastUser = -1
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]!.role === 'user') {
        lastUser = i
        break
      }
    }
    out.messages = msgs.map((m, i) => {
      if (m.role !== 'assistant') return m
      let next = m
      if (next.content === null || next.content === undefined) next = { ...next, content: '' }
      // 之前轮次的思维链不再回传；本轮工具调用循环里的保留，让模型接着想
      if ((!enabled || i < lastUser) && 'reasoning_content' in next) {
        const { reasoning_content: _drop, ...rest } = next
        next = rest
      }
      return next
    })
  }
  return out
}

export function createQianfanDriver(): ProviderDriver {
  return {
    id: 'qianfan',
    name: '百度千帆（文心 ERNIE）',
    plugin: 'provider-qianfan',
    baseURL: QIANFAN_BASE_URL,
    envKeys: ['QIANFAN_API_KEY'],
    defaultModel: QIANFAN_DEFAULT_MODEL,
    models: QIANFAN_MODELS,
    maxTokensField: 'max_tokens',
    // 思考 + 工具调用时回传本轮思考内容；之前轮次的和非思考模式由 prepare 去掉
    sendReasoning: true,
    // /v2/models 返回平台全部模型（含非文本与其它厂商），只展示内置的 ERNIE 模型
    fetchModels: false,
    errorCodes: QIANFAN_ERROR_CODES,
    prepare: prepareQianfanBody,
    // provider ≥ 0.3.0：provider.json 里没有 qianfan 条目时写入，/model、/think、/effort 切换后同步
    settingsTemplate: { defaultModel: QIANFAN_DEFAULT_MODEL, thinking: 'enabled', reasoningEffort: 'max' },
  }
}

export function createProviderQianfanPlugin(): PluginDefinition {
  return {
    name: 'leo-plugin-provider-qianfan',
    inject: ['providers' as never],
    async apply(ctx) {
      const registry = ctx.get('providers' as never) as unknown as ProviderRegistryLike
      try {
        await ctx.effect(() => registry.registerDriver(createQianfanDriver()))
      } catch (err) {
        throw new Error(`provider-qianfan: ${(err as Error).message}（需要 leo-plugin-provider ≥ 0.3.1）`)
      }
    },
  }
}

const plugin = createProviderQianfanPlugin()
export default plugin
