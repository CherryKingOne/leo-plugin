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

/** 读取要上传的图片：http(s) 地址下载，data URL 直接解码（0.3.0 起，给需要先上传图片的平台用） */
export async function loadImage(fetchImpl: typeof fetch, url: string, opts: { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number } = {}): Promise<{ bytes: Buffer; mimeType: string; fileName: string }> {
  const max = opts.maxBytes ?? 10 * 1024 * 1024
  const data = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url)
  if (data) {
    const mimeType = data[1] || 'image/png'
    const bytes = data[2] ? Buffer.from(data[3]!, 'base64') : Buffer.from(decodeURIComponent(data[3]!), 'utf8')
    if (bytes.length > max) throw new ChannelHttpError(`image too large (${bytes.length} bytes)`)
    return { bytes, mimeType, fileName: `image.${mimeType.split('/')[1] ?? 'png'}` }
  }
  if (!/^https?:/i.test(url)) throw new ChannelHttpError('image url must be http(s) or a data URL')
  const signal = AbortSignal.any([AbortSignal.timeout(opts.timeoutMs ?? 30_000), ...(opts.signal ? [opts.signal] : [])])
  const res = await fetchImpl(url, { signal })
  if (!res.ok) throw new ChannelHttpError(`download image: HTTP ${res.status}`, res.status)
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.length > max) throw new ChannelHttpError(`image too large (${bytes.length} bytes)`)
  const mimeType = res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png'
  const fileName = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'image.png')
  return { bytes, mimeType, fileName }
}
