/**
 * leo-plugin-gateway：leo 的消息网关（参考 OpenClaw Gateway、Hermes Messaging Gateway）。
 *
 * 一个常驻的“总机”：接入 Telegram / 飞书 / QQ 等聊天平台，把每个聊天路由到独立的 leo 会话，
 * 由 leo 的 Agent 回复；同一个端口提供控制面 HTTP / SSE / WebSocket 与 OpenAI 兼容接口。
 *
 * 0.2.0 起网关是“注册层”：授权、会话、路由、审批、控制面归网关；聊天平台是驱动，
 * 内置驱动（telegram / feishu / qq）由网关自己注册，其他插件用 `ctx.get('gateway').registerChannel(driver)` 注册，
 * 与内置驱动同 id 时顶替内置驱动（如 leo-plugin-gateway-qq）。
 *
 * 运行：`leo serve`（后台常驻，推荐）或交互式 `leo`（对话的同时网关也在线）。
 *
 * - 服务 `gateway`（见 GatewayService）：渠道、会话、投递、配对
 * - 事件 `gateway/message`、`gateway/turn-start`、`gateway/turn-end`、`gateway/sent`、`gateway/status`、
 *   `gateway/pairing-requested`、`gateway/paired`、`gateway/session-reset`
 * - 工具 `gateway_status`（只读）、`gateway_send`（gateway.send，副作用）、`gateway_pair`（gateway.pair，副作用）
 * - 配置 `~/.leo/gateway.json` / `.leo/gateway.json`（热加载：改完自动重启网关）
 */
import type { Context, EventDef, PluginDefinition } from 'leo-agents'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { BUILTIN_DRIVERS } from './channels/index.js'
import { createChannelRegistry } from './channels/registry.js'
import { type GatewayConfig, GatewayConfigSchema } from './config.js'
import { agentFactoryOf, GatewayCore } from './core.js'
import { CONFIG_FILE_NAME, mergeConfig, readConfigFile } from './files.js'
import { accountNotifier, controlPlaneLines, createNotify, primaryBase } from './notice.js'
import { resolveValue } from './secrets.js'
import { GatewayServer } from './server.js'
import { GatewayState } from './state.js'
import { createPairingTool, createSendTool, createStatusTool } from './tools.js'
import type { AccountStatus, GatewayService, GatewayTurnResult, InboundMessage, PairingRequest } from './types.js'

export type * from './types.js'
export type { GatewayConfig, GatewayConfigInput, AccountInput } from './config.js'
export { BUILTIN_CHANNELS, GatewayConfigSchema } from './config.js'
export { CONFIG_FILE_NAME, mergeConfig, stripJsonc } from './files.js'
export { parseCommand, HELP, GATEWAY_INSTRUCTIONS } from './core.js'
export { sessionKey } from './state.js'
export { splitText } from './text.js'
export { PROTOCOL_VERSION, WS_METHODS } from './server.js'

declare module 'leo-agents' {
  interface Services {
    gateway: GatewayService
  }
  interface Events {
    /** 通过授权、即将路由的入站消息 */
    'gateway/message': EventDef<'emit', { sessionKey: string; message: InboundMessage }>
    'gateway/turn-start': EventDef<'emit', { sessionKey: string; sessionId: string; text: string }>
    'gateway/turn-end': EventDef<'emit', GatewayTurnResult>
    'gateway/sent': EventDef<'emit', { account: string; chatId: string; text: string; messageIds: string[] }>
    'gateway/status': EventDef<'emit', AccountStatus>
    'gateway/pairing-requested': EventDef<'emit', PairingRequest>
    'gateway/paired': EventDef<'emit', { user: string; by?: string }>
    'gateway/session-reset': EventDef<'emit', { sessionKey: string }>
  }
}

export interface GatewayPluginOptions {
  /** 测试用：替换出站 fetch */
  fetch?: typeof fetch
  /** 测试用：替换 WebSocket 构造器 */
  WebSocket?: typeof WebSocket
}

/** 广播给 WebSocket 订阅者的事件 */
const BROADCAST = ['gateway/message', 'gateway/turn-start', 'gateway/turn-end', 'gateway/sent', 'gateway/status', 'gateway/pairing-requested', 'gateway/paired', 'gateway/session-reset'] as const

/** 插件配置只做“原样接收”，与 gateway.json 合并后再统一校验（这样文件里的值不会被默认值覆盖） */
const PluginConfigSchema = z.record(z.string(), z.unknown()).prefault({})

export function createGatewayPlugin(opts: GatewayPluginOptions = {}): PluginDefinition<Record<string, unknown>> & { watch?: readonly string[] } {
  return {
    name: 'leo-plugin-gateway',
    inject: ['tools'],
    config: PluginConfigSchema,
    // leo-agents 热加载：gateway.json 变化后自动重新加载本插件（重启网关）；旧版宿主忽略此字段
    watch: [CONFIG_FILE_NAME],
    async apply(ctx, raw) {
      const notify = createNotify(ctx)
      const config = await loadConfig(ctx, raw)
      if (!config.enabled) {
        notify('已停用（gateway.json 里 enabled=false）')
        // 仍然提供一个空的注册层，依赖 gateway 服务的渠道插件（如 leo-plugin-gateway-qq）不会因此卡住宿主启动
        ctx.provide('gateway', disabledService())
        return void ctx.logger.info('gateway: disabled (enabled=false)')
      }

      const paths = ctx.maybe('leoPaths')
      const base = paths?.projectRoot ?? paths?.cwd ?? process.cwd()
      const stateDir = config.stateDir ? (isAbsolute(config.stateDir) ? config.stateDir : resolve(base, config.stateDir)) : paths ? join(paths.projectDir ?? paths.userDir, 'gateway') : undefined
      const state = new GatewayState(stateDir ? GatewayState.fileIn(stateDir) : undefined)
      await state.load()
      await ctx.effect(() => () => state.flush())

      let token: string | undefined
      if (config.server.token) {
        try {
          token = resolveValue(config.server.token) || undefined
        } catch (err) {
          throw new Error(`gateway: server.token: ${(err as Error).message}`)
        }
      }

      // —— 组件 ——
      // eslint-disable-next-line prefer-const
      let registry: ReturnType<typeof createChannelRegistry>
      const core = new GatewayCore({
        ctx,
        config,
        state,
        sendTo: async (account, target, text, replyTo, signal) => {
          const r = await registry.send(account, target, { text, ...(replyTo ? { replyTo } : {}) }, signal)
          ctx.emit('gateway/sent', { account, chatId: target.chatId, text, messageIds: r.messageIds })
          return r
        },
        accountConfig: (id) => registry.account(id)?.config,
        accountIds: () => registry.accounts().map((a) => a.account),
      })

      const listeners = new Set<(event: string, payload: unknown) => void>()
      for (const name of BROADCAST) {
        ctx.on(name, (payload: unknown) => {
          for (const fn of listeners) fn(name, payload)
        })
      }

      const service: GatewayService = {
        registerChannel: (driver) => registry.registerDriver(driver),
        channels: () => registry.drivers(),
        accounts: () => registry.accounts(),
        restartAccount: (id, o) => registry.restart(id, o),
        sessions: () => core.sessions(),
        chat: (input) => core.chat(input),
        resetSession: (key) => core.resetSession(key),
        abortSession: (key) => core.abortSession(key),
        history: (key) => core.history(key),
        async send(target, text, signal) {
          const t = core.resolveTarget(target)
          const r = await registry.send(t.account, t.target, { text, ...(t.replyTo ? { replyTo: t.replyTo } : {}) }, signal)
          ctx.emit('gateway/sent', { account: t.account, chatId: t.target.chatId, text, messageIds: r.messageIds })
          return { ...r, account: t.account, chatId: t.target.chatId }
        },
        inject: (m) => registry.dispatch(m),
        pairing: () => state.pending(),
        approvePairing: (code) => core.approvePairing(code, 'operator'),
        revokeUser: (user) => state.unpair(user),
        pairedUsers: () => state.pairedUsers(),
        sessionOfAgent: (agentId) => core.laneOfAgent(agentId)?.key,
        address: () => server?.address(),
      }

      const server = config.server.enabled
        ? new GatewayServer(
            config.server,
            token,
            {
              service,
              resolveApproval: (key, approved) => core.resolveApprovalFor(key, approved),
              subscribe: (fn) => {
                listeners.add(fn)
                return () => listeners.delete(fn)
              },
              info: () => ({ name: 'leo-gateway', model: config.agent.model ?? agentFactoryOf(ctx)?.defaultModel ?? null, busy: config.sessions.busy }),
              modelName: () => config.agent.model ?? agentFactoryOf(ctx)?.defaultModel ?? 'leo',
            },
            ctx.logger,
          )
        : undefined
      const onAccountStatus = accountNotifier(notify, () => {
        const addr = server?.address()
        return addr ? primaryBase(addr) : undefined
      })

      registry = createChannelRegistry({
        ctx,
        accounts: config.channels,
        notify: (m, l) => notify(m, l),
        authorize: (user, o) => core.authorize(user, o),
        mountHook: (account, handler) => {
          if (!server) return Promise.reject(new Error(`account "${account}" uses webhook mode but server.enabled is false`))
          return server.mountHook(account, handler)
        },
        onInbound: (m, a) => core.handleInbound(m, a.config),
        onStatus: (s) => {
          ctx.emit('gateway/status', s)
          onAccountStatus(s)
        },
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        ...(opts.WebSocket ? { WebSocket: opts.WebSocket } : {}),
      })

      // 清理顺序（LIFO）：先停平台账号，再关会话，最后关端口
      if (server) {
        await server.start()
        await ctx.effect(() => () => server.close())
        const addr = server.address()
        if (addr) for (const line of controlPlaneLines(addr, Boolean(token))) notify(line)
      } else {
        notify('控制面已关闭（server.enabled=false），只运行聊天渠道')
      }
      await ctx.effect(() => () => core.dispose())
      await ctx.effect(() => () => registry.dispose())
      ctx.provide('gateway', service)

      // 审批：网关会话里需要审批的工具在聊天里问（最外层中间件）；宿主没有审批服务时（leo serve）由网关兜底
      ctx.on('tools/pre-execute', (p, next) => core.preExecute(p, next), { prepend: true })
      if (!ctx.has('approval')) ctx.provide('approval', { request: (req, signal) => core.approve(req, signal) })
      // 聊天里的 Agent 不能自己批准配对
      ctx.on('tools/guard', (p) => (p.tool.name === 'gateway_pair' && core.laneOfAgent(p.agentId) ? { deny: 'pairing can only be approved by the operator or an admin (/pair)' } : undefined))

      if (config.tools) {
        const get = () => service
        await ctx.effect(() => ctx.get('tools').register(createStatusTool(get)))
        await ctx.effect(() => ctx.get('tools').register(createSendTool(get)))
        await ctx.effect(() => ctx.get('tools').register(createPairingTool(get)))
      }

      // 最后注册驱动：注册即启动对应账号
      for (const id of config.builtin) await ctx.effect(() => registry.registerDriver(BUILTIN_DRIVERS[id], { builtin: true }))

      // 最后注册 → 卸载时最先执行
      await ctx.effect(() => () => notify.mute())

      if (!registry.accounts().length) {
        notify(`还没有配置聊天渠道账号：编辑 ${paths ? join(paths.userDir, CONFIG_FILE_NAME) : CONFIG_FILE_NAME} 的 channels，保存后自动生效`, 'warn')
      }

      const a = server?.address()
      ctx.logger.info(
        { accounts: registry.accounts().map((x) => `${x.account}(${x.channel})`), control: a ? `http://${a.host}:${a.port}` : 'disabled' },
        'gateway: started',
      )
    },
  }
}

/** enabled=false 时提供的空注册层：驱动可以注册（不启动任何账号），其余操作报错 */
function disabledService(): GatewayService {
  const off = (): never => {
    throw new Error('gateway is disabled (enabled=false in gateway.json)')
  }
  return {
    registerChannel: () => () => {},
    channels: () => [],
    accounts: () => [],
    restartAccount: async () => off(),
    sessions: () => [],
    chat: async () => off(),
    resetSession: async () => false,
    abortSession: () => false,
    history: async () => [],
    send: async () => off(),
    inject: () => {},
    pairing: () => [],
    approvePairing: () => undefined,
    revokeUser: () => false,
    pairedUsers: () => [],
    sessionOfAgent: () => undefined,
    address: () => undefined,
  }
}

/** 合并 ~/.leo/gateway.json < .leo/gateway.json < 插件配置，再统一校验 */
export async function loadConfig(ctx: Context<any>, raw: Record<string, unknown>): Promise<GatewayConfig> {
  const paths = ctx.maybe('leoPaths')
  const layers: Record<string, unknown>[] = []
  if (raw.loadConfigFiles !== false && paths) {
    for (const dir of [paths.userDir, paths.projectDir]) {
      if (!dir) continue
      const f = await readConfigFile(dir)
      if (f) {
        layers.push(f.data)
        ctx.logger.debug({ file: f.file }, 'gateway: config file loaded')
      }
    }
  }
  layers.push(raw)
  const merged = mergeConfig(...layers)
  const parsed = GatewayConfigSchema.safeParse(merged)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new Error(`gateway: invalid configuration: ${issues}`)
  }
  return parsed.data
}

const plugin = createGatewayPlugin()
export default plugin
