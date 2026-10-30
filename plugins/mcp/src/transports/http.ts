/**
 * Streamable HTTP 传输：每条消息一次 POST，响应为 JSON 或本请求专属的 SSE 流。
 *
 * - 2026-07-28（modern）：无会话；每个请求带 MCP-Protocol-Version、Mcp-Method、Mcp-Name 等镜像头
 * - 2025-03-26 ~ 2025-11-25（legacy）：initialize 返回 Mcp-Session-Id，之后每个请求带上；
 *   服务器可能在 SSE 中发来请求（ping 等），由 onServerRequest 应答并 POST 回去；关闭时 DELETE 会话
 */
import {
  type Connection,
  isNotification,
  isRequest,
  isResponse,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  METHOD_NOT_FOUND,
  parseMessages,
  parseSse,
  RpcError,
  type RequestOptions,
  type ServerRequestHandler,
  TransportError,
  withTimeout,
} from '../jsonrpc.js'

const ACCEPT = 'application/json, text/event-stream'

/** 头部值编码：不能安全放进 HTTP 头的值用 `=?base64?...?=`（MCP 2026-07-28 Value Encoding） */
export function encodeHeaderValue(v: string): string {
  const safe = /^[\x20-\x7E\t]*$/.test(v) && v === v.trim() && !(v.startsWith('=?base64?') && v.endsWith('?='))
  return safe ? v : `=?base64?${Buffer.from(v, 'utf8').toString('base64')}?=`
}

export class HttpConnection implements Connection {
  readonly kind = 'http' as const
  private nextId = 1
  private _closed = false
  private readonly inflight = new Set<AbortController>()
  private listen?: AbortController
  /** legacy：服务器分配的会话 */
  sessionId?: string
  /** true 时按 2026-07-28 发送 Mcp-Method / Mcp-Name 镜像头 */
  modern = false
  protocolVersion?: string
  onServerRequest?: ServerRequestHandler
  onNotification?: (n: JsonRpcNotification) => void
  onClose?: (reason: Error) => void

  constructor(
    readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get closed() {
    return this._closed
  }

  private buildHeaders(msg: JsonRpcRequest | JsonRpcNotification | JsonRpcMessage, extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { ...this.headers, 'content-type': 'application/json', accept: ACCEPT }
    if (this.protocolVersion) h['mcp-protocol-version'] = this.protocolVersion
    if (this.sessionId) h['mcp-session-id'] = this.sessionId
    if (this.modern && 'method' in msg) {
      h['mcp-method'] = msg.method
      const p = msg.params ?? {}
      const name = msg.method === 'resources/read' ? p.uri : msg.method === 'tools/call' || msg.method === 'prompts/get' ? p.name : undefined
      if (typeof name === 'string') h['mcp-name'] = encodeHeaderValue(name)
    }
    return { ...h, ...extra }
  }

  private async post(msg: JsonRpcMessage, signal: AbortSignal, extra?: Record<string, string>): Promise<Response> {
    try {
      return await this.fetchImpl(this.url, { method: 'POST', headers: this.buildHeaders(msg, extra), body: JSON.stringify(msg), signal })
    } catch (err) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new TransportError('request cancelled')
      throw new TransportError(`HTTP request to ${this.url} failed: ${(err as Error).message}`)
    }
  }

  /** 非 2xx：能解析出 JSON-RPC 错误则抛 RpcError（带状态码），否则 TransportError */
  private async fail(res: Response): Promise<never> {
    const body = await res.text().catch(() => '')
    // legacy：带会话的请求返回 404 表示会话已失效，需要重新 initialize
    if (res.status === 404 && this.sessionId && !this.modern) {
      this.sessionId = undefined
      throw new TransportError(`MCP session expired (HTTP 404 from ${this.url})`, { httpStatus: 404, body, closed: true })
    }
    const err = parseMessages(body).find((m) => isResponse(m) && m.error)
    if (err && isResponse(err) && err.error) throw RpcError.from(err.error, res.status)
    throw new TransportError(`HTTP ${res.status} from ${this.url}${body ? `: ${body.slice(0, 300)}` : ''}`, { httpStatus: res.status, body })
  }

  async request(method: string, params: Record<string, unknown> | undefined, opts: RequestOptions = {}): Promise<unknown> {
    if (this._closed) throw new TransportError('connection is closed', { closed: true })
    const id = this.nextId++
    const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }
    const ac = new AbortController()
    this.inflight.add(ac)
    const cleanup = withTimeout(opts.signal, opts.timeoutMs, (err) => ac.abort(err))
    try {
      const res = await this.post(msg, ac.signal, opts.headers)
      const sid = res.headers.get('mcp-session-id')
      if (sid && !this.modern) this.sessionId = sid
      if (!res.ok) await this.fail(res)
      const type = res.headers.get('content-type') ?? ''
      if (type.includes('text/event-stream')) {
        if (!res.body) throw new TransportError('empty SSE response')
        for await (const ev of parseSse(res.body, ac.signal)) {
          for (const m of parseMessages(ev.data)) {
            if (isResponse(m) && m.id === id) {
              ac.abort() // 关闭流（modern：关闭即结束本请求）
              if (m.error) throw RpcError.from(m.error)
              return m.result
            }
            this.handleIncoming(m, opts)
          }
        }
        if (ac.signal.aborted) throw ac.signal.reason
        throw new TransportError(`SSE stream ended without a response to ${method}`)
      }
      const text = await res.text()
      const msgs = parseMessages(text)
      for (const m of msgs) {
        if (isResponse(m) && m.id === id) {
          if (m.error) throw RpcError.from(m.error, res.status)
          return m.result
        }
        this.handleIncoming(m, opts)
      }
      throw new TransportError(`HTTP ${res.status} response did not contain a JSON-RPC reply to ${method}`, { httpStatus: res.status, body: text })
    } catch (err) {
      if (err instanceof TransportError && err.info.closed) this.terminate(err)
      if (ac.signal.aborted && !(err instanceof RpcError) && !(err instanceof TransportError)) {
        const r = ac.signal.reason
        throw r instanceof Error ? r : new TransportError('request cancelled')
      }
      throw err
    } finally {
      cleanup()
      this.inflight.delete(ac)
    }
  }

  private handleIncoming(m: JsonRpcMessage, opts?: RequestOptions) {
    if (isRequest(m)) void this.answer(m)
    else if (isNotification(m)) {
      if (m.params?.progressToken !== undefined && opts?.onNotification) opts.onNotification(m)
      else if (opts?.onNotification && m.method === 'notifications/message') opts.onNotification(m)
      else this.onNotification?.(m)
    }
  }

  private async answer(req: JsonRpcRequest) {
    let reply: JsonRpcMessage
    try {
      if (!this.onServerRequest) throw RpcError.from(METHOD_NOT_FOUND)
      reply = { jsonrpc: '2.0', id: req.id, result: (await this.onServerRequest(req)) ?? {} }
    } catch (err) {
      const e = err instanceof RpcError ? { code: err.code, message: err.message } : { code: -32603, message: (err as Error).message }
      reply = { jsonrpc: '2.0', id: req.id, error: e }
    }
    const ac = new AbortController()
    await this.post(reply, ac.signal).then((r) => r.body?.cancel()).catch(() => {})
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    if (this._closed) throw new TransportError('connection is closed', { closed: true })
    const ac = new AbortController()
    const res = await this.post({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }, ac.signal)
    if (!res.ok) await this.fail(res)
    await res.body?.cancel().catch(() => {})
  }

  /**
   * legacy：尝试打开 GET 流接收服务器主动消息（tools/list_changed 等）。
   * 服务器不支持（405）时静默放弃。modern 协议没有这个端点
   */
  openListenStream(): void {
    if (this.modern || this.listen || this._closed) return
    const ac = new AbortController()
    this.listen = ac
    void (async () => {
      try {
        const h: Record<string, string> = { ...this.headers, accept: 'text/event-stream' }
        if (this.protocolVersion) h['mcp-protocol-version'] = this.protocolVersion
        if (this.sessionId) h['mcp-session-id'] = this.sessionId
        const res = await this.fetchImpl(this.url, { method: 'GET', headers: h, signal: ac.signal })
        if (!res.ok || !res.body || !(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
          await res.body?.cancel().catch(() => {})
          return
        }
        for await (const ev of parseSse(res.body, ac.signal)) for (const m of parseMessages(ev.data)) this.handleIncoming(m)
      } catch {
        // 监听流是尽力而为
      } finally {
        if (this.listen === ac) this.listen = undefined
      }
    })()
  }

  private terminate(reason: Error) {
    if (this._closed) return
    this._closed = true
    this.onClose?.(reason)
  }

  async close(): Promise<void> {
    if (this._closed && !this.sessionId) return
    this._closed = true
    this.listen?.abort()
    for (const ac of this.inflight) ac.abort(new TransportError('connection closed', { closed: true }))
    if (this.sessionId) {
      const h: Record<string, string> = { ...this.headers, 'mcp-session-id': this.sessionId }
      if (this.protocolVersion) h['mcp-protocol-version'] = this.protocolVersion
      this.sessionId = undefined
      await this.fetchImpl(this.url, { method: 'DELETE', headers: h, signal: AbortSignal.timeout(3_000) })
        .then((r) => r.body?.cancel())
        .catch(() => {})
    }
  }
}
