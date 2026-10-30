import { z } from 'zod'

export const BUILTIN_CHANNELS = ['qq', 'feishu', 'telegram'] as const
export type BuiltinChannel = (typeof BUILTIN_CHANNELS)[number]

const ID = /^[a-z][a-z0-9-]{0,63}$/

/** 单个机器人账号。`options` 的结构由对应渠道驱动定义，在驱动注册后校验 */
export const AccountSchema = z.object({
  /** 渠道驱动 id：qq / feishu / telegram，或第三方渠道 id */
  channel: z.string().regex(ID, 'channel 必须是 kebab-case 渠道 id'),
  enabled: z.boolean().default(true),
  /** 各渠道自己的机器人配置（密钥写 $ENV / !command 引用，不要写明文） */
  options: z.record(z.string(), z.unknown()).default({}),
  /** 发送者白名单（渠道侧用户 id）；为空表示不限制 */
  allowFrom: z.array(z.string()).default([]),
  /** 会话白名单（渠道侧 chat id）；为空表示不限制 */
  allowChats: z.array(z.string()).default([]),
  /** 群聊里必须 @ 机器人才处理 */
  requireMention: z.boolean().default(true),
  /** 交给 Agent 自动回复（还需全局 agent.enabled） */
  autoReply: z.boolean().default(true),
})
export type AccountInput = z.input<typeof AccountSchema>

export const AgentBridgeSchema = z.object({
  /** 开启后，入站消息默认交给 Agent 处理并把回复发回原会话 */
  enabled: z.boolean().default(false),
  /** `provider/model`；开启 agent 时必填 */
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  /**
   * 聊天 Agent 可用的工具名。默认不给任何工具（聊天对象是外部用户，fail closed）。
   * 需要时显式列出，如 ["web_fetch"]
   */
  tools: z.array(z.string()).default([]),
  /** 同时运行的 turn 上限（全局） */
  maxConcurrent: z.number().int().min(1).max(64).default(4),
  /** 每个会话排队等待的消息上限，超出的消息被丢弃并记录日志 */
  maxQueuePerChat: z.number().int().min(1).max(100).default(5),
  /** 保留的会话 Agent 上限（LRU） */
  maxSessions: z.number().int().min(1).max(10_000).default(200),
  /** 单个 turn 超时（毫秒） */
  turnTimeoutMs: z.number().int().positive().default(120_000),
  /** 单个 turn 最大步数 */
  maxSteps: z.number().int().positive().default(10),
  /** Agent 出错时回给用户的提示；空字符串表示不回 */
  errorReply: z.string().default('抱歉，处理消息时出错了，请稍后再试。'),
})

export const WebhookSchema = z.object({
  /** 默认只监听本机，由反向代理（nginx / Caddy / 内网穿透）暴露 HTTPS */
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(0).max(65535).default(8790),
  /** 回调路径前缀，最终路径为 `<basePath>/<account>` */
  basePath: z
    .string()
    .regex(/^\/[A-Za-z0-9/_-]*$/)
    .default('/leo/chat'),
  /** 请求体上限（字节） */
  maxBodyBytes: z.number().int().positive().default(1_048_576),
})

export const ChatChannelsConfigSchema = z
  .object({
    /** 要加载的内置渠道子插件；只注册驱动，不会启动任何机器人 */
    builtin: z.array(z.enum(BUILTIN_CHANNELS)).default([...BUILTIN_CHANNELS]),
    /**
     * 读取机器人配置目录：`~/.leo/chat-channels/<渠道>.json` 与 `<项目>/.leo/chat-channels/<渠道>.json`
     *（需要 leo-agents 提供 leoPaths）。推荐把机器人写在这里，而不是 accounts
     */
    loadBotFiles: z.boolean().default(true),
    /** 额外的机器人配置目录（相对路径基于项目根或 cwd），优先级最高 */
    botsDir: z.string().optional(),
    /** 直接在插件配置里声明的机器人账号：键为账号 id（kebab-case），与目录中的同名账号冲突时以这里为准 */
    accounts: z.record(z.string().regex(ID, '账号 id 必须是 kebab-case'), AccountSchema).default({}),
    webhook: WebhookSchema.prefault({}),
    agent: AgentBridgeSchema.prefault({}),
    /** 出站 HTTP 请求超时（毫秒） */
    requestTimeoutMs: z.number().int().positive().default(15_000),
    /** 注册 chat_channels / chat_send 工具，让 Agent 可以主动查看渠道与发消息 */
    tools: z.boolean().default(true),
  })
  .prefault({})

export type ChatChannelsConfig = z.infer<typeof ChatChannelsConfigSchema>
export type AgentBridgeConfig = z.infer<typeof AgentBridgeSchema>
export type WebhookConfig = z.infer<typeof WebhookSchema>
