/**
 * OpenAI Chat Completions 兼容协议（从 leo-agents 0.1.x 的 OpenAICompatibleProvider 迁移而来）。
 * 注册层的内置协议 `openai-compatible`；驱动（provider-deepseek 等）在它上面声明默认值，并可用 `prepare` 加厂商参数。
 */
import type { AgentMessage, ContentBlock, FinishReason, LlmProvider, LlmRequest, LlmStreamEvent, ModelInfo, ProviderStatusInfo, StreamOptions, Usage } from 'leo-agents'
import { isAbortError, isProviderError, type ProviderError, providerError } from './errors.js'
import { resolveValue } from './secrets.js'
import { parseSSE } from './sse.js'

type LeoError = ProviderError
const LeoErrorCtor = providerError

export interface OpenAICompatibleOptions {
  /** Provider id，用作模型前缀：`deepseek/deepseek-chat` */
  id?: string
  /** 例如 https://api.openai.com/v1、https://api.deepseek.com/v1、vLLM / leo-inference 的 /v1 */
  baseURL: string
  /** API Key，或每次请求时调用的取值函数（便于密钥轮换）。也可以用 apiKeyEnv 从环境变量读取 */
  apiKey?: string | (() => string | undefined)
  apiKeyEnv?: string
  /** 为 true 时缺少密钥直接报 auth 错误（不发请求），默认 false（本地服务常不需要密钥） */
  requireApiKey?: boolean
  /** 额外请求头（如 OpenRouter 的 HTTP-Referer）；值支持 `$ENV` / `!command` */
  headers?: Record<string, string>
  /** 模型元信息：上下文窗口与价格，用于预算控制和计费 */
  models?: ModelInfo[]
  /** 首字节（响应头）超时，默认 60s */
  connectTimeoutMs?: number
  /** 两个流分片之间的最大间隔，默认 120s（推理模型思考时间较长） */
  idleTimeoutMs?: number
  /** 输出长度参数名：OpenAI 新模型用 max_completion_tokens，大多数兼容端点用 max_tokens */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  /** 是否把历史中的 reasoning 以 reasoning_content 回传（部分 DeepSeek 思考+工具模式需要） */
  sendReasoning?: boolean
  /** 自定义 fetch（测试或代理用） */
  fetch?: typeof fetch
  /** 显示名（leo models / doctor） */
  name?: string
  /** 未指定模型时用的模型 id */
  defaultModel?: string
  /** 当前状态（缺密钥等），注册层提供 */
  status?: () => ProviderStatusInfo
  /** 厂商参数：在通用请求体构造完之后、用户 providerOptions 合并之前改写请求体 */
  prepare?: (body: Record<string, unknown>, request: LlmRequest) => Record<string, unknown>
}

/**
 * OpenAI Chat Completions 兼容 Provider。
 * 适用于 OpenAI、DeepSeek、通义千问、Kimi、智谱、vLLM、SGLang、leo-inference 等兼容端点。
 */
export class OpenAICompatibleProvider implements LlmProvider {
  readonly id: string
  readonly name?: string
  readonly defaultModel?: string
  private readonly opts: OpenAICompatibleOptions

  constructor(opts: OpenAICompatibleOptions) {
    this.id = opts.id ?? 'openai'
    this.opts = opts
    if (opts.name) this.name = opts.name
    if (opts.defaultModel) this.defaultModel = opts.defaultModel
  }

  getModelInfo(model: string): ModelInfo | undefined {
    return this.opts.models?.find((m) => m.id === model)
  }

  listModels(): ModelInfo[] {
    return [...(this.opts.models ?? [])]
  }

  status(): ProviderStatusInfo {
    return this.opts.status?.() ?? { ready: true, baseURL: this.opts.baseURL }
  }

  async *stream(request: LlmRequest, opts: StreamOptions): AsyncGenerator<LlmStreamEvent> {
    const doFetch = this.opts.fetch ?? fetch
    const headers = this.headers()
    const controller = new AbortController()
    const onAbort = () => controller.abort(opts.signal.reason)
    if (opts.signal.aborted) throw LeoErrorCtor('cancelled', 'Request cancelled before start')
    opts.signal.addEventListener('abort', onAbort, { once: true })

    let timedOut: 'connect' | 'idle' | undefined
    let timer: NodeJS.Timeout | undefined
    const arm = (kind: 'connect' | 'idle', ms: number) => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        timedOut = kind
        controller.abort(LeoErrorCtor('timeout', `LLM ${kind} timeout after ${ms}ms`))
      }, ms)
    }

    try {
      arm('connect', this.opts.connectTimeoutMs ?? 60_000)
      let res: Response
      try {
        res = await doFetch(`${this.opts.baseURL.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(this.buildBody(request)),
          signal: controller.signal,
        })
      } catch (err) {
        throw this.mapThrown(err, timedOut, opts.signal)
      }
      if (!res.ok) throw await this.mapHttpError(res)
      if (!res.body) throw LeoErrorCtor('network', 'Empty response body')

      const idleMs = this.opts.idleTimeoutMs ?? 120_000
      arm('idle', idleMs)
      let finish: FinishReason | undefined
      try {
        for await (const data of parseSSE(res.body, controller.signal)) {
          arm('idle', idleMs)
          if (data === '[DONE]') break
          let chunk: ChatChunk
          try {
            chunk = JSON.parse(data) as ChatChunk
          } catch {
            continue
          }
          if (chunk.error) throw mapErrorPayload(chunk.error)
          if (chunk.usage) yield { type: 'usage', usage: mapUsage(chunk.usage) }
          for (const choice of chunk.choices ?? []) {
            const d = choice.delta ?? {}
            const reasoning = d.reasoning_content ?? d.reasoning
            if (reasoning) yield { type: 'reasoning_delta', text: reasoning }
            if (d.content) yield { type: 'text_delta', text: d.content }
            for (const tc of d.tool_calls ?? []) {
              const ev: LlmStreamEvent & { type: 'tool_call_delta' } = { type: 'tool_call_delta', index: tc.index ?? 0 }
              if (tc.id) ev.id = tc.id
              if (tc.function?.name) ev.name = tc.function.name
              if (tc.function?.arguments) ev.argumentsDelta = tc.function.arguments
              yield ev
            }
            if (choice.finish_reason) finish = mapFinish(choice.finish_reason)
          }
        }
      } catch (err) {
        throw this.mapThrown(err, timedOut, opts.signal)
      }
      yield { type: 'done', finishReason: finish ?? 'stop' }
    } finally {
      clearTimeout(timer)
      opts.signal.removeEventListener('abort', onAbort)
    }
  }

  private headers(): Record<string, string> {
    const raw = this.opts.apiKey
    const key = (typeof raw === 'function' ? raw() : raw) ?? (this.opts.apiKeyEnv ? process.env[this.opts.apiKeyEnv] : undefined)
    if (!key && this.opts.requireApiKey) {
      throw LeoErrorCtor(
        'auth',
        `No API key for provider "${this.id}". Run \`leo auth set ${this.id}\`${this.opts.apiKeyEnv ? ` or set ${this.opts.apiKeyEnv}` : ''}.`,
      )
    }
    const extra: Record<string, string> = {}
    for (const [k, v] of Object.entries(this.opts.headers ?? {})) {
      try {
        extra[k] = resolveValue(v)
      } catch (err) {
        throw LeoErrorCtor('auth', `Header ${k} of provider "${this.id}": ${(err as Error).message}`)
      }
    }
    return {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...extra,
    }
  }

  /** 构造请求体（公开以便测试与子类覆盖） */
  buildBody(req: LlmRequest): Record<string, unknown> {
    const messages: unknown[] = []
    if (req.system) messages.push({ role: 'system', content: req.system })
    for (const m of req.messages) messages.push(...this.convertMessage(m))
    const body: Record<string, unknown> = {
      model: req.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    }
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }))
      if (req.toolChoice) {
        body.tool_choice =
          typeof req.toolChoice === 'string' ? req.toolChoice : { type: 'function', function: { name: req.toolChoice.name } }
      }
    }
    if (req.maxOutputTokens !== undefined) body[this.opts.maxTokensField ?? 'max_tokens'] = req.maxOutputTokens
    if (req.temperature !== undefined) body.temperature = req.temperature
    if (req.topP !== undefined) body.top_p = req.topP
    if (req.stop?.length) body.stop = req.stop
    const prepared = this.opts.prepare ? this.opts.prepare(body, req) : body
    return { ...prepared, ...req.providerOptions }
  }

  private convertMessage(m: AgentMessage): unknown[] {
    switch (m.role) {
      case 'system':
        return [{ role: 'system', content: textContent(m.content) }]
      case 'user':
        return [{ role: 'user', content: userContent(m.content) }]
      case 'assistant': {
        const calls = m.content.filter((b) => b.type === 'tool_call')
        const out: Record<string, unknown> = { role: 'assistant', content: textContent(m.content) || null }
        if (calls.length) {
          out.tool_calls = calls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: c.rawArguments || '{}' },
          }))
        }
        if (this.opts.sendReasoning) {
          const r = m.content.filter((b) => b.type === 'reasoning').map((b) => b.text).join('')
          if (r) out.reasoning_content = r
        }
        return [out]
      }
      case 'tool':
        return [{ role: 'tool', tool_call_id: m.toolCallId, content: textContent(m.content) }]
      default:
        return []
    }
  }

  private async mapHttpError(res: Response): Promise<LeoError> {
    const text = await res.text().catch(() => '')
    let message = text.slice(0, 2000) || res.statusText
    let code: string | undefined
    try {
      const j = JSON.parse(text) as { error?: { message?: string; code?: string; type?: string } }
      if (j.error?.message) message = j.error.message
      code = j.error?.code ?? j.error?.type
    } catch {}
    const status = res.status
    const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'))
    const base = { status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}), details: { body: text.slice(0, 2000) } }
    if (status === 429) {
      // 余额/配额耗尽不是暂时性错误，不应重试
      if (code === 'insufficient_quota') return LeoErrorCtor('auth', message, base)
      return LeoErrorCtor('rate_limit', message, base)
    }
    if (status === 401 || status === 403 || status === 402) return LeoErrorCtor('auth', message, base)
    if (status === 408) return LeoErrorCtor('timeout', message, base)
    if (status >= 500) return LeoErrorCtor('overloaded', message, base)
    if (isContextOverflow(message, code)) return LeoErrorCtor('context_overflow', message, base)
    return LeoErrorCtor('invalid_request', message, base)
  }

  private mapThrown(err: unknown, timedOut: 'connect' | 'idle' | undefined, userSignal: AbortSignal): LeoError {
    if (isProviderError(err)) return err
    if (userSignal.aborted) return LeoErrorCtor('cancelled', 'LLM request cancelled', { cause: err })
    if (timedOut) return LeoErrorCtor('timeout', `LLM ${timedOut} timeout`, { cause: err })
    if (isAbortError(err)) return LeoErrorCtor('cancelled', 'LLM request aborted', { cause: err })
    return LeoErrorCtor('network', err instanceof Error ? err.message : String(err), { cause: err })
  }
}

function textContent(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

function userContent(blocks: ContentBlock[]): unknown {
  if (blocks.every((b) => b.type === 'text')) return textContent(blocks)
  return blocks.flatMap((b): Record<string, unknown>[] => {
    if (b.type === 'text') return [{ type: 'text', text: b.text }]
    if (b.type === 'image') return [{ type: 'image_url', image_url: { url: b.url } }]
    return []
  })
}

function isContextOverflow(message: string, code?: string): boolean {
  return (
    code === 'context_length_exceeded' ||
    /context[_ ]length|maximum context|context window|too many tokens|prompt is too long|reduce the length/i.test(message)
  )
}

function parseRetryAfter(v: string | null): number | undefined {
  if (!v) return undefined
  const s = Number(v)
  if (Number.isFinite(s)) return Math.max(0, s * 1000)
  const t = Date.parse(v)
  return Number.isNaN(t) ? undefined : Math.max(0, t - Date.now())
}

function mapFinish(r: string): FinishReason {
  if (r === 'stop' || r === 'tool_calls' || r === 'length' || r === 'content_filter') return r
  if (r === 'function_call') return 'tool_calls'
  return 'other'
}

function mapErrorPayload(e: { message?: string; code?: string | number; type?: string }): LeoError {
  const msg = e.message ?? 'Upstream stream error'
  if (isContextOverflow(msg, String(e.code ?? ''))) return LeoErrorCtor('context_overflow', msg)
  if (e.code === 429 || e.type === 'rate_limit_error') return LeoErrorCtor('rate_limit', msg)
  return LeoErrorCtor('overloaded', msg)
}

interface ChatChunk {
  choices?: {
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      reasoning?: string | null
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
    }
    finish_reason?: string | null
  }[]
  usage?: RawUsage
  error?: { message?: string; code?: string | number; type?: string }
}

interface RawUsage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_cache_hit_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

function mapUsage(u: RawUsage): Partial<Usage> {
  const out: Partial<Usage> = {
    inputTokens: u.prompt_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0,
  }
  const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens
  if (cached !== undefined) out.cachedInputTokens = cached
  if (u.completion_tokens_details?.reasoning_tokens !== undefined) out.reasoningTokens = u.completion_tokens_details.reasoning_tokens
  return out
}
