// 测试用的假 MCP 服务器核心逻辑（与传输无关）。
// era: 'modern'（只支持 2026-07-28）| 'legacy'（只支持 initialize）| 'dual'
export const MODERN = '2026-07-28'
export const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

export const TOOLS = [
  { name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'add', description: 'Add numbers', annotations: { readOnlyHint: true }, inputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } },
  { name: 'slow', description: 'Reports progress', inputSchema: { type: 'object', properties: { steps: { type: 'integer' } } } },
  { name: 'fail', description: 'Always fails', inputSchema: { type: 'object', properties: {} } },
  { name: 'image', description: 'Returns an image', inputSchema: { type: 'object', properties: {} } },
  { name: 'whoami', description: 'Returns env and meta', inputSchema: { type: 'object', properties: {} } },
  { name: 'region', description: 'Header tool', inputSchema: { type: 'object', properties: { region: { type: 'string', 'x-mcp-header': 'Region' }, q: { type: 'string' } } } },
  { name: 'bad_header', description: 'Invalid header annotation', inputSchema: { type: 'object', properties: { list: { type: 'array', items: { type: 'string', 'x-mcp-header': 'Item' } } } } },
]

const err = (id, code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } })
const ok = (id, result) => ({ jsonrpc: '2.0', id, result })

/**
 * 创建一个服务器实例。state 对应 stdio 进程或 HTTP 会话。
 * handle(msg, ctx) → Promise<response | undefined>；ctx.notify(n) 发送与请求相关的通知；ctx.headers 为 HTTP 头
 */
export function createServer({ era = 'dual', pageSize = 0, log = [] } = {}) {
  let initialized = null // legacy 协商的版本
  const cancelled = new Set()

  async function callTool(id, params, ctx, meta) {
    const args = params.arguments ?? {}
    switch (params.name) {
      case 'echo':
        return ok(id, { content: [{ type: 'text', text: `echo: ${args.text}` }] })
      case 'add':
        return ok(id, { content: [{ type: 'text', text: String(args.a + args.b) }], structuredContent: { sum: args.a + args.b } })
      case 'slow': {
        const token = params._meta?.progressToken
        const steps = args.steps ?? 3
        for (let i = 1; i <= steps; i++) {
          await new Promise((r) => setTimeout(r, 20))
          if (cancelled.has(id)) return undefined
          if (token !== undefined) ctx.notify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: i, total: steps, message: `step ${i}` } })
        }
        return ok(id, { content: [{ type: 'text', text: 'slow done' }] })
      }
      case 'fail':
        return ok(id, { isError: true, content: [{ type: 'text', text: 'it broke' }] })
      case 'image':
        return ok(id, { content: [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }, { type: 'text', text: 'caption' }] })
      case 'whoami':
        return ok(id, { content: [{ type: 'text', text: JSON.stringify({ token: process.env.FAKE_TOKEN ?? null, cwd: process.cwd(), meta: meta ?? null, auth: ctx.headers?.authorization ?? null, initialized }) }] })
      case 'region':
        return ok(id, { content: [{ type: 'text', text: `region header=${ctx.headers?.['mcp-param-region'] ?? 'none'}` }] })
      default:
        return err(id, -32602, `Unknown tool ${params.name}`)
    }
  }

  async function handle(msg, ctx = { notify() {} }) {
    log.push(msg.method ?? 'response')
    if (msg.method === 'notifications/cancelled') {
      cancelled.add(msg.params?.requestId)
      return undefined
    }
    if (msg.method === 'notifications/initialized') return undefined
    if (msg.id === undefined) return undefined
    const id = msg.id
    const params = msg.params ?? {}
    const meta = params._meta ?? {}
    const pv = meta['io.modelcontextprotocol/protocolVersion']

    // modern 请求（带 _meta 协议版本）
    if (pv && era !== 'legacy') {
      if (pv !== MODERN) return err(id, -32022, 'Unsupported protocol version', { supported: era === 'dual' ? [MODERN, ...LEGACY] : [MODERN], requested: pv })
      switch (msg.method) {
        case 'server/discover':
          return ok(id, { resultType: 'complete', supportedVersions: era === 'dual' ? [MODERN, ...LEGACY] : [MODERN], capabilities: { tools: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'fake', version: '1.0.0' } }, instructions: 'Use echo for testing.' })
        case 'tools/list':
          return listTools(id, params, { resultType: 'complete' })
        case 'tools/call':
          if (params.name === 'needs_input') return ok(id, { resultType: 'input_required', inputRequests: { a: { method: 'elicitation/create', params: {} } } })
          return callTool(id, params, ctx, meta)
        default:
          return err(id, -32601, 'Method not found')
      }
    }

    if (era === 'modern') {
      // modern-only 服务器收到 initialize 或缺少 _meta 的请求
      return err(id, -32600, `This server supports only ${MODERN}`)
    }

    // legacy
    if (msg.method === 'initialize') {
      const requested = params.protocolVersion
      initialized = LEGACY.includes(requested) ? requested : LEGACY[0]
      return ok(id, { protocolVersion: initialized, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fake-legacy', version: '0.9.0' }, instructions: 'Legacy server.' })
    }
    if (msg.method === 'ping') return ok(id, {})
    if (!initialized) return err(id, -32002, 'Server not initialized')
    switch (msg.method) {
      case 'tools/list':
        return listTools(id, params, {})
      case 'tools/call':
        return callTool(id, params, ctx, null)
      default:
        return err(id, -32601, 'Method not found')
    }
  }

  function listTools(id, params, extra) {
    if (!pageSize) return ok(id, { ...extra, tools: TOOLS })
    const start = Number(params.cursor ?? 0)
    const page = TOOLS.slice(start, start + pageSize)
    const next = start + pageSize < TOOLS.length ? String(start + pageSize) : undefined
    return ok(id, { ...extra, tools: page, ...(next ? { nextCursor: next } : {}) })
  }

  return { handle, get initialized() { return initialized } }
}
