/**
 * leo-plugin-chat-channels：聊天渠道注册层（Chat Channel Registry Layer）。
 *
 * 聊天渠道插件 = 渠道注册层 + 渠道子插件体系。
 *
 * - 本插件是唯一可安装、可配置的入口（“大箱子”）。
 * - QQ / 飞书 / Telegram 是内置的渠道驱动（“小盒子”），位于 `src/channels/<id>/`。
 *   它们不是 leo 插件，不能单独加载，只能由本注册层注册后使用；每个渠道定义自己的机器人配置 schema。
 * - 后续新增渠道：实现一个 ChannelDriver 放进 `src/channels/<id>/` 并登记到 BUILTIN_DRIVERS；
 *   运行时也可以通过 `chatChannels.registerDriver()` 追加。
 *
 * 能力：
 * - 服务 `chatChannels`：驱动与账号管理、发送、状态
 * - 事件 `chat-channels/driver-registered`、`chat-channels/status`、`chat-channels/received`、
 *   `chat-channels/inbound`（waterfall，可拦截 / 改写回复）、`chat-channels/sent`
 * - 工具 `chat_channels`（只读）、`chat_send`（`chat.send`，副作用，走审批）
 * - 可选 Agent 桥接：收到消息自动交给 Agent 回复（默认关闭，默认不给工具）
 */
import type { EventDef, PluginDefinition } from 'leo-agents'
import { isAbsolute, join, resolve } from 'node:path'
import { createAgentBridge } from './bridge.js'
import { BUILTIN_DRIVERS } from './channels/index.js'
import { type AccountInput, type ChatChannelsConfig, ChatChannelsConfigSchema } from './config.js'
import { loadBotFiles } from './files.js'
import { createRegistry, type InboundPayload } from './registry.js'
import { createListTool, createSendTool } from './tools.js'
import type { AccountStatus, ChannelTarget, ChatChannelService, DriverInfo, InboundMessage, OutboundMessage } from './types.js'

export type * from './types.js'
export type { AgentBridgeConfig, ChatChannelsConfig, WebhookConfig, AccountInput } from './config.js'
export { BUILTIN_CHANNELS, ChatChannelsConfigSchema } from './config.js'
export type { InboundPayload } from './registry.js'
export { splitText } from './text.js'
export { BOTS_DIR_NAME }

/** 机器人配置目录名：`.leo/chat-channels/` */
const BOTS_DIR_NAME = 'chat-channels'

export interface ChatMessageSent {
  account: string
  channel: string
  target: ChannelTarget
  text: string
  messageIds: string[]
}

declare module 'leo-agents' {
  interface Services {
    chatChannels: ChatChannelService
  }
  interface Events {
    'chat-channels/driver-registered': EventDef<'emit', DriverInfo>
    'chat-channels/status': EventDef<'emit', AccountStatus>
    /** 通过过滤（白名单、@提及）的入站消息 */
    'chat-channels/received': EventDef<'emit', InboundMessage>
    /**
     * 入站消息处理链：返回要回复到原会话的消息，返回 undefined 表示不回复。
     * 链的终点是 Agent 桥接；中间件可以不调用 next() 来拦截（如指令、关键词、风控）
     */
    'chat-channels/inbound': EventDef<'waterfall', InboundPayload, OutboundMessage | undefined>
    'chat-channels/sent': EventDef<'emit', ChatMessageSent>
  }
}

export interface ChatChannelsPluginOptions {
  /** 测试用：替换出站 fetch */
  fetch?: typeof fetch
  /** 测试用：替换 WebSocket 构造器 */
  WebSocket?: typeof WebSocket
}

/** 创建插件对象；默认导出的是 `createChatChannelsPlugin()` */
export function createChatChannelsPlugin(opts: ChatChannelsPluginOptions = {}): PluginDefinition<ChatChannelsConfig> {
  return {
    name: 'leo-plugin-chat-channels',
    inject: ['tools'],
    config: ChatChannelsConfigSchema,
    async apply(ctx, rawConfig) {
      const config = { ...rawConfig, accounts: await collectAccounts(ctx, rawConfig) }
      const bridge = createAgentBridge(ctx, config.agent)
      const registry = createRegistry({
        ctx,
        config,
        builtinIds: new Set(config.builtin),
        final: (p) => bridge.handle(p),
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        ...(opts.WebSocket ? { WebSocket: opts.WebSocket } : {}),
      })
      // 先挂清理：注册驱动会启动账号，期间卸载也能停干净（LIFO：先停账号与 webhook，再释放会话 Agent）
      await ctx.effect(() => () => bridge.dispose())
      await ctx.effect(() => () => registry.dispose())
      ctx.provide('chatChannels', registry.service)

      // 把内置的小盒子装进大箱子
      for (const id of config.builtin) {
        const driver = BUILTIN_DRIVERS[id]
        await ctx.effect(() => registry.service.registerDriver(driver))
      }

      if (config.tools) {
        const service = () => registry.service
        await ctx.effect(() => ctx.get('tools').register(createListTool(service)))
        await ctx.effect(() => ctx.get('tools').register(createSendTool(service)))
      }
    },
  }
}

/** 合并 机器人配置目录 与 插件配置里的 accounts（后者优先） */
async function collectAccounts(ctx: Parameters<PluginDefinition<ChatChannelsConfig>['apply']>[0], config: ChatChannelsConfig): Promise<ChatChannelsConfig['accounts']> {
  const paths = ctx.maybe('leoPaths')
  const dirs: (string | undefined)[] = []
  if (config.loadBotFiles && paths) dirs.push(join(paths.userDir, BOTS_DIR_NAME), paths.projectDir ? join(paths.projectDir, BOTS_DIR_NAME) : undefined)
  if (config.botsDir) dirs.push(isAbsolute(config.botsDir) ? config.botsDir : resolve(paths?.projectRoot ?? paths?.cwd ?? process.cwd(), config.botsDir))
  if (!dirs.some(Boolean)) return config.accounts
  const fromFiles = await loadBotFiles(dirs, (file, err) => ctx.logger.warn({ file, err: err.message }, 'chat-channels: failed to read bot config file'))
  const out: Record<string, AccountInput> = {}
  for (const [id, { account, file }] of Object.entries(fromFiles)) {
    if (config.accounts[id]) {
      ctx.logger.warn({ account: id, file }, 'chat-channels: account also declared in plugin config; the plugin config wins')
      continue
    }
    out[id] = account
    ctx.logger.debug({ account: id, file }, 'chat-channels: bot loaded from file')
  }
  return { ...out, ...config.accounts } as ChatChannelsConfig['accounts']
}

const plugin = createChatChannelsPlugin()
export default plugin
