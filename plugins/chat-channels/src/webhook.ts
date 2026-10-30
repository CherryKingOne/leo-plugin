/**
 * 共享 webhook 服务器：所有 webhook 型渠道账号共用一个端口，按路径 `<basePath>/<account>` 分发。
 * 第一个路由挂载时才启动监听，最后一个路由卸载时关闭。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Logger } from 'leo-agents'
import type { WebhookConfig } from './config.js'
import type { WebhookHandler, WebhookRequest } from './types.js'

export class WebhookServer {
  private server: Server | undefined
  private listening: Promise<void> | undefined
  private readonly routes = new Map<string, WebhookHandler>()

  constructor(
    private readonly config: WebhookConfig,
    private readonly logger: Logger,
  ) {}

  pathFor(account: string): string {
    return `${this.config.basePath.replace(/\/+$/, '')}/${account}`
  }

  /** 挂载路由并确保服务器在监听；返回路径与撤销函数 */
  async mount(account: string, handler: WebhookHandler): Promise<{ path: string; unmount: () => Promise<void> }> {
    const path = this.pathFor(account)
    if (this.routes.has(path)) throw new Error(`webhook path already mounted: ${path}`)
    this.routes.set(path, handler)
    try {
      await this.ensureListening()
    } catch (err) {
      this.routes.delete(path)
      throw err
    }
    return {
      path,
      unmount: async () => {
        this.routes.delete(path)
        if (this.routes.size === 0) await this.close()
      },
    }
  }

  /** 实际监听的地址（port 配 0 时由系统分配，测试用） */
  address(): { host: string; port: number } | undefined {
    const a = this.server?.address()
    return a && typeof a === 'object' ? { host: a.address, port: a.port } : undefined
  }

  private ensureListening(): Promise<void> {
    if (this.listening) return this.listening
    const server = createServer((req, res) => void this.handle(req, res))
    this.server = server
    this.listening = new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.config.port, this.config.host, () => {
        server.off('error', reject)
        server.on('error', (err) => this.logger.error({ err: err.message }, 'chat-channels: webhook server error'))
        const a = this.address()
        this.logger.info({ host: a?.host, port: a?.port, basePath: this.config.basePath }, 'chat-channels: webhook server listening')
        resolve()
      })
    }).catch((err: Error) => {
      this.server = undefined
      this.listening = undefined
      throw new Error(`chat-channels: cannot listen on ${this.config.host}:${this.config.port}: ${err.message}`)
    })
    return this.listening
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.listening = undefined
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const handler = this.routes.get(url.pathname.replace(/\/+$/, ''))
    if (!handler) return reply(res, 404, 'not found')
    if (req.method !== 'GET' && req.method !== 'POST') return reply(res, 405, 'method not allowed')

    let body: Buffer
    try {
      body = await readBody(req, this.config.maxBodyBytes)
    } catch (err) {
      return reply(res, (err as Error).message === 'too_large' ? 413 : 400, 'bad request')
    }
    const headers: Record<string, string | undefined> = {}
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : v
    const request: WebhookRequest = { method: req.method, headers, query: url.searchParams, body }
    try {
      const out = await handler(request)
      res.writeHead(out.status ?? 200, out.headers ?? { 'content-type': 'text/plain; charset=utf-8' })
      res.end(out.body ?? '')
    } catch (err) {
      // 只记录错误消息，不记录请求体（可能含用户消息）
      this.logger.warn({ path: url.pathname, err: (err as Error).message }, 'chat-channels: webhook handler failed')
      reply(res, 500, 'internal error')
    }
  }
}

function reply(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(text)
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
