/**
 * 渠道注册层的实现：驱动表 + 账号表 + 生命周期 + 收发分发。
 */
import type { Context } from 'leo-agents'
import { type AccountInput, AccountSchema, type ChatChannelsConfig } from './config.js'
import { resolveValue } from './secrets.js'
import { preview, splitText } from './text.js'
import type {
  AccountConfig,
  AccountState,
  AccountStatus,
  ChannelConnection,
  ChannelDriver,
  ChannelInit,
  ChannelTarget,
  ChatChannelService,
  DriverInfo,
  InboundMessage,
  OutboundMessage,
  SendResult,
} from './types.js'
import { WebhookServer } from './webhook.js'

interface DriverEntry {
  driver: ChannelDriver
  builtin: boolean
}

interface AccountRuntime {
  id: string
  config: AccountConfig
  state: AccountState
  error?: string
  conn?: ChannelConnection
  controller?: AbortController
  webhookPath?: string
  unmount?: () => Promise<void>
  received: number
  sent: number
  /** 串行化 start / stop，避免并发重启 */
  op: Promise<void>
}

export interface RegistryDeps {
  ctx: Context<any>
  config: ChatChannelsConfig
  fetch?: typeof fetch
  /** 内置子插件的驱动 id（用于诊断展示） */
  builtinIds: ReadonlySet<string>
  /** `chat-channels/inbound` 中间件链的终点（默认 Agent 桥接）；返回要回复的消息 */
  final?: (payload: InboundPayload) => Promise<OutboundMessage | undefined>
}

export interface InboundPayload {
  message: InboundMessage
  /** 账号配置的 autoReply */
  autoReply: boolean
}

export function createRegistry(deps: RegistryDeps): { service: ChatChannelService; dispose(): Promise<void> } {
  const { ctx, config } = deps
  const log = ctx.logger
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const drivers = new Map<string, DriverEntry>()
  const accounts = new Map<string, AccountRuntime>()
  const webhook = new WebhookServer(config.webhook, log)
  let disposed = false

  const status = (a: AccountRuntime): AccountStatus => ({
    account: a.id,
    channel: a.config.channel,
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
    ctx.emit('chat-channels/status', status(a))
  }

  /** 串行执行账号上的操作 */
  function serialize(a: AccountRuntime, fn: () => Promise<void>): Promise<void> {
    a.op = a.op.then(fn, fn)
    return a.op
  }

  function secretFor(a: AccountRuntime) {
    const credentials = ctx.maybe('credentials')
    return (field: string): string | undefined => {
      const raw = a.config.options[field]
      const configured = typeof raw === 'string' && raw !== '' ? raw : undefined
      if (credentials) {
        // 优先级：.leo/credentials.json 中的 chat-channels/<account>/<field> > 配置值（$ENV / !cmd）
        return credentials.get({ id: `chat-channels/${a.id}/${field}`, ...(configured ? { configured } : {}) }) || undefined
      }
      if (configured === undefined) return undefined
      try {
        return resolveValue(configured) || undefined
      } catch (err) {
        throw new Error(`${a.id}.options.${field}: ${(err as Error).message}`)
      }
    }
  }

  async function startAccount(a: AccountRuntime): Promise<void> {
    if (disposed) return
    if (!a.config.enabled) return setState(a, 'disabled')
    const entry = drivers.get(a.config.channel)
    if (!entry) return setState(a, 'waiting_driver')

    const parsed = entry.driver.options.safeParse(a.config.options)
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `options.${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
      log.warn({ account: a.id, channel: a.config.channel, issues }, 'chat-channels: invalid bot options')
      return setState(a, 'failed', `invalid options for ${a.config.channel}: ${issues}`)
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
        const { path, unmount } = await webhook.mount(a.id, handler)
        a.webhookPath = path
        a.unmount = unmount
        return path
      },
      fetch: fetchImpl,
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
      log.info({ account: a.id, channel: a.config.channel, webhook: a.webhookPath }, 'chat-channels: account running')
    } catch (err) {
      await teardown(a)
      const message = (err as Error).message
      log.warn({ account: a.id, channel: a.config.channel, err: message }, 'chat-channels: account failed to start')
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
      log.warn({ account: a.id, err: (err as Error).message }, 'chat-channels: error while stopping account')
    }
    const unmount = a.unmount
    a.unmount = undefined
    delete a.webhookPath
    await unmount?.().catch(() => {})
  }

  async function stopAccount(a: AccountRuntime, next: AccountState): Promise<void> {
    await teardown(a)
    setState(a, next)
  }

  // ---------------------------------------------------------------- 入站

  function accepted(a: AccountRuntime, m: InboundMessage): string | undefined {
    if (a.state !== 'running') return 'account not running'
    if (a.config.allowFrom.length && !a.config.allowFrom.includes(m.sender.id)) return 'sender not in allowFrom'
    if (a.config.allowChats.length && !a.config.allowChats.includes(m.chat.id)) return 'chat not in allowChats'
    if (m.chat.type !== 'direct' && a.config.requireMention && !m.mentioned) return 'bot not mentioned'
    if (!m.text.trim()) return 'empty text'
    return undefined
  }

  function dispatch(m: InboundMessage): void {
    const a = accounts.get(m.account)
    if (!a) return void log.warn({ account: m.account }, 'chat-channels: message for unknown account dropped')
    const reason = accepted(a, m)
    if (reason) {
      log.debug({ account: a.id, chat: m.chat.id, sender: m.sender.id, reason }, 'chat-channels: message ignored')
      return
    }
    a.received++
    ctx.emit('chat-channels/received', m)
    log.debug({ account: a.id, chat: m.chat.id, text: preview(m.text) }, 'chat-channels: message received')
    void ctx
      .waterfall('chat-channels/inbound', { message: m, autoReply: a.config.autoReply }, (p) => deps.final?.(p) ?? undefined)
      .then(async (reply) => {
        if (!reply || !reply.text.trim()) return
        await service.send(m.account, { chatId: m.chat.id, chatType: m.chat.type, ...(m.chat.extra ? { extra: m.chat.extra } : {}) }, { replyTo: m.id, ...reply })
      })
      .catch((err: Error) => log.warn({ account: a.id, chat: m.chat.id, err: err.message }, 'chat-channels: failed to handle message'))
  }

  // ---------------------------------------------------------------- 服务

  function addRuntime(id: string, cfg: AccountConfig): AccountRuntime {
    if (accounts.has(id)) throw new Error(`account "${id}" already exists`)
    const a: AccountRuntime = { id, config: cfg, state: 'waiting_driver', received: 0, sent: 0, op: Promise.resolve() }
    accounts.set(id, a)
    return a
  }

  const service: ChatChannelService = {
    registerDriver(driver) {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(driver.id)) throw new Error(`invalid channel driver id "${driver.id}"`)
      if (drivers.has(driver.id)) throw new Error(`channel driver "${driver.id}" is already registered`)
      const entry: DriverEntry = { driver, builtin: deps.builtinIds.has(driver.id) }
      drivers.set(driver.id, entry)
      ctx.emit('chat-channels/driver-registered', info(entry))
      log.debug({ channel: driver.id }, 'chat-channels: driver registered')
      const users = [...accounts.values()].filter((a) => a.config.channel === driver.id)
      for (const a of users) void serialize(a, () => startAccount(a))

      return async () => {
        if (drivers.get(driver.id) !== entry) return
        drivers.delete(driver.id)
        const affected = [...accounts.values()].filter((a) => a.config.channel === driver.id)
        await Promise.all(affected.map((a) => serialize(a, () => stopAccount(a, disposed ? 'stopped' : 'waiting_driver'))))
      }
    },

    drivers: () => [...drivers.values()].map(info),

    async addAccount(id, input) {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error(`invalid account id "${id}"`)
      const cfg = AccountSchema.parse(input) as AccountConfig
      const a = addRuntime(id, cfg)
      await serialize(a, () => startAccount(a))
      return async () => {
        if (accounts.get(id) !== a) return
        await serialize(a, () => stopAccount(a, 'stopped'))
        accounts.delete(id)
      }
    },

    accounts: () => [...accounts.values()].map(status),

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
      const limit = drivers.get(a.config.channel)?.driver.textLimit ?? 4000
      const parts = splitText(message.text, limit)
      const ids: string[] = []
      const sig = signal ?? a.controller?.signal ?? new AbortController().signal
      for (const [i, text] of parts.entries()) {
        const r = await conn.send(target, { text, ...(i === 0 && message.replyTo ? { replyTo: message.replyTo } : {}) }, sig)
        ids.push(...r.messageIds)
      }
      a.sent++
      const result: SendResult = { messageIds: ids }
      ctx.emit('chat-channels/sent', { account: id, channel: a.config.channel, target, text: message.text, messageIds: ids })
      return result
    },

    inject: (m) => dispatch(m),
  }

  function info(e: DriverEntry): DriverInfo {
    return {
      id: e.driver.id,
      name: e.driver.name,
      ...(e.driver.description ? { description: e.driver.description } : {}),
      ...(e.driver.receive ? { receive: e.driver.receive } : {}),
      ...(e.driver.textLimit ? { textLimit: e.driver.textLimit } : {}),
      builtin: e.builtin,
    }
  }

  // 配置中的账号：先登记，等驱动注册后自动启动
  for (const [id, raw] of Object.entries(config.accounts)) addRuntime(id, AccountSchema.parse(raw satisfies AccountInput) as AccountConfig)

  return {
    service,
    async dispose() {
      disposed = true
      await Promise.all([...accounts.values()].map((a) => serialize(a, () => teardown(a))))
      await webhook.close()
    },
  }
}

