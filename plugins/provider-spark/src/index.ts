/**
 * leo-plugin-provider-spark：模型供应商注册层（leo-plugin-provider）的讯飞星火子插件。
 *
 * 注册驱动 `spark`：保存 APIKey（`leo auth set spark`，或环境变量 `SPARK_API_KEY` / `SPARK_API_PASSWORD`）后自动接入。
 * 只内置讯飞自研的星火模型（星辰 MaaS 平台上的开源 / 第三方模型不在列表里）。
 *
 * 全部依据星辰 MaaS 文档（maas.xfyun.cn/doc，2026-10-31）：
 * - 端点：`POST https://maas-api.cn-huabei-1.xf-yun.com/v2/chat/completions`，`Authorization: Bearer <APIKey>`
 * - 模型：spark-x2.6 / spark-x2.6-4b / spark-x2.6-preview / spark-x2.5 / spark-x2.5-4b / spark-x2.5-1.7b，只支持文本输入输出；
 *   文档没有模型列表接口，也没有给出最大输出长度和价格，所以只用下面的内置列表
 * - 输出上限：`max_completion_tokens`（含思考 token）；`max_tokens` 已废弃
 * - `temperature`（固定 1）、`top_p`（固定 0.95）：文档建议不要显式传入 → 不发送；
 *   `presence_penalty`、`frequency_penalty` 已废弃 → 不发送
 * - 思考：`thinking: { type: enabled | disabled | auto }`，默认 enabled；`auto` 由模型自行判断（星火扩展取值）。
 *   没有思考预算，也没有推理强度参数；思考内容在 `reasoning_content`（只在响应里出现，请求消息不带）
 * - 消息：role 为 system / user / assistant / tool，content 为字符串或只含 text 的数组（必填）
 * - 工具：最多 128 个，`function` 之外还有内置联网搜索 `{ type: "web_search", web_search: { enable: true } }`
 * - 错误：HTTP 状态码 + 顶层 `{ code, message }`（code 0 为成功），流里也可能出现（需要 leo-plugin-provider ≥ 0.3.1 才会报出原文）
 *
 * 思考设置的优先级：宿主每次请求的 `reasoning`（--thinking、/think、--effort none、配置 agent.reasoning）
 * > provider.json 的 `thinking` > 默认 enabled。推理强度除 none（关闭思考）外不生效
 */
import type { LlmRequest, ModelInfo, PluginDefinition } from 'leo-agents'
import type { ProviderDriver, ProviderRegistryLike, ProviderSettings } from './contract.js'

export type * from './contract.js'

export const SPARK_BASE_URL = 'https://maas-api.cn-huabei-1.xf-yun.com/v2'
export const SPARK_DEFAULT_MODEL = 'spark-x2.6'
/** 工具数量上限（文档：最多 128 个） */
export const SPARK_MAX_TOOLS = 128

const K256 = 262_144
const M1 = 1_048_576
/** 只有开关，没有强度档位 */
const REASONING = { supported: true, canDisable: true, defaultEnabled: true } satisfies ModelInfo['reasoning']

const model = (id: string, name: string, contextWindow: number): ModelInfo => ({
  id,
  name,
  contextWindow,
  inputModalities: ['text'],
  outputModalities: ['text'],
  reasoning: REASONING,
  ownedBy: 'iFLYTEK',
})

/** 讯飞自研的星火模型（文档“模型介绍 / 快速调用”表） */
export const SPARK_MODELS: ModelInfo[] = [
  model('spark-x2.6', 'Spark-X2.6', M1),
  model('spark-x2.6-4b', 'Spark-X2.6-4B', M1),
  model('spark-x2.6-preview', 'Spark-X2.6-Preview', K256),
  model('spark-x2.5', 'Spark-X2.5', K256),
  model('spark-x2.5-4b', 'Spark-X2.5-4B', M1),
  model('spark-x2.5-1.7b', 'Spark-X2.5-1.7B', M1),
]

/**
 * 错误码速查（文档 1.2）→ 宿主错误类别：决定是否重试。
 * 敏感内容、参数错误不重试；当日用量用完（11201）重试也没用，按配额耗尽处理；限流与服务端错误可重试
 */
export const SPARK_ERROR_CODES: Record<string, 'invalid_request' | 'auth' | 'rate_limit' | 'overloaded' | 'context_overflow'> = {
  // 400
  '10005': 'invalid_request', // 输入格式不正确
  '10305': 'invalid_request',
  '10013': 'invalid_request', // 输入内容包含敏感内容
  '10313': 'invalid_request',
  '10014': 'invalid_request', // 输出内容包含敏感内容
  '10314': 'invalid_request',
  '10163': 'invalid_request', // 部分参数不支持
  '10224': 'context_overflow', // 序列过长
  '10404': 'invalid_request', // model_id 不正确
  '10042': 'overloaded', // 服务器内部错误（稍后重试）
  // 403
  '11200': 'auth', // APIKEY 没有对应授权
  '11221': 'auth', // 使用套餐不允许的模型
  // 429
  '11201': 'auth', // 当日使用量达到上限
  '11202': 'rate_limit', // QPS 超限
  '11203': 'rate_limit', // 并发路数或 TPM 超限
  '11210': 'rate_limit', // TPM 超限
  // 500 / 503
  '10020': 'overloaded',
  '10041': 'overloaded',
  '10011': 'overloaded',
  '10012': 'overloaded',
  '10912': 'overloaded',
  '10222': 'overloaded',
  '10223': 'overloaded',
  '10051': 'overloaded', // 与后端引擎连接超时
  '10110': 'overloaded', // 引擎并发路数不足
  '10010': 'overloaded', // 引擎排队较多
  '10310': 'overloaded',
}

/** 配置错误：带 Symbol.for('leo.error') 标记，宿主按 invalid_request 处理（不重试） */
const configError = (message: string) =>
  Object.assign(new Error(message), { name: 'LeoError', code: 'invalid_request', [Symbol.for('leo.error')]: true })

export type SparkThinking = 'enabled' | 'disabled' | 'auto'

/** 驱动特有的 provider.json 字段 */
export interface SparkSettings {
  /** 思考模式默认值：enabled（默认）/ disabled / auto（模型自行判断）；true / false 同 enabled / disabled */
  thinking?: SparkThinking
  /** 开启内置联网搜索工具 web_search（默认关闭） */
  webSearch?: boolean
  /** 终端用户标识（user 字段）：只用 a-z A-Z 0-9 - _，最长 512；请勿填隐私信息 */
  user?: string
}

function settingsOf(s: ProviderSettings): SparkSettings {
  const out: SparkSettings = {}
  if (s.thinking === true) out.thinking = 'enabled'
  else if (s.thinking === false) out.thinking = 'disabled'
  else if (s.thinking === 'enabled' || s.thinking === 'disabled' || s.thinking === 'auto') out.thinking = s.thinking
  else if (s.thinking !== undefined) throw configError('spark: "thinking" must be "enabled" / "disabled" / "auto" (or true / false) in provider.json')
  if (s.webSearch !== undefined) {
    if (typeof s.webSearch !== 'boolean') throw configError('spark: "webSearch" must be true / false in provider.json')
    out.webSearch = s.webSearch
  }
  if (s.user !== undefined) {
    if (typeof s.user !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(s.user)) {
      throw configError('spark: "user" may only contain a-z, A-Z, 0-9, "-" and "_" (at most 512 characters) in provider.json')
    }
    out.user = s.user
  }
  return out
}

/** 消息内容只能是字符串或 text 数组：其它块（图片等）去掉，数组只剩文本时合并成字符串 */
function textOnly(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type: 'text'; text: string } => !!p && typeof p === 'object' && (p as { type?: unknown }).type === 'text')
      .map((p) => p.text)
      .join('')
  }
  return ''
}

/** 星火请求体改写：思考开关、去掉固定 / 废弃的采样参数、消息只保留文档支持的字段、可选联网搜索 */
export function prepareSparkBody(body: Record<string, unknown>, input: { request: LlmRequest; settings: ProviderSettings; model?: ModelInfo }): Record<string, unknown> {
  const s = settingsOf(input.settings)
  const out = { ...body }

  // 思考：1) 宿主每次请求的 reasoning（effort none = 关闭，其它强度没有对应参数）；2) provider.json；3) 默认 enabled
  const r = (input.request as LlmRequest & { reasoning?: { enabled?: boolean; effort?: string } }).reasoning
  let type: SparkThinking | undefined
  if (r?.enabled !== undefined) type = r.enabled ? 'enabled' : 'disabled'
  else if (r?.effort === 'none') type = 'disabled'
  type ??= s.thinking ?? 'enabled'
  out.thinking = { type }

  // 文档：temperature / top_p 固定值，建议不传；penalty 已废弃；没有推理强度、思考预算参数
  for (const k of ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty', 'reasoning_effort', 'thinking_budget']) delete out[k]
  // max_tokens 已废弃，统一用 max_completion_tokens
  if (out.max_tokens !== undefined) {
    out.max_completion_tokens ??= out.max_tokens
    delete out.max_tokens
  }
  if (s.user) out.user = s.user

  if (Array.isArray(out.messages)) {
    out.messages = (out.messages as Record<string, unknown>[]).map((m) => {
      // 请求消息里没有 reasoning_content 字段
      const { reasoning_content: _r, reasoning: _r2, ...rest } = m
      const next: Record<string, unknown> = { ...rest }
      // content 必填，只支持文本
      if (Array.isArray(next.content) && (next.content as unknown[]).every((p) => (p as { type?: unknown })?.type === 'text')) {
        // 纯文本数组保持原样
      } else next.content = textOnly(next.content)
      return next
    })
  }

  if (s.webSearch) {
    const tools = Array.isArray(out.tools) ? [...(out.tools as unknown[])] : []
    if (!tools.some((t) => (t as { type?: unknown })?.type === 'web_search')) tools.push({ type: 'web_search', web_search: { enable: true } })
    out.tools = tools
  }
  if (Array.isArray(out.tools) && out.tools.length > SPARK_MAX_TOOLS) {
    throw configError(`spark: at most ${SPARK_MAX_TOOLS} tools per request, got ${out.tools.length}`)
  }
  return out
}

export function createSparkDriver(): ProviderDriver {
  return {
    id: 'spark',
    name: '讯飞星火',
    plugin: 'provider-spark',
    baseURL: SPARK_BASE_URL,
    envKeys: ['SPARK_API_KEY', 'SPARK_API_PASSWORD'],
    defaultModel: SPARK_DEFAULT_MODEL,
    models: SPARK_MODELS,
    maxTokensField: 'max_completion_tokens',
    // 文档的请求消息没有 reasoning_content，不回传历史思考
    sendReasoning: false,
    // 文档没有模型列表接口（平台上还有非自研模型），只用内置列表
    fetchModels: false,
    prepare: prepareSparkBody,
    errorCodes: SPARK_ERROR_CODES,
    // provider ≥ 0.3.0：provider.json 里没有 spark 条目时写入，/model、/think 切换后同步
    settingsTemplate: { defaultModel: SPARK_DEFAULT_MODEL, thinking: 'enabled' },
  }
}

export function createProviderSparkPlugin(): PluginDefinition {
  return {
    name: 'leo-plugin-provider-spark',
    inject: ['providers' as never],
    async apply(ctx) {
      const registry = ctx.get('providers' as never) as unknown as ProviderRegistryLike
      try {
        await ctx.effect(() => registry.registerDriver(createSparkDriver()))
      } catch (err) {
        throw new Error(`provider-spark: ${(err as Error).message}（需要 leo-plugin-provider ≥ 0.2.0）`)
      }
    },
  }
}

const plugin = createProviderSparkPlugin()
export default plugin
