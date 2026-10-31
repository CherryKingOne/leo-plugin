/** 渠道驱动共用的 HTTP 辅助：超时、取消、JSON 解析；错误信息里不包含请求体与 URL 查询串（可能含 token） */

export class ChannelHttpError extends Error {
  override name = 'ChannelHttpError'
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message)
  }
}

export interface JsonRequest {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: unknown
  signal?: AbortSignal
  timeoutMs: number
  /** 写在错误信息里的名字，如 `telegram sendMessage`；不要用含 token 的 URL */
  label: string
}

export async function requestJson<T = any>(fetchImpl: typeof fetch, url: string, req: JsonRequest): Promise<T> {
  const timeout = AbortSignal.timeout(req.timeoutMs)
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout
  let res: Response
  try {
    res = await fetchImpl(url, {
      method: req.method ?? (req.body === undefined ? 'GET' : 'POST'),
      headers: { ...(req.body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' }), ...req.headers },
      ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
      signal,
    })
  } catch (err) {
    if (req.signal?.aborted) throw new ChannelHttpError(`${req.label}: cancelled`)
    if (timeout.aborted) throw new ChannelHttpError(`${req.label}: timed out after ${req.timeoutMs}ms`)
    throw new ChannelHttpError(`${req.label}: ${(err as Error).message}`)
  }
  const text = await res.text()
  let data: unknown
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    data = undefined
  }
  if (!res.ok) {
    const detail = describeError(data) ?? `HTTP ${res.status}`
    throw new ChannelHttpError(`${req.label}: ${detail}`, res.status, data)
  }
  if (data === undefined) throw new ChannelHttpError(`${req.label}: invalid JSON response`, res.status)
  return data as T
}

/** 从常见的错误结构里挑出可读信息（不含密钥） */
function describeError(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined
  const d = data as Record<string, unknown>
  const msg = d.description ?? d.msg ?? d.message ?? d.errmsg ?? d.error
  const code = d.error_code ?? d.code ?? d.errcode ?? d.err_code
  if (msg === undefined && code === undefined) return undefined
  return [code !== undefined ? `code ${String(code)}` : '', msg !== undefined ? String(msg) : ''].filter(Boolean).join(': ')
}

/** 带过期时间的 access token 缓存：提前 refreshMarginMs 刷新，并发请求共享同一次刷新 */
export class TokenCache {
  private value: string | undefined
  private expiresAt = 0
  private pending: Promise<string> | undefined
  constructor(
    private readonly fetchToken: () => Promise<{ token: string; expiresInSec: number }>,
    private readonly refreshMarginMs = 60_000,
  ) {}

  async get(): Promise<string> {
    if (this.value && Date.now() < this.expiresAt - this.refreshMarginMs) return this.value
    this.pending ??= this.fetchToken()
      .then(({ token, expiresInSec }) => {
        this.value = token
        this.expiresAt = Date.now() + expiresInSec * 1000
        return token
      })
      .finally(() => {
        this.pending = undefined
      })
    return this.pending
  }

  invalidate(): void {
    this.value = undefined
    this.expiresAt = 0
  }
}
