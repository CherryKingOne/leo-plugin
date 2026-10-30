import { z } from 'zod'

/**
 * 单个 MCP 服务器的连接配置。
 *
 * 写法与 Claude Desktop / Claude Code / Cursor 的 `mcpServers` 兼容，可以直接把那边的配置粘过来：
 *
 * ```jsonc
 * {
 *   "mcpServers": {
 *     // 本地进程（stdio）
 *     "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
 *     // 远程（Streamable HTTP；旧版 HTTP+SSE 会自动回退）
 *     "docs": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } }
 *   }
 * }
 * ```
 */
export const ServerConfigSchema = z
  .object({
    /** 传输方式。不写时：有 command 为 stdio，有 url 为 http（自动探测 Streamable HTTP / 旧版 SSE） */
    type: z.enum(['stdio', 'http', 'streamable-http', 'streamableHttp', 'sse']).optional(),

    // —— stdio ——
    /** 启动服务器的命令 */
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    /** 额外环境变量。值支持 `$NAME` / `${NAME}` / `!command` 引用与 `${NAME}` 内插 */
    env: z.record(z.string(), z.string()).default({}),
    /** 工作目录，相对路径基于声明该服务器的配置文件所在项目 */
    cwd: z.string().optional(),

    // —— 远程 ——
    url: z.string().url().optional(),
    /** 额外请求头（如 Authorization）。值支持与 env 相同的引用写法 */
    headers: z.record(z.string(), z.string()).default({}),

    // —— 通用 ——
    /** 为 true（或 enabled: false）时不连接 */
    disabled: z.boolean().optional(),
    enabled: z.boolean().optional(),
    /**
     * 协议代际：
     * - `auto`（默认）：先按 2026-07-28（无状态）请求，服务器不认识再回退到 initialize 握手
     * - `modern`：只用 2026-07-28 及以后
     * - `legacy`：直接 initialize 握手（2025-11-25 及更早）
     */
    protocol: z.enum(['auto', 'modern', 'legacy']).default('auto'),
    /** 指定协议版本（如 "2025-06-18"），一般不需要 */
    protocolVersion: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    /** 只暴露这些工具（MCP 原始工具名） */
    includeTools: z.array(z.string()).optional(),
    /** 不暴露这些工具 */
    excludeTools: z.array(z.string()).optional(),
    /**
     * 免审批：true 表示信任该服务器全部工具，数组表示只信任列出的工具。
     * 默认所有 MCP 工具都视为副作用，按 leo 的审批模式（ask / auto / deny、-y）处理
     */
    autoApprove: z.union([z.boolean(), z.array(z.string())]).optional(),
    /** 单次工具调用超时（毫秒），覆盖插件的 timeoutMs */
    timeoutMs: z.number().int().positive().optional(),
    /** 连接超时（毫秒），覆盖插件的 connectTimeoutMs */
    connectTimeoutMs: z.number().int().positive().optional(),
    /** 写进工具说明里的服务器简介 */
    description: z.string().optional(),
  })
  .superRefine((s, ctx) => {
    const remote = s.type === 'http' || s.type === 'streamable-http' || s.type === 'streamableHttp' || s.type === 'sse'
    if (s.type === 'stdio' && !s.command) ctx.addIssue({ code: 'custom', message: 'type "stdio" requires "command"', path: ['command'] })
    if (remote && !s.url) ctx.addIssue({ code: 'custom', message: `type "${s.type}" requires "url"`, path: ['url'] })
    if (!s.type && !s.command && !s.url) ctx.addIssue({ code: 'custom', message: 'either "command" (stdio) or "url" (http) is required' })
    if (!s.type && s.command && s.url) ctx.addIssue({ code: 'custom', message: 'both "command" and "url" given; set "type" to pick one' })
  })

export type ServerConfigInput = z.input<typeof ServerConfigSchema>
export type ServerConfig = z.infer<typeof ServerConfigSchema>

/** 服务器名：用于工具名前缀与日志 */
export const SERVER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/

const DEFAULTS = {
  servers: {},
  loadServerFiles: true,
  toolPrefix: 'mcp',
  connectTimeoutMs: 30_000,
  probeTimeoutMs: 5_000,
  timeoutMs: 120_000,
  maxOutputChars: 30_000,
  includeInstructions: true,
}

export const McpConfigSchema = z
  .object({
    /** 直接在插件配置里声明的服务器，与 mcp-servers.json 合并，同名以这里为准 */
    servers: z.record(z.string().regex(SERVER_NAME_RE), z.unknown()).default({}),
    /** 读取 ~/.leo/mcp-servers.json 与项目 .leo/mcp-servers.json（需要 leo-agents 提供 leoPaths） */
    loadServerFiles: z.boolean().default(true),
    /** 工具名前缀：`<prefix>__<server>__<tool>`；设为空串则为 `<server>__<tool>` */
    toolPrefix: z
      .string()
      .regex(/^([a-zA-Z][a-zA-Z0-9_]{0,15})?$/)
      .default('mcp'),
    /** 每个服务器的连接超时（毫秒）。超时的服务器跳过，不阻塞其他服务器 */
    connectTimeoutMs: z.number().int().positive().default(30_000),
    /** stdio 下 2026-07-28 探测（server/discover）的等待时间，超时视为旧版服务器 */
    probeTimeoutMs: z.number().int().positive().default(5_000),
    /** 单次工具调用超时（毫秒） */
    timeoutMs: z.number().int().positive().default(120_000),
    /** 返回给模型的工具输出上限（字符） */
    maxOutputChars: z.number().int().positive().default(30_000),
    /** 把服务器提供的 instructions 注入系统提示 */
    includeInstructions: z.boolean().default(true),
  })
  .default(DEFAULTS)

export type McpConfig = z.infer<typeof McpConfigSchema>
