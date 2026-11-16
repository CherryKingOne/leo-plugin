/**
 * 本机网页与 JSON API（单端口，只读）：
 *   GET /                         网页（单文件，无外部资源）
 *   GET /health                   { ok: true }（不需要令牌）
 *   GET /api/sessions             会话列表
 *   GET /api/sessions/:id         轨迹树（?depth=0..4，默认 2）
 *   GET /api/stream               SSE：update 事件（TrajectoryUpdate），?session=<id> 只推该会话及其子会话
 *
 * 安全（与 gateway 控制面相同的规则）：默认只监听 127.0.0.1；监听非本机地址必须设置 token，否则拒绝启动；
 * 设置了 token 时除 /health 外都要带令牌（`Authorization: Bearer <token>`、`x-leo-trajectory-token` 头，
 * 或网页 / SSE 用的 `?token=` 查询参数）。没有 token 时只接受 Host 为本机名的请求（防 DNS rebinding）。
 */
import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { Trajectories } from './service.js'
import type { TrajectoryUpdate } from './types.js'
import { PAGE_HTML } from './ui.js'

export const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

export interface ServerOptions {
  host: string
  port: number
  token?: string
}

export class TrajectoryServer {
  private server: Server | undefined
  private readonly sockets = new Set<Socket>()
  private readonly streams = new Set<() => void>()

  constructor(
    private readonly opts: ServerOptions,
    private readonly service: Trajectories,
  ) {}

  address(): { host: string; port: number } | undefined {
    const a = this.server?.address()
    return a && typeof a === 'object' ? { host: a.address, port: a.port } : undefined
  }

  url(): string | undefined {
    const a = this.address()
    if (!a) return undefined
    const host = a.host === '0.0.0.0' || a.host === '::' ? '127.0.0.1' : a.host.includes(':') ? `[${a.host}]` : a.host
    return `http://${host}:${a.port}/`
  }

  async start(): Promise<void> {
    if (!LOOPBACK.has(this.opts.host) && !this.opts.token) {
      throw new Error(`refusing to listen on ${this.opts.host} without a token (set the "token" option, e.g. "$LEO_TRAJECTORY_TOKEN")`)
    }
    const server = createServer((req, res) => void this.handle(req, res))
    server.on('connection', (s) => {
      this.sockets.add(s)
      s.on('close', () => this.sockets.delete(s))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.opts.port, this.opts.host, () => {
        server.off('error', reject)
        resolve()
      })
    }).catch((err: Error) => {
      throw new Error(`cannot listen on ${this.opts.host}:${this.opts.port}: ${err.message}`)
    })
    this.server = server
  }

  async close(): Promise<void> {
    for (const stop of [...this.streams]) stop()
    this.streams.clear()
    const server = this.server
    this.server = undefined
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
      for (const s of this.sockets) s.destroy()
    })
    this.sockets.clear()
  }

  private authorized(req: IncomingMessage, url: URL): boolean {
    const token = this.opts.token
    if (!token) {
      // 没有令牌只服务本机：Host 必须是本机名（浏览器里的恶意网页无法借 DNS rebinding 读数据）
      const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase()
      return LOCAL_HOSTNAMES.has(host)
    }
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')
    const given = m?.[1] ?? (req.headers['x-leo-trajectory-token'] as string | undefined) ?? url.searchParams.get('token') ?? ''
    return safeEqual(given, token)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.replace(/\/+$/, '') || '/'
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method_not_allowed' })
      if (path === '/health') return json(res, 200, { ok: true })
      if (!this.authorized(req, url)) return json(res, 401, { error: 'unauthorized', message: 'missing or invalid trajectory token' })
      if (path === '/' || path === '/index.html') {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:",
        })
        return void res.end(PAGE_HTML)
      }
      if (path === '/api/sessions') return json(res, 200, { sessions: await this.service.list() })
      if (path === '/api/stream') return this.stream(req, res, url)
      const m = /^\/api\/sessions\/([\w.:-]{1,200})$/.exec(path)
      if (m) {
        const depth = Math.max(0, Math.min(4, Number(url.searchParams.get('depth') ?? 2) || 0))
        const t = await this.service.get(decodeURIComponent(m[1]!), { depth })
        return t ? json(res, 200, t) : json(res, 404, { error: 'not_found' })
      }
      return json(res, 404, { error: 'not_found' })
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: 'internal', message: (err as Error).message })
      else res.end()
    }
  }

  private stream(req: IncomingMessage, res: ServerResponse, url: URL) {
    const only = url.searchParams.get('session') ?? undefined
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(`event: hello\ndata: ${JSON.stringify({ at: Date.now(), ...(only ? { session: only } : {}) })}\n\n`)
    // 只推指定会话：包括它的子会话（父链接在服务里解析，这里放宽为“该会话或任意会话的 parent 指向它”的近似：
    // 客户端收到后自己刷新，误推无害）
    const send = (u: TrajectoryUpdate) => {
      if (only && u.sessionId !== only && !this.relatedTo(u.sessionId, only)) return
      res.write(`event: update\ndata: ${JSON.stringify(u)}\n\n`)
    }
    const unsubscribe = this.service.subscribe(send)
    const ping = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 15_000)
    ping.unref?.()
    const stop = () => {
      clearInterval(ping)
      unsubscribe()
      this.streams.delete(stop)
      res.end()
    }
    this.streams.add(stop)
    req.on('close', stop)
  }

  /** 子会话的更新也推给父会话的订阅者（运行时链接，最多向上 4 层） */
  private relatedTo(sessionId: string, root: string): boolean {
    let cur: string | undefined = sessionId
    for (let i = 0; i < 4 && cur; i++) {
      cur = this.service.parentOf(cur)
      if (cur === root) return true
    }
    return false
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(body))
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
