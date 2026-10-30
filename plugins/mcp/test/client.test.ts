import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { McpClient, type TransportSpec } from '../src/client.js'
import { extractHeaderParams } from '../src/headers.js'
import { encodeHeaderValue } from '../src/transports/http.js'
// @ts-expect-error 测试夹具是 .mjs
import { startHttpServer } from './fixtures/http-server.mjs'

const fixture = fileURLToPath(new URL('./fixtures/stdio-server.mjs', import.meta.url))
const stdio = (...args: string[]): TransportSpec => ({ kind: 'stdio', command: process.execPath, args: [fixture, ...args], env: {} })

const clients: McpClient[] = []
const servers: { close(): Promise<void> }[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()))
  await Promise.all(servers.splice(0).map((s) => s.close()))
})

function client(transport: TransportSpec, extra: Partial<ConstructorParameters<typeof McpClient>[0]> = {}) {
  const c = new McpClient({
    name: 't',
    transport,
    protocol: 'auto',
    clientInfo: { name: 'test', version: '0' },
    connectTimeoutMs: 5_000,
    probeTimeoutMs: 500,
    ...extra,
  })
  clients.push(c)
  return c
}

const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? '').join('')

describe('stdio', () => {
  it('modern 服务器：server/discover 探测，请求携带 _meta，无 initialize', async () => {
    const c = client(stdio('modern'))
    await c.connect()
    expect(c.era).toBe('modern')
    expect(c.protocolVersion).toBe('2026-07-28')
    expect(c.server.name).toBe('fake')
    expect(c.server.instructions).toContain('echo')
    const tools = await c.listTools()
    expect(tools.map((t) => t.name)).toContain('echo')
    const who = JSON.parse(text(await c.callTool({ name: 'whoami', inputSchema: {} }, {})))
    expect(who.meta['io.modelcontextprotocol/protocolVersion']).toBe('2026-07-28')
    expect(who.meta['io.modelcontextprotocol/clientInfo']).toEqual({ name: 'test', version: '0' })
    expect(who.initialized).toBeNull()
  })

  it('dual-era 服务器优先使用 modern', async () => {
    const c = client(stdio('dual'))
    await c.connect()
    expect(c.era).toBe('modern')
  })

  it('legacy 服务器：探测报错后回退 initialize（2025-11-25）', async () => {
    const c = client(stdio('legacy'))
    await c.connect()
    expect(c.era).toBe('legacy')
    expect(c.protocolVersion).toBe('2025-11-25')
    expect(c.server.name).toBe('fake-legacy')
    expect(text(await c.callTool({ name: 'echo', inputSchema: {} }, { text: 'hi' }))).toBe('echo: hi')
  })

  it('legacy 服务器不回应探测：超时后回退', async () => {
    const c = client(stdio('legacy', '--silent-probe'))
    const t0 = Date.now()
    await c.connect()
    expect(c.era).toBe('legacy')
    expect(Date.now() - t0).toBeGreaterThanOrEqual(450)
  })

  it('legacy 服务器收到探测直接退出：重启进程再握手', async () => {
    const c = client(stdio('legacy', '--exit-on-unknown'))
    await c.connect()
    expect(c.era).toBe('legacy')
    expect(text(await c.callTool({ name: 'echo', inputSchema: {} }, { text: 'x' }))).toBe('echo: x')
  })

  it('protocol=legacy 跳过探测；指定 protocolVersion 协商旧版本', async () => {
    const c = client(stdio('dual'), { protocol: 'legacy', protocolVersion: '2025-06-18' })
    await c.connect()
    expect(c.era).toBe('legacy')
    expect(c.protocolVersion).toBe('2025-06-18')
  })

  it('protocol=modern 遇到 legacy 服务器明确报错', async () => {
    const c = client(stdio('legacy'), { protocol: 'modern' })
    await expect(c.connect()).rejects.toThrow(/does not speak MCP 2026-07-28/)
  })

  it('分页拉取工具列表', async () => {
    const c = client(stdio('modern', '--page=3'))
    const tools = await c.listTools()
    expect(tools.length).toBe(8)
  })

  it('进度通知、取消、进程崩溃后自动重启', async () => {
    const c = client(stdio('modern'))
    const progress: number[] = []
    const r = await c.callTool({ name: 'slow', inputSchema: {} }, { steps: 3 }, { onProgress: (p) => progress.push(p.progress) })
    expect(text(r)).toBe('slow done')
    expect(progress).toEqual([1, 2, 3])

    const ac = new AbortController()
    setTimeout(() => ac.abort(new Error('user cancelled')), 30)
    await expect(c.callTool({ name: 'slow', inputSchema: {} }, { steps: 20 }, { signal: ac.signal })).rejects.toThrow(/user cancelled/)

    // crash：进程退出 → 自动重连后重试一次，第二次仍然崩溃则报错
    await expect(c.callTool({ name: 'crash', inputSchema: {} }, {})).rejects.toThrow(/exited/)
    expect(text(await c.callTool({ name: 'echo', inputSchema: {} }, { text: 'back' }))).toBe('echo: back')
  })

  it('legacy 服务器主动 ping 时客户端应答', async () => {
    const c = client(stdio('legacy'))
    // ping_me 不是已知工具，服务器返回 -32602；重点是服务器的 ping 被应答、连接没断
    await expect(c.callTool({ name: 'ping_me', inputSchema: {} }, {})).rejects.toThrow(/Unknown tool/)
    expect(text(await c.callTool({ name: 'echo', inputSchema: {} }, { text: 'alive' }))).toBe('echo: alive')
  }, 10_000)

  it('命令不存在时报错', async () => {
    const c = client({ kind: 'stdio', command: 'definitely-not-a-command-xyz', args: [], env: {} })
    await expect(c.connect()).rejects.toThrow(/failed to start/)
  })

  it('MRTR input_required 转为错误结果', async () => {
    const c = client(stdio('modern'))
    const r = await c.callTool({ name: 'needs_input', inputSchema: {} }, {})
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('elicitation/create')
  })
})

describe('Streamable HTTP', () => {
  it('modern：镜像头 MCP-Protocol-Version / Mcp-Method / Mcp-Name / Mcp-Param-*', async () => {
    const s = await startHttpServer('modern')
    servers.push(s)
    const c = client({ kind: 'http', url: s.url, headers: { authorization: 'Bearer abc' } })
    await c.connect()
    expect(c.era).toBe('modern')
    expect(c.transportKind).toBe('http')
    const tools = await c.listTools()
    expect(tools.find((t) => t.name === 'bad_header')).toBeUndefined() // 非法 x-mcp-header 被排除
    const region = tools.find((t) => t.name === 'region')!
    expect(region.headerParams).toEqual([{ name: 'Region', path: ['region'], type: 'string' }])
    expect(text(await c.callTool(region, { region: 'us-west1', q: 'x' }))).toBe('region header=us-west1')
    const who = JSON.parse(text(await c.callTool({ name: 'whoami', inputSchema: {} }, {})))
    expect(who.auth).toBe('Bearer abc')
    const call = s.requests.find((r: { body: string }) => r.body.includes('"whoami"'))
    expect(call.headers['mcp-name']).toBe('whoami')
    expect(call.headers['mcp-session-id']).toBeUndefined()
    expect(s.requests.some((r: { body: string }) => r.body.includes('"initialize"'))).toBe(false)
  })

  it('modern：SSE 响应流中的进度通知', async () => {
    const s = await startHttpServer('modern', { sse: true })
    servers.push(s)
    const c = client({ kind: 'http', url: s.url, headers: {} })
    const progress: string[] = []
    const r = await c.callTool({ name: 'slow', inputSchema: {} }, { steps: 2 }, { onProgress: (p) => progress.push(p.message ?? '') })
    expect(text(r)).toBe('slow done')
    expect(progress).toEqual(['step 1', 'step 2'])
  })

  it('legacy Streamable HTTP：400 非 modern 错误 → initialize + 会话；关闭时 DELETE', async () => {
    const s = await startHttpServer('legacy')
    servers.push(s)
    const c = client({ kind: 'http', url: s.url, headers: {} })
    await c.connect()
    expect(c.era).toBe('legacy')
    expect(c.transportKind).toBe('http')
    expect(text(await c.callTool({ name: 'echo', inputSchema: {} }, { text: 'sess' }))).toBe('echo: sess')
    const call = s.requests.find((r: { body: string }) => r.body.includes('"echo"'))
    expect(call.headers['mcp-session-id']).toBe('s1')
    expect(call.headers['mcp-protocol-version']).toBe('2025-11-25')
    expect(call.headers['mcp-method']).toBeUndefined()
    await c.close()
    expect(s.sessions.size).toBe(0)
  })

  it('legacy 会话过期（404）后重新握手', async () => {
    const s = await startHttpServer('legacy')
    servers.push(s)
    const c = client({ kind: 'http', url: s.url, headers: {} })
    await c.connect()
    s.sessions.clear()
    expect(text(await c.callTool({ name: 'echo', inputSchema: {} }, { text: 'again' }))).toBe('echo: again')
    expect(s.sessions.size).toBe(1)
  })

  it('2024-11-05 HTTP+SSE：POST 失败后回退 GET endpoint', async () => {
    const s = await startHttpServer('sse')
    servers.push(s)
    const c = client({ kind: 'http', url: s.url, headers: {} })
    await c.connect()
    expect(c.transportKind).toBe('sse')
    expect(c.era).toBe('legacy')
    expect(c.protocolVersion).toBe('2024-11-05')
    expect(text(await c.callTool({ name: 'add', inputSchema: {} }, { a: 2, b: 3 }))).toBe('5')
  })

  it('type=sse 直接走旧版 SSE', async () => {
    const s = await startHttpServer('sse')
    servers.push(s)
    const c = client({ kind: 'http', url: s.url, headers: {}, sseOnly: true })
    await c.connect()
    expect(c.transportKind).toBe('sse')
    expect(s.requests.filter((r: { method: string; path: string }) => r.method === 'POST' && r.path === '/sse')).toHaveLength(0)
  })
})

describe('x-mcp-header', () => {
  it('校验标注位置与类型', () => {
    expect(extractHeaderParams({ type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'integer', 'x-mcp-header': 'B' } } } } })).toEqual([{ name: 'B', path: ['a', 'b'], type: 'integer' }])
    expect(() => extractHeaderParams({ type: 'object', properties: { a: { type: 'number', 'x-mcp-header': 'A' } } })).toThrow(/string, integer or boolean/)
    expect(() => extractHeaderParams({ type: 'object', properties: { a: { type: 'string', 'x-mcp-header': 'A' }, b: { type: 'string', 'x-mcp-header': 'a' } } })).toThrow(/duplicate/)
    expect(() => extractHeaderParams({ type: 'object', oneOf: [{ properties: { a: { type: 'string', 'x-mcp-header': 'A' } } }] })).toThrow(/statically reachable/)
  })

  it('头部值编码', () => {
    expect(encodeHeaderValue('us-west1')).toBe('us-west1')
    expect(encodeHeaderValue('Hello, 世界')).toBe('=?base64?SGVsbG8sIOS4lueVjA==?=')
    expect(encodeHeaderValue(' padded ')).toBe('=?base64?IHBhZGRlZCA=?=')
    expect(encodeHeaderValue('=?base64?literal?=')).toBe('=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=')
  })
})
