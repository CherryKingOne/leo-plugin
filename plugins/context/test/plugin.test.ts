import { request } from 'node:http'
import { rm } from 'node:fs/promises'
import type { LlmRequest, MockResponse, PluginDefinition } from 'leo-agents'
import { afterEach, describe, expect, it } from 'vitest'
import plugin from '../src/index.js'
import type { ContextInsightService, Overview, RequestDetail, SessionReport } from '../src/types.js'
import { echoTool, setup, waitFor } from './helpers.js'

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

const svc = (leo: { ctx: { get(k: string): unknown } }) => leo.ctx.get('contextInsight' as never) as ContextInsightService
const hasToolResult = (req: LlmRequest) => req.messages.some((m) => m.role === 'tool')

/** 只用 http 模块（可以自定义 Host 头） */
function rawGet(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; type?: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, ...(res.headers['content-type'] ? { type: res.headers['content-type'] } : {}) }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** 一轮：调用 echo 工具，再回答 */
const route = (req: LlmRequest): MockResponse =>
  hasToolResult(req) ? { text: '好了', usage: { inputTokens: 300, outputTokens: 20, cachedInputTokens: 100 } } : { toolCalls: [{ name: 'echo', arguments: { text: 'hi' } }], usage: { inputTokens: 200, outputTokens: 10 } }

/** 模拟插件注入的 system 片段（skills 插件那样） */
const fakeSkills: PluginDefinition = {
  name: 'fake-skills',
  inject: ['context'],
  apply(ctx) {
    ;(ctx.get('context' as never) as any).registerSection({ id: 'skills.catalog', layer: 'runtime', render: () => '<available_skills>pdf: read PDFs</available_skills>' })
  },
}

async function runOnce(h: Awaited<ReturnType<typeof host>>) {
  h.leo.ctx.get('tools').register(echoTool)
  const agent = h.leo.createAgent({ model: 'm', systemPrompt: 'You are leo.' })
  await agent.run('say hi')
  return agent.sessionId
}

describe('leo-plugin-context', () => {
  it('真实会话：报告、组成、用量；/context 命令', async () => {
    const h = await host(route, {}, [fakeSkills])
    const id = await runOnce(h)
    const r = (await svc(h.leo).report(id))!
    expect(r.stats.turns).toBe(1)
    expect(r.stats.steps).toBe(2)
    expect(r.stats.toolCalls).toBe(1)
    expect(r.stats.usage.inputTokens).toBe(500)
    expect(r.stats.usage.cachedInputTokens).toBe(100)
    expect(r.tools[0]).toMatchObject({ name: 'echo', calls: 1, errors: 0 })
    const c = r.current!
    expect(c.composition.toolResults).toBeGreaterThan(0)
    expect(c.composition.toolCalls).toBeGreaterThan(0)
    expect(c.composition.user).toBeGreaterThan(0)
    expect(c.estimatedTokens).toBeGreaterThan(0)
    // LEO_EXPECT_BREAKDOWN=1：明确要求宿主写 breakdown（配合 LEO_AGENTS_DIST 指向 leo-agents ≥ 0.2.3）
    if (process.env.LEO_EXPECT_BREAKDOWN) expect(r.completeness.breakdown).toBe(true)
    if (r.completeness.breakdown) {
      // leo-agents ≥ 0.2.3：片段带来源插件，工具定义精确
      expect(c.source).toBe('log')
      expect(c.injectedBy.skills).toBeGreaterThan(0)
      expect(c.sections!.map((s) => s.id)).toEqual(['agent.system', 'skills.catalog'])
      expect(Object.keys(c.toolDefs!)).toContain('echo')
      expect(c.window.source).toBe('log')
    } else {
      expect(c.source).toBe('estimate')
      expect(c.composition.system).toBeGreaterThan(0)
      expect(c.composition.tools).toBeGreaterThan(0)
    }

    const out = await h.command('', id)
    expect(out.isError).toBeFalsy()
    expect(out.text).toContain('上下文')
    expect(out.text).toContain('工具结果')
    expect(out.text).toMatch(/http:\/\/127\.0\.0\.1:\d+\//)
    expect((await h.command('open')).text).toMatch(/上下文网页：http/)
    expect((await h.command('list')).text).toContain(id)
    expect((await h.command('nope-session')).isError).toBe(true)
    expect((await h.command('')).isError).toBe(true)
    expect(h.notices.some((n) => n.plugin === 'context' && /上下文网页 http/.test(n.message))).toBe(true)
  })

  it('HTTP：网页、列表、报告、浏览器、洞察、SSE；本机 Host 校验', async () => {
    const h = await host(route)
    const id = await runOnce(h)
    const base = svc(h.leo).url()!
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    const page = await rawGet(base)
    expect(page.status).toBe(200)
    expect(page.type).toContain('text/html')
    expect(page.body).toContain('leo 上下文')
    expect((await rawGet(`${base}health`, { host: 'evil.example' })).status).toBe(200)
    // 没有令牌：只接受本机 Host（防 DNS rebinding）
    expect((await rawGet(`${base}api/sessions`, { host: 'evil.example' })).status).toBe(401)

    const list = JSON.parse((await rawGet(`${base}api/sessions`)).body) as { sessions: { sessionId: string; contextTokens?: number }[] }
    const s = list.sessions.find((x) => x.sessionId === id)!
    expect(s.contextTokens).toBeGreaterThan(0)

    const rep = JSON.parse((await rawGet(`${base}api/sessions/${id}`)).body) as SessionReport
    expect(rep.trend).toHaveLength(2)
    expect((await rawGet(`${base}api/sessions/nope`)).status).toBe(404)

    const d = JSON.parse((await rawGet(`${base}api/sessions/${id}/requests/1?limit=2`)).body) as RequestDetail
    expect(d.index).toBe(1)
    expect(d.items.length).toBeLessThanOrEqual(2)
    expect(d.total).toBeGreaterThan(2)
    const onlyResults = JSON.parse((await rawGet(`${base}api/sessions/${id}/requests/1?category=toolResults`)).body) as RequestDetail
    expect(onlyResults.items.map((i) => i.label)).toEqual(['tool · echo'])
    expect((await rawGet(`${base}api/sessions/${id}/requests/9`)).status).toBe(404)

    const ov = JSON.parse((await rawGet(`${base}api/overview?days=7`)).body) as Overview
    expect(ov.kpi.sessions).toBe(1)
    expect(ov.kpi.requests).toBe(2)
    expect(ov.kpi.billedTokens).toBe(530)
    expect(ov.kpi.cacheHitRate).toBeCloseTo(100 / 500)
    expect(ov.last7).toHaveLength(7)
    expect(ov.last7[6]!.billedTokens).toBe(530)
    expect(ov.heatmap).toHaveLength(56)
    expect(ov.tools[0]).toMatchObject({ name: 'echo', calls: 1 })
    expect(ov.sessions.map((x) => x.sessionId)).toEqual([id])

    // SSE：hello，然后新一轮的追加事件推送 update
    const updates: string[] = []
    const sse = await new Promise<import('node:http').ClientRequest>((resolve) => {
      const req = request(`${base}api/stream?session=${id}`, (res) => {
        res.setEncoding('utf8')
        res.on('data', (c: string) => updates.push(c))
        resolve(req)
      })
      req.end()
    })
    await waitFor(() => updates.join('').includes('event: hello'))
    const agent = h.leo.createAgent({ model: 'm', sessionId: id } as any)
    await agent.run('again')
    await waitFor(() => updates.join('').includes('event: update'))
    sse.destroy()
    // 缓存已失效：报告反映新一轮
    const after = (await svc(h.leo).report(id))!
    expect(after.stats.turns).toBe(2)
  })

  it('令牌：非本机地址没有令牌拒绝启动；有令牌时要带', async () => {
    const h = await host(route, { host: '0.0.0.0' })
    expect(svc(h.leo).url()).toBeUndefined()
    expect(h.notices.some((n) => n.level === 'error' && /without a token/.test(n.message))).toBe(true)
    // 插件其他功能照常
    expect(await h.command('open')).toMatchObject({ text: expect.stringContaining('没有启动') })

    process.env.LEO_CTX_TEST_TOKEN = 'sekret-123'
    const t = await host(route, { token: '$LEO_CTX_TEST_TOKEN' })
    const base = svc(t.leo).url()!
    expect((await rawGet(`${base}api/sessions`)).status).toBe(401)
    expect((await rawGet(`${base}api/sessions`, { authorization: 'Bearer sekret-123' })).status).toBe(200)
    expect((await rawGet(`${base}api/sessions`, { 'x-leo-context-token': 'sekret-123', host: 'anything.example' })).status).toBe(200)
    expect((await rawGet(`${base}api/sessions?token=sekret-123`)).status).toBe(200)
    expect((await rawGet(`${base}api/sessions?token=wrong`)).status).toBe(401)
  })

  it('server: false 时不监听；卸载插件关闭端口', async () => {
    const h = await host(route, { server: false })
    expect(svc(h.leo).url()).toBeUndefined()
    expect((await h.command('open')).text).toContain('已关闭')

    const t = await host(route)
    const base = svc(t.leo).url()!
    expect((await rawGet(`${base}health`)).status).toBe(200)
    await t.rt.dispose()
    await expect(rawGet(`${base}health`)).rejects.toThrow()
  })

  it('清单与默认导出一致', async () => {
    const { readFile } = await import('node:fs/promises')
    const manifest = JSON.parse(await readFile(new URL('../leo-plugin.json', import.meta.url), 'utf8'))
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    expect(manifest.version).toBe(pkg.version)
    expect(manifest.package).toBe(plugin.name)
    expect(manifest.inject).toEqual(plugin.inject)
  })
})
