/**
 * 渠道注册表：驱动表 + 账号表 + 生命周期 + 出站分段发送。
 * 入站消息经过账号级过滤（会话白名单、群聊 @ 提及）后交给网关核心（授权、指令、路由在那里做）。
 *
 * 驱动来源有两种：网关内置（`builtin`）与其他插件通过 `gateway.registerChannel()` 注册（插件驱动）。
 * 同一个 id 两者都有时插件驱动生效、内置驱动被“顶替”（不启动）；插件驱动撤销后内置驱动自动恢复。
 * 两者的注册顺序任意，结果相同。
 */
import type { Context, Disposer } from 'leo-agents'
import { type AccountConfig, AccountSchema, COMMON_ACCOUNT_KEYS, ID } from '../config.js'
import { resolveValue } from '../secrets.js'
import { splitText } from '../text.js'
import type {
  AccountState,
  ChannelReport,
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

/** 一个渠道 id 下的驱动：插件驱动优先于内置驱动 */
interface DriverSlot {
  builtin?: DriverEntry
  external?: DriverEntry
}

export interface RegisterOptions {
  /** 网关内置驱动（只由网关自己传） */
  builtin?: boolean
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
  /** waiting_bind 时驱动汇报的绑定信息 */
  bind?: ChannelReport
  /** 下一次启动要求驱动重新绑定 */
  rebind?: boolean
  /** 等待账号进入 waiting_bind 的回调（restart 用） */
  waiters: Set<() => void>
  /** 账号通用配置校验失败的原因；有值时永不启动 */
  invalid?: string
  /** 串行化 start / stop，避免并发重启 */
  op: Promise<void>
}

export interface RegistryDeps {
  ctx: Context<any>
  accounts: Record<string, unknown>
  fetch?: typeof fetch
  WebSocket?: typeof WebSocket
  /** 在网关 HTTP 服务上挂载 webhook */
  mountHook(account: string, handler: WebhookHandler): Promise<{ path: string; unmount(): Promise<void> }>
  /** 通过账号级过滤的入站消息 */
  onInbound(message: InboundMessage, account: AccountRuntime): void
  onStatus?(status: AccountStatus): void
  /** 给用户看的提示（驱动顶替 / 恢复、驱动自己的提示） */
  notify?(message: string, level?: 'info' | 'warn' | 'error'): void
  /** 渠道驱动直接授权用户（init.authorize） */
  authorize?(user: string, opts: { admin?: boolean; name?: string; by: string }): void
}

export interface ChannelRegistry {
  registerDriver(driver: ChannelDriver, opts?: RegisterOptions): Disposer
  drivers(): ChannelInfo[]
  accounts(): AccountStatus[]
  account(id: string): AccountRuntime | undefined
  restart(id: string, opts?: { rebind?: boolean }): Promise<AccountStatus>
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
  const slots = new Map<string, DriverSlot>()
  const active = (id: string): DriverEntry | undefined => {
    const slot = slots.get(id)
    return slot?.external ?? slot?.builtin
  }
  const accounts = new Map<string, AccountRuntime>()
  let disposed = false

  const status = (a: AccountRuntime): AccountStatus => ({
    account: a.id,
    channel: a.channel,
    state: a.state,
    ...(a.state === 'waiting_bind' && a.bind?.bindUrl ? { bindUrl: a.bind.bindUrl } : {}),
    ...(a.state === 'waiting_bind' && a.bind?.detail ? { detail: a.bind.detail } : {}),
    ...(a.webhookPath ? { webhookPath: a.webhookPath } : {}),
    ...(a.error ? { error: a.error } : {}),
    received: a.received,
    sent: a.sent,
  })

  function setState(a: AccountRuntime, state: AccountState, error?: string): void {
    a.state = state
    if (state !== 'waiting_bind') delete a.bind
    if (error) a.error = error
    else delete a.error
    deps.onStatus?.(status(a))
    if (state === 'waiting_bind') {
      for (const fn of a.waiters) fn()
      a.waiters.clear()
    }
  }

  /** 立即取消账号正在进行的启动（等待扫码、长时间握手），再排队执行 fn，避免 fn 一直排在一个不会结束的启动后面 */
  function interrupt(a: AccountRuntime, fn: () => Promise<void>): Promise<void> {
    a.controller?.abort()
    return serialize(a, fn)
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
    const entry = active(a.channel)
    if (!entry) return setState(a, 'waiting_driver')
    const rebind = a.rebind === true
    a.rebind = false

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
      report: (update) => {
        if (controller.signal.aborted || a.controller !== controller || (a.state !== 'starting' && a.state !== 'waiting_bind')) return
        if (update) {
          a.bind = { ...update }
          setState(a, 'waiting_bind')
        } else if (a.state !== 'starting') setState(a, 'starting')
      },
      notify: (message, level) => {
        if (!controller.signal.aborted) deps.notify?.(`${a.id === a.channel ? a.id : `${a.id}（${a.channel}）`}：${message}`, level)
      },
      rebind,
      authorize: (userId, o = {}) => {
        if (controller.signal.aborted || !userId) return
        deps.authorize?.(`${a.channel}:${userId}`, { ...o, by: `${a.channel}:${a.id}` })
      },
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
      // 被 restart / 驱动切换 / 卸载打断：状态由打断方决定，不算失败
      const interrupted = controller.signal.aborted
      await teardown(a)
      if (interrupted) return
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

  function info(e: DriverEntry, overridesBuiltin: boolean): ChannelInfo {
    return {
      id: e.driver.id,
      name: e.driver.name,
      ...(e.driver.description ? { description: e.driver.description } : {}),
      ...(e.driver.receive ? { receive: e.driver.receive } : {}),
      ...(e.driver.textLimit ? { textLimit: e.driver.textLimit } : {}),
      builtin: e.builtin,
      ...(overridesBuiltin ? { overridesBuiltin: true } : {}),
    }
  }

  /** 渠道生效的驱动变了：把该渠道的账号停掉，用新驱动（或没有驱动时 waiting_driver）重新启动 */
  function switchDriver(channel: string): Promise<void> {
    const affected = [...accounts.values()].filter((a) => a.channel === channel)
    return Promise.all(
      affected.map((a) =>
        interrupt(a, async () => {
          await teardown(a)
          if (disposed) return setState(a, 'stopped')
          await startAccount(a)
        }),
      ),
    ).then(() => {})
  }

  const label = (d: ChannelDriver) => `${d.name}（${d.id}）`

  // 配置中的账号：先登记，等驱动注册后自动启动；单个账号配置错误不影响其他账号
  for (const [id, raw] of Object.entries(deps.accounts)) {
    const base = { id, state: 'waiting_driver' as AccountState, received: 0, sent: 0, op: Promise.resolve(), waiters: new Set<() => void>() }
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
    registerDriver(driver, opts = {}) {
      if (!ID.test(driver.id)) throw new Error(`invalid channel driver id "${driver.id}"`)
      const builtin = opts.builtin === true
      const slot = slots.get(driver.id) ?? {}
      if (builtin ? slot.builtin : slot.external) throw new Error(`channel driver "${driver.id}" is already registered`)
      const entry: DriverEntry = { driver, builtin }
      const before = active(driver.id)
      if (builtin) slot.builtin = entry
      else slot.external = entry
      slots.set(driver.id, slot)
      log.debug({ channel: driver.id, builtin }, 'gateway: channel driver registered')
      if (!builtin && slot.builtin) {
        log.info({ channel: driver.id, driver: driver.name }, 'gateway: plugin driver overrides built-in driver')
        deps.notify?.(`渠道 ${driver.id} 改用插件提供的驱动 ${label(driver)}，内置驱动已停用（卸载该插件即恢复内置驱动）`)
      } else if (builtin && slot.external) {
        log.info({ channel: driver.id }, 'gateway: built-in driver shadowed by plugin driver')
      }
      if (active(driver.id) !== before) void switchDriver(driver.id)

      return async () => {
        const cur = slots.get(driver.id)
        if (!cur || (builtin ? cur.builtin : cur.external) !== entry) return
        const was = active(driver.id)
        if (builtin) delete cur.builtin
        else delete cur.external
        if (!cur.builtin && !cur.external) slots.delete(driver.id)
        const now = active(driver.id)
        if (now === was) return
        if (!disposed && now?.builtin) {
          log.info({ channel: driver.id }, 'gateway: plugin driver removed, built-in driver restored')
          deps.notify?.(`渠道 ${driver.id} 的插件驱动已卸载，恢复使用内置驱动`)
        }
        await switchDriver(driver.id)
      }
    },
    drivers: () => [...slots.values()].flatMap((slot) => (slot.external ? [info(slot.external, Boolean(slot.builtin))] : slot.builtin ? [info(slot.builtin, false)] : [])),
    accounts: () => [...accounts.values()].map(status),
    account: (id) => accounts.get(id),
    async restart(id, opts = {}) {
      const a = accounts.get(id)
      if (!a) throw new Error(`unknown account "${id}"`)
      // 进入 waiting_bind（等用户扫码）就返回，不必等绑定完成
      let release!: () => void
      const bound = new Promise<void>((r) => (release = r))
      const op = interrupt(a, async () => {
        a.waiters.add(release)
        if (opts.rebind) a.rebind = true
        await teardown(a)
        await startAccount(a)
      })
      try {
        await Promise.race([op, bound])
      } finally {
        a.waiters.delete(release)
      }
      return status(a)
    },
    async send(id, target, message, signal) {
      const a = accounts.get(id)
      if (!a) throw new Error(`unknown account "${id}"`)
      const conn = a.conn
      if (a.state !== 'running' || !conn) throw new Error(`account "${id}" is not running (${a.state}${a.error ? `: ${a.error}` : ''})`)
      const limit = active(a.channel)?.driver.textLimit ?? 4000
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
      await Promise.all([...accounts.values()].map((a) => interrupt(a, () => teardown(a))))
    },
  }
}
