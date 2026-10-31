/**
 * 网关控制面：一个端口同时承载（与 OpenClaw Gateway 的单端口复用一致）
 *
 * - 渠道 webhook 回调：`<hooksPath>/<account>`（平台自己校验签名，不需要网关令牌）
 * - HTTP API：`/health`、`/v1/status`、`/v1/sessions`、`/v1/chat`（可 SSE 流式）、`/v1/send`、`/v1/pairing` …
 * - OpenAI 兼容：`POST /v1/chat/completions`、`GET /v1/models`（任何 OpenAI 客户端把 Base URL 指到 `/v1` 即可）
 * - WebSocket：`/ws`，JSON 帧 `{type:"req",id,method,params}` → `{type:"res",id,ok,payload|error}`，
 *   服务端推送 `{type:"event",event,payload}`；第一帧必须是 `connect`
 *
 * 安全：默认只监听 127.0.0.1；设置了 token 时除 /health 与 webhook 外都要带令牌；
 * 监听非本机地址却没有 token 时拒绝启动。
 */
import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Logger } from 'leo-agents'
import type { ServerConfig } from './config.js'
import type { GatewayService, GatewayStreamEvent, WebhookHandler, WebhookRequest } from './types.js'
import { acceptWebSocket, type WsConnection } from './ws.js'

export const PROTOCOL_VERSION = 1

export interface ControlApi {
  service: GatewayService
  resolveApproval(sessionKey: string, approved: boolean): boolean
  /** 订阅网关事件（WebSocket 广播用）；返回取消函数 */
  subscribe(fn: (event: string, payload: unknown) => void): () => void
  info(): Record<string, unknown>
  /** OpenAI 兼容接口里展示的模型名 */
  modelName(): string
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

export class GatewayServer {
  private server: Server | undefined
  private readonly hooks = new Map<string, WebhookHandler>()
  private readonly sockets = new Set<WsConnection>()

  constructor(
    private readonly config: ServerConfig,
    private readonly token: string | undefined,
    private readonly api: ControlApi,
    private readonly logger: Logger,
  ) {}

  hookPath(account: string): string {
    return `${this.config.hooksPath.replace(/\/+$/, '')}/${account}`
  }

  async mountHook(account: string, handler: WebhookHandler): Promise<{ path: string; unmount(): Promise<void> }> {
    if (!this.server) throw new Error(`gateway server is disabled; account "${account}" needs it for webhook mode (set server.enabled to true)`)
    const path = this.hookPath(account)
    if (this.hooks.has(path)) throw new Error(`webhook path already mounted: ${path}`)
    this.hooks.set(path, handler)
    return {
      path,
      unmount: async () => {
        this.hooks.delete(path)
      },
    }
  }

  address(): { host: string; port: number } | undefined {
    const a = this.server?.address()
    return a && typeof a === 'object' ? { host: a.address, port: a.port } : undefined
  }

  async start(): Promise<void> {
    if (!LOOPBACK.has(this.config.host) && !this.token) {
      throw new Error(`gateway: refusing to listen on ${this.config.host} without server.token (set it to a secret reference like "$LEO_GATEWAY_TOKEN")`)
    }
    const server = createServer((req, res) => void this.handle(req, res))
    server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.config.port, this.config.host, () => {
        server.off('error', reject)
        server.on('error', (err) => this.logger.error({ err: err.message }, 'gateway: server error'))
        resolve()
      })
    }).catch((err: Error) => {
      throw new Error(`gateway: cannot listen on ${this.config.host}:${this.config.port}: ${err.message}`)
    })
    this.server = server
    const a = this.address()
    this.logger.info({ host: a?.host, port: a?.port }, 'gateway: control plane listening')
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.close(1001, 'gateway stopping')
    this.sockets.clear()
    const server = this.server
    this.server = undefined
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
  }

  // ———————————————————————————————————————— HTTP ————————————————————————————————————————

  private authorized(req: IncomingMessage): boolean {
    if (!this.token) return true
    const h = req.headers.authorization ?? ''
    const m = /^Bearer\s+(.+)$/i.exec(h)
    const given = m?.[1] ?? (req.headers['x-leo-gateway-token'] as string | undefined) ?? ''
    return safeEqual(given, this.token)
  }

  private cors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin
    if (origin && (this.config.corsOrigins.includes(origin) || this.config.corsOrigins.includes('*'))) {
      res.setHeader('access-control-allow-origin', origin)
      res.setHeader('access-control-allow-headers', 'authorization, content-type, x-session-key')
      res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS')
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.replace(/\/+$/, '') || '/'
    try {
      const hook = this.hooks.get(path)
      if (hook) return await this.handleHook(hook, req, res, url)
      this.cors(req, res)
      if (req.method === 'OPTIONS') return void res.writeHead(204).end()
      if (path === '/health' || path === '/healthz') return json(res, 200, { ok: true })
      if (!this.authorized(req)) throw new HttpError(401, 'unauthorized', 'missing or invalid gateway token')
      await this.route(req, res, path, url)
    } catch (err) {
      if (res.headersSent) return void res.end()
      if (err instanceof HttpError) return json(res, err.status, { error: { code: err.code, message: err.message } })
      this.logger.warn({ path, err: (err as Error).message }, 'gateway: request failed')
      json(res, 500, { error: { code: 'internal', message: (err as Error).message } })
    }
  }

  private async handleHook(hook: WebhookHandler, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'POST') return void res.writeHead(405).end()
    let body: Buffer
    try {
      body = await readBody(req, this.config.maxBodyBytes)
    } catch {
      return void res.writeHead(413).end()
    }
    const headers: Record<string, string | undefined> = {}
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : v
    const request: WebhookRequest = { method: req.method, headers, query: url.searchParams, body }
    try {
      const out = await hook(request)
      res.writeHead(out.status ?? 200, out.headers ?? { 'content-type': 'text/plain; charset=utf-8' })
      res.end(out.body ?? '')
    } catch (err) {
      // 只记录错误消息，不记录请求体（可能含用户消息）
      this.logger.warn({ path: url.pathname, err: (err as Error).message }, 'gateway: webhook handler failed')
      res.writeHead(500).end('internal error')
    }
  }

  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    let raw: Buffer
    try {
      raw = await readBody(req, this.config.maxBodyBytes)
    } catch {
      throw new HttpError(413, 'too_large', 'request body too large')
    }
    if (!raw.length) return {}
    try {
      const v = JSON.parse(raw.toString('utf8')) as unknown
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object')
      return v as Record<string, unknown>
    } catch {
      throw new HttpError(400, 'invalid_json', 'request body must be a JSON object')
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<void> {
    const s = this.api.service
    const method = req.method ?? 'GET'
    const sessionMatch = /^\/v1\/sessions\/([^/]+)(?:\/(messages|reset|abort|approve|deny))?$/.exec(path)

    if (method === 'GET' && path === '/v1/status') return json(res, 200, this.status())
    if (method === 'GET' && path === '/v1/channels') return json(res, 200, { channels: s.channels(), accounts: s.accounts() })
    if (method === 'POST' && /^\/v1\/channels\/[^/]+\/restart$/.test(path)) {
      const b = await this.body(req)
      return json(res, 200, await s.restartAccount(decodeURIComponent(path.split('/')[3]!), b.rebind === true ? { rebind: true } : {}))
    }
    if (method === 'GET' && path === '/v1/sessions') return json(res, 200, { sessions: s.sessions() })
    if (sessionMatch) {
      const key = decodeURIComponent(sessionMatch[1]!)
      const action = sessionMatch[2]
      if (method === 'GET' && action === 'messages') return json(res, 200, { sessionKey: key, messages: await s.history(key) })
      if (method === 'POST' && action === 'reset') return json(res, 200, { ok: await s.resetSession(key) })
      if (method === 'POST' && action === 'abort') return json(res, 200, { ok: s.abortSession(key) })
      if (method === 'POST' && (action === 'approve' || action === 'deny')) return json(res, 200, { ok: this.api.resolveApproval(key, action === 'approve') })
      if (method === 'DELETE' && !action) return json(res, 200, { ok: await s.resetSession(key) })
    }
    if (method === 'POST' && path === '/v1/chat') return this.chat(req, res)
    if (method === 'POST' && path === '/v1/send') {
      const b = await this.body(req)
      const target = b.target ?? (typeof b.account === 'string' && typeof b.chat_id === 'string' ? `${b.account}:${b.chat_id}` : undefined)
      if (!target || typeof b.text !== 'string' || !b.text.trim()) throw new HttpError(400, 'invalid_params', 'need "target" (or "account" + "chat_id") and "text"')
      try {
        return json(res, 200, await s.send(target as string, b.text))
      } catch (err) {
        throw new HttpError(400, 'send_failed', (err as Error).message)
      }
    }
    if (method === 'GET' && path === '/v1/pairing') return json(res, 200, { pending: s.pairing(), paired: s.pairedUsers() })
    if (method === 'POST' && path === '/v1/pairing/approve') {
      const b = await this.body(req)
      const r = typeof b.code === 'string' ? s.approvePairing(b.code) : undefined
      if (!r) throw new HttpError(404, 'not_found', 'pairing code not found or expired')
      return json(res, 200, { approved: r })
    }
    if (method === 'POST' && path === '/v1/pairing/revoke') {
      const b = await this.body(req)
      return json(res, 200, { ok: typeof b.user === 'string' && s.revokeUser(b.user) })
    }
    if (method === 'GET' && path === '/v1/models') {
      return json(res, 200, { object: 'list', data: [{ id: 'leo', object: 'model', owned_by: 'leo-gateway', created: 0 }, { id: this.api.modelName(), object: 'model', owned_by: 'leo-gateway', created: 0 }] })
    }
    if (method === 'POST' && path === '/v1/chat/completions') return this.completions(req, res)
    void url
    throw new HttpError(404, 'not_found', `no route for ${method} ${path}`)
  }

  private status() {
    const s = this.api.service
    const sessions = s.sessions()
    return {
      ...this.api.info(),
      protocol: PROTOCOL_VERSION,
      address: this.address(),
      accounts: s.accounts(),
      sessions: { total: sessions.length, running: sessions.filter((x) => x.running).length },
      pairing: { pending: s.pairing().length, paired: s.pairedUsers().length },
    }
  }

  /** POST /v1/chat {message, session_key?, stream?} */
  private async chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const b = await this.body(req)
    const text = typeof b.message === 'string' ? b.message : typeof b.text === 'string' ? b.text : undefined
    if (!text?.trim()) throw new HttpError(400, 'invalid_params', '"message" is required')
    const sessionKey = (typeof b.session_key === 'string' ? b.session_key : undefined) ?? (req.headers['x-session-key'] as string | undefined)
    const stream = b.stream === true || (req.headers.accept ?? '').includes('text/event-stream')
    const ac = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) ac.abort()
    })
    const input = { text, ...(sessionKey ? { sessionKey } : {}), ...(typeof b.user === 'string' ? { userName: b.user } : {}), signal: ac.signal }
    if (!stream) {
      const r = await this.api.service.chat(input)
      return json(res, r.reason === 'queue_full' ? 409 : 200, r)
    }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' })
    const send = (ev: GatewayStreamEvent) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`)
    const r = await this.api.service.chat({ ...input, onEvent: send })
    res.write(`event: result\ndata: ${JSON.stringify(r)}\n\n`)
    res.end()
  }

  /** OpenAI 兼容：取最后一条 user 消息作为输入；会话用 `user` 字段或 X-Session-Key 头 */
  private async completions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const b = await this.body(req)
    const messages = Array.isArray(b.messages) ? (b.messages as { role?: string; content?: unknown }[]) : []
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    const text = contentText(lastUser?.content)
    if (!text.trim()) throw new HttpError(400, 'invalid_params', 'messages must contain a user message')
    const sessionKey = (req.headers['x-session-key'] as string | undefined) ?? (typeof b.user === 'string' ? `openai-${b.user}` : undefined)
    const id = `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    const created = Math.floor(Date.now() / 1000)
    const model = typeof b.model === 'string' ? b.model : 'leo'
    const ac = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) ac.abort()
    })
    const input = { text, ...(sessionKey ? { sessionKey } : {}), signal: ac.signal }
    if (b.stream !== true) {
      const r = await this.api.service.chat(input)
      return json(res, 200, {
        id,
        object: 'chat.completion',
        created,
        model,
        session_key: r.sessionKey,
        choices: [{ index: 0, message: { role: 'assistant', content: r.text }, finish_reason: r.reason === 'completed' ? 'stop' : 'length' }],
      })
    }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const chunk = (delta: Record<string, unknown>, finish: string | null) =>
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
    chunk({ role: 'assistant' }, null)
    const r = await this.api.service.chat({ ...input, onEvent: (ev) => ev.type === 'delta' && chunk({ content: ev.text }, null) })
    chunk({}, r.reason === 'completed' ? 'stop' : 'length')
    res.write('data: [DONE]\n\n')
    res.end()
  }

  // ———————————————————————————————————————— WebSocket ————————————————————————————————————————

  private upgrade(req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '')
    if (path !== '/ws') return void socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
    const state = { connected: false, unsubscribe: undefined as (() => void) | undefined, runs: new Map<string, AbortController>() }
    const ok = acceptWebSocket(
      req,
      socket,
      head,
      {
        onMessage: (conn, text) => void this.wsMessage(conn, text, state),
        onClose: (conn) => {
          this.sockets.delete(conn)
          state.unsubscribe?.()
          for (const ac of state.runs.values()) ac.abort()
        },
      },
      this.config.maxBodyBytes,
    )
    if (!ok) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  }

  private async wsMessage(conn: WsConnection, text: string, st: { connected: boolean; unsubscribe: (() => void) | undefined; runs: Map<string, AbortController> }): Promise<void> {
    let frame: { type?: string; id?: string; method?: string; params?: Record<string, unknown> }
    try {
      frame = JSON.parse(text)
    } catch {
      return conn.close(1007, 'invalid JSON')
    }
    const id = String(frame.id ?? '')
    const reply = (payload: unknown) => conn.send(JSON.stringify({ type: 'res', id, ok: true, payload }))
    const fail = (code: string, message: string) => conn.send(JSON.stringify({ type: 'res', id, ok: false, error: { code, message } }))
    const event = (name: string, payload: unknown) => conn.send(JSON.stringify({ type: 'event', event: name, payload }))
    if (frame.type !== 'req' || typeof frame.method !== 'string') return fail('invalid_frame', 'expected {type:"req", id, method, params}')
    const p = frame.params ?? {}

    if (!st.connected) {
      if (frame.method !== 'connect') return conn.close(1008, 'first frame must be connect')
      const token = (p.auth as { token?: string } | undefined)?.token ?? ''
      if (this.token && !safeEqual(token, this.token)) return conn.close(1008, 'unauthorized')
      st.connected = true
      this.sockets.add(conn)
      return reply({ protocol: PROTOCOL_VERSION, server: this.api.info(), methods: WS_METHODS, events: ['chat', 'gateway'] })
    }

    const s = this.api.service
    try {
      switch (frame.method) {
        case 'health':
          return reply({ ok: true })
        case 'status':
          return reply(this.status())
        case 'channels.list':
          return reply({ channels: s.channels(), accounts: s.accounts() })
        case 'channels.restart':
          return reply(await s.restartAccount(String(p.account), p.rebind === true ? { rebind: true } : {}))
        case 'sessions.list':
          return reply({ sessions: s.sessions() })
        case 'sessions.history':
          return reply({ messages: await s.history(String(p.sessionKey)) })
        case 'sessions.reset':
          return reply({ ok: await s.resetSession(String(p.sessionKey)) })
        case 'sessions.abort':
          return reply({ ok: s.abortSession(String(p.sessionKey)) })
        case 'approval.resolve':
          return reply({ ok: this.api.resolveApproval(String(p.sessionKey), p.approved === true) })
        case 'chat.send': {
          const message = typeof p.message === 'string' ? p.message : ''
          if (!message.trim()) return fail('invalid_params', '"message" is required')
          const runId = `run-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
          const ac = new AbortController()
          st.runs.set(runId, ac)
          reply({ runId })
          const r = await s.chat({
            text: message,
            ...(typeof p.sessionKey === 'string' ? { sessionKey: p.sessionKey } : {}),
            signal: ac.signal,
            onEvent: (ev) => event('chat', { runId, ...ev }),
          })
          st.runs.delete(runId)
          return event('chat', { runId, type: 'result', ...r })
        }
        case 'chat.abort': {
          const ac = st.runs.get(String(p.runId))
          ac?.abort()
          return reply({ ok: Boolean(ac) })
        }
        case 'send':
          return reply(await s.send(p.target as string, String(p.text ?? '')))
        case 'pairing.list':
          return reply({ pending: s.pairing(), paired: s.pairedUsers() })
        case 'pairing.approve': {
          const r = s.approvePairing(String(p.code ?? ''))
          return r ? reply({ approved: r }) : fail('not_found', 'pairing code not found or expired')
        }
        case 'pairing.revoke':
          return reply({ ok: s.revokeUser(String(p.user ?? '')) })
        case 'subscribe':
          st.unsubscribe?.()
          st.unsubscribe = this.api.subscribe((name, payload) => event('gateway', { event: name, payload }))
          return reply({ subscribed: true })
        case 'unsubscribe':
          st.unsubscribe?.()
          st.unsubscribe = undefined
          return reply({ subscribed: false })
        default:
          return fail('unknown_method', `unknown method "${frame.method}"`)
      }
    } catch (err) {
      return fail('failed', (err as Error).message)
    }
  }
}

export const WS_METHODS = [
  'health',
  'status',
  'channels.list',
  'channels.restart',
  'sessions.list',
  'sessions.history',
  'sessions.reset',
  'sessions.abort',
  'approval.resolve',
  'chat.send',
  'chat.abort',
  'send',
  'pairing.list',
  'pairing.approve',
  'pairing.revoke',
  'subscribe',
  'unsubscribe',
] as const

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function contentText(c: unknown): string {
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((p) => (p && typeof p === 'object' && (p as { type?: string }).type === 'text' ? String((p as { text?: unknown }).text ?? '') : '')).join('')
  return ''
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        req.destroy()
        reject(new Error('too_large'))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
