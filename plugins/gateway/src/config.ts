import { z } from 'zod'

export const BUILTIN_CHANNELS = ['telegram', 'feishu', 'qq'] as const
export type BuiltinChannel = (typeof BUILTIN_CHANNELS)[number]

export const ID = /^[a-z][a-z0-9-]{0,63}$/

/**
 * 一个机器人账号。`channel` 之外、通用字段之外的键都是该平台自己的机器人配置（options），
 * 由对应驱动的 schema 校验——这样 gateway.json 里一个账号就是一个扁平对象：
 *
 *   "telegram": { "channel": "telegram", "botToken": "$TELEGRAM_BOT_TOKEN", "allowFrom": ["12345"] }
 */
export const AccountSchema = z
  .object({
    /** 渠道驱动 id：telegram / feishu / qq，或第三方驱动 id；省略时用账号 id */
    channel: z.string().regex(ID, 'channel 必须是 kebab-case 渠道 id').optional(),
    enabled: z.boolean().default(true),
    /** 允许对话的平台用户 id（不带平台前缀）；与 auth.allowFrom、配对、管理员取并集 */
    allowFrom: z.array(z.string()).default([]),
    /** 只处理这些会话 id 的消息；为空表示不限制 */
    allowChats: z.array(z.string()).default([]),
    /** 群聊里必须 @ 机器人才处理（私聊总是处理） */
    requireMention: z.boolean().default(true),
    /** 主动消息（定时任务结果、通知）的默认投递会话 id；gateway_send 的 `home` 目标用它 */
    home: z.string().optional(),
    /** 该账号的会话额外系统提示词（如“这是客服群，只回答产品问题”） */
    prompt: z.string().optional(),
  })
  .catchall(z.unknown())
export type AccountInput = z.input<typeof AccountSchema>
export type AccountConfig = z.infer<typeof AccountSchema>
/** 账号对象里属于网关的通用字段，其余字段交给驱动 */
export const COMMON_ACCOUNT_KEYS = ['channel', 'enabled', 'allowFrom', 'allowChats', 'requireMention', 'home', 'prompt'] as const

export const ServerSchema = z.object({
  /** 控制面开关。关掉后 webhook 型渠道也无法接收回调 */
  enabled: z.boolean().default(true),
  /** 默认只监听本机；对外暴露请走反向代理 / Tailscale / SSH 隧道，并设置 token */
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(0).max(65535).default(18790),
  /**
   * 访问令牌（写 `$LEO_GATEWAY_TOKEN` 这样的引用）。HTTP 用 `Authorization: Bearer <token>`，
   * WebSocket 在第一帧 connect 的 auth.token 里带上。监听非本机地址时必须设置，否则拒绝启动
   */
  token: z.string().optional(),
  /** 渠道 webhook 回调路径前缀：`<hooksPath>/<account>` */
  hooksPath: z
    .string()
    .regex(/^\/[A-Za-z0-9/_-]*$/)
    .default('/hooks'),
  /** 请求体上限（字节） */
  maxBodyBytes: z.number().int().positive().default(4_194_304),
  /** 允许跨域访问控制面的来源（浏览器 WebChat 用）；为空不发 CORS 头 */
  corsOrigins: z.array(z.string()).default([]),
})

export const AgentSchema = z.object({
  /** `provider/model`；默认用宿主 leo 的默认模型 */
  model: z.string().optional(),
  /** 追加在宿主系统提示词之后的说明 */
  systemPrompt: z.string().optional(),
  /**
   * 网关会话可用的工具：`all`（默认，副作用工具在聊天里请求 /approve）、`none`，或工具名列表。
   * 只有已授权的用户能和网关对话，所以默认给全部工具，与 Hermes / OpenClaw 一致
   */
  tools: z.union([z.enum(['all', 'none']), z.array(z.string())]).default('all'),
  maxSteps: z.number().int().positive().optional(),
  turnTimeoutMs: z.number().int().positive().default(1_800_000),
  /** 是否把工具进度（“正在执行 bash …”）发到聊天里 */
  toolProgress: z.boolean().default(false),
  /** Agent 出错时回给用户的提示；空字符串表示不回 */
  errorReply: z.string().default('抱歉，处理消息时出错了：{error}'),
})

export const SessionsSchema = z.object({
  /** 群聊 / 频道里每个用户一个独立会话（默认）；false 表示整个群共享一个会话 */
  groupPerUser: z.boolean().default(true),
  /** 话题（Telegram forum topic 等）里每个用户一个独立会话；默认整个话题共享 */
  threadPerUser: z.boolean().default(false),
  /**
   * 会话正忙（Agent 还在跑）时收到新消息：
   * - `queue`（默认）：排队，当前 turn 结束后按顺序执行
   * - `steer`：作为插话注入当前 turn（下一步之前生效）
   * - `interrupt`：取消当前 turn，立即处理新消息
   */
  busy: z.enum(['queue', 'steer', 'interrupt']).default('queue'),
  /** 每个会话最多排队的消息数，超出的消息被丢弃并提示 */
  maxQueue: z.number().int().min(1).max(100).default(5),
  /** 全局同时运行的 turn 上限 */
  maxConcurrent: z.number().int().min(1).max(64).default(4),
  /** 内存中保留的会话 Agent 上限（LRU，淘汰后下次消息从历史恢复，不丢上下文） */
  maxCached: z.number().int().min(1).max(10_000).default(128),
})

export const AuthSchema = z.object({
  /** 允许所有人对话（不推荐，仅用于公开机器人且 tools 为 none 时） */
  allowAll: z.boolean().default(false),
  /** 允许对话的用户：`<channel>:<userId>`，如 `telegram:12345` */
  allowFrom: z.array(z.string()).default([]),
  /** 管理员（也自动获得对话权限）：可在聊天里 /pair <配对码> 批准新用户 */
  admins: z.array(z.string()).default([]),
  /** 未授权用户私聊机器人时发给他一个配对码，管理员批准后即可对话 */
  pairing: z.boolean().default(true),
  /** 配对码有效期（毫秒） */
  pairingTtlMs: z.number().int().positive().default(3_600_000),
  /** 每个账号同时待批准的配对请求上限 */
  maxPendingPairing: z.number().int().min(1).max(100).default(5),
})

export const ApprovalSchema = z.object({
  /** 等待 /approve 的超时（毫秒），超时视为拒绝 */
  timeoutMs: z.number().int().positive().default(300_000),
})

export const GatewayConfigSchema = z
  .object({
    /** 总开关：false 时插件加载但不连接任何平台、不监听端口 */
    enabled: z.boolean().default(true),
    /** 读取 `~/.leo/gateway.json` 与项目 `.leo/gateway.json`（需要宿主提供 leoPaths） */
    loadConfigFiles: z.boolean().default(true),
    /** 要注册的内置平台驱动 */
    builtin: z.array(z.enum(BUILTIN_CHANNELS)).default([...BUILTIN_CHANNELS]),
    server: ServerSchema.prefault({}),
    agent: AgentSchema.prefault({}),
    sessions: SessionsSchema.prefault({}),
    auth: AuthSchema.prefault({}),
    approval: ApprovalSchema.prefault({}),
    /** 机器人账号：键为账号 id（kebab-case） */
    channels: z.record(z.string().regex(ID, '账号 id 必须是 kebab-case'), AccountSchema).default({}),
    /** 注册工具 gateway_status（只读）与 gateway_send（主动发消息，副作用） */
    tools: z.boolean().default(true),
    /** 网关状态目录（会话映射、配对记录）；默认 `<项目 .leo 或 ~/.leo>/gateway/` */
    stateDir: z.string().optional(),
  })
  .prefault({})

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>
export type GatewayConfigInput = z.input<typeof GatewayConfigSchema>
export type ServerConfig = z.infer<typeof ServerSchema>
export type AgentConfig = z.infer<typeof AgentSchema>
export type SessionsConfig = z.infer<typeof SessionsSchema>
export type AuthConfig = z.infer<typeof AuthSchema>
