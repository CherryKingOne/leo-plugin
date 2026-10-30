/** JSON-RPC 2.0 消息与 MCP 连接抽象（与传输方式无关） */

export type RpcId = string | number

export interface RpcErrorObject {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: RpcId
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: RpcId | null
  result?: unknown
  error?: RpcErrorObject
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

export const isRequest = (m: JsonRpcMessage): m is JsonRpcRequest => 'method' in m && 'id' in m && m.id !== undefined && m.id !== null
export const isNotification = (m: JsonRpcMessage): m is JsonRpcNotification => 'method' in m && !('id' in m && m.id !== undefined && m.id !== null)
export const isResponse = (m: JsonRpcMessage): m is JsonRpcResponse => !('method' in m) && ('result' in m || 'error' in m)

/** MCP 2026-07-28 定义的错误码（-32020..-32099 保留给规范） */
export const MCP_ERRORS = {
  HeaderMismatch: -32020,
  MissingRequiredClientCapability: -32021,
  UnsupportedProtocolVersion: -32022,
} as const
export const MODERN_ERROR_CODES: ReadonlySet<number> = new Set(Object.values(MCP_ERRORS))

/** 服务器返回的 JSON-RPC 错误 */
export class RpcError extends Error {
  override name = 'RpcError'
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
    /** HTTP 传输下的状态码 */
    readonly httpStatus?: number,
  ) {
    super(message)
  }
  static from(e: RpcErrorObject, httpStatus?: number) {
    return new RpcError(e.code, e.message, e.data, httpStatus)
  }
}

/** 传输层失败：进程退出、网络错误、非 JSON-RPC 的 HTTP 错误、超时 */
export class TransportError extends Error {
  override name = 'TransportError'
  constructor(
    message: string,
    readonly info: { httpStatus?: number; body?: string; timeout?: boolean; closed?: boolean } = {},
  ) {
    super(message)
  }
}

export interface RequestOptions {
  signal?: AbortSignal
  timeoutMs?: number
  /** 与本请求相关的通知（进度、日志） */
  onNotification?(n: JsonRpcNotification): void
  /** HTTP 传输额外的请求头（Mcp-Name、Mcp-Param-*） */
  headers?: Record<string, string>
}

/** 服务器主动发来的请求（仅旧版协议），返回 result 或抛出 RpcError */
export type ServerRequestHandler = (req: JsonRpcRequest) => Promise<unknown>

export interface Connection {
  readonly kind: 'stdio' | 'http' | 'sse'
  readonly closed: boolean
  request(method: string, params: Record<string, unknown> | undefined, opts?: RequestOptions): Promise<unknown>
  notify(method: string, params?: Record<string, unknown>): Promise<void>
  close(): Promise<void>
  /** 旧版协议：服务器发来的请求 */
  onServerRequest?: ServerRequestHandler
  /** 不属于任何进行中请求的通知 */
  onNotification?: (n: JsonRpcNotification) => void
  /** 连接意外断开 */
  onClose?: (reason: Error) => void
  /** HTTP：随请求发送的 MCP-Protocol-Version；旧版握手成功后设置 */
  protocolVersion?: string
  /** 诊断信息（如 stderr 尾部） */
  diagnostics?(): string
}

export const METHOD_NOT_FOUND: RpcErrorObject = { code: -32601, message: 'Method not found' }

/** 进行中的请求表，供基于流的连接（stdio、旧版 SSE）复用 */
export class PendingRequests {
  private nextId = 1
  private readonly pending = new Map<RpcId, { resolve(v: unknown): void; reject(e: Error): void; opts: RequestOptions; progressToken?: RpcId }>()

  id(): number {
    return this.nextId++
  }

  add(id: RpcId, opts: RequestOptions, progressToken?: RpcId): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, opts, ...(progressToken !== undefined ? { progressToken } : {}) })
    })
  }

  has(id: RpcId) {
    return this.pending.has(id)
  }

  settle(res: JsonRpcResponse): boolean {
    if (res.id === null || res.id === undefined) return false
    const p = this.pending.get(res.id)
    if (!p) return false
    this.pending.delete(res.id)
    if (res.error) p.reject(RpcError.from(res.error))
    else p.resolve(res.result)
    return true
  }

  reject(id: RpcId, err: Error) {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    p.reject(err)
  }

  rejectAll(err: Error) {
    for (const [id] of this.pending) this.reject(id, err)
  }

  /** 进度通知按 progressToken 路由到对应请求；返回是否已路由 */
  route(n: JsonRpcNotification): boolean {
    const token = n.params?.progressToken as RpcId | undefined
    if (token === undefined) return false
    for (const p of this.pending.values()) {
      if (p.progressToken === token) {
        p.opts.onNotification?.(n)
        return true
      }
    }
    return false
  }
}

/** 解析 SSE 字节流为事件 */
export async function* parseSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<{ event: string; data: string; id?: string }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let event = ''
  let data: string[] = []
  let id: string | undefined
  const onAbort = () => void reader.cancel().catch(() => {})
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.search(/\r\n|\r|\n/)) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + (buf[nl] === '\r' && buf[nl + 1] === '\n' ? 2 : 1))
        if (line === '') {
          if (data.length) yield { event: event || 'message', data: data.join('\n'), ...(id !== undefined ? { id } : {}) }
          event = ''
          data = []
          continue
        }
        if (line.startsWith(':')) continue
        const colon = line.indexOf(':')
        const field = colon < 0 ? line : line.slice(0, colon)
        let val = colon < 0 ? '' : line.slice(colon + 1)
        if (val.startsWith(' ')) val = val.slice(1)
        if (field === 'event') event = val
        else if (field === 'data') data.push(val)
        else if (field === 'id') id = val
      }
    }
    if (data.length) yield { event: event || 'message', data: data.join('\n'), ...(id !== undefined ? { id } : {}) }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
}

/** 解析一条（或一批，旧版 2025-03-26 允许 batch）JSON-RPC 消息；非法内容返回空数组 */
export function parseMessages(text: string): JsonRpcMessage[] {
  try {
    const v = JSON.parse(text) as unknown
    const arr = Array.isArray(v) ? v : [v]
    return arr.filter((m): m is JsonRpcMessage => !!m && typeof m === 'object' && (m as { jsonrpc?: unknown }).jsonrpc === '2.0')
  } catch {
    return []
  }
}

/** 组合外部 signal 与超时，返回清理函数 */
export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number | undefined, onFire: (err: Error) => void): () => void {
  const cleanups: (() => void)[] = []
  if (timeoutMs) {
    const t = setTimeout(() => onFire(new TransportError(`request timed out after ${timeoutMs}ms`, { timeout: true })), timeoutMs)
    cleanups.push(() => clearTimeout(t))
  }
  if (signal) {
    const onAbort = () => onFire(signal.reason instanceof Error ? signal.reason : new TransportError('request cancelled'))
    if (signal.aborted) queueMicrotask(onAbort)
    else {
      signal.addEventListener('abort', onAbort, { once: true })
      cleanups.push(() => signal.removeEventListener('abort', onAbort))
    }
  }
  return () => cleanups.forEach((c) => c())
}
