import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLeoFromConfig, defineTool, z } from 'leo-agents'
import { createProviderPlugin } from 'leo-plugin-provider'
import { describe, expect, it } from 'vitest'
import plugin, { QIANFAN_MODELS, normalizeQianfanEffort, prepareQianfanBody, thinkingSpecOf } from '../src/index.js'

const on = { enabled: true }
const BASE = 'https://qianfan.baidubce.com/v2'
const KEY = 'bce-v3/ALTAK-test/secret'
const info = (id: string) => QIANFAN_MODELS.find((m) => m.id === id)
const prep = (model: string, opts: { reasoning?: unknown; settings?: Record<string, unknown>; body?: Record<string, unknown> } = {}) =>
  prepareQianfanBody({ model, ...opts.body }, { request: { model, messages: [], reasoning: opts.reasoning } as never, settings: { ...on, ...opts.settings }, model: info(model) })

const sse = (chunks: unknown[]) => new Response(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`, { status: 200 })

describe('prepareQianfanBody', () => {
  it('ernie-light-dt-1.0: thinking on by default, switchable, effort low / high / max', () => {
    expect(prep('ernie-light-dt-1.0')).toEqual({ model: 'ernie-light-dt-1.0', thinking: { type: 'enabled' } })
    expect(prep('ernie-light-dt-1.0', { reasoning: { enabled: false }, settings: { thinking: 'enabled', reasoningEffort: 'max' } })).toEqual({ model: 'ernie-light-dt-1.0', thinking: { type: 'disabled' } })
    expect(prep('ernie-light-dt-1.0', { reasoning: { effort: 'none' } }).thinking).toEqual({ type: 'disabled' })
    expect(prep('ernie-light-dt-1.0', { settings: { thinking: false } }).thinking).toEqual({ type: 'disabled' })
    expect(prep('ernie-light-dt-1.0', { settings: { reasoningEffort: 'none' } }).thinking).toEqual({ type: 'disabled' })
    const effort = (reasoning: unknown, settings?: Record<string, unknown>) => prep('ernie-light-dt-1.0', { reasoning, ...(settings ? { settings } : {}) }).reasoning_effort
    expect([effort({ effort: 'minimal' }), effort({ effort: 'low' }), effort({ effort: 'medium' }), effort({ effort: 'high' }), effort({ effort: 'xhigh' }), effort({ effort: 'max' })]).toEqual(['low', 'low', 'high', 'high', 'max', 'max'])
    expect(effort(undefined, { reasoningEffort: 'low' })).toBe('low')
    // 交互中 /effort 优先于 provider.json
    expect(effort({ enabled: true, effort: 'max' }, { reasoningEffort: 'low' })).toBe('max')
  })

  it('ernie-5.5-flash-preview: always sends thinking enabled, never disabled or an effort', () => {
    expect(prep('ernie-5.5-flash-preview')).toEqual({ model: 'ernie-5.5-flash-preview', thinking: { type: 'enabled' } })
    expect(prep('ernie-5.5-flash-preview', { reasoning: { enabled: false, effort: 'max' }, body: { reasoning_effort: 'low', thinking: { type: 'disabled' } } })).toEqual({ model: 'ernie-5.5-flash-preview', thinking: { type: 'enabled' } })
  })

  it('ernie-5.1: a plain text model, no thinking parameters, reasoning_content dropped', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, reasoning_content: 'r', tool_calls: [{ id: 'c1' }] },
    ]
    const out = prep('ernie-5.1', { reasoning: { enabled: true, effort: 'max' }, body: { messages } })
    expect(out.thinking).toBeUndefined()
    expect(out.reasoning_effort).toBeUndefined()
    expect((out.messages as any[])[1]).toEqual({ role: 'assistant', content: '', tool_calls: [{ id: 'c1' }] })
  })

  it('keeps reasoning_content while thinking, drops it when off; assistant null content becomes a string', () => {
    const messages = [{ role: 'assistant', content: null, reasoning_content: 'r', tool_calls: [{ id: 'c1' }] }]
    expect((prep('ernie-light-dt-1.0', { body: { messages } }).messages as any[])[0]).toEqual({ role: 'assistant', content: '', reasoning_content: 'r', tool_calls: [{ id: 'c1' }] })
    expect((prep('ernie-light-dt-1.0', { reasoning: { enabled: false }, body: { messages } }).messages as any[])[0]).toEqual({ role: 'assistant', content: '', tool_calls: [{ id: 'c1' }] })
  })

  it('validates provider.json and handles models added by hand', () => {
    expect(() => prep('ernie-light-dt-1.0', { settings: { thinking: 'maybe' } })).toThrow(/thinking/)
    expect(() => prep('ernie-light-dt-1.0', { settings: { reasoningEffort: 'ultra' } })).toThrow(/reasoningEffort/)
    // 手动加的非 ERNIE 模型：没声明思考能力就原样发送
    expect(prepareQianfanBody({ model: 'deepseek-v4-pro' }, { request: { model: 'deepseek-v4-pro', messages: [] }, settings: on })).toEqual({ model: 'deepseek-v4-pro' })
    expect(thinkingSpecOf('deepseek-v4-pro', { id: 'deepseek-v4-pro', reasoning: { supported: true, efforts: ['low', 'high', 'max'] } } as never)).toEqual({ toggle: 'switch', effort: true })
    expect(thinkingSpecOf('ERNIE-Light-DT-1.0')).toEqual({ toggle: 'switch', effort: true })
    expect(normalizeQianfanEffort('bogus')).toBeUndefined()
  })
})

describe('provider-qianfan with the provider registry', () => {
  const setup = async (opts: { config?: unknown; provider?: unknown; chat: (body: any, n: number) => Response }) => {
    const root = await mkdtemp(join(tmpdir(), 'leo-qf-'))
    const home = await mkdtemp(join(tmpdir(), 'leo-qf-home-'))
    await mkdir(join(root, '.leo'), { recursive: true })
    await writeFile(join(root, '.leo', 'credentials.json'), JSON.stringify({ qianfan: KEY }))
    if (opts.config) await writeFile(join(root, '.leo', 'config.json'), JSON.stringify(opts.config))
    if (opts.provider) await writeFile(join(root, '.leo', 'provider.json'), JSON.stringify(opts.provider))
    const bodies: any[] = []
    const calls: string[] = []
    const fetch = (async (url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).authorization
      calls.push(`${init.method} ${url} ${auth}`)
      const base = String(url).replace(/\/chat\/completions$/, '')
      expect(String(url).endsWith('/chat/completions')).toBe(true)
      bodies.push({ ...JSON.parse(String(init.body)), _base: base })
      return opts.chat(bodies.at(-1), bodies.length)
    }) as unknown as typeof globalThis.fetch
    const app = await createLeoFromConfig({
      cwd: root,
      userDir: home,
      env: {},
      overrides: { tools: { builtin: false } },
      plugins: [createProviderPlugin({ fetch }), plugin],
      watchPlugins: false,
    })
    return { app, bodies, calls }
  }

  it('auto-connects with a saved key, streams reasoning and passes it back during tool calls', async () => {
    const { app, bodies, calls } = await setup({
      chat: (_b, n) =>
        n === 1
          ? sse([
              { choices: [{ delta: { reasoning_content: '先算一下' } }] },
              { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'add', arguments: '{"a":2,"b":3}' } }] }, finish_reason: 'tool_calls' }] },
            ])
          : sse([{ choices: [{ delta: { content: '5' }, finish_reason: 'stop', flag: 0 }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } }]),
    })
    expect(app.model).toBe('qianfan/ernie-5.5-flash-preview')
    expect(app.providers[0]).toMatchObject({ id: 'qianfan', via: 'provider-qianfan', loaded: true, baseURL: BASE })
    app.leo.ctx.get('tools').register(defineTool({ name: 'add', description: 'add', parameters: z.object({ a: z.number(), b: z.number() }), execute: ({ a, b }) => String(a + b) }))
    const r = await app.createAgent().run('2+3?')
    expect(r.text).toBe('5')
    expect(calls).toEqual([`POST ${BASE}/chat/completions Bearer ${KEY}`, `POST ${BASE}/chat/completions Bearer ${KEY}`])
    expect(bodies[0]).toMatchObject({ model: 'ernie-5.5-flash-preview', stream: true, thinking: { type: 'enabled' } })
    expect(bodies[0].reasoning_effort).toBeUndefined()
    expect(bodies[1].messages.find((m: any) => m.role === 'assistant')).toMatchObject({ content: '', reasoning_content: '先算一下', tool_calls: [{ id: 'c1' }] })
    await app.dispose()
  })

  it('lists only the builtin ERNIE models without calling GET /models', async () => {
    const { app, calls } = await setup({ chat: () => sse([]) })
    const [g] = await app.leo.ctx.get('llm').models({ refresh: true })
    expect(calls).toEqual([])
    expect(g!.models.map((m) => [m.id, m.contextWindow, m.maxOutputTokens, m.reasoning?.canDisable])).toEqual([
      ['ernie-5.5-flash-preview', 1000000, 131072, false],
      ['ernie-light-dt-1.0', 1000000, 131072, true],
      ['ernie-5.1', 131072, 65536, undefined],
    ])
    await app.dispose()
  })

  it('switches thinking for ernie-light-dt-1.0 and honours a Token Plan baseURL', async () => {
    const { app, bodies } = await setup({
      config: { model: 'qianfan/ernie-light-dt-1.0', agent: { reasoning: { enabled: false } } },
      provider: { providers: { qianfan: { baseURL: 'https://qianfan.baidubce.com/v2/tokenplan/personal' } } },
      chat: () => sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]),
    })
    await app.createAgent({ tools: false }).run('a')
    await app.createAgent({ tools: false, reasoning: { enabled: true } }).run('b')
    await app.createAgent({ tools: false, reasoning: { enabled: true, effort: 'low' } }).run('c')
    expect(bodies.map((b) => [b.model, b.thinking.type, b.reasoning_effort])).toEqual([
      ['ernie-light-dt-1.0', 'disabled', undefined],
      ['ernie-light-dt-1.0', 'enabled', undefined],
      ['ernie-light-dt-1.0', 'enabled', 'low'],
    ])
    expect(new Set(bodies.map((b) => b._base))).toEqual(new Set(['https://qianfan.baidubce.com/v2/tokenplan/personal']))
    await app.dispose()
  })

  it('maps Qianfan error codes: tokens_too_long → context_overflow, quota → auth (no retry)', async () => {
    const run = async (code: string, status: number) => {
      let n = 0
      const { app } = await setup({
        chat: () => {
          n++
          return new Response(JSON.stringify({ error: { code, message: code, type: 'x' } }), { status })
        },
      })
      const r = await app.createAgent({ tools: false }).run('a')
      await app.dispose()
      return { code: (r as any).error?.code, calls: n }
    }
    expect((await run('tokens_too_long', 400)).code).toBe('context_overflow')
    expect(await run('coding_plan_month_quota_exceeded', 429)).toEqual({ code: 'auth', calls: 1 })
    expect(await run('account_overdue', 403)).toEqual({ code: 'auth', calls: 1 })
  })
})
