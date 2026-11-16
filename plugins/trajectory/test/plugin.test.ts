import { request } from 'node:http'
import { access, readFile, rm, symlink, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { LlmRequest, MockResponse, PluginDefinition, ToolDefinition } from 'leo-agents'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import plugin from '../src/index.js'
import type { RawEvent, TrajectoryService, TrajectoryTree } from '../src/types.js'
import { echoTool, hasToolEvents, setup, waitFor } from './helpers.js'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c().catch(() => {})
})

async function host(route: (req: LlmRequest, i: number) => MockResponse, config: Record<string, unknown> = {}, extra: PluginDefinition<any>[] = []) {
  const h = await setup(route, config, extra)
  cleanups.push(async () => {
    await h.leo.dispose()
    await rm(h.root, { recursive: true, force: true })
  })
  return h
}

const svc = (leo: { ctx: { get(k: string): unknown } }) => leo.ctx.get('trajectory' as never) as TrajectoryService
const hasToolResult = (req: LlmRequest) => req.messages.some((m) => m.role === 'tool')

/** 只用 http 模块（可以自定义 Host 头） */
function rawGet(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** 模拟 sub-agents 插件（旧宿主上它不写 session/meta）：tool task 起一个子 Agent */
const fakeSubAgents: PluginDefinition = {
  name: 'fake-sub-agents',
  inject: ['tools', 'agentLoop'],
  async apply(ctx) {
    const task: ToolDefinition<{ prompt: string }> = {
      name: 'task',
      description: 'delegate',
      parameters: z.object({ prompt: z.string() }),
      async execute({ prompt }, exec) {
        const child = ctx.get('agentLoop').create({
          model: 'm',
          systemPrompt: 'child',
          tools: false,
          label: 'sub-agent:explorer',
          state: { subAgent: { agent: 'explorer', depth: 1, parentAgentId: exec.agentId } },
        })
        ctx.emit('sub-agents/started' as never, { id: child.id, agent: 'explorer', sessionId: child.sessionId, parentAgentId: exec.agentId, depth: 1, tools: [], startedAt: Date.now() } as never)
        exec.onUpdate({ type: 'progress', message: 'explorer 开始', agentId: child.id })
        const r = await child.run(prompt)
        await child.dispose()
        return Object.assign({ content: r.text, details: { agentId: child.id, agent: 'explorer', sessionId: child.sessionId } }, { [Symbol.for('leo.toolOutput')]: true })
      },
    }
    await ctx.effect(() => ctx.get('tools').register(task as never))
  },
}

const parentRoute = (req: LlmRequest): MockResponse => {
  if (req.system === 'child') return { text: '子任务完成', delayMs: 15, usage: { inputTokens: 7, outputTokens: 3 } }
  if (!hasToolResult(req)) return { toolCalls: [{ id: 'call_task', name: 'task', arguments: { prompt: '查一下' } }, { id: 'call_echo', name: 'echo', arguments: { text: 'hi' } }], delayMs: 10 }
  return { text: '全部完成', delayMs: 10 }
}

describe('插件加载', () => {
  it('无配置可加载：提供 trajectory 服务，不注册任何工具，打印网页地址', async () => {
    const h = await host(() => ({ text: 'x' }))
    const before = h.leo.ctx.get('tools').list().length
    expect(svc(h.leo)).toBeDefined()
    expect(h.leo.ctx.get('tools').list().length).toBe(before)
    expect(h.commands.has('trace')).toBe(true)
    const url = svc(h.leo).url()!
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    expect(h.notices.find((n) => n.plugin === 'trajectory')?.message).toContain(url)
  })

  it('卸载关闭服务器并撤销注册，同一端口可以再次加载', async () => {
    const h = await host(() => ({ text: 'x' }))
    const url = svc(h.leo).url()!
    const port = Number(new URL(url).port)
    // 卸载时有一个打开的 SSE 连接也不能卡住
    const ac = new AbortController()
    const res = await fetch(`${url}api/stream`, { signal: ac.signal })
    expect(res.status).toBe(200)
    await h.rt.dispose()
    ac.abort()
    expect(h.leo.ctx.maybe('trajectory' as never)).toBeUndefined()
    expect(h.commands.has('trace')).toBe(false)
    await expect(fetch(`${url}health`)).rejects.toThrow()
    const again = await h.leo.plugin(plugin, { port } as never)
    expect(svc(h.leo).url()).toBe(url)
    expect((await fetch(`${url}health`)).status).toBe(200)
    await again.dispose()
  })

  it('非本机地址没有令牌：不启动网页，发出错误提示，服务与命令照常', async () => {
    const h = await host(() => ({ text: 'x' }), { host: '0.0.0.0' })
    expect(svc(h.leo).url()).toBeUndefined()
    expect(h.notices.find((n) => n.level === 'error')?.message).toMatch(/without a token/)
    expect((await h.command('open')).text).toContain('没有启动')
  })

  it('server: false 时不监听', async () => {
    const h = await host(() => ({ text: 'x' }), { server: false })
    expect(svc(h.leo).url()).toBeUndefined()
    expect((await h.command('open')).text).toContain('已关闭')
  })
})

describe('真实 Agent 运行（mock 模型）', () => {
  it('step、工具、子会话与计时；新旧宿主都可用', async () => {
    const h = await host(parentRoute, {}, [fakeSubAgents, { name: 'echo', inject: ['tools'], apply: async (ctx) => void (await ctx.effect(() => ctx.get('tools').register(echoTool(30) as never))) }])
    const agent = h.leo.createAgent({ model: 'm' })
    const r = await agent.run('开始')
    expect(r.reason).toBe('completed')

    const t = (await svc(h.leo).get(agent.sessionId))!
    const events = (await h.leo.ctx.get('sessions').events(agent.sessionId)) as unknown as RawEvent[]
    const newHost = hasToolEvents(events)
    if (process.env.LEO_AGENTS_EXPECT_NEW) expect(newHost).toBe(process.env.LEO_AGENTS_EXPECT_NEW === '1')
    expect(t.turns).toHaveLength(1)
    const [s1, s2] = t.turns[0]!.steps
    expect(s1!.tools.map((c) => c.name)).toEqual(['task', 'echo'])
    // TTFT：新宿主来自日志，旧宿主来自现场测量
    expect(s1!.ttftSource).toBe(newHost ? 'log' : 'live')
    expect(s1!.ttftMs).toBeGreaterThanOrEqual(5)
    expect(s2!.ttftMs).toBeDefined()
    const echo = s1!.tools.find((c) => c.name === 'echo')!
    expect(echo.timing).toBe(newHost ? 'log' : 'live')
    expect(echo.durationMs).toBeGreaterThanOrEqual(25)
    expect(t.capabilities.toolEvents).toBe(newHost)

    // 子会话挂在 task 调用下，并已展开
    const task = s1!.tools.find((c) => c.name === 'task')!
    expect(task.children.map((c) => c.sessionId)).toHaveLength(1)
    const childId = task.children[0]!.sessionId
    expect(task.progress).toContain('explorer 开始')
    const child = t.childSessions[childId] as TrajectoryTree
    expect(child.meta).toMatchObject({ origin: 'sub-agent', label: 'sub-agent:explorer', parentSessionId: agent.sessionId, parentToolCallId: 'call_task' })
    expect(child.usage.inputTokens).toBe(7)

    // 列表里有父子两个会话
    const list = await svc(h.leo).list()
    expect(list.map((s) => s.sessionId)).toEqual(expect.arrayContaining([agent.sessionId, childId]))
    expect(list.find((s) => s.sessionId === childId)!.parentSessionId).toBe(agent.sessionId)

    // /trace 摘要
    const out = await h.command('', agent.sessionId)
    expect(out.text).toContain(`会话 ${agent.sessionId}`)
    expect(out.text).toContain('工具调用 2')
    expect(out.text).toContain('最慢的工具')
    expect(out.text).toContain('子会话')
    if (!newHost) expect(out.text).toContain('需要 leo-agents ≥ 0.2.2')

    // 进程“重启”：内存里的现场数据没了，子会话仍能靠工具结果 details 挂上
    await h.rt.dispose()
    await h.leo.plugin(plugin, { port: 0, sessionsDir: h.sessionsDir } as never)
    const cold = (await svc(h.leo).get(agent.sessionId))!
    const coldTask = cold.turns[0]!.steps[0]!.tools.find((c) => c.name === 'task')!
    expect(coldTask.children[0]!.sessionId).toBe(childId)
    expect(cold.childSessions[childId]).toBeDefined()
    expect(cold.turns[0]!.steps[0]!.ttftSource).toBe(newHost ? 'log' : 'unavailable')
    expect(coldTask.timing).toBe(newHost ? 'log' : 'estimated')
    expect((await svc(h.leo).list()).map((s) => s.sessionId)).toEqual(expect.arrayContaining([agent.sessionId, childId]))
  })

  it('session/meta 链接（宿主 ≥ 0.2.2 写的元信息，这里直接写入日志模拟）', async () => {
    const h = await host(() => ({ text: 'x' }))
    const store = h.leo.ctx.get('sessions')
    const append = (sid: string, type: string, data: unknown) => (store.append as (s: string, t: string, d: unknown) => Promise<unknown>)(sid, type, data)
    await append('parent1', 'turn/start', { turnId: 't' })
    await append('parent1', 'llm/request', { turnId: 't', stepId: 's', model: 'm', system: '', messageIds: [], tools: [], params: {}, fingerprint: '', estimatedTokens: 0 })
    await append('parent1', 'llm/response', { turnId: 't', stepId: 's', messageId: 'a', finishReason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 }, attempts: 1 })
    await append('parent1', 'message', { message: { id: 'a', role: 'assistant', content: [{ type: 'tool_call', id: 'kk', name: 'spawn', arguments: {}, rawArguments: '{}' }], createdAt: 0 } })
    await append('kid1', 'session/meta', { origin: 'team-member', label: 'agent-team:dev', parentSessionId: 'parent1', parentToolCallId: 'kk' })
    await append('kid1', 'turn/start', { turnId: 't2' })
    const t = (await svc(h.leo).get('parent1'))!
    const call = t.turns[0]!.steps[0]!.tools[0]!
    expect(call.children).toEqual([{ sessionId: 'kid1', origin: 'team-member', label: 'agent-team:dev', via: 'meta' }])
    expect(t.childSessions.kid1!.metaSource).toBe('log')
  })
})

describe('HTTP API 与网页', () => {
  it('会话列表、轨迹、404、网页自包含', async () => {
    const h = await host(() => ({ text: 'ok', delayMs: 5 }))
    const agent = h.leo.createAgent({ model: 'm' })
    await agent.run('hello sk-proj-abcdefghijklmnopqrstuvwxyz')
    const base = svc(h.leo).url()!
    const list = (await (await fetch(`${base}api/sessions`)).json()) as { sessions: { sessionId: string }[] }
    expect(list.sessions.map((s) => s.sessionId)).toContain(agent.sessionId)
    const res = await fetch(`${base}api/sessions/${agent.sessionId}?depth=0`)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain('sk-proj-abcdefghijklmnop')
    expect(JSON.parse(body).turns[0].input).toContain('sk-p***')
    expect((await fetch(`${base}api/sessions/nope`)).status).toBe(404)
    expect((await fetch(`${base}api/sessions`, { method: 'POST' })).status).toBe(405)
    const page = await fetch(base)
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'")
    const html = await page.text()
    expect(html).toContain('leo 轨迹观测')
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=|https?:\/\/(?!localhost)/)
  })

  it('没有令牌时只接受本机 Host（防 DNS rebinding）', async () => {
    const h = await host(() => ({ text: 'x' }))
    const base = svc(h.leo).url()!
    expect((await rawGet(`${base}api/sessions`)).status).toBe(200)
    expect((await rawGet(`${base}api/sessions`, { host: 'evil.example:80' })).status).toBe(401)
    expect((await rawGet(`${base}health`, { host: 'evil.example' })).status).toBe(200)
  })

  it('设置令牌后：头、x-leo-trajectory-token、?token= 都可以，错误或缺失返回 401', async () => {
    process.env.TRAJ_TEST_TOKEN = 'tok-123456'
    const h = await host(() => ({ text: 'x' }), { token: '$TRAJ_TEST_TOKEN' })
    const base = svc(h.leo).url()!
    expect((await fetch(`${base}api/sessions`)).status).toBe(401)
    expect((await fetch(base)).status).toBe(401)
    expect((await fetch(`${base}api/sessions`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
    expect((await fetch(`${base}api/sessions`, { headers: { authorization: 'Bearer tok-123456' } })).status).toBe(200)
    expect((await fetch(`${base}api/sessions`, { headers: { 'x-leo-trajectory-token': 'tok-123456' } })).status).toBe(200)
    expect((await fetch(`${base}?token=tok-123456`)).status).toBe(200)
    expect((await fetch(`${base}health`)).status).toBe(200)
    expect(h.notices.at(-1)!.message).toContain('需要令牌')
    expect(h.notices.at(-1)!.message).not.toContain('tok-123456')
  })

  it('令牌引用解析失败：不启动网页', async () => {
    delete process.env.TRAJ_MISSING
    const h = await host(() => ({ text: 'x' }), { token: '$TRAJ_MISSING' })
    expect(svc(h.leo).url()).toBeUndefined()
    expect(h.notices.find((n) => n.level === 'error')!.message).toContain('TRAJ_MISSING')
  })

  it('SSE 实时推送：运行中的 Agent 产生 update 事件', async () => {
    const h = await host(() => ({ text: 'streaming answer', delayMs: 20 }))
    const base = svc(h.leo).url()!
    const agent = h.leo.createAgent({ model: 'm' })
    const ac = new AbortController()
    const res = await fetch(`${base}api/stream?session=${agent.sessionId}`, { signal: ac.signal })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let text = ''
    const reading = (async () => {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        text += dec.decode(value)
        if (text.includes('"type":"turn/end"')) break
      }
    })().catch(() => {})
    await agent.run('hi')
    await waitFor(() => text.includes('"type":"turn/end"'))
    ac.abort()
    await reading
    expect(text).toContain('event: hello')
    expect(text).toContain('event: update')
    expect(text).toContain('"type":"first_token"')
    expect(text).toContain(`"sessionId":"${agent.sessionId}"`)
  })

  it('SSE 指定会话时不推送无关会话', async () => {
    const h = await host(() => ({ text: 'x' }))
    const base = svc(h.leo).url()!
    const ac = new AbortController()
    const res = await fetch(`${base}api/stream?session=only-this`, { signal: ac.signal })
    const reader = res.body!.getReader()
    let text = ''
    const reading = (async () => {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        text += new TextDecoder().decode(value)
      }
    })().catch(() => {})
    await h.leo.createAgent({ model: 'm' }).run('hi')
    await new Promise((r) => setTimeout(r, 100))
    ac.abort()
    await reading
    expect(text).toContain('event: hello')
    expect(text).not.toContain('event: update')
  })
})

describe('/trace 命令', () => {
  it('list、open、export 默认路径与指定路径', async () => {
    const h = await host(() => ({ text: 'x' }))
    const agent = h.leo.createAgent({ model: 'm' })
    await agent.run('hi')
    expect((await h.command('list')).text).toContain(agent.sessionId)
    expect((await h.command('open')).text).toContain(svc(h.leo).url()!)
    const exp = await h.command('export', agent.sessionId)
    expect(exp.isError).toBeFalsy()
    const path = exp.text!.split(' → ')[1]!
    expect(path.startsWith(join(h.leoDir, 'trajectory'))).toBe(true)
    const json = JSON.parse(await readFile(path, 'utf8'))
    expect(json.format).toBe('leo-trajectory')
    expect(json.trajectory.sessionId).toBe(agent.sessionId)
    const named = await h.command('export out/my.json', agent.sessionId)
    expect(named.text).toContain(join(h.leoDir, 'out', 'my.json'))
    await access(join(h.leoDir, 'out', 'my.json'))
  })

  it('导出路径不能越出 .leo（.. / 绝对路径 / 符号链接）', async () => {
    const h = await host(() => ({ text: 'x' }))
    const agent = h.leo.createAgent({ model: 'm' })
    await agent.run('hi')
    const a = await h.command('export ../escape.json', agent.sessionId)
    expect(a.isError).toBe(true)
    expect(a.text).toContain('必须在')
    const b = await h.command(`export ${join(tmpdir(), 'escape.json')}`, agent.sessionId)
    expect(b.isError).toBe(true)
    const outside = join(h.root, 'outside')
    await mkdir(outside, { recursive: true })
    await symlink(outside, join(h.leoDir, 'link'))
    const c = await h.command('export link/x.json', agent.sessionId)
    expect(c.isError).toBe(true)
    await expect(access(join(outside, 'x.json'))).rejects.toThrow()
    // 绝对路径在 .leo 之内是允许的
    const d = await h.command(`export ${join(h.leoDir, 'abs.json')}`, agent.sessionId)
    expect(d.isError).toBeFalsy()
  })

  it('没有会话时给出提示；/trace <id> 查看指定会话', async () => {
    const h = await host(() => ({ text: 'x' }))
    expect((await h.command('')).text).toContain('还没有会话')
    const agent = h.leo.createAgent({ model: 'm' })
    await agent.run('hi')
    expect((await h.command(agent.sessionId)).text).toContain(`会话 ${agent.sessionId}`)
    expect((await h.command('no-such-session')).isError).toBe(true)
  })
})
