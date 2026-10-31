import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLeoFromConfig, defineTool, z } from 'leo-agents'
import { createProviderPlugin } from 'leo-plugin-provider'
import { describe, expect, it } from 'vitest'
import plugin, { prepareDeepSeekBody } from '../src/index.js'

const req = { model: 'x', messages: [] }

describe('prepareDeepSeekBody', () => {
  it('rewrites retired model names to deepseek-flash with the matching thinking mode', () => {
    expect(prepareDeepSeekBody({ model: 'deepseek-chat' }, { request: req, settings: { enabled: true } })).toEqual({ model: 'deepseek-flash', thinking: { type: 'disabled' } })
    expect(prepareDeepSeekBody({ model: 'deepseek-reasoner' }, { request: req, settings: { enabled: true, reasoningEffort: 'max' } })).toEqual({
      model: 'deepseek-flash',
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    })
    expect(prepareDeepSeekBody({ model: 'deepseek-chat' }, { request: req, settings: { enabled: true, legacyModels: false } })).toEqual({ model: 'deepseek-chat' })
  })

  it('sends thinking / reasoning_effort from provider.json and leaves defaults to DeepSeek otherwise', () => {
    expect(prepareDeepSeekBody({ model: 'deepseek-v4-pro' }, { request: req, settings: { enabled: true } })).toEqual({ model: 'deepseek-v4-pro' })
    expect(prepareDeepSeekBody({ model: 'deepseek-flash' }, { request: req, settings: { enabled: true, thinking: 'disabled', reasoningEffort: 'high' } })).toEqual({
      model: 'deepseek-flash',
      thinking: { type: 'disabled' },
    })
  })

  it('rejects bad settings with a non-retryable marked error', () => {
    try {
      prepareDeepSeekBody({ model: 'deepseek-flash' }, { request: req, settings: { enabled: true, reasoningEffort: 'huge' } })
      throw new Error('expected failure')
    } catch (e) {
      expect(e).toMatchObject({ code: 'invalid_request' })
      expect((e as Record<symbol, unknown>)[Symbol.for('leo.error')]).toBe(true)
    }
  })
})

describe('provider-deepseek with the provider registry', () => {
  it('auto-connects with a saved key, defaults to deepseek-flash and passes reasoning_content back during tool calls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'leo-ds-'))
    const home = await mkdtemp(join(tmpdir(), 'leo-ds-home-'))
    await mkdir(join(root, '.leo'), { recursive: true })
    await writeFile(join(root, '.leo', 'credentials.json'), JSON.stringify({ deepseek: 'sk-ds' }))
    const bodies: any[] = []
    const auth: string[] = []
    const fetch = (async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.deepseek.com/chat/completions')
      auth.push((init.headers as Record<string, string>).authorization!)
      bodies.push(JSON.parse(String(init.body)))
      const chunks =
        bodies.length === 1
          ? [
              { choices: [{ delta: { reasoning_content: '先算一下' } }] },
              { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'add', arguments: '{"a":2,"b":3}' } }] }, finish_reason: 'tool_calls' }] },
            ]
          : [{ choices: [{ delta: { content: '5' }, finish_reason: 'stop' }] }]
      return new Response(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`, { status: 200 })
    }) as unknown as typeof globalThis.fetch
    const app = await createLeoFromConfig({
      cwd: root,
      userDir: home,
      env: {},
      overrides: { tools: { builtin: false } },
      plugins: [createProviderPlugin({ fetch }), plugin],
    })
    expect(app.model).toBe('deepseek/deepseek-flash')
    expect(app.providers[0]).toMatchObject({ id: 'deepseek', name: 'DeepSeek', via: 'provider-deepseek', loaded: true, baseURL: 'https://api.deepseek.com' })
    app.leo.ctx.get('tools').register(defineTool({ name: 'add', description: 'add', parameters: z.object({ a: z.number(), b: z.number() }), execute: ({ a, b }) => String(a + b) }))
    const r = await app.createAgent().run('2+3?')
    expect(r.text).toBe('5')
    expect(auth).toEqual(['Bearer sk-ds', 'Bearer sk-ds'])
    expect(bodies[0].model).toBe('deepseek-flash')
    expect(bodies[1].messages.find((m: any) => m.role === 'assistant')).toMatchObject({ reasoning_content: '先算一下', tool_calls: [{ id: 'c1' }] })
    expect(app.leo.ctx.get('llm').resolve('deepseek/deepseek-flash').info).toMatchObject({ contextWindow: 1_000_000 })
    await app.dispose()
  })

  it('keeps a 0.1.x config (model deepseek/deepseek-chat) working', async () => {
    const root = await mkdtemp(join(tmpdir(), 'leo-ds-'))
    const home = await mkdtemp(join(tmpdir(), 'leo-ds-home-'))
    await mkdir(join(root, '.leo'), { recursive: true })
    await writeFile(join(root, '.leo', 'config.json'), JSON.stringify({ model: 'deepseek/deepseek-chat', providers: { deepseek: {} } }))
    const bodies: any[] = []
    const fetch = (async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)))
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { status: 200 })
    }) as unknown as typeof globalThis.fetch
    const app = await createLeoFromConfig({
      cwd: root,
      userDir: home,
      env: { DEEPSEEK_API_KEY: 'sk-env' },
      overrides: { tools: { builtin: false } },
      plugins: [createProviderPlugin({ fetch }), plugin],
    })
    expect(app.model).toBe('deepseek/deepseek-chat')
    expect((await app.createAgent({ tools: false }).run('hi')).text).toBe('ok')
    expect(bodies[0]).toMatchObject({ model: 'deepseek-flash', thinking: { type: 'disabled' } })
    await app.dispose()
  })
})
