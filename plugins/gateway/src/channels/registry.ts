/**
 * 渠道注册表：驱动表 + 账号表 + 生命周期 + 出站分段发送。
 * 入站消息经过账号级过滤（会话白名单、群聊 @ 提及）后交给网关核心（授权、指令、路由在那里做）。
 */
import type { Context, Disposer } from 'leo-agents'
import { type AccountConfig, AccountSchema, COMMON_ACCOUNT_KEYS, ID } from '../config.js'
import { resolveValue } from '../secrets.js'
import { splitText } from '../text.js'
import type {
  AccountState,
  AccountStatus,
  ChannelConnection,
  ChannelDriver,
  ChannelInfo,
  ChannelInit,
  ChannelTarget,
  InboundMessage,
  OutboundMessage,
  SendResult,
  WebhookHandler,
} from '../types.js'

interface DriverEntry {
  driver: ChannelDriver
  builtin: boolean
}

export interface AccountRuntime {
  id: string
  channel: string
  config: AccountConfig
  /** 交给驱动的平台配置（去掉通用字段） */
  options: Record<string, unknown>
  state: AccountState
  error?: string
  conn?: ChannelConnection
  controller?: AbortController
  webhookPath?: string
  unmount?: () => Promise<void>
  received: number
  sent: number
  /** 账号通用配置校验失败的原因；有值时永不启动 */
  invalid?: string
  /** 串行化 start / stop，避免并发重启 */
  op: Promise<void>
}

export interface RegistryDeps {
  ctx: Context<any>
  accounts: Record<string, unknown>
  builtinIds: ReadonlySet<string>
  fetch?: typeof fetch
  WebSocket?: typeof WebSocket
  /** 在网关 HTTP 服务上挂载 webhook */
  mountHook(account: string, handler: WebhookHandler): Promise<{ path: string; unmount(): Promise<void> }>
  /** 通过账号级过滤的入站消息 */
  onInbound(message: InboundMessage, account: AccountRuntime): void
  onStatus?(status: AccountStatus): void
}

export interface ChannelRegistry {
  registerDriver(driver: ChannelDriver): Disposer
  drivers(): ChannelInfo[]
  accounts(): AccountStatus[]
  account(id: string): AccountRuntime | undefined
  restart(id: string): Promise<AccountStatus>
  send(account: string, target: ChannelTarget, message: OutboundMessage, signal?: AbortSignal): Promise<SendResult>
  /** 走完整入站流程（账号过滤 → 网关） */
  dispatch(message: InboundMessage): void
  dispose(): Promise<void>
}

/** 账号对象 → 通用配置 + 驱动 options */
export function splitAccount(id: string, raw: unknown): { config: AccountConfig; options: Record<string, unknown>; channel: string } {
  const config = AccountSchema.parse(raw ?? {})
  const options: Record<string, unknown> = {}
  for (const [k, v] of Object.entries((raw ?? {}) as Record<string, unknown>)) if (!(COMMON_ACCOUNT_KEYS as readonly string[]).includes(k)) options[k] = v
  // 兼容 chat-channels 写法：平台配置放在 options 里
  if (options.options && typeof options.options === 'object' && !Array.isArray(options.options)) {
    Object.assign(options, options.options as Record<string, unknown>)
    delete options.options
  }
  return { config, options, channel: config.channel ?? id }
}

export function createChannelRegistry(deps: RegistryDeps): ChannelRegistry {
  const { ctx } = deps
  const log = ctx.logger
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const drivers = new Map<string, DriverEntry>()
  const accounts = new Map<string, AccountRuntime>()
  let disposed = false

  const status = (a: AccountRuntime): AccountStatus => ({
    account: a.id,
    channel: a.channel,
    state: a.state,
    ...(a.webhookPath ? { webhookPath: a.webhookPath } : {}),
    ...(a.error ? { error: a.error } : {}),
    received: a.received,
    sent: a.sent,
  })

  function setState(a: AccountRuntime, state: AccountState, error?: string): void {
    a.state = state
    if (error) a.error = error
    else delete a.error
    deps.onStatus?.(status(a))
  }

  function serialize(a: AccountRuntime, fn: () => Promise<void>): Promise<void> {
    a.op = a.op.then(fn, fn)
    return a.op
  }

  function secretFor(a: AccountRuntime) {
    const credentials = ctx.maybe('credentials')
    return (field: string): string | undefined => {
      const raw = a.options[field]
      const configured = typeof raw === 'string' && raw !== '' ? raw : undefined
      if (credentials) {
        // 优先级：.leo/credentials.json 中的 gateway/<account>/<field> > 配置值（$ENV / !cmd）
        return credentials.get({ id: `gateway/${a.id}/${field}`, ...(configured ? { configured } : {}) }) || undefined
      }
      if (configured === undefined) return undefined
      try {
        return resolveValue(configured) || undefined
      } catch (err) {
        throw new Error(`${a.id}.${field}: ${(err as Error).message}`)
      }
    }
  }

  async function startAccount(a: AccountRuntime): Promise<void> {
    if (disposed) return
    if (a.invalid) return setState(a, 'failed', `invalid account config: ${a.invalid}`)
    if (!a.config.enabled) return setState(a, 'disabled')
    const entry = drivers.get(a.channel)
    if (!entry) return setState(a, 'waiting_driver')

    const parsed = entry.driver.options.safeParse(a.options)
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
      log.warn({ account: a.id, channel: a.channel, issues }, 'gateway: invalid bot options')
      return setState(a, 'failed', `invalid options for ${a.channel}: ${issues}`)
    }

    setState(a, 'starting')
    const controller = new AbortController()
    a.controller = controller
    const init: ChannelInit<unknown> = {
      account: a.id,
      options: parsed.data,
      secret: secretFor(a),
      dispatch: (m) => dispatch(m),
      webhook: async (handler) => {
        if (a.unmount) throw new Error(`account ${a.id} already mounted a webhook`)
        const { path, unmount } = await deps.mountHook(a.id, handler)
        a.webhookPath = path
        a.unmount = unmount
        return path
      },
      fetch: fetchImpl,
      WebSocket: deps.WebSocket ?? globalThis.WebSocket,
      fail: (error) => {
        if (controller.signal.aborted || a.state !== 'running') return
        log.error({ account: a.id, channel: a.channel, err: error }, 'gateway: account failed')
        a.op = a.op.then(async () => {
          if (controller.signal.aborted) return
          await teardown(a)
          setState(a, 'failed', error)
        })
      },
      signal: controller.signal,
      logger: log,
      ctx,
    }
    try {
      const conn = await entry.driver.create(init)
      a.conn = conn
      await conn.start?.()
      if (controller.signal.aborted) return
      setState(a, 'running')
      log.info({ account: a.id, channel: a.channel, webhook: a.webhookPath }, 'gateway: account running')
    } catch (err) {
      await teardown(a)
      const message = (err as Error).message
      log.warn({ account: a.id, channel: a.channel, err: message }, 'gateway: account failed to start')
      setState(a, 'failed', message)
    }
  }

  async function teardown(a: AccountRuntime): Promise<void> {
    a.controller?.abort()
    const conn = a.conn
    a.conn = undefined
    a.controller = undefined
    try {
      await conn?.stop?.()
    } catch (err) {
      log.warn({ account: a.id, err: (err as Error).message }, 'gateway: error while stopping account')
    }
    const unmount = a.unmount
    a.unmount = undefined
    delete a.webhookPath
    await unmount?.().catch(() => {})
  }

  function accepted(a: AccountRuntime, m: InboundMessage): string | undefined {
    if (a.state !== 'running') return 'account not running'
    if (a.config.allowChats.length && !a.config.allowChats.includes(m.chat.id)) return 'chat not in allowChats'
    if (m.chat.type !== 'direct' && a.config.requireMention && !m.mentioned) return 'bot not mentioned'
    if (!m.text.trim()) return 'empty text'
    return undefined
  }

  function dispatch(m: InboundMessage): void {
    const a = accounts.get(m.account)
    if (!a) return void log.warn({ account: m.account }, 'gateway: message for unknown account dropped')
    const reason = accepted(a, m)
    if (reason) return void log.debug({ account: a.id, chat: m.chat.id, sender: m.sender.id, reason }, 'gateway: message ignored')
    a.received++
    try {
      deps.onInbound(m, a)
    } catch (err) {
      log.warn({ account: a.id, err: (err as Error).message }, 'gateway: inbound handler failed')
    }
  }

  function info(e: DriverEntry): ChannelInfo {
    return {
      id: e.driver.id,
      name: e.driver.name,
      ...(e.driver.description ? { description: e.driver.description } : {}),
      ...(e.driver.receive ? { receive: e.driver.receive } : {}),
      ...(e.driver.textLimit ? { textLimit: e.driver.textLimit } : {}),
      builtin: e.builtin,
    }
  }

  // 配置中的账号：先登记，等驱动注册后自动启动；单个账号配置错误不影响其他账号
  for (const [id, raw] of Object.entries(deps.accounts)) {
    const base = { id, state: 'waiting_driver' as AccountState, received: 0, sent: 0, op: Promise.resolve() }
    try {
      const { config, options, channel } = splitAccount(id, raw)
      if (!ID.test(channel)) throw new Error(`channel "${channel}" must be a kebab-case id`)
      accounts.set(id, { ...base, channel, config, options })
    } catch (err) {
      const issues = (err as { issues?: { path: PropertyKey[]; message: string }[] }).issues
      const invalid = issues ? issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') : (err as Error).message
      accounts.set(id, { ...base, channel: 'unknown', config: AccountSchema.parse({}), options: {}, invalid, state: 'failed', error: `invalid account config: ${invalid}` })
      log.warn({ account: id, issues: invalid }, 'gateway: invalid account config')
    }
  }

  return {
    registerDriver(driver) {
      if (!ID.test(driver.id)) throw new Error(`invalid channel driver id "${driver.id}"`)
      if (drivers.has(driver.id)) throw new Error(`channel driver "${driver.id}" is already registered`)
      const entry: DriverEntry = { driver, builtin: deps.builtinIds.has(driver.id) }
      drivers.set(driver.id, entry)
      log.debug({ channel: driver.id }, 'gateway: channel driver registered')
      for (const a of accounts.values()) if (a.channel === driver.id) void serialize(a, () => startAccount(a))
      return async () => {
        if (drivers.get(driver.id) !== entry) return
        drivers.delete(driver.id)
        const affected = [...accounts.values()].filter((a) => a.channel === driver.id)
        await Promise.all(
          affected.map((a) =>
            serialize(a, async () => {
              await teardown(a)
              setState(a, disposed ? 'stopped' : 'waiting_driver')
            }),
          ),
        )
      }
    },
    drivers: () => [...drivers.values()].map(info),
    accounts: () => [...accounts.values()].map(status),
    account: (id) => accounts.get(id),
    async restart(id) {
      const a = accounts.get(id)
      if (!a) throw new Error(`unknown account "${id}"`)
      await serialize(a, async () => {
        await teardown(a)
        await startAccount(a)
      })
      return status(a)
    },
    async send(id, target, message, signal) {
      const a = accounts.get(id)
      if (!a) throw new Error(`unknown account "${id}"`)
      const conn = a.conn
      if (a.state !== 'running' || !conn) throw new Error(`account "${id}" is not running (${a.state}${a.error ? `: ${a.error}` : ''})`)
      const limit = drivers.get(a.channel)?.driver.textLimit ?? 4000
      const parts = splitText(message.text, limit)
      const ids: string[] = []
      const sig = signal ?? a.controller?.signal ?? new AbortController().signal
      for (const [i, text] of parts.entries()) {
        const r = await conn.send(target, { text, ...(i === 0 && message.replyTo ? { replyTo: message.replyTo } : {}) }, sig)
        ids.push(...r.messageIds)
      }
      a.sent++
      return { messageIds: ids }
    },
    dispatch,
    async dispose() {
      disposed = true
      await Promise.all([...accounts.values()].map((a) => serialize(a, () => teardown(a))))
    },
  }
}
