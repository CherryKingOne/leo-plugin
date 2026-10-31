import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLeoFromConfig, defineTool, z } from 'leo-agents'
import { createProviderPlugin } from 'leo-plugin-provider'
import { describe, expect, it } from 'vitest'
import plugin, { SPARK_MODELS, prepareSparkBody } from '../src/index.js'

const req = { model: 'x', messages: [] }
const on = { enabled: true }
const BASE = 'https://maas-api.cn-huabei-1.xf-yun.com/v2'

const sse = (chunks: unknown[]) => new Response(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`, { status: 200 })

describe('prepareSparkBody', () => {
  it('thinking enabled by default; drops fixed / deprecated sampling params; max_tokens → max_completion_tokens', () => {
    expect(
      prepareSparkBody(
        { model: 'spark-x2.6', temperature: 0.2, top_p: 0.5, presence_penalty: 1, frequency_penalty: 1, reasoning_effort: 'high', max_tokens: 100 },
        { request: req, settings: on },
      ),
    ).toEqual({ model: 'spark-x2.6', thinking: { type: 'enabled' }, max_completion_tokens: 100 })
  })

  it('request.reasoning wins over provider.json; effort none turns thinking off; auto from provider.json', () => {
    const run = (reasoning: unknown, settings: Record<string, unknown> = {}) =>
      prepareSparkBody({ model: 'm' }, { request: { ...req, reasoning } as never, settings: { ...on, ...settings } }).thinking
    expect(run({ enabled: false }, { thinking: 'enabled' })).toEqual({ type: 'disabled' })
    expect(run({ enabled: true }, { thinking: false })).toEqual({ type: 'enabled' })
    expect(run({ effort: 'none' }, { thinking: 'auto' })).toEqual({ type: 'disabled' })
    expect(run({ effort: 'high' }, { thinking: 'auto' })).toEqual({ type: 'auto' })
    expect(run(undefined, { thinking: 'auto' })).toEqual({ type: 'auto' })
    expect(run(undefined, { thinking: 'disabled' })).toEqual({ type: 'disabled' })
    expect(() => run(undefined, { thinking: 'fast' })).toThrow(/thinking/)
  })

  it('keeps messages to documented fields: no reasoning_content, content always present and text only', () => {
    const out = prepareSparkBody(
      {
        model: 'm',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image_url', image_url: { url: 'x' } }] },
          { role: 'assistant', content: null, reasoning_content: '想', tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'c', content: 'ok' },
          { role: 'user', content: [{ type: 'text', text: 'b' }] },
        ],
      },
      { request: req, settings: on },
    )
    expect(out.messages).toEqual([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c', content: 'ok' },
      { role: 'user', content: [{ type: 'text', text: 'b' }] },
    ])
  })

  it('webSearch adds the built-in web_search tool; user is validated; at most 128 tools', () => {
    const out = prepareSparkBody({ model: 'm', tools: [{ type: 'function', function: { name: 'f' } }] }, { request: req, settings: { ...on, webSearch: true, user: 'u_1' } })
    expect(out.tools).toEqual([{ type: 'function', function: { name: 'f' } }, { type: 'web_search', web_search: { enable: true } }])
    expect(out.user).toBe('u_1')
    expect(prepareSparkBody({ model: 'm' }, { request: req, settings: { ...on, webSearch: true } }).tools).toEqual([{ type: 'web_search', web_search: { enable: true } }])
    expect(() => prepareSparkBody({ model: 'm' }, { request: req, settings: { ...on, user: 'a b' } })).toThrow(/user/)
    expect(() => prepareSparkBody({ model: 'm', tools: Array.from({ length: 129 }, () => ({ type: 'function' })) }, { request: req, settings: on })).toThrow(/128/)
  })
})

describe('SPARK_MODELS', () => {
  it('lists only the six self-developed models from the docs', () => {
    expect(SPARK_MODELS.map((m) => [m.id, m.contextWindow])).toEqual([
      ['spark-x2.6', 1048576],
      ['spark-x2.6-4b', 1048576],
      ['spark-x2.6-preview', 262144],
      ['spark-x2.5', 262144],
      ['spark-x2.5-4b', 1048576],
      ['spark-x2.5-1.7b', 1048576],
    ])
    expect(SPARK_MODELS.every((m) => m.reasoning?.canDisable && !m.reasoning.efforts?.length)).toBe(true)
  })
})

describe('provider-spark with the provider registry', () => {
  const setup = async (chat: (body: any, n: number) => Response) => {
    const root = await mkdtemp(join(tmpdir(), 'leo-spark-'))
    const home = await mkdtemp(join(tmpdir(), 'leo-spark-home-'))
    await mkdir(join(root, '.leo'), { recursive: true })
    const bodies: any[] = []
    const calls: string[] = []
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${url} ${(init.headers as Record<string, string>).authorization}`)
      bodies.push(JSON.parse(String(init.body)))
      return chat(bodies.at(-1), bodies.length)
    }) as unknown as typeof globalThis.fetch
    const app = await createLeoFromConfig({
      cwd: root,
      userDir: home,
      env: { SPARK_API_PASSWORD: 'ak-test' },
      overrides: { tools: { builtin: false } },
      plugins: [createProviderPlugin({ fetch }), plugin],
      watchPlugins: false,
    })
    return { app, bodies, calls }
  }

  it('auto-connects with SPARK_API_PASSWORD, streams reasoning, runs tools without passing reasoning back', async () => {
    const { app, bodies, calls } = await setup((_b, n) =>
      n === 1
        ? sse([
            { code: 0, message: 'Success', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '算一下' } }] },
            { code: 0, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'add', arguments: '{"a":2,"b":3}' } }] }, finish_reason: 'tool_calls' }] },
          ])
        : sse([{ code: 0, choices: [{ index: 0, delta: { content: '5' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 8, completion_tokens_details: { reasoning_tokens: 4 }, total_tokens: 18 } }]),
    )
    expect(app.model).toBe('spark/spark-x2.6')
    expect(app.providers[0]).toMatchObject({ id: 'spark', name: '讯飞星火', via: 'provider-spark', loaded: true, baseURL: BASE })
    app.leo.ctx.get('tools').register(defineTool({ name: 'add', description: 'add', parameters: z.object({ a: z.number(), b: z.number() }), execute: ({ a, b }) => String(a + b) }))
    const r = await app.createAgent().run('2+3?')
    expect(r.text).toBe('5')
    expect(calls).toEqual([`POST ${BASE}/chat/completions Bearer ak-test`, `POST ${BASE}/chat/completions Bearer ak-test`])
    expect(bodies[0]).toMatchObject({ model: 'spark-x2.6', thinking: { type: 'enabled' }, stream: true })
    expect(bodies[0].temperature).toBeUndefined()
    expect(bodies[0].max_tokens).toBeUndefined()
    const assistant = bodies[1].messages.find((m: any) => m.role === 'assistant')
    expect(assistant).toMatchObject({ content: '', tool_calls: [{ id: 'c1' }] })
    expect(assistant).not.toHaveProperty('reasoning_content')
    expect(bodies[1].messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c1', content: '5' })
    await app.dispose()
  })

  it('surfaces a business error code from the stream', async () => {
    let n = 0
    const { app } = await setup(() => (n++, sse([{ code: 10013, message: '输入内容包含敏感内容' }])))
    const r = (await app.createAgent({ tools: false }).run('x')) as any
    expect(r.error).toMatchObject({ code: 'invalid_request', message: '输入内容包含敏感内容' })
    // 敏感内容不重试
    expect(n).toBe(1)
    await app.dispose()
  })

  it('lists only the builtin models, without calling the platform', async () => {
    const { app, calls } = await setup(() => sse([]))
    const [g] = await app.leo.ctx.get('llm').models({ refresh: true })
    expect(g!.models.map((m) => m.id)).toEqual(SPARK_MODELS.map((m) => m.id))
    expect(calls).toEqual([])
    await app.dispose()
  })
})
