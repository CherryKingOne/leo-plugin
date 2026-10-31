import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLeoFromConfig, defineTool, z } from 'leo-agents'
import { createProviderPlugin } from 'leo-plugin-provider'
import { describe, expect, it } from 'vitest'
import plugin, { DEEPSEEK_MODELS, mapDeepSeekModel, mapEffort, prepareDeepSeekBody } from '../src/index.js'

const req = { model: 'x', messages: [] }
const on = { enabled: true }
const flash = DEEPSEEK_MODELS[0]!

/** 官方文档 GET /models 的示例响应 */
const MODELS_RESPONSE = {
  object: 'list',
  data: [
    {
      id: 'deepseek-flash',
      object: 'model',
      owned_by: 'deepseek',
      name: 'DeepSeek-V4.1-Flash',
      context_window: 1048576,
      max_output_tokens: 393216,
      input_modalities: ['text', 'image'],
      output_modalities: ['text'],
      effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' },
      api_capabilities: { anthropic_messages: { system_prompt_update: 'in-history' } },
    },
    {
      id: 'deepseek-v4-pro',
      object: 'model',
      owned_by: 'deepseek',
      name: 'DeepSeek-V4-Pro',
      context_window: 1048576,
      max_output_tokens: 393216,
      input_modalities: ['text'],
      output_modalities: ['text'],
      effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' },
    },
  ],
}

const sse = (chunks: unknown[]) => new Response(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`, { status: 200 })

describe('prepareDeepSeekBody', () => {
  it('turns thinking on by default and rewrites retired model names', () => {
    expect(prepareDeepSeekBody({ model: 'deepseek-v4-pro' }, { request: req, settings: on })).toEqual({ model: 'deepseek-v4-pro', thinking: { type: 'enabled' } })
    expect(prepareDeepSeekBody({ model: 'deepseek-chat' }, { request: req, settings: on })).toEqual({ model: 'deepseek-flash', thinking: { type: 'disabled' } })
    expect(prepareDeepSeekBody({ model: 'deepseek-reasoner' }, { request: req, settings: { ...on, reasoningEffort: 'max' } })).toEqual({
      model: 'deepseek-flash',
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    })
    expect(prepareDeepSeekBody({ model: 'deepseek-chat' }, { request: req, settings: { ...on, legacyModels: false } })).toEqual({ model: 'deepseek-chat', thinking: { type: 'enabled' } })
  })

  it('request.reasoning (host /think, /effort) wins over provider.json', () => {
    const body = { model: 'deepseek-flash' }
    const run = (reasoning: unknown, settings: Record<string, unknown> = {}) => prepareDeepSeekBody(body, { request: { ...req, reasoning } as never, settings: { ...on, ...settings }, model: flash })
    expect(run({ enabled: false }, { thinking: 'enabled', reasoningEffort: 'max' })).toEqual({ model: 'deepseek-flash', thinking: { type: 'disabled' } })
    expect(run({ enabled: true, effort: 'max' }, { thinking: 'disabled' })).toEqual({ model: 'deepseek-flash', thinking: { type: 'enabled' }, reasoning_effort: 'max' })
    expect(run({ effort: 'none' })).toEqual({ model: 'deepseek-flash', thinking: { type: 'disabled' } })
    // 兼容档位：minimal → low，medium / xhigh → high
    expect(run({ effort: 'minimal' })).toMatchObject({ reasoning_effort: 'low' })
    expect(run({ effort: 'medium' })).toMatchObject({ reasoning_effort: 'high' })
    expect(run({ effort: 'xhigh' })).toMatchObject({ reasoning_effort: 'high' })
    // provider.json 的默认强度在宿主只开关思考时仍生效
    expect(run({ enabled: true }, { reasoningEffort: 'low' })).toEqual({ model: 'deepseek-flash', thinking: { type: 'enabled' }, reasoning_effort: 'low' })
    expect(run(undefined, { thinking: false })).toEqual({ model: 'deepseek-flash', thinking: { type: 'disabled' } })
  })

  it('maps efforts to the levels the model supports', () => {
    expect(mapEffort('max', ['low', 'high'])).toBe('high')
    expect(mapEffort('minimal', ['high', 'max'])).toBe('high')
    expect(mapEffort('none')).toBe('none')
  })

  it('drops reasoning_content history when thinking is off, keeps it when on', () => {
    const body = { model: 'deepseek-flash', messages: [{ role: 'assistant', content: 'a', reasoning_content: 'r' }, { role: 'user', content: 'u' }] }
    expect((prepareDeepSeekBody(body, { request: { ...req, reasoning: { enabled: false } } as never, settings: on }).messages as any[])[0]).toEqual({ role: 'assistant', content: 'a' })
    expect((prepareDeepSeekBody(body, { request: req, settings: on }).messages as any[])[0]).toMatchObject({ reasoning_content: 'r' })
  })

  it('handles tool_choice that thinking mode does not support', () => {
    const body = { model: 'deepseek-flash', tool_choice: 'required' }
    expect(prepareDeepSeekBody(body, { request: req, settings: on })).toMatchObject({ thinking: { type: 'disabled' } })
    expect(() => prepareDeepSeekBody(body, { request: { ...req, reasoning: { enabled: true } } as never, settings: on })).toThrow(/thinking mode/)
  })

  it('rejects bad settings with a non-retryable marked error', () => {
    try {
      prepareDeepSeekBody({ model: 'deepseek-flash' }, { request: req, settings: { ...on, reasoningEffort: 'huge' } })
      throw new Error('expected failure')
    } catch (e) {
      expect(e).toMatchObject({ code: 'invalid_request' })
      expect((e as Record<symbol, unknown>)[Symbol.for('leo.error')]).toBe(true)
    }
  })
})

describe('mapDeepSeekModel', () => {
  it('reads name, limits, modalities and effort levels from GET /models, keeps builtin pricing', () => {
    const m = mapDeepSeekModel(MODELS_RESPONSE.data[1]!, DEEPSEEK_MODELS[1])
    expect(m).toEqual({
      ...DEEPSEEK_MODELS[1],
      id: 'deepseek-v4-pro',
      name: 'DeepSeek-V4-Pro',
      contextWindow: 1048576,
      maxOutputTokens: 393216,
      inputModalities: ['text'],
      outputModalities: ['text'],
      reasoning: { supported: true, canDisable: true, defaultEnabled: true, efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
      ownedBy: 'deepseek',
      source: 'remote',
    })
    expect(mapDeepSeekModel({ id: 'deepseek-new', context_window: 2000 })).toMatchObject({ id: 'deepseek-new', contextWindow: 2000, source: 'remote' })
  })
})

describe('provider-deepseek with the provider registry', () => {
  const setup = async (opts: { config?: unknown; env?: NodeJS.ProcessEnv; models?: (auth?: string) => Response; chat: (body: any, n: number) => Response }) => {
    const root = await mkdtemp(join(tmpdir(), 'leo-ds-'))
    const home = await mkdtemp(join(tmpdir(), 'leo-ds-home-'))
    await mkdir(join(root, '.leo'), { recursive: true })
    await writeFile(join(root, '.leo', 'credentials.json'), JSON.stringify({ deepseek: 'sk-ds' }))
    if (opts.config) await writeFile(join(root, '.leo', 'config.json'), JSON.stringify(opts.config))
    const bodies: any[] = []
    const calls: string[] = []
    const fetch = (async (url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).authorization
      calls.push(`${init.method} ${url} ${auth}`)
      if (url === 'https://api.deepseek.com/models') return opts.models ? opts.models(auth) : Response.json(MODELS_RESPONSE)
      expect(url).toBe('https://api.deepseek.com/chat/completions')
      bodies.push(JSON.parse(String(init.body)))
      return opts.chat(bodies.at(-1), bodies.length)
    }) as unknown as typeof globalThis.fetch
    const app = await createLeoFromConfig({
      cwd: root,
      userDir: home,
      env: opts.env ?? {},
      overrides: { tools: { builtin: false } },
      plugins: [createProviderPlugin({ fetch }), plugin],
      watchPlugins: false,
    })
    return { app, bodies, calls }
  }

  it('auto-connects with a saved key, defaults to deepseek-flash, thinking on, and passes reasoning_content back during tool calls', async () => {
    const { app, bodies, calls } = await setup({
      chat: (_b, n) =>
        n === 1
          ? sse([
              { choices: [{ delta: { reasoning_content: '先算一下' } }] },
              { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'add', arguments: '{"a":2,"b":3}' } }] }, finish_reason: 'tool_calls' }] },
            ])
          : sse([{ choices: [{ delta: { content: '5' }, finish_reason: 'stop' }] }]),
    })
    expect(app.model).toBe('deepseek/deepseek-flash')
    expect(app.providers[0]).toMatchObject({ id: 'deepseek', name: 'DeepSeek', via: 'provider-deepseek', loaded: true, baseURL: 'https://api.deepseek.com' })
    app.leo.ctx.get('tools').register(defineTool({ name: 'add', description: 'add', parameters: z.object({ a: z.number(), b: z.number() }), execute: ({ a, b }) => String(a + b) }))
    const r = await app.createAgent().run('2+3?')
    expect(r.text).toBe('5')
    expect(calls.filter((c) => c.includes('chat/completions'))).toEqual(['POST https://api.deepseek.com/chat/completions Bearer sk-ds', 'POST https://api.deepseek.com/chat/completions Bearer sk-ds'])
    expect(bodies[0]).toMatchObject({ model: 'deepseek-flash', thinking: { type: 'enabled' } })
    expect(bodies[0].reasoning_effort).toBeUndefined()
    expect(bodies[1].messages.find((m: any) => m.role === 'assistant')).toMatchObject({ reasoning_content: '先算一下', tool_calls: [{ id: 'c1' }] })
    await app.dispose()
  })

  it('lists the real models from GET /models with details, hiding aliases', async () => {
    const { app, calls } = await setup({ chat: () => sse([]) })
    const llm = app.leo.ctx.get('llm')
    // 离线：内置列表（真实上限），别名不展示
    const offline = await llm.models()
    expect(offline[0]!.models.map((m) => [m.id, m.contextWindow, m.maxOutputTokens, m.source])).toEqual([
      ['deepseek-flash', 1048576, 393216, 'builtin'],
      ['deepseek-v4-pro', 1048576, 393216, 'builtin'],
    ])
    const [g] = await llm.models({ refresh: true })
    expect(g!.error).toBeUndefined()
    expect(calls).toContain('GET https://api.deepseek.com/models Bearer sk-ds')
    expect(g!.models.map((m) => [m.id, m.name, m.inputModalities, m.reasoning?.efforts, m.reasoning?.defaultEffort, m.source])).toEqual([
      ['deepseek-flash', 'DeepSeek-V4.1-Flash', ['text', 'image'], ['low', 'high', 'max'], 'high', 'remote'],
      ['deepseek-v4-pro', 'DeepSeek-V4-Pro', ['text'], ['low', 'high', 'max'], 'high', 'remote'],
    ])
    // 价格沿用内置；旧名字仍可解析（别名）
    expect(llm.resolve('deepseek/deepseek-v4-pro').info).toMatchObject({ name: 'DeepSeek-V4-Pro', pricing: { inputPerMTok: 1.32 } })
    expect(llm.resolve('deepseek/deepseek-chat').info).toMatchObject({ alias: true, contextWindow: 1048576 })
    await app.dispose()
  })

  it('falls back to the builtin list with a reason when GET /models fails', async () => {
    const { app } = await setup({ models: () => new Response('{"error":{"message":"Authentication Fails"}}', { status: 401 }), chat: () => sse([]) })
    const [g] = await app.leo.ctx.get('llm').models({ refresh: true })
    expect(g!.error).toMatch(/Authentication Fails/)
    expect(g!.models.map((m) => m.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    await app.dispose()
  })

  it('sends the host reasoning options (agent.reasoning / --effort) as thinking + reasoning_effort', async () => {
    const { app, bodies } = await setup({
      config: { agent: { reasoning: { effort: 'max' } } },
      chat: () => sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]),
    })
    await app.createAgent({ tools: false }).run('a')
    await app.createAgent({ tools: false, reasoning: { enabled: false } }).run('b')
    await app.createAgent({ tools: false, model: 'deepseek/deepseek-v4-pro', reasoning: { effort: 'low' } }).run('c')
    expect(bodies.map((b) => [b.model, b.thinking, b.reasoning_effort])).toEqual([
      ['deepseek-flash', { type: 'enabled' }, 'max'],
      ['deepseek-flash', { type: 'disabled' }, undefined],
      ['deepseek-v4-pro', { type: 'enabled' }, 'low'],
    ])
    await app.dispose()
  })

  it('keeps a 0.1.x config (model deepseek/deepseek-chat) working', async () => {
    const { app, bodies } = await setup({
      config: { model: 'deepseek/deepseek-chat', providers: { deepseek: {} } },
      env: { DEEPSEEK_API_KEY: 'sk-env' },
      chat: () => sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]),
    })
    expect(app.model).toBe('deepseek/deepseek-chat')
    expect((await app.createAgent({ tools: false }).run('hi')).text).toBe('ok')
    expect(bodies[0]).toMatchObject({ model: 'deepseek-flash', thinking: { type: 'disabled' } })
    await app.dispose()
  })
})
