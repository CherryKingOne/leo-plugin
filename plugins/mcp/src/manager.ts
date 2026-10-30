/**
 * 管理全部 MCP 服务器：并发连接、把工具注册进 leo 的工具注册表、断线重连、列表变化时刷新。
 * 通过服务 `mcp` 暴露给代码使用。
 */
import { isAbsolute, resolve } from 'node:path'
import type { Context, Disposer, ToolDefinition, ToolOutput, ToolProgress } from 'leo-agents'
import { type CallToolResult, McpClient, type McpTool } from './client.js'
import { type McpConfig, SERVER_NAME_RE, type ServerConfig, ServerConfigSchema } from './config.js'
import { toContent, toolName, toParameters } from './convert.js'
import type { ServerSource } from './files.js'
import { resolveRecord } from './secrets.js'

export type ServerStatus = 'disabled' | 'connecting' | 'connected' | 'failed'

export interface McpServerState {
  name: string
  status: ServerStatus
  transport?: 'stdio' | 'http' | 'sse'
  /** modern = 2026-07-28 起（无状态）；legacy = initialize 握手 */
  era?: 'modern' | 'legacy'
  protocolVersion?: string
  serverInfo?: { name?: string; version?: string }
  /** leo 中注册的工具名 → MCP 原始工具名 */
  tools: { name: string; mcpName: string }[]
  error?: string
  file?: string
}

export interface McpService {
  /** 所有服务器的状态 */
  servers(): McpServerState[]
  /** 调用某个服务器的工具（不经过 leo 的审批管线，代码直接调用时自行负责） */
  callTool(server: string, tool: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult>
  /** 重新拉取工具列表 */
  refresh(server: string): Promise<McpServerState>
  /** 断开并重新连接 */
  reconnect(server: string): Promise<McpServerState>
}

interface Entry {
  state: McpServerState
  config?: ServerConfig
  client?: McpClient
  tools: Map<string, McpTool>
  disposers: Disposer[]
}

const PKG_VERSION = '0.1.0'

export function createManager(ctx: Context<any>, config: McpConfig, sources: Record<string, ServerSource>) {
  const entries = new Map<string, Entry>()
  let disposed = false
  const log = ctx.logger

  const fail = (e: Entry, err: unknown) => {
    e.state.status = 'failed'
    e.state.error = (err as Error)?.message ?? String(err)
    log.warn({ server: e.state.name, err: e.state.error }, 'mcp: server unavailable')
    ctx.emit('mcp/error', { server: e.state.name, error: e.state.error })
  }

  for (const [name, src] of Object.entries(sources)) {
    const state: McpServerState = { name, status: 'connecting', tools: [], ...(src.file ? { file: src.file } : {}) }
    const e: Entry = { state, tools: new Map(), disposers: [] }
    entries.set(name, e)
    if (!SERVER_NAME_RE.test(name)) {
      fail(e, new Error(`invalid server name "${name}" (letters, digits, _ . - only)`))
      continue
    }
    const parsed = ServerConfigSchema.safeParse(src.raw)
    if (!parsed.success) {
      fail(e, new Error(`invalid config${src.file ? ` in ${src.file}` : ''}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`))
      continue
    }
    const sc = parsed.data
    e.config = sc
    if (sc.disabled === true || sc.enabled === false) {
      state.status = 'disabled'
      continue
    }
    try {
      const sseOnly = sc.type === 'sse'
      const transport =
        sc.type === 'stdio' || (!sc.type && sc.command)
          ? {
              kind: 'stdio' as const,
              command: sc.command!,
              args: sc.args,
              env: resolveRecord(sc.env),
              ...(sc.cwd ? { cwd: isAbsolute(sc.cwd) ? sc.cwd : resolve(src.baseDir, sc.cwd) } : { cwd: src.baseDir }),
            }
          : { kind: 'http' as const, url: sc.url!, headers: resolveRecord(sc.headers), ...(sseOnly ? { sseOnly } : {}) }
      e.client = new McpClient({
        name,
        transport,
        protocol: sc.protocol,
        ...(sc.protocolVersion ? { protocolVersion: sc.protocolVersion } : {}),
        clientInfo: { name: 'leo-plugin-mcp', version: PKG_VERSION },
        connectTimeoutMs: sc.connectTimeoutMs ?? config.connectTimeoutMs,
        probeTimeoutMs: config.probeTimeoutMs,
        onStderr: (line) => log.debug({ server: name }, line),
        onLog: (level, msg) => log.debug({ server: name, level }, msg),
        onToolsChanged: () => void refreshTools(e).catch((err) => log.warn({ server: name, err: (err as Error).message }, 'mcp: refresh failed')),
        onDisconnect: (err) => {
          // 下次调用时自动重连；这里只更新状态
          log.debug({ server: name, err: err.message }, 'mcp: disconnected')
        },
      })
    } catch (err) {
      // 典型：引用的环境变量未设置
      fail(e, err)
    }
  }

  const isApproved = (sc: ServerConfig, mcpName: string) => (sc.autoApprove === true ? true : Array.isArray(sc.autoApprove) ? sc.autoApprove.includes(mcpName) : false)

  const makeTool = (e: Entry, t: McpTool, name: string): ToolDefinition => {
    const sc = e.config!
    const server = e.state.name
    const desc = (t.description ?? t.annotations?.title ?? t.title ?? '').trim()
    return {
      name,
      ...(t.title || t.annotations?.title ? { title: t.title ?? t.annotations?.title } : {}),
      description: `${desc || `MCP tool "${t.name}".`}\n\n(From MCP server "${server}"${sc.description ? `: ${sc.description}` : ''}.)`,
      parameters: toParameters(t.inputSchema),
      // 外部工具的副作用未知（annotations 只是服务器自报的提示，不可信），默认交给审批策略
      permissions: [{ kind: 'mcp.call', server, tool: t.name, sideEffect: !isApproved(sc, t.name), ...(t.annotations?.readOnlyHint ? { readOnlyHint: true } : {}) }],
      timeoutMs: sc.timeoutMs ?? config.timeoutMs,
      tags: ['mcp', `mcp:${server}`],
      async execute(args: unknown, exec): Promise<ToolOutput> {
        const client = e.client!
        const res = await client.callTool(t, (args && typeof args === 'object' ? args : {}) as Record<string, unknown>, {
          signal: exec.signal,
          timeoutMs: sc.timeoutMs ?? config.timeoutMs,
          onProgress: (p) => {
            const pct = p.total ? ` ${Math.round((p.progress / p.total) * 100)}%` : ''
            exec.onUpdate({ ...p, type: 'progress', message: `${server}/${t.name}${pct}${p.message ? ` ${p.message}` : ''}` } satisfies ToolProgress)
          },
        })
        const out: ToolOutput = { content: toContent(res, config.maxOutputChars), ...(res.isError ? { isError: true } : {}) }
        if (res.structuredContent !== undefined) out.details = { structuredContent: res.structuredContent }
        return Object.assign(out, { [Symbol.for('leo.toolOutput')]: true })
      },
    }
  }

  const unregister = (e: Entry) => {
    for (const d of e.disposers.splice(0)) d()
    e.state.tools = []
    e.tools.clear()
  }

  async function refreshTools(e: Entry) {
    const sc = e.config!
    const list = await e.client!.listTools((tool, reason) => log.warn({ server: e.state.name, tool, reason }, 'mcp: tool excluded (invalid x-mcp-header)'))
    if (disposed) return
    unregister(e)
    const registry = ctx.get('tools')
    for (const t of list) {
      if (sc.includeTools && !sc.includeTools.includes(t.name)) continue
      if (sc.excludeTools?.includes(t.name)) continue
      const name = toolName(config.toolPrefix, e.state.name, t.name)
      if (registry.get(name)) {
        log.warn({ server: e.state.name, tool: t.name, name }, 'mcp: tool name already registered, skipped')
        continue
      }
      e.disposers.push(registry.register(makeTool(e, t, name)))
      e.tools.set(t.name, t)
      e.state.tools.push({ name, mcpName: t.name })
    }
  }

  async function start(e: Entry) {
    if (!e.client) return
    e.state.status = 'connecting'
    delete e.state.error
    try {
      await e.client.connect()
      await refreshTools(e)
      const c = e.client
      Object.assign(e.state, {
        status: 'connected' as const,
        ...(c.transportKind ? { transport: c.transportKind } : {}),
        ...(c.era ? { era: c.era } : {}),
        ...(c.protocolVersion ? { protocolVersion: c.protocolVersion } : {}),
        serverInfo: { ...(c.server.name ? { name: c.server.name } : {}), ...(c.server.version ? { version: c.server.version } : {}) },
      })
      log.info({ server: e.state.name, era: c.era, version: c.protocolVersion, tools: e.state.tools.length }, 'mcp: connected')
      ctx.emit('mcp/connected', { server: e.state.name, era: c.era!, protocolVersion: c.protocolVersion!, tools: e.state.tools.map((t) => t.name) })
    } catch (err) {
      await e.client.close().catch(() => {})
      fail(e, err)
    }
  }

  const entry = (name: string) => {
    const e = entries.get(name)
    if (!e) throw new Error(`unknown MCP server "${name}"`)
    return e
  }
  const snapshot = (e: Entry): McpServerState => structuredClone(e.state)

  const service: McpService = {
    servers: () => [...entries.values()].map(snapshot),
    async callTool(server, tool, args = {}, signal) {
      const e = entry(server)
      if (!e.client) throw new Error(`MCP server "${server}" is ${e.state.status}${e.state.error ? `: ${e.state.error}` : ''}`)
      const t = e.tools.get(tool) ?? { name: tool, inputSchema: { type: 'object' } }
      return e.client.callTool(t, args, { ...(signal ? { signal } : {}), timeoutMs: e.config?.timeoutMs ?? config.timeoutMs })
    },
    async refresh(server) {
      const e = entry(server)
      if (e.client) await refreshTools(e)
      return snapshot(e)
    },
    async reconnect(server) {
      const e = entry(server)
      unregister(e)
      await e.client?.close()
      await start(e)
      return snapshot(e)
    },
  }

  /** 服务器 instructions，供系统提示片段使用 */
  const instructions = () =>
    [...entries.values()]
      .filter((e) => e.state.status === 'connected' && e.client?.server.instructions)
      .map((e) => `## MCP server "${e.state.name}"\n${e.client!.server.instructions!.trim()}`)
      .join('\n\n')

  return {
    service,
    instructions,
    /** 并发连接全部服务器；单个失败不影响其他 */
    startAll: () => Promise.allSettled([...entries.values()].map(start)).then(() => undefined),
    async closeAll() {
      disposed = true
      await Promise.allSettled([...entries.values()].map(async (e) => {
        unregister(e)
        await e.client?.close()
      }))
    },
  }
}
