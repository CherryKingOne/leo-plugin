/**
 * 已弃用的 HTTP+SSE 传输（协议 2024-11-05）：GET 打开 SSE 流，首个 `endpoint` 事件给出 POST 地址，
 * 之后客户端消息 POST 到该地址，服务器消息（含响应）都从 SSE 流返回。
 * 仅用于连接还没升级的老服务器。
 */
import { type JsonRpcMessage, parseMessages, parseSse, TransportError } from '../jsonrpc.js'
import { StreamConnection } from './stream.js'

export class LegacySseConnection extends StreamConnection {
  readonly kind = 'sse' as const
  private readonly ac = new AbortController()
  private endpoint?: string

  constructor(
    readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    super()
  }

  /** 打开 SSE 流并等待 endpoint 事件 */
  async start(timeoutMs: number): Promise<void> {
    const timer = setTimeout(() => this.ac.abort(new TransportError(`no "endpoint" event from ${this.url} within ${timeoutMs}ms`, { timeout: true })), timeoutMs)
    let res: Response
    try {
      res = await this.fetchImpl(this.url, { method: 'GET', headers: { ...this.headers, accept: 'text/event-stream' }, signal: this.ac.signal })
    } catch (err) {
      clearTimeout(timer)
      throw this.ac.signal.aborted ? this.ac.signal.reason : new TransportError(`GET ${this.url} failed: ${(err as Error).message}`)
    }
    if (!res.ok || !res.body || !(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      clearTimeout(timer)
      await res.body?.cancel().catch(() => {})
      throw new TransportError(`GET ${this.url} did not open an SSE stream (HTTP ${res.status})`, { httpStatus: res.status })
    }
    const events = parseSse(res.body, this.ac.signal)
    try {
      for (;;) {
        const { value, done } = await events.next()
        if (done) throw new TransportError(`SSE stream from ${this.url} closed before the "endpoint" event`)
        if (value.event !== 'endpoint') continue
        const ep = new URL(value.data.trim(), this.url)
        if (ep.origin !== new URL(this.url).origin) throw new TransportError(`refusing cross-origin endpoint ${ep.origin}`)
        this.endpoint = ep.href
        break
      }
    } catch (err) {
      clearTimeout(timer)
      this.ac.abort()
      throw this.ac.signal.reason instanceof TransportError ? this.ac.signal.reason : err
    }
    clearTimeout(timer)
    // 后台读取剩余事件
    void (async () => {
      try {
        for await (const ev of events) if (ev.event === 'message') for (const m of parseMessages(ev.data)) this.dispatch(m)
        this.terminate(new TransportError('SSE stream closed by server', { closed: true }))
      } catch (err) {
        this.terminate(new TransportError(`SSE stream error: ${(err as Error).message}`, { closed: true }))
      }
    })()
  }

  protected async write(msg: JsonRpcMessage): Promise<void> {
    if (!this.endpoint || this._closed) throw new TransportError('SSE connection is not open', { closed: true })
    const h: Record<string, string> = { ...this.headers, 'content-type': 'application/json' }
    if (this.protocolVersion) h['mcp-protocol-version'] = this.protocolVersion
    let res: Response
    try {
      res = await this.fetchImpl(this.endpoint, { method: 'POST', headers: h, body: JSON.stringify(msg) })
    } catch (err) {
      throw new TransportError(`POST ${this.endpoint} failed: ${(err as Error).message}`)
    }
    const body = await res.text().catch(() => '')
    if (!res.ok) throw new TransportError(`POST ${this.endpoint} returned HTTP ${res.status}${body ? `: ${body.slice(0, 300)}` : ''}`, { httpStatus: res.status })
  }

  async close(): Promise<void> {
    this.terminate(new TransportError('connection closed', { closed: true }))
    this.ac.abort()
  }
}
