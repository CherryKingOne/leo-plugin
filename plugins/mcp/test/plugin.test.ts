import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { approvalPolicy, createLeo, type LlmRequest, MockProvider, type MockResponse } from 'leo-agents'
import { describe, expect, it } from 'vitest'
import mcp, { toolName } from '../src/index.js'
import { stripJsonc } from '../src/files.js'
import { resolveValue } from '../src/secrets.js'

const fixture = fileURLToPath(new URL('./fixtures/stdio-server.mjs', import.meta.url))
const server = (era: string, extra: Record<string, unknown> = {}) => ({ command: process.execPath, args: [fixture, era], ...extra })
const textOf = (blocks: { type: string; text?: string }[]) => blocks.map((b) => b.text ?? '').join('')

async function setup(config: Record<string, unknown>, opts: { approval?: 'ask' | 'auto' | 'deny'; script?: MockResponse[]; paths?: Record<string, unknown> } = {}) {
  const requests: LlmRequest[] = []
  const script = (opts.script ?? []).map((r) => (req: LlmRequest) => {
    requests.push(req)
    return r
  })
  const mock = new MockProvider({ script })
  const leo = await createLeo({
    logLevel: 'silent',
    providers: [mock],
    plugins: [
      ...(opts.paths ? [{ name: 'paths', apply: (ctx: any) => void ctx.provide('leoPaths', opts.paths) }] : []),
      [mcp, { probeTimeoutMs: 300, ...config }],
      ...(opts.approval ? [[approvalPolicy, { mode: opts.approval }] as const] : []),
    ] as never,
  })
  return { leo, requests }
}

describe('加载与卸载', () => {
  it('无配置可加载，提供 mcp 服务', async () => {
    const leo = await createLeo({ logLevel: 'silent', plugins: [mcp] })
    expect(leo.ctx.get('mcp').servers()).toEqual([])
    await leo.dispose()
  })

  it('连接服务器并把工具注册为 mcp__<server>__<tool>；卸载后撤销', async () => {
    const leo = await createLeo({ logLevel: 'silent' })
    const rt = await leo.plugin(mcp, { servers: { fake: server('modern') } } as never)
    const reg = leo.ctx.get('tools')
    expect(reg.get('mcp__fake__echo')).toBeDefined()
    const add = reg.get('mcp__fake__add')!
    expect((add.parameters as Record<string, unknown>).$schema).toBeUndefined()
    expect(add.description).toContain('MCP server "fake"')
    expect(add.permissions?.[0]).toMatchObject({ kind: 'mcp.call', server: 'fake', tool: 'add', sideEffect: true, readOnlyHint: true })
    const [st] = leo.ctx.get('mcp').servers()
    expect(st).toMatchObject({ name: 'fake', status: 'connected', era: 'modern', protocolVersion: '2026-07-28', transport: 'stdio' })
    await rt.dispose()
    expect(reg.get('mcp__fake__echo')).toBeUndefined()
    expect(leo.ctx.has('mcp')).toBe(false)
    await leo.dispose()
  })

  it('非法插件配置在加载时报错', async () => {
    const leo = await createLeo({ logLevel: 'silent' })
    await expect(leo.plugin(mcp, { timeoutMs: -1 } as never)).rejects.toThrow(/Invalid config/)
    await leo.dispose()
  })

  it('单个服务器失败不影响其他服务器', async () => {
    const { leo } = await setup({
      servers: {
        good: server('legacy'),
        broken: { command: 'definitely-not-a-command-xyz' },
        invalid: { args: ['x'] },
        off: { ...server('modern'), disabled: true },
      },
    })
    const byName = Object.fromEntries(leo.ctx.get('mcp').servers().map((s) => [s.name, s]))
    expect(byName.good?.status).toBe('connected')
    expect(byName.good?.era).toBe('legacy')
    expect(byName.broken?.status).toBe('failed')
    expect(byName.invalid?.status).toBe('failed')
    expect(byName.invalid?.error).toMatch(/command/)
    expect(byName.off?.status).toBe('disabled')
    expect(leo.ctx.get('tools').get('mcp__good__echo')).toBeDefined()
    await leo.dispose()
  })

  it('includeTools / excludeTools 与 toolPrefix', async () => {
    const { leo } = await setup({ toolPrefix: '', servers: { a: server('modern', { includeTools: ['echo', 'add'] }), b: server('modern', { excludeTools: ['echo'] }) } })
    const names = leo.ctx.get('tools').list().map((t) => t.name).filter((n) => n.startsWith('a__') || n.startsWith('b__'))
    expect(names.filter((n) => n.startsWith('a__')).sort()).toEqual(['a__add', 'a__echo'])
    expect(names).not.toContain('b__echo')
    expect(names).toContain('b__add')
    await leo.dispose()
  })
})

describe('Agent 调用 MCP 工具', () => {
  it('经过 leo 工具管线执行，结果回到模型；approval=auto', async () => {
    const { leo, requests } = await setup(
      { servers: { fake: server('dual') } },
      { approval: 'auto', script: [{ toolCalls: [{ id: 'c1', name: 'mcp__fake__echo', arguments: { text: 'hello' } }, { id: 'c2', name: 'mcp__fake__image', arguments: {} }] }, { text: 'done' }] },
    )
    const r = await leo.createAgent({ model: 'm' }).run('go')
    expect(r.text).toBe('done')
    const tools = r.messages.filter((m) => m.role === 'tool')
    expect(textOf(tools[0]!.content as never)).toBe('echo: hello')
    expect(tools[1]!.content.some((b) => b.type === 'image')).toBe(true)
    // 模型看到工具 schema；服务器 instructions 注入系统提示
    expect(requests[0]!.tools?.map((t) => t.name)).toContain('mcp__fake__echo')
    expect(requests[0]!.system).toContain('Use echo for testing.')
    await leo.dispose()
  })

  it('默认需要审批：approval=ask 且无人审批时拒绝；autoApprove 的工具放行', async () => {
    const { leo } = await setup(
      { servers: { fake: server('modern', { autoApprove: ['add'] }) } },
      { approval: 'ask', script: [{ toolCalls: [{ id: 'c1', name: 'mcp__fake__echo', arguments: { text: 'x' } }, { id: 'c2', name: 'mcp__fake__add', arguments: { a: 1, b: 2 } }] }, { text: 'ok' }] },
    )
    const r = await leo.createAgent({ model: 'm' }).run('go')
    const [echo, add] = r.messages.filter((m) => m.role === 'tool')
    expect(echo!.isError).toBe(true)
    expect(add!.isError).toBeFalsy()
    expect(textOf(add!.content as never)).toBe('3')
    await leo.dispose()
  })

  it('MCP 工具 isError 结果对模型可见；进度转发为 tool_update', async () => {
    const { leo } = await setup(
      { servers: { fake: server('modern', { autoApprove: true }) } },
      { script: [{ toolCalls: [{ id: 'c1', name: 'mcp__fake__fail', arguments: {} }, { id: 'c2', name: 'mcp__fake__slow', arguments: { steps: 2 } }] }, { text: 'ok' }] },
    )
    const updates: unknown[] = []
    leo.ctx.on('agent/event', ({ event }) => void (event.type === 'tool_update' && updates.push(event.partial)))
    const r = await leo.createAgent({ model: 'm' }).run('go')
    const [fail, slow] = r.messages.filter((m) => m.role === 'tool')
    expect(fail!.isError).toBe(true)
    expect(textOf(fail!.content as never)).toBe('it broke')
    expect(textOf(slow!.content as never)).toBe('slow done')
    expect(updates).toEqual([expect.objectContaining({ type: 'progress', message: 'fake/slow 50% step 1' }), expect.objectContaining({ type: 'progress', message: 'fake/slow 100% step 2' })])
    await leo.dispose()
  })
})

describe('mcp-servers.json', () => {
  it('读取用户级与项目级文件（JSONC），项目级覆盖，插件配置最高；环境变量引用', async () => {
    const root = await mkdtemp(join(tmpdir(), 'leo-mcp-'))
    const home = await mkdtemp(join(tmpdir(), 'leo-home-'))
    await mkdir(join(root, '.leo'), { recursive: true })
    await writeFile(
      join(home, 'mcp-servers.json'),
      JSON.stringify({ mcpServers: { shared: server('legacy'), useronly: server('modern') } }),
    )
    await writeFile(
      join(root, '.leo', 'mcp-servers.json'),
      `{
        // 项目级覆盖 shared
        "mcpServers": {
          "shared": { "command": ${JSON.stringify(process.execPath)}, "args": [${JSON.stringify(fixture)}, "modern"], "env": { "FAKE_TOKEN": "\${LEO_MCP_TEST_TOKEN}" }, },
        },
      }`,
    )
    process.env.LEO_MCP_TEST_TOKEN = 'tok-123'
    const { leo } = await setup(
      { servers: { inline: server('modern') } },
      { paths: { cwd: root, projectRoot: root, projectDir: join(root, '.leo'), userDir: home } },
    )
    const states = Object.fromEntries(leo.ctx.get('mcp').servers().map((s) => [s.name, s]))
    expect(Object.keys(states).sort()).toEqual(['inline', 'shared', 'useronly'])
    expect(states.shared).toMatchObject({ era: 'modern', file: join(root, '.leo', 'mcp-servers.json') })
    const who = JSON.parse(textOf((await leo.ctx.get('mcp').callTool('shared', 'whoami')).content as never))
    expect(who.token).toBe('tok-123')
    expect(who.cwd).toBe(root) // stdio 默认在项目根启动
    delete process.env.LEO_MCP_TEST_TOKEN
    await leo.dispose()
  })

  it('引用的环境变量未设置时该服务器失败，错误里不含值', async () => {
    const { leo } = await setup({ servers: { s: server('modern', { env: { T: '${LEO_MCP_MISSING_VAR}' } }) } })
    const [st] = leo.ctx.get('mcp').servers()
    expect(st?.status).toBe('failed')
    expect(st?.error).toMatch(/LEO_MCP_MISSING_VAR is not set/)
    await leo.dispose()
  })
})

describe('工具函数', () => {
  it('toolName 规范化与截断', () => {
    expect(toolName('mcp', 'my.server', 'get weather')).toBe('mcp__my_server__get_weather')
    expect(toolName('', '1srv', 't')).toBe('m_1srv__t')
    const long = toolName('mcp', 'server', 'x'.repeat(100))
    expect(long.length).toBe(64)
    expect(long).not.toBe(toolName('mcp', 'server', `${'x'.repeat(99)}y`))
  })

  it('stripJsonc 保留字符串中的 // 与逗号', () => {
    expect(JSON.parse(stripJsonc('{"u":"http://a,}", /* c */ "b":[1,2,],}'))).toEqual({ u: 'http://a,}', b: [1, 2] })
  })

  it('resolveValue', () => {
    const env = { A: 'x', B: 'y' }
    expect(resolveValue('$A', env)).toBe('x')
    expect(resolveValue('${A}', env)).toBe('x')
    expect(resolveValue('Bearer ${B}', env)).toBe('Bearer y')
    expect(resolveValue('cost $$5', env)).toBe('cost $5')
    expect(resolveValue('$!literal', env)).toBe('!literal')
    expect(resolveValue('!echo hi', env)).toBe('hi')
    expect(resolveValue('plain', env)).toBe('plain')
  })
})
