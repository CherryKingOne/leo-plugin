/**
 * QQ 机器人 WebSocket 网关客户端（https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html）：
 *
 * 1. GET `<api>/gateway`（Authorization: QQBot {AccessToken}）→ `{ url }`
 * 2. 连接后收到 op 10 Hello `{ heartbeat_interval }`
 * 3. 首次发 op 2 Identify `{ token: "QQBot {AccessToken}", intents, shard: [0, 1] }`，收到 READY 拿 session_id；
 *    断线重连发 op 6 Resume `{ token, session_id, seq }`，服务端补发遗漏事件后下发 RESUMED
 * 4. 按周期发 op 1 Heartbeat `d = 最近收到的 s`，服务端回 op 11
 * 5. op 7 Reconnect：重连并 resume；op 9 Invalid Session：丢弃 session 重新 identify
 * 6. 关闭码 4914（已下架，只能连沙箱）/ 4915（已封禁）/ 4001 / 4002 / 4010–4014 不可重试，账号进入 failed
 */
import { ChannelHttpError, requestJson } from '../http.js'
import type { ChannelInit } from '../contract.js'

/** 事件订阅位 */
export const QQ_INTENTS = {
  /** 单聊消息、群 @机器人 消息（C2C_MESSAGE_CREATE / GROUP_AT_MESSAGE_CREATE） */
  c2c_group: 1 << 25,
  /** 公域频道 @机器人 消息（AT_MESSAGE_CREATE） */
  guild_at: 1 << 30,
  /** 频道私信（DIRECT_MESSAGE_CREATE），需要申请权限 */
  guild_dm: 1 << 12,
} as const
export type QqIntent = keyof typeof QQ_INTENTS

export const intentsOf = (events: readonly QqIntent[]): number => events.reduce((n, e) => (n | QQ_INTENTS[e]) >>> 0, 0)

/** 不可重试的关闭码 */
const FATAL: Record<number, string> = {
  4001: 'invalid opcode',
  4002: 'invalid payload',
  4010: 'invalid shard',
  4011: 'too many guilds, sharding required',
  4012: 'invalid version',
  4013: 'invalid intent',
  4014: 'intent not permitted (check the events option and your bot permissions)',
  4914: 'bot is offline/unpublished, only the sandbox environment may connect (set sandbox: true)',
  4915: 'bot is banned',
}
/** 断线后可以 resume 的关闭码，其余可重试的码需要重新 identify */
const RESUMABLE = new Set([4008, 4009])

export interface QqGatewayOptions {
  base: string
  intents: number
  timeoutMs: number
  token(): Promise<string>
  invalidateToken(): void
  onEvent(type: string, d: unknown): void
}

interface Payload {
  op: number
  d?: any
  s?: number
  t?: string
}

class FatalError extends Error {}

export class QqGateway {
  private sessionId: string | undefined
  private seq: number | null = null
  private loop: Promise<void> | undefined
  private ws: WebSocket | undefined

  constructor(
    private readonly init: Pick<ChannelInit<unknown>, 'fetch' | 'WebSocket' | 'signal' | 'logger' | 'account' | 'fail'>,
    private readonly opts: QqGatewayOptions,
  ) {}

  /** 连接并完成 identify（READY）；失败直接抛出，之后断线自动重连 */
  async start(): Promise<void> {
    const first = await this.connect()
    this.loop = this.run(first)
  }

  async stop(): Promise<void> {
    this.ws?.close(1000)
    await this.loop
  }

  private async gatewayUrl(): Promise<string> {
    const call = async () =>
      requestJson<{ url?: string; code?: number; message?: string }>(this.init.fetch, `${this.opts.base}/gateway`, {
        method: 'GET',
        headers: { authorization: `QQBot ${await this.opts.token()}` },
        timeoutMs: this.opts.timeoutMs,
        label: 'qq gateway',
        signal: this.init.signal,
      })
    let r: Awaited<ReturnType<typeof call>>
    try {
      r = await call()
    } catch (err) {
      if (!(err instanceof ChannelHttpError && err.status === 401)) throw err
      this.opts.invalidateToken()
      r = await call()
    }
    if (!r.url) throw new ChannelHttpError(`qq gateway: code ${r.code}: ${r.message}`)
    return r.url
  }

  /**
   * 打开一个连接，等到 READY / RESUMED 才 resolve。
   * 返回的 closed 在连接关闭时 resolve 关闭码。
   */
  private async connect(): Promise<{ closed: Promise<number> }> {
    const url = await this.gatewayUrl()
    const ws = new this.init.WebSocket(url)
    this.ws = ws
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let ready!: () => void
    let notReady!: (err: Error) => void
    const readyP = new Promise<void>((res, rej) => {
      ready = res
      notReady = rej
    })
    const send = (p: Payload) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(p))
    }
    const onAbort = () => ws.close(1000)
    this.init.signal.addEventListener('abort', onAbort, { once: true })
    const readyTimer = setTimeout(() => {
      notReady(new Error('qq gateway: timed out waiting for READY'))
      ws.close(4000)
    }, this.opts.timeoutMs * 2)

    const closed = new Promise<number>((resolve) => {
      ws.onerror = () => {}
      ws.onclose = (ev) => {
        clearInterval(heartbeat)
        clearTimeout(readyTimer)
        this.init.signal.removeEventListener('abort', onAbort)
        const fatal = FATAL[ev.code]
        notReady(fatal ? new FatalError(`qq gateway closed ${ev.code}: ${fatal}`) : new Error(`qq gateway closed before READY (${ev.code})`))
        resolve(ev.code)
      }
    })

    ws.onmessage = async (ev) => {
      let p: Payload
      try {
        p = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer))
      } catch {
        return
      }
      if (typeof p.s === 'number') this.seq = p.s
      switch (p.op) {
        case 10: {
          const interval = Number(p.d?.heartbeat_interval) || 45_000
          heartbeat = setInterval(() => send({ op: 1, d: this.seq }), interval)
          try {
            const token = `QQBot ${await this.opts.token()}`
            if (this.sessionId) send({ op: 6, d: { token, session_id: this.sessionId, seq: this.seq ?? 0 } })
            else send({ op: 2, d: { token, intents: this.opts.intents, shard: [0, 1], properties: { $os: process.platform, $browser: 'leo-plugin-gateway-qq', $device: 'leo-plugin-gateway-qq' } } })
          } catch (err) {
            notReady(err as Error)
            ws.close(4000)
          }
          return
        }
        case 0:
          if (p.t === 'READY') {
            this.sessionId = p.d?.session_id
            this.init.logger.info({ account: this.init.account, bot: p.d?.user?.username }, 'qq gateway: ready')
            ready()
          } else if (p.t === 'RESUMED') {
            this.init.logger.info({ account: this.init.account }, 'qq gateway: resumed')
            ready()
          } else if (p.t) {
            try {
              this.opts.onEvent(p.t, p.d)
            } catch (err) {
              this.init.logger.warn({ account: this.init.account, err: (err as Error).message }, 'qq gateway: failed to handle event')
            }
          }
          return
        case 1: // 服务端要求立即心跳
          send({ op: 1, d: this.seq })
          return
        case 7: // 服务端要求重连（保留 session，重连后 resume）
          ws.close(4009)
          return
        case 9: // session 无效：丢弃后重新 identify
          this.sessionId = undefined
          this.seq = null
          ws.close(4006)
          return
        default:
          return
      }
    }

    try {
      await readyP
    } finally {
      clearTimeout(readyTimer)
    }
    return { closed }
  }

  private async run(first: { closed: Promise<number> }): Promise<void> {
    let current: { closed: Promise<number> } | undefined = first
    let backoff = 1000
    while (!this.init.signal.aborted) {
      if (current) {
        const code = await current.closed
        current = undefined
        if (this.init.signal.aborted) break
        if (FATAL[code]) {
          this.init.fail(`qq gateway closed ${code}: ${FATAL[code]}`)
          return
        }
        if (!RESUMABLE.has(code)) {
          // 4006 / 4007 / 49xx 等：重新 identify
          this.sessionId = undefined
          this.seq = null
        }
        this.init.logger.warn({ account: this.init.account, code, resume: !!this.sessionId }, 'qq gateway: connection closed, reconnecting')
        backoff = 1000
      }
      await sleep(backoff + Math.floor(Math.random() * 500), this.init.signal)
      if (this.init.signal.aborted) break
      try {
        current = await this.connect()
        backoff = 1000
      } catch (err) {
        if (err instanceof FatalError) {
          this.init.fail(err.message)
          return
        }
        // resume 失败时下一次改为 identify
        if (this.sessionId && /closed before READY/.test((err as Error).message)) {
          this.sessionId = undefined
          this.seq = null
        }
        this.init.logger.warn({ account: this.init.account, err: (err as Error).message, retryInMs: backoff }, 'qq gateway: reconnect failed')
        backoff = Math.min(backoff * 2, 60_000)
      }
    }
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
