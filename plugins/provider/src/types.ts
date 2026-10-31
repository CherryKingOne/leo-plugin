/**
 * 模型供应商注册层的契约。子插件（provider-deepseek 等）只用 `import type` 引用这些类型，
 * 运行时通过服务 `ctx.get('providers')` 拿到注册层。
 */
import type { Disposer, LlmProvider, LlmRequest, ModelInfo } from 'leo-agents'

/** provider.json 里一个 provider 的配置（合并、校验后）。驱动特有的字段（如 DeepSeek 的 thinking）原样保留 */
export interface ProviderSettings {
  /** 用哪个驱动；默认等于 provider id（`"deepseek": {}` 用 deepseek 驱动） */
  driver?: string
  /** 协议；默认取驱动声明的协议，再默认 openai-compatible。0.1.x 写法的 `type` 同义 */
  protocol?: string
  enabled: boolean
  /** 设为默认 provider（纯模型名走它；宿主没配 model 时它的默认模型就是默认模型） */
  default?: boolean
  baseURL?: string
  /** 密钥：`$ENV` / `!command` / 字面值（推荐 leo auth set <id> 存到 credentials.json） */
  apiKey?: string
  apiKeyEnv?: string
  headers?: Record<string, string>
  /** 覆盖 / 追加模型元信息；字符串只声明 id */
  models?: (string | ModelInfo)[]
  defaultModel?: string
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  sendReasoning?: boolean
  connectTimeoutMs?: number
  idleTimeoutMs?: number
  /** 本地服务（Ollama、vLLM）不需要密钥 */
  keyless?: boolean
  [key: string]: unknown
}

/** 驱动 / 协议拿到的输入 */
export interface DriverInput {
  /** provider id（模型前缀） */
  id: string
  settings: ProviderSettings
  /** 每次请求时解析的密钥（credentials 服务：--api-key > 项目 / 用户 credentials.json > apiKey > 环境变量） */
  apiKey: () => string | undefined
  /** 驱动默认值与配置合并后的结果 */
  resolved: ResolvedProvider
}

/** 驱动默认值与 provider.json 合并后的结果（协议直接用） */
export interface ResolvedProvider {
  id: string
  name: string
  baseURL?: string
  envKeys: string[]
  defaultModel?: string
  models: ModelInfo[]
  keyless: boolean
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  sendReasoning?: boolean
  headers?: Record<string, string>
  connectTimeoutMs?: number
  idleTimeoutMs?: number
  /** 驱动的厂商参数钩子 */
  prepare?: (body: Record<string, unknown>, request: LlmRequest) => Record<string, unknown>
  /** 由谁提供：驱动所在插件名，或 “provider（通用）” */
  via: string
}

/**
 * 模型供应商驱动（小盒子）。子插件注册一个驱动，用户在 provider.json 写 `"<id>": {}` 或只保存密钥即可使用。
 * 大多数厂商只需声明默认值（走 openai-compatible 协议）；协议不兼容的厂商实现 `create`。
 */
export interface ProviderDriver {
  /** 驱动 id，也是默认的 provider id / 模型前缀 / 密钥名，如 `deepseek` */
  id: string
  name: string
  /** 提供驱动的插件名（展示用），如 `provider-deepseek` */
  plugin?: string
  baseURL?: string
  /** 回退读取的环境变量 */
  envKeys?: string[]
  defaultModel?: string
  models?: ModelInfo[]
  keyless?: boolean
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  sendReasoning?: boolean
  headers?: Record<string, string>
  /** 协议，默认 openai-compatible */
  protocol?: string
  /** 厂商参数：拿到通用请求体与该 provider 的配置，返回改写后的请求体（在用户 providerOptions 之前） */
  prepare?(body: Record<string, unknown>, input: { request: LlmRequest; settings: ProviderSettings }): Record<string, unknown>
  /** 完全自定义实现（不走协议）。注册层会补上 name / defaultModel / status */
  create?(input: DriverInput): LlmProvider
}

/** 协议实现：把合并后的配置变成 LlmProvider。内置 openai-compatible，第三方插件可以注册 anthropic 等 */
export type ProviderProtocol = (input: DriverInput) => LlmProvider

export type ProviderState = 'ready' | 'no_key' | 'disabled' | 'waiting_driver' | 'error'

export interface ProviderEntryStatus {
  id: string
  /** 使用的驱动 id；通用端点为 undefined */
  driver?: string
  name: string
  state: ProviderState
  reason?: string
  baseURL?: string
  defaultModel?: string
  default: boolean
  via?: string
}

export interface DriverInfo {
  id: string
  name: string
  plugin?: string
  defaultModel?: string
}

/** 服务 `providers`：注册层（大箱子） */
export interface ProviderRegistryService {
  /** 注册驱动；返回撤销函数（请包在 ctx.effect 里，子插件卸载时自动撤销） */
  registerDriver(driver: ProviderDriver): Disposer
  /** 注册协议；返回撤销函数 */
  registerProtocol(name: string, protocol: ProviderProtocol): Disposer
  drivers(): DriverInfo[]
  protocols(): string[]
  /** 每个 provider 的状态（含没接上的：缺密钥、缺驱动、已停用） */
  status(): ProviderEntryStatus[]
}
