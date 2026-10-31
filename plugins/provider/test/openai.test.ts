import { describe, expect, it } from 'vitest'
import { createLeo, defineTool, providerPlugin, z } from 'leo-agents'
import { OpenAICompatibleProvider, parseRemoteModel } from '../src/openai.js'
import type { ProviderError as LeoError } from '../src/errors.js'

function sseResponse(chunks: unknown[], init: ResponseInit = {}) {
  const body = chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join('')
  const enc = new TextEncoder().encode(body)
  // 故意切成小块，测试跨块解析
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < enc.length; i += 7) controller.enqueue(enc.slice(i, i + 7))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' }, ...init })
}

describe('OpenAICompatibleProvider', () => {
  it('parses text, reasoning, tool calls and usage from SSE', async () => {
    const bodies: any[] = []
    const fetchMock = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)))
      return sseResponse([
        { choices: [{ delta: { reasoning_content: '想一想' } }] },
        { choices: [{ delta: { content: '好的' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'weather', arguments: '{"ci' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"北京"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 50, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 20 } } },
        '[DONE]',
      ])
    }) as unknown as typeof fetch
    const p = new OpenAICompatibleProvider({ id: 'ds', baseURL: 'https://example.test/v1/', apiKey: 'k', fetch: fetchMock })
    const events = []
    for await (const e of p.stream(
      { model: 'deepseek-chat', system: 'sys', messages: [{ id: '1', role: 'user', content: [{ type: 'text', text: 'hi' }], createdAt: 0 }], tools: [{ name: 'weather', description: 'w', parameters: { type: 'object' } }], maxOutputTokens: 100 },
      { signal: new AbortController().signal },
    ))
      events.push(e)
    expect(events.map((e) => e.type)).toEqual(['reasoning_delta', 'text_delta', 'tool_call_delta', 'tool_call_delta', 'usage', 'done'])
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'tool_calls' })
    expect(events[4]).toEqual({ type: 'usage', usage: { inputTokens: 50, outputTokens: 9, cachedInputTokens: 20 } })
    expect(bodies[0]).toMatchObject({
      model: 'deepseek-chat',
      stream: true,
      max_tokens: 100,
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'weather' } }],
    })
  })

  it('maps HTTP errors to LeoError codes', async () => {
    const make = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      new OpenAICompatibleProvider({
        baseURL: 'https://x.test/v1',
        fetch: (async () => new Response(JSON.stringify(body), { status, headers })) as unknown as typeof fetch,
      })
    const run = async (p: OpenAICompatibleProvider) => {
      try {
        for await (const _ of p.stream({ model: 'm', messages: [] }, { signal: new AbortController().signal })) {
        }
      } catch (e) {
        return e as LeoError
      }
      throw new Error('expected failure')
    }
    const rl = await run(make(429, { error: { message: 'slow' } }, { 'retry-after': '2' }))
    expect(rl.code).toBe('rate_limit')
    expect(rl.retryAfterMs).toBe(2000)
    expect((await run(make(429, { error: { message: 'no money', code: 'insufficient_quota' } }))).code).toBe('auth')
    expect((await run(make(401, { error: { message: 'bad key' } }))).code).toBe('auth')
    expect((await run(make(503, { error: { message: 'busy' } }))).code).toBe('overloaded')
    expect((await run(make(400, { error: { message: "This model's maximum context length is 8192 tokens" } }))).code).toBe('context_overflow')
    expect((await run(make(400, { error: { message: 'bad param' } }))).code).toBe('invalid_request')
    // 插件抛的错误带 Symbol.for('leo.error') 标记，宿主按 code 处理
    expect((rl as unknown as Record<symbol, unknown>)[Symbol.for('leo.error')]).toBe(true)
  })

  it('does not retry a 401 inside the agent loop (host recognises the marked error)', async () => {
    let calls = 0
    const p = new OpenAICompatibleProvider({
      id: 'x',
      baseURL: 'https://x.test/v1',
      fetch: (async (_u: string, init: RequestInit) => {
        if (init.method === 'POST') calls++
        return new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 })
      }) as unknown as typeof fetch,
    })
    const leo = await createLeo({ logLevel: 'silent', plugins: [providerPlugin(p, { default: true })] })
    const r = await leo.createAgent({ model: 'x/m', retry: { baseDelayMs: 1 } }).run('hi')
    expect(calls).toBe(1)
    expect(r.error?.code).toBe('auth')
    await leo.dispose()
  })

  it('applies the driver prepare hook before user providerOptions', async () => {
    const bodies: any[] = []
    const p = new OpenAICompatibleProvider({
      baseURL: 'https://x.test/v1',
      apiKey: 'k',
      prepare: (body) => ({ ...body, thinking: { type: 'enabled' }, reasoning_effort: 'high' }),
      fetch: (async (_u: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)))
        return sseResponse(['[DONE]'])
      }) as unknown as typeof fetch,
    })
    for await (const _ of p.stream({ model: 'm', messages: [], providerOptions: { reasoning_effort: 'max' } }, { signal: new AbortController().signal })) {
    }
    expect(bodies[0]).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'max' })
  })

  it('maps network failures and idle timeouts', async () => {
    const net = new OpenAICompatibleProvider({
      baseURL: 'https://x.test/v1',
      fetch: (async () => {
        throw new TypeError('fetch failed')
      }) as unknown as typeof fetch,
    })
    await expect(
      (async () => {
        for await (const _ of net.stream({ model: 'm', messages: [] }, { signal: new AbortController().signal })) {
        }
      })(),
    ).rejects.toMatchObject({ code: 'network' })

    const idle = new OpenAICompatibleProvider({
      baseURL: 'https://x.test/v1',
      idleTimeoutMs: 30,
      fetch: (async (_u: string, init: RequestInit) =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'))
              init.signal?.addEventListener('abort', () => c.error(init.signal?.reason))
            },
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    })
    await expect(
      (async () => {
        for await (const _ of idle.stream({ model: 'm', messages: [] }, { signal: new AbortController().signal })) {
        }
      })(),
    ).rejects.toMatchObject({ code: 'timeout' })
  })

  it('drives a full agent turn end-to-end against an OpenAI-compatible endpoint', async () => {
    let call = 0
    const requests: any[] = []
    const fetchMock = (async (_u: string, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)))
      call++
      if (call === 1) {
        return sseResponse([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'add', arguments: '{"a":2,"b":3}' } }] }, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ])
      }
      return sseResponse([{ choices: [{ delta: { content: '答案是 5' }, finish_reason: 'stop' }] }, '[DONE]'])
    }) as unknown as typeof fetch
    const leo = await createLeo({ logLevel: 'silent', plugins: [providerPlugin(new OpenAICompatibleProvider({ id: 'local', baseURL: 'http://x/v1', fetch: fetchMock }), { default: true })] })
    leo.ctx.get('tools').register(
      defineTool({ name: 'add', description: '加法', parameters: z.object({ a: z.number(), b: z.number() }), execute: ({ a, b }) => String(a + b) }),
    )
    const r = await leo.createAgent({ model: 'local/qwen' }).run('2+3=?')
    expect(r.text).toBe('答案是 5')
    expect(requests[0].model).toBe('qwen')
    expect(requests[0].tools[0].function.parameters).toMatchObject({ type: 'object', properties: { a: { type: 'number' } } })
    expect(requests[1].messages.slice(-2)).toEqual([
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'add', arguments: '{"a":2,"b":3}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '5' },
    ])
  })

  it('refreshes models from GET /models with generic field parsing and builtin fallback fields', async () => {
    const seen: string[] = []
    const p = new OpenAICompatibleProvider({
      id: 'x',
      baseURL: 'https://x.test/v1/',
      apiKey: 'k',
      models: [{ id: 'a', contextWindow: 8000, pricing: { inputPerMTok: 1, outputPerMTok: 2 } }, { id: 'old', contextWindow: 8000, alias: true }],
      fetch: (async (u: string, init: RequestInit) => {
        seen.push(`${init.method} ${u} ${(init.headers as Record<string, string>).authorization}`)
        return Response.json({
          object: 'list',
          data: [
            { id: 'a', owned_by: 'x', context_length: 32000, top_provider: { max_completion_tokens: 4000 }, architecture: { input_modalities: ['text', 'image'] } },
            { id: 'b', display_name: 'Model B', context_window: 64000, max_output_tokens: 8000, effort: { supported_levels: ['low', 'medium', 'high'], default_level: 'medium' } },
            { nope: true },
          ],
        })
      }) as unknown as typeof fetch,
    })
    expect(p.listModels().map((m) => m.source)).toEqual(['builtin', 'builtin'])
    const list = await p.refreshModels()
    expect(seen).toEqual(['GET https://x.test/v1/models Bearer k'])
    expect(list).toEqual([
      { id: 'a', contextWindow: 32000, maxOutputTokens: 4000, inputModalities: ['text', 'image'], pricing: { inputPerMTok: 1, outputPerMTok: 2 }, ownedBy: 'x', source: 'remote' },
      { id: 'b', name: 'Model B', contextWindow: 64000, maxOutputTokens: 8000, reasoning: { supported: true, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' }, source: 'remote' },
      { id: 'old', contextWindow: 8000, alias: true, source: 'builtin' },
    ])
    expect(p.getModelInfo('b')?.name).toBe('Model B')
    expect(parseRemoteModel({ id: 'z' })).toEqual({ id: 'z', contextWindow: 128000, source: 'remote' })
  })

  it('reports GET /models failures and skips fetching when disabled', async () => {
    let n = 0
    const bad = new OpenAICompatibleProvider({ baseURL: 'https://x.test/v1', apiKey: 'k', fetch: (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch })
    await expect(bad.refreshModels()).rejects.toMatchObject({ code: 'invalid_request' })
    const off = new OpenAICompatibleProvider({ baseURL: 'https://x.test/v1', apiKey: 'k', fetchModels: false, models: [{ id: 'm', contextWindow: 1 }], fetch: (async () => (n++, Response.json({ data: [] }))) as unknown as typeof fetch })
    expect((await off.refreshModels()).map((m) => m.id)).toEqual(['m'])
    expect(n).toBe(0)
  })

  it('sends reasoning_effort for an explicit effort on generic endpoints', async () => {
    const p = new OpenAICompatibleProvider({ baseURL: 'https://x.test/v1', apiKey: 'k', fetchModels: false })
    expect(p.buildBody({ model: 'm', messages: [], reasoning: { effort: 'low' } })).toMatchObject({ reasoning_effort: 'low' })
    expect(p.buildBody({ model: 'm', messages: [], reasoning: { enabled: false, effort: 'low' } }).reasoning_effort).toBeUndefined()
    expect(p.buildBody({ model: 'm', messages: [], reasoning: { effort: 'none' } }).reasoning_effort).toBeUndefined()
    expect(p.buildBody({ model: 'm', messages: [] }).reasoning_effort).toBeUndefined()
  })
})
