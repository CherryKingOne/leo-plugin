/** 基于单一双向消息流的连接（stdio、旧版 HTTP+SSE）共用的请求/响应路由 */
import {
  type Connection,
  isNotification,
  isRequest,
  isResponse,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  METHOD_NOT_FOUND,
  PendingRequests,
  RpcError,
  type RequestOptions,
  type ServerRequestHandler,
  TransportError,
  withTimeout,
} from '../jsonrpc.js'

export abstract class StreamConnection implements Connection {
  abstract readonly kind: 'stdio' | 'sse'
  protected readonly pending = new PendingRequests()
  protected _closed = false
  onServerRequest?: ServerRequestHandler
  onNotification?: (n: JsonRpcNotification) => void
  onClose?: (reason: Error) => void
  protocolVersion?: string

  get closed() {
    return this._closed
  }

  /** 发送一条消息；失败时抛出 */
  protected abstract write(msg: JsonRpcMessage): Promise<void>
  abstract close(): Promise<void>

  async request(method: string, params: Record<string, unknown> | undefined, opts: RequestOptions = {}): Promise<unknown> {
    if (this._closed) throw new TransportError('connection is closed', { closed: true })
    const id = this.pending.id()
    const meta = params?._meta as Record<string, unknown> | undefined
    const progressToken = meta?.progressToken as string | number | undefined
    const done = this.pending.add(id, opts, progressToken)
    const cleanup = withTimeout(opts.signal, opts.timeoutMs, (err) => {
      if (!this.pending.has(id)) return
      this.pending.reject(id, err)
      // 告诉服务器放弃这个请求（stdio 规范要求；旧版 SSE 同样适用）
      void this.write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: err.message } }).catch(() => {})
    })
    try {
      await this.write({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })
    } catch (err) {
      this.pending.reject(id, err as Error)
    }
    try {
      return await done
    } finally {
      cleanup()
    }
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    if (this._closed) throw new TransportError('connection is closed', { closed: true })
    await this.write({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })
  }

  /** 子类收到一条消息时调用 */
  protected dispatch(msg: JsonRpcMessage) {
    if (isResponse(msg)) {
      this.pending.settle(msg)
    } else if (isRequest(msg)) {
      void this.answer(msg)
    } else if (isNotification(msg)) {
      if (!this.pending.route(msg)) this.onNotification?.(msg)
    }
  }

  private async answer(req: JsonRpcRequest) {
    try {
      if (!this.onServerRequest) throw RpcError.from(METHOD_NOT_FOUND)
      const result = await this.onServerRequest(req)
      await this.write({ jsonrpc: '2.0', id: req.id, result: result ?? {} })
    } catch (err) {
      const e = err instanceof RpcError ? { code: err.code, message: err.message } : { code: -32603, message: (err as Error).message }
      await this.write({ jsonrpc: '2.0', id: req.id, error: e }).catch(() => {})
    }
  }

  /** 子类在连接断开时调用 */
  protected terminate(reason: Error) {
    if (this._closed) return
    this._closed = true
    this.pending.rejectAll(reason)
    this.onClose?.(reason)
  }
}
