import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLeoFromConfig, defineTool, z } from 'leo-agents'
import { createProviderPlugin } from 'leo-plugin-provider'
import { describe, expect, it } from 'vitest'
import plugin, { LONGCAT_MODELS, mapLongCatModel, prepareLongCatBody } from '../src/index.js'

const req = { model: 'x', messages: [] }
const on = { enabled: true }
const BASE = 'https://api.longcat.chat/openai/v1'

/** 官方文档 GET /models 的示例响应 */
const MODELS_RESPONSE = { object: 'list', data: [{ id: 'LongCat-2.5-Preview', object: 'model', owned_by: 'LongCat' }] }

const sse = (chunks: unknown[]) => new Response(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`, { status: 200 })

describe('prepareLongCatBody', () => {
  it('turns thinking on by default and drops temperature / reasoning_effort', () => {
    expect(prepareLongCatBody({ model: 'LongCat-2.5-Preview', temperature: 0.2, reasoning_effort: 'high' }, { request: req, settings: on })).toEqual({
      model: 'LongCat-2.5-Preview',
      thinking: { type: 'enabled' },
    })
  })

  it('request.reasoning wins over provider.json; effort none turns thinking off', () => {
    const run = (reasoning: unknown, settings: Record<string, unknown> = {}) =>
      prepareLongCatBody({ model: 'm' }, { request: { ...req, reasoning } as never, settings: { ...on, ...settings } })
    expect(run({ enabled: false }, { thinking: 'enabled' }).thinking).toEqual({ type: 'disabled' })
    expect(run({ enabled: true }, { thinking: false }).thinking).toEqual({ type: 'enabled' })
    expect(run({ effort: 'none' }).thinking).toEqual({ type: 'disabled' })
    expect(run({ effort: 'max' }, { thinking: 'disabled' })).toEqual({ model: 'm', thinking: { type: 'disabled' } })
    expect(run(undefined, { thinking: 'disabled' }).thinking).toEqual({ type: 'disabled' })
  })

  it('sends thinking_budget only while thinking, and validates provider.json', () => {
    expect(prepareLongCatBody({ model: 'm' }, { request: req, settings: { ...on, thinkingBudget: 4096 } })).toEqual({ model: 'm', thinking: { type: 'enabled' }, thinking_budget: 4096 })
    expect(prepareLongCatBody({ model: 'm' }, { request: req, settings: { ...on, thinking: 'disabled', thinkingBudget: 4096 } })).toEqual({ model: 'm', thinking: { type: 'disabled' } })
    expect(() => prepareLongCatBody({}, { request: req, settings: { ...on, thinkingBudget: 300000 } })).toThrow(/thinkingBudget/)
    expect(() => prepareLongCatBody({}, { request: req, settings: { ...on, thinking: 'maybe' } })).toThrow(/thinking/)
  })

  it('keeps assistant content a string and drops reasoning_content when thinking is off', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, reasoning_content: 'r', tool_calls: [{ id: 'c1' }] },
    ]
    expect((prepareLongCatBody({ messages }, { request: req, settings: on }).messages as any[])[1]).toEqual({ role: 'assistant', content: '', reasoning_content: 'r', tool_calls: [{ id: 'c1' }] })
    expect((prepareLongCatBody({ messages }, { request: { ...req, reasoning: { enabled: false } } as never, settings: on }).messages as any[])[1]).toEqual({ role: 'assistant', content: '', tool_calls: [{ id: 'c1' }] })
  })
})

describe('mapLongCatModel', () => {
  it('fills limits and pricing from the builtin info, reads the model detail shape', () => {
    expect(mapLongCatModel(MODELS_RESPONSE.data[0]!, LONGCAT_MODELS[0])).toMatchObject({
      id: 'LongCat-2.5-Preview',
      contextWindow: 1048576,
      maxOutputTokens: 262144,
      ownedBy: 'LongCat',
      pricing: { inputPerMTok: 0.3 },
      source: 'remote',
    })
    // GET /models/{id} 的详情格式；价格是人民币，不采用
    expect(
      mapLongCatModel({ id: 'LongCat-3', name: 'LongCat-3', context_length: 2000, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, pricing: { prompt: '2' } }),
    ).toMatchObject({ id: 'LongCat-3', name: 'LongCat-3', contextWindow: 2000, inputModalities: ['text', 'image'], pricing: { inputPerMTok: 0.3 }, source: 'remote' })
  })
})

describe('provider-longcat with the provider registry', () => {
  const setup = async (opts: { config?: unknown; models?: () => Response; chat: (body: any, n: number) => Response }) => {
    const root = await mkdtemp(join(tmpdir(), 'leo-lc-'))
    const home = await mkdtemp(join(tmpdir(), 'leo-lc-home-'))
    await mkdir(join(root, '.leo'), { recursive: true })
    await writeFile(join(root, '.leo', 'credentials.json'), JSON.stringify({ longcat: 'sk-lc' }))
    if (opts.config) await writeFile(join(root, '.leo', 'config.json'), JSON.stringify(opts.config))
    const bodies: any[] = []
    const calls: string[] = []
    const fetch = (async (url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).authorization
      calls.push(`${init.method} ${url} ${auth}`)
      if (url === `${BASE}/models`) return opts.models ? opts.models() : Response.json(MODELS_RESPONSE)
      expect(url).toBe(`${BASE}/chat/completions`)
      bodies.push(JSON.parse(String(init.body)))
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

  it('auto-connects with a saved key, thinking on, streams reasoning and passes it back during tool calls', async () => {
    const { app, bodies, calls } = await setup({
      chat: (_b, n) =>
        n === 1
          ? sse([
              { choices: [{ delta: { reasoning_content: '先算一下' } }] },
              { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'add', arguments: '{"a":2,"b":3}' } }] }, finish_reason: 'tool_calls' }] },
            ])
          : sse([{ choices: [{ delta: { content: '5' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 8, completion_tokens_details: { reasoning_tokens: 4 } } }]),
    })
    expect(app.model).toBe('longcat/LongCat-2.5-Preview')
    expect(app.providers[0]).toMatchObject({ id: 'longcat', name: 'LongCat', via: 'provider-longcat', loaded: true, baseURL: BASE })
    app.leo.ctx.get('tools').register(defineTool({ name: 'add', description: 'add', parameters: z.object({ a: z.number(), b: z.number() }), execute: ({ a, b }) => String(a + b) }))
    const r = await app.createAgent().run('2+3?')
    expect(r.text).toBe('5')
    expect(calls.filter((c) => c.includes('chat/completions'))).toEqual([`POST ${BASE}/chat/completions Bearer sk-lc`, `POST ${BASE}/chat/completions Bearer sk-lc`])
    expect(bodies[0]).toMatchObject({ model: 'LongCat-2.5-Preview', thinking: { type: 'enabled' }, stream: true })
    expect(bodies[0].temperature).toBeUndefined()
    expect(bodies[1].messages.find((m: any) => m.role === 'assistant')).toMatchObject({ content: '', reasoning_content: '先算一下', tool_calls: [{ id: 'c1' }] })
    await app.dispose()
  })

  it('lists models from GET /models with builtin details, falls back with a reason on failure', async () => {
    const { app, calls } = await setup({ chat: () => sse([]) })
    const [g] = await app.leo.ctx.get('llm').models({ refresh: true })
    expect(g!.error).toBeUndefined()
    expect(calls).toContain(`GET ${BASE}/models Bearer sk-lc`)
    expect(g!.models.map((m) => [m.id, m.contextWindow, m.maxOutputTokens, m.reasoning?.supported, m.source])).toEqual([['LongCat-2.5-Preview', 1048576, 262144, true, 'remote']])
    await app.dispose()

    const bad = await setup({ models: () => new Response('{"error":{"message":"invalid api key"}}', { status: 401 }), chat: () => sse([]) })
    const [f] = await bad.app.leo.ctx.get('llm').models({ refresh: true })
    expect(f!.error).toMatch(/invalid api key/)
    expect(f!.models.map((m) => [m.id, m.source])).toEqual([['LongCat-2.5-Preview', 'builtin']])
    await bad.app.dispose()
  })

  it('sends the host reasoning options as thinking on / off', async () => {
    const { app, bodies } = await setup({
      config: { agent: { reasoning: { enabled: false } } },
      chat: () => sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]),
    })
    await app.createAgent({ tools: false }).run('a')
    await app.createAgent({ tools: false, reasoning: { enabled: true } }).run('b')
    expect(bodies.map((b) => b.thinking)).toEqual([{ type: 'disabled' }, { type: 'enabled' }])
    await app.dispose()
  })
})
