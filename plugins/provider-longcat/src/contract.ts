/**
 * 与模型供应商注册层（leo-plugin-provider）的契约，结构上与它的 types.ts 一致。
 * 子插件之间不互相 import（各自打成单文件），所以这里只写用到的部分。
 */
import type { Disposer, LlmRequest, ModelInfo } from 'leo-agents'

export interface ProviderSettings {
  driver?: string
  enabled: boolean
  [key: string]: unknown
}

export interface ProviderDriver {
  id: string
  name: string
  plugin?: string
  baseURL?: string
  envKeys?: string[]
  defaultModel?: string
  models?: ModelInfo[]
  keyless?: boolean
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  sendReasoning?: boolean
  headers?: Record<string, string>
  protocol?: string
  prepare?(body: Record<string, unknown>, input: { request: LlmRequest; settings: ProviderSettings; model?: ModelInfo }): Record<string, unknown>
  fetchModels?: boolean
  mapModel?(raw: Record<string, unknown> & { id: string }, builtin?: ModelInfo): ModelInfo | undefined
  /** provider.json 条目的默认内容（provider ≥ 0.3.0 写入；旧版本忽略） */
  settingsTemplate?: Record<string, string | number | boolean>
}

export interface ProviderRegistryLike {
  registerDriver(driver: ProviderDriver): Disposer
}
