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
 *   - `thinking: { type: enabled | disabled }`：`ernie-light-dt-1.0` 可开可关；`ernie-5.5-flash-preview` 只能开启
 *   - `reasoning_effort`：`ernie-light-dt-1.0` 取 low / high / max（默认 max）；`ernie-5.5-flash-preview` 固定 high、不可调
 *   - `ernie-5.1` 不在深度思考模型列表里，按普通文本模型处理，不发思考参数
 *   - 思考内容在 `reasoning_content`；带工具的思考多轮要回传它，新一轮问题时服务端会忽略旧的
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

/** 千帆接受的推理强度（low / medium 会被映射为 high，xhigh 映射为 max；这里只暴露真正生效的三档） */
export const QIANFAN_EFFORTS = ['low', 'high', 'max'] as const
export type QianfanEffort = (typeof QIANFAN_EFFORTS)[number]
const ALL_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** 宿主的 7 档 → 千帆的 3 档：minimal → low，medium → high，xhigh → max */
export function normalizeQianfanEffort(e: string | undefined): QianfanEffort | 'none' | undefined {
  if (e === 'none') return 'none'
  if (e === 'minimal') return 'low'
  if (e === 'medium') return 'high'
  if (e === 'xhigh') return 'max'
  return QIANFAN_EFFORTS.includes(e as QianfanEffort) ? (e as QianfanEffort) : undefined
}

/** 每个 ERNIE 模型支持的思考参数 */
export interface ErnieThinkingSpec {
  /** 能否通过 thinking 开关 */
  toggle: 'switch' | 'always-on' | 'none'
  /** 能否通过 reasoning_effort 调强度 */
  effort: boolean
}

export const ERNIE_THINKING: Record<string, ErnieThinkingSpec> = {
  'ernie-5.5-flash-preview': { toggle: 'always-on', effort: false },
  'ernie-light-dt-1.0': { toggle: 'switch', effort: true },
  'ernie-5.1': { toggle: 'none', effort: false },
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
  /** 推理强度：none（关闭思考）/ low / high / max；兼容 minimal、medium、xhigh。只对能调强度的模型生效 */
  reasoningEffort?: QianfanEffort | 'none'
}

function settingsOf(s: ProviderSettings): QianfanSettings {
  const out: QianfanSettings = {}
  if (s.thinking === 'enabled' || s.thinking === true) out.thinking = 'enabled'
  else if (s.thinking === 'disabled' || s.thinking === false) out.thinking = 'disabled'
  else if (s.thinking !== undefined) throw configError('qianfan: "thinking" must be "enabled" / "disabled" (or true / false) in provider.json')
  if (s.reasoningEffort !== undefined) {
    const e = ALL_EFFORTS.includes(s.reasoningEffort as never) ? normalizeQianfanEffort(s.reasoningEffort as string) : undefined
    if (!e) throw configError(`qianfan: "reasoningEffort" must be one of none / low / high / max in provider.json, got "${String(s.reasoningEffort)}"`)
    out.reasoningEffort = e
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

/** 千帆请求体改写：按模型发 thinking / reasoning_effort、助手消息内容转字符串、关闭思考时去掉 reasoning_content */
export function prepareQianfanBody(body: Record<string, unknown>, input: { request: LlmRequest; settings: ProviderSettings; model?: ModelInfo }): Record<string, unknown> {
  const s = settingsOf(input.settings)
  const out = { ...body }
  const model = typeof out.model === 'string' ? out.model : (input.request.model ?? '')
  const spec = thinkingSpecOf(model, input.model)

  // 开关：1) 宿主每次请求的 reasoning；2) provider.json；3) 默认开启
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
  if (spec.toggle === 'none') enabled = false
  else if (spec.toggle === 'always-on') {
    // 只能开启：不发关闭（会报错），也不发强度（不可调）
    enabled = true
  } else {
    out.thinking = { type: enabled ? 'enabled' : 'disabled' }
  }
  if (enabled && spec.effort) {
    const fileEffort = s.reasoningEffort && s.reasoningEffort !== 'none' ? s.reasoningEffort : undefined
    const effort = reqEffort && reqEffort !== 'none' ? reqEffort : fileEffort
    if (effort) out.reasoning_effort = effort
  }

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
    // 思考 + 工具调用时回传历史思考内容；非思考模式由 prepare 去掉
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
