/**
 * 双代际（dual-era）MCP 客户端。
 *
 * 版本与代际（MCP 以日期标识版本，没有官方的 "1.0 / 2.0"）：
 * - modern：2026-07-28 起（俗称 MCP 2.0）。无 initialize 握手、无会话，每个请求在
 *   `_meta` 中携带协议版本 / 客户端信息 / 客户端能力；`server/discover` 查询服务器信息。
 * - legacy：2025-11-25、2025-06-18、2025-03-26、2024-11-05（俗称 MCP 1.x）。
 *   先 `initialize` 协商版本，再发 `notifications/initialized`，之后在会话内请求。
 *
 * 探测流程（遵循 2026-07-28 Versioning: Backward Compatibility）：
 * - stdio：先发 `server/discover`（带 modern 版本）。返回结果 → modern；返回
 *   UnsupportedProtocolVersion → 用其 supported 列表中的 modern 版本重试；其他错误或超时 → legacy，发 initialize。
 * - HTTP：先 POST 一个 modern 请求（server/discover）。成功或返回已知的 modern 错误 → modern；
 *   其他 4xx / 非 modern 错误 → 对同一 URL 走 legacy Streamable HTTP 的 initialize；
 *   仍是 400/404/405 → 回退到 2024-11-05 的 HTTP+SSE（GET 等 endpoint 事件）。
 * 探测结果缓存在客户端实例上，重连时直接复用。
 */
import { type HeaderParam, extractHeaderParams, headerValues } from './headers.js'
import {
  type Connection,
  type JsonRpcNotification,
  type JsonRpcRequest,
  METHOD_NOT_FOUND,
  MCP_ERRORS,
  MODERN_ERROR_CODES,
  RpcError,
  TransportError,
} from './jsonrpc.js'
import { HttpConnection } from './transports/http.js'
import { LegacySseConnection } from './transports/sse.js'
import { StdioConnection } from './transports/stdio.js'

/** 本客户端支持的 modern 版本（新的在前） */
export const MODERN_VERSIONS = ['2026-07-28'] as const
/** 本客户端支持的 legacy 版本（新的在前） */
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const

const META = {
  protocolVersion: 'io.modelcontextprotocol/protocolVersion',
  clientInfo: 'io.modelcontextprotocol/clientInfo',
  clientCapabilities: 'io.modelcontextprotocol/clientCapabilities',
  serverInfo: 'io.modelcontextprotocol/serverInfo',
} as const

export type Era = 'modern' | 'legacy'

export interface McpTool {
  name: string
  title?: string
  description?: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  annotations?: {
    title?: string
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
  /** x-mcp-header 标注（仅 HTTP 使用） */
  headerParams?: HeaderParam[]
}

export interface McpContent {
  type: string
  text?: string
  data?: string
  mimeType?: string
  uri?: string
  name?: string
  resource?: { uri: string; mimeType?: string; text?: string; blob?: string }
  [k: string]: unknown
}

export interface CallToolResult {
  content: McpContent[]
  structuredContent?: unknown
  isError?: boolean
}

export type TransportSpec =
  | { kind: 'stdio'; command: string; args: string[]; env: Record<string, string>; cwd?: string }
  | { kind: 'http'; url: string; headers: Record<string, string>; sseOnly?: boolean }

export interface ClientOptions {
  name: string
  transport: TransportSpec
  protocol: 'auto' | 'modern' | 'legacy'
  protocolVersion?: string
  clientInfo: { name: string; version: string }
  connectTimeoutMs: number
  probeTimeoutMs: number
  fetch?: typeof fetch
  onStderr?(line: string): void
  onLog?(level: string, msg: string): void
  /** 服务器通知工具列表变化（legacy 推送） */
  onToolsChanged?(): void
  /** 连接意外断开 */
  onDisconnect?(err: Error): void
}

export interface ServerInfo {
  name?: string
  version?: string
  instructions?: string
  capabilities: Record<string, unknown>
}

export class McpClient {
  era?: Era
  protocolVersion?: string
  transportKind?: 'stdio' | 'http' | 'sse'
  server: ServerInfo = { capabilities: {} }
  private conn?: Connection
  private connecting?: Promise<void>
  private progressSeq = 0
  private closedByUser = false
  /** 握手完成后才把断开当作“意外断开”上报（探测阶段的进程退出不算） */
  private ready = false

  constructor(private readonly opts: ClientOptions) {}

  get connected() {
    return !!this.conn && !this.conn.closed
  }

  /** 建立连接（已连接则直接返回）；并发调用共享同一次连接 */
  connect(): Promise<void> {
    if (this.connected) return Promise.resolve()
    this.closedByUser = false
    this.connecting ??= this.doConnect().finally(() => (this.connecting = undefined))
    return this.connecting
  }

  private async doConnect(): Promise<void> {
    const deadline = AbortSignal.timeout(this.opts.connectTimeoutMs)
    const t = this.opts.transport
    this.ready = false
    try {
      if (t.kind === 'stdio') await this.connectStdio(t, deadline)
      else await this.connectHttp(t, deadline)
      this.ready = true
    } catch (err) {
      await this.conn?.close().catch(() => {})
      this.conn = undefined
      if (deadline.aborted && !(err instanceof RpcError)) {
        throw new TransportError(`timed out connecting after ${this.opts.connectTimeoutMs}ms${this.diag()}`, { timeout: true })
      }
      throw err
    }
  }

  private diag(): string {
    const d = this.conn?.diagnostics?.()
    return d ? `\n${d}` : ''
  }

  private wire(conn: Connection) {
    this.conn = conn
    this.transportKind = conn.kind
    conn.onServerRequest = (req) => this.onServerRequest(req)
    conn.onNotification = (n) => this.onNotification(n)
    conn.onClose = (err) => {
      if (this.conn !== conn) return
      this.conn = undefined
      if (this.ready && !this.closedByUser) this.opts.onDisconnect?.(err)
    }
  }

  // —— stdio ——

  private async connectStdio(t: Extract<TransportSpec, { kind: 'stdio' }>, deadline: AbortSignal) {
    const start = async () => {
      const conn = new StdioConnection({ command: t.command, args: t.args, env: t.env, ...(t.cwd ? { cwd: t.cwd } : {}), ...(this.opts.onStderr ? { onStderr: this.opts.onStderr } : {}) })
      this.wire(conn)
      await conn.start()
      return conn
    }
    let conn = await start()
    const want = this.wantEra()
    if (want !== 'legacy') {
      const probe = await this.probeModern(conn, deadline, Math.min(this.opts.probeTimeoutMs, this.opts.connectTimeoutMs))
      if (probe === 'modern') return
      if (want === 'modern') throw new TransportError(`server "${this.opts.name}" does not speak MCP ${this.modernVersion()} (protocol is set to "modern")`)
      // 有的旧服务器收到 initialize 之前的请求会直接退出，此时重启进程再握手
      if (conn.closed) conn = await start()
    }
    await this.initializeLegacy(conn, deadline)
  }

  // —— HTTP ——

  private async connectHttp(t: Extract<TransportSpec, { kind: 'http' }>, deadline: AbortSignal) {
    const want = this.wantEra()
    if (!t.sseOnly) {
      if (want !== 'legacy') {
        const conn = new HttpConnection(t.url, t.headers, this.opts.fetch)
        conn.modern = true
        this.wire(conn)
        const probe = await this.probeModern(conn, deadline)
        if (probe === 'modern') return
        if (want === 'modern') throw new TransportError(`server "${this.opts.name}" does not speak MCP ${this.modernVersion()} (protocol is set to "modern")`)
      }
      // legacy Streamable HTTP（2025-03-26 ~ 2025-11-25）
      const conn = new HttpConnection(t.url, t.headers, this.opts.fetch)
      this.wire(conn)
      try {
        await this.initializeLegacy(conn, deadline)
        conn.openListenStream()
        return
      } catch (err) {
        const status = err instanceof RpcError ? err.httpStatus : err instanceof TransportError ? err.info.httpStatus : undefined
        const modernErr = err instanceof RpcError && MODERN_ERROR_CODES.has(err.code)
        if (modernErr || !(status === 400 || status === 404 || status === 405)) throw err
      }
    }
    // 2024-11-05 HTTP+SSE
    const sse = new LegacySseConnection(t.url, t.headers, this.opts.fetch)
    this.wire(sse)
    const remaining = Math.max(1_000, this.opts.connectTimeoutMs)
    await sse.start(remaining)
    await this.initializeLegacy(sse, deadline, '2024-11-05')
  }

  private wantEra(): 'auto' | 'modern' | 'legacy' {
    // 代际是服务器的属性：探测过就复用（重连时不再等待 legacy 服务器的探测超时）
    if (this.era) return this.era
    const v = this.opts.protocolVersion
    if (v) return (MODERN_VERSIONS as readonly string[]).includes(v) || v >= MODERN_VERSIONS[MODERN_VERSIONS.length - 1]! ? 'modern' : 'legacy'
    return this.opts.protocol
  }

  private modernVersion(): string {
    return this.opts.protocolVersion && this.wantEra() === 'modern' ? this.opts.protocolVersion : MODERN_VERSIONS[0]
  }

  /**
   * 用 server/discover 探测 modern 服务器。返回 'modern' 表示已确定并完成版本选择，
   * 'legacy' 表示应回退到 initialize。
   */
  private async probeModern(conn: Connection, deadline: AbortSignal, timeoutMs?: number): Promise<Era> {
    let version = this.modernVersion()
    for (let attempt = 0; attempt < 2; attempt++) {
      conn.protocolVersion = version // HTTP 需要 MCP-Protocol-Version 头与 _meta 一致
      try {
        const res = (await conn.request('server/discover', this.withMeta({}, version), { signal: deadline, ...(timeoutMs ? { timeoutMs } : {}) })) as Record<string, unknown>
        if (!res || typeof res !== 'object') return 'legacy'
        const supported = Array.isArray(res.supportedVersions) ? (res.supportedVersions as string[]) : [version]
        const pick = supported.includes(version) ? version : pickModern(supported)
        if (!pick) return 'legacy'
        this.useModern(conn, pick, res)
        return 'modern'
      } catch (err) {
        if (deadline.aborted) throw err
        if (err instanceof RpcError && err.code === MCP_ERRORS.UnsupportedProtocolVersion) {
          const supported = ((err.data as { supported?: string[] } | undefined)?.supported ?? []).filter((v) => typeof v === 'string')
          const pick = pickModern(supported)
          if (pick && pick !== version) {
            version = pick
            continue
          }
          // 只支持 legacy 版本的 dual-era 服务器：走 initialize
          if (supported.some((v) => (LEGACY_VERSIONS as readonly string[]).includes(v))) return 'legacy'
          throw new TransportError(`server "${this.opts.name}" supports protocol versions [${supported.join(', ')}], none of which this client speaks`)
        }
        if (err instanceof RpcError && MODERN_ERROR_CODES.has(err.code)) {
          throw new TransportError(`server "${this.opts.name}" rejected the request: ${err.message}`)
        }
        // stdio 进程直接退出 / 超时 / 其他错误：视为 legacy
        if (err instanceof TransportError && err.info.closed && conn.kind !== 'stdio') throw err
        return 'legacy'
      }
    }
    return 'legacy'
  }

  private useModern(conn: Connection, version: string, discover: Record<string, unknown>) {
    this.era = 'modern'
    this.protocolVersion = version
    conn.protocolVersion = version
    const meta = (discover._meta ?? {}) as Record<string, unknown>
    const info = (meta[META.serverInfo] ?? discover.serverInfo ?? {}) as { name?: string; version?: string }
    this.server = {
      ...(info.name ? { name: info.name } : {}),
      ...(info.version ? { version: info.version } : {}),
      ...(typeof discover.instructions === 'string' ? { instructions: discover.instructions } : {}),
      capabilities: (discover.capabilities ?? {}) as Record<string, unknown>,
    }
  }

  private async initializeLegacy(conn: Connection, deadline: AbortSignal, preferred?: string) {
    const requested = this.opts.protocolVersion && this.wantEra() === 'legacy' ? this.opts.protocolVersion : (preferred ?? LEGACY_VERSIONS[0])
    const res = (await conn.request(
      'initialize',
      { protocolVersion: requested, capabilities: {}, clientInfo: this.opts.clientInfo },
      { signal: deadline },
    )) as { protocolVersion?: string; capabilities?: Record<string, unknown>; serverInfo?: { name?: string; version?: string }; instructions?: string }
    const version = res?.protocolVersion
    if (!version || !(LEGACY_VERSIONS as readonly string[]).includes(version)) {
      throw new TransportError(`server "${this.opts.name}" negotiated unsupported protocol version ${version ?? '(none)'}`)
    }
    this.era = 'legacy'
    this.protocolVersion = version
    conn.protocolVersion = version
    this.server = {
      ...(res.serverInfo?.name ? { name: res.serverInfo.name } : {}),
      ...(res.serverInfo?.version ? { version: res.serverInfo.version } : {}),
      ...(typeof res.instructions === 'string' ? { instructions: res.instructions } : {}),
      capabilities: res.capabilities ?? {},
    }
    await conn.notify('notifications/initialized')
  }

  /** modern：每个请求的 params._meta 携带版本、客户端信息与能力 */
  private withMeta(params: Record<string, unknown>, version = this.protocolVersion): Record<string, unknown> {
    const meta = { ...((params._meta as Record<string, unknown>) ?? {}) }
    meta[META.protocolVersion] = version
    meta[META.clientInfo] = this.opts.clientInfo
    meta[META.clientCapabilities] = {}
    return { ...params, _meta: meta }
  }

  private async onServerRequest(req: JsonRpcRequest): Promise<unknown> {
    // 仅 legacy 服务器会主动发请求。我们没有声明 sampling / roots / elicitation 能力
    if (req.method === 'ping') return {}
    throw RpcError.from(METHOD_NOT_FOUND)
  }

  private onNotification(n: JsonRpcNotification) {
    if (n.method === 'notifications/tools/list_changed') this.opts.onToolsChanged?.()
    else if (n.method === 'notifications/message') {
      const p = n.params ?? {}
      this.opts.onLog?.(String(p.level ?? 'info'), typeof p.data === 'string' ? p.data : JSON.stringify(p.data))
    }
  }

  /** 发送请求；modern 下处理版本变更（-32022）后重试一次，连接断开时自动重连一次 */
  private async request(method: string, params: Record<string, unknown>, opts: { signal?: AbortSignal; timeoutMs?: number; onNotification?(n: JsonRpcNotification): void; headers?: Record<string, string> } = {}): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      await this.connect()
      const conn = this.conn!
      const p = this.era === 'modern' ? this.withMeta(params) : params
      try {
        return await conn.request(method, p, opts)
      } catch (err) {
        if (attempt > 0 || opts.signal?.aborted) throw err
        if (this.era === 'modern' && err instanceof RpcError && err.code === MCP_ERRORS.UnsupportedProtocolVersion) {
          const pick = pickModern(((err.data as { supported?: string[] } | undefined)?.supported ?? []))
          if (!pick) throw err
          this.protocolVersion = pick
          conn.protocolVersion = pick
          continue
        }
        // 进程退出 / 会话过期：重连后重试（modern 无状态，legacy 重新握手）
        if (err instanceof TransportError && err.info.closed) {
          await conn.close().catch(() => {})
          if (this.conn === conn) this.conn = undefined
          continue
        }
        throw err
      }
    }
  }

  /** 拉取全部工具（处理分页）。HTTP 下会校验 x-mcp-header，标注不合法的工具被排除 */
  async listTools(onInvalid?: (tool: string, reason: string) => void): Promise<McpTool[]> {
    const out: McpTool[] = []
    let cursor: string | undefined
    for (let page = 0; page < 100; page++) {
      const res = (await this.request('tools/list', cursor ? { cursor } : {}, { timeoutMs: this.opts.connectTimeoutMs })) as { tools?: McpTool[]; nextCursor?: string }
      for (const t of res?.tools ?? []) {
        if (!t || typeof t.name !== 'string') continue
        const tool: McpTool = { ...t, inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object' } }
        if (this.transportKind === 'http' && this.era === 'modern') {
          try {
            const hp = extractHeaderParams(tool.inputSchema)
            if (hp.length) tool.headerParams = hp
          } catch (err) {
            onInvalid?.(tool.name, (err as Error).message)
            continue
          }
        }
        out.push(tool)
      }
      if (!res?.nextCursor) break
      cursor = res.nextCursor
    }
    return out
  }

  async callTool(
    tool: McpTool,
    args: Record<string, unknown>,
    opts: { signal?: AbortSignal; timeoutMs?: number; onProgress?(p: { progress: number; total?: number; message?: string }): void } = {},
  ): Promise<CallToolResult> {
    const progressToken = `leo-${++this.progressSeq}`
    const headers = tool.headerParams && this.transportKind === 'http' && this.era === 'modern' ? headerValues(tool.headerParams, args) : undefined
    const res = (await this.request(
      'tools/call',
      { name: tool.name, arguments: args, _meta: { progressToken } },
      {
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
        ...(headers ? { headers } : {}),
        onNotification: (n) => {
          if (n.method === 'notifications/progress' && opts.onProgress) {
            const p = n.params ?? {}
            opts.onProgress({
              progress: Number(p.progress ?? 0),
              ...(typeof p.total === 'number' ? { total: p.total } : {}),
              ...(typeof p.message === 'string' ? { message: p.message } : {}),
            })
          }
        },
      },
    )) as Record<string, unknown>
    if (res?.resultType === 'input_required') {
      // MRTR：服务器需要客户端输入（采样 / 表单 / roots），本客户端没有声明这些能力
      const kinds = Object.values((res.inputRequests ?? {}) as Record<string, { method?: string }>).map((r) => r?.method ?? 'unknown')
      return { isError: true, content: [{ type: 'text', text: `MCP server requires client input (${kinds.join(', ') || 'unknown'}), which leo does not support yet.` }] }
    }
    return {
      content: Array.isArray(res?.content) ? (res.content as McpContent[]) : [],
      ...(res && 'structuredContent' in res ? { structuredContent: res.structuredContent } : {}),
      ...(res?.isError === true ? { isError: true } : {}),
    }
  }

  async close(): Promise<void> {
    this.closedByUser = true
    const conn = this.conn
    this.conn = undefined
    await conn?.close().catch(() => {})
  }
}

function pickModern(supported: string[]): string | undefined {
  return MODERN_VERSIONS.find((v) => supported.includes(v))
}
