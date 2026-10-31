/**
 * 飞书长连接（WebSocket）客户端：不需要公网地址，由机器人主动连到飞书。
 *
 * 流程（与官方 SDK 的 WSClient 一致）：
 * 1. POST `<域名>/callback/ws/endpoint` `{ AppID, AppSecret }` → `{ URL, ClientConfig }`
 * 2. 连接 URL（wss，带一次性票据；URL 的 service_id 参数用于 ping 帧）
 * 3. 每 PingInterval 秒发一个控制帧 `type=ping`；pong 帧可能带新的 ClientConfig
 * 4. 数据帧 `type=event` 的 payload 是事件 JSON（可能分片：sum / seq / message_id）；
 *    处理后把原帧带上 `{"code":200}` payload 回给服务端作为 ACK
 * 5. 断线后重新获取 endpoint 再连（票据一次性），指数退避
 */
import { ChannelHttpError, requestJson } from '../../http.js'
import type { ChannelInit } from '../../types.js'
import { decodeFrame, encodeFrame, FRAME_CONTROL, FRAME_DATA, type Frame } from './frame.js'

export interface WsClientConfig {
  PingInterval?: number
  ReconnectCount?: number
  ReconnectInterval?: number
  ReconnectNonce?: number
}

export interface FeishuWsOptions {
  base: string
  appId: string
  appSecret: string
  timeoutMs: number
  /** 收到一个完整事件（已解析的 JSON） */
  onEvent(payload: unknown): void
}

const enc = new TextEncoder()
const dec = new TextDecoder()

export class FeishuWsClient {
  private ws: WebSocket | undefined
  private loop: Promise<void> | undefined
  private pingTimer: ReturnType<typeof setInterval> | undefined
  private pingMs = 120_000
  private readonly fragments = new Map<string, { parts: (Uint8Array | undefined)[]; at: number }>()

  constructor(
    private readonly init: Pick<ChannelInit<unknown>, 'fetch' | 'WebSocket' | 'signal' | 'logger' | 'account'>,
    private readonly opts: FeishuWsOptions,
  ) {}

  /** 建立首个连接；失败直接抛出（账号进入 failed），之后断线自动重连 */
  async start(): Promise<void> {
    const first = await this.connect()
    this.loop = this.run(first)
  }

  async stop(): Promise<void> {
    this.ws?.close(1000)
    await this.loop
  }

  private async endpoint(): Promise<{ url: string; serviceId: number; config: WsClientConfig }> {
    const r = await requestJson<{ code: number; msg: string; data?: { URL?: string; ClientConfig?: WsClientConfig } }>(this.init.fetch, `${this.opts.base}/callback/ws/endpoint`, {
      body: { AppID: this.opts.appId, AppSecret: this.opts.appSecret },
      headers: { locale: 'zh' },
      timeoutMs: this.opts.timeoutMs,
      label: 'feishu ws endpoint',
      signal: this.init.signal,
    })
    if (r.code !== 0 || !r.data?.URL) throw new ChannelHttpError(`feishu ws endpoint: code ${r.code}: ${r.msg}`)
    const serviceId = Number(new URL(r.data.URL).searchParams.get('service_id') ?? 0)
    return { url: r.data.URL, serviceId, config: r.data.ClientConfig ?? {} }
  }

  /** 获取 endpoint 并打开连接；resolve 时连接已 open */
  private async connect(): Promise<{ ws: WebSocket; serviceId: number }> {
    const { url, serviceId, config } = await this.endpoint()
    this.applyConfig(config)
    const ws = new this.init.WebSocket(url)
    ws.binaryType = 'arraybuffer'
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        ws.close(1000)
        reject(new Error('aborted'))
      }
      ws.onopen = () => {
        this.init.signal.removeEventListener('abort', onAbort)
        resolve()
      }
      ws.onerror = () => {}
      ws.onclose = (ev) => {
        this.init.signal.removeEventListener('abort', onAbort)
        reject(new Error(`feishu ws: connection closed before open (${ev.code})`))
      }
      this.init.signal.addEventListener('abort', onAbort, { once: true })
    })
    return { ws, serviceId }
  }

  private applyConfig(c: WsClientConfig): void {
    if (c.PingInterval && c.PingInterval > 0) this.pingMs = Math.max(5, c.PingInterval) * 1000
  }

  /** 一个连接的生命周期：resolve 于连接关闭 */
  private session(ws: WebSocket, serviceId: number): Promise<void> {
    this.ws = ws
    const ping = () => {
      if (ws.readyState !== 1) return
      ws.send(encodeFrame({ seqId: 0n, logId: 0n, service: serviceId, method: FRAME_CONTROL, headers: { type: 'ping' } }))
    }
    const schedule = () => {
      clearInterval(this.pingTimer)
      this.pingTimer = setInterval(ping, this.pingMs)
    }
    ping()
    schedule()
    return new Promise<void>((resolve) => {
      const onAbort = () => ws.close(1000)
      this.init.signal.addEventListener('abort', onAbort, { once: true })
      ws.onmessage = (ev) => {
        try {
          const before = this.pingMs
          this.onFrame(ws, decodeFrame(new Uint8Array(ev.data as ArrayBuffer)))
          if (this.pingMs !== before) schedule()
        } catch (err) {
          this.init.logger.warn({ account: this.init.account, err: (err as Error).message }, 'feishu ws: bad frame')
        }
      }
      ws.onerror = () => {}
      ws.onclose = (ev) => {
        clearInterval(this.pingTimer)
        this.init.signal.removeEventListener('abort', onAbort)
        if (!this.init.signal.aborted) this.init.logger.warn({ account: this.init.account, code: ev.code }, 'feishu ws: connection closed')
        resolve()
      }
    })
  }

  private async run(first: { ws: WebSocket; serviceId: number }): Promise<void> {
    let current: { ws: WebSocket; serviceId: number } | undefined = first
    let backoff = 1000
    while (!this.init.signal.aborted) {
      if (current) {
        this.init.logger.info({ account: this.init.account }, 'feishu ws: connected')
        await this.session(current.ws, current.serviceId)
        current = undefined
        backoff = 1000
        if (this.init.signal.aborted) break
      }
      await sleep(backoff + Math.floor(Math.random() * 500), this.init.signal)
      if (this.init.signal.aborted) break
      try {
        current = await this.connect()
      } catch (err) {
        this.init.logger.warn({ account: this.init.account, err: (err as Error).message, retryInMs: backoff }, 'feishu ws: reconnect failed')
        backoff = Math.min(backoff * 2, 60_000)
      }
    }
  }

  private onFrame(ws: WebSocket, f: Frame): void {
    const type = f.headers.type
    if (f.method === FRAME_CONTROL) {
      if (type === 'pong' && f.payload?.length) {
        try {
          this.applyConfig(JSON.parse(dec.decode(f.payload)) as WsClientConfig)
        } catch {
          /* ignore */
        }
      }
      return
    }
    if (f.method !== FRAME_DATA) return
    const payload = this.assemble(f)
    if (!payload) return
    let code = 200
    if (type === 'event') {
      try {
        this.opts.onEvent(JSON.parse(dec.decode(payload)))
      } catch (err) {
        code = 500
        this.init.logger.warn({ account: this.init.account, err: (err as Error).message }, 'feishu ws: failed to handle event')
      }
    }
    // ACK：原帧带上处理结果
    if (ws.readyState === 1) ws.send(encodeFrame({ ...f, headers: { ...f.headers, biz_rt: '0' }, payload: enc.encode(JSON.stringify({ code })) }))
  }

  /** 合并分片；未收齐返回 undefined */
  private assemble(f: Frame): Uint8Array | undefined {
    const sum = Number(f.headers.sum ?? 1)
    if (!(sum > 1)) return f.payload ?? new Uint8Array()
    const id = f.headers.message_id ?? ''
    const seq = Number(f.headers.seq ?? 0)
    const now = Date.now()
    for (const [k, v] of this.fragments) if (now - v.at > 30_000) this.fragments.delete(k)
    const entry = this.fragments.get(id) ?? { parts: new Array<Uint8Array | undefined>(sum).fill(undefined), at: now }
    entry.parts[seq] = f.payload ?? new Uint8Array()
    this.fragments.set(id, entry)
    if (entry.parts.some((p) => p === undefined)) return undefined
    this.fragments.delete(id)
    const total = entry.parts.reduce((n, p) => n + p!.length, 0)
    const out = new Uint8Array(total)
    let off = 0
    for (const p of entry.parts) {
      out.set(p!, off)
      off += p!.length
    }
    return out
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms)
    function done() {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}
