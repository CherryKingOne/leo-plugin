import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLeoFromConfig, type PluginDefinition } from 'leo-agents'
import { describe, expect, it } from 'vitest'
import { createProviderPlugin } from '../src/index.js'
import type { ProviderDriver, ProviderRegistryService } from '../src/types.js'

function sse(text: string) {
  const body = `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** 记录请求的假端点 */
function endpoint() {
  const calls: { url: string; auth?: string; body: any }[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    const h = init.headers as Record<string, string>
    calls.push({ url, ...(h.authorization ? { auth: h.authorization } : {}), body: JSON.parse(String(init.body)) })
    return sse('pong')
  }) as unknown as typeof globalThis.fetch
  return { calls, fetch }
}

async function project(files: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'leo-prov-'))
  const home = await mkdtemp(join(tmpdir(), 'leo-prov-home-'))
  await mkdir(join(root, '.leo'), { recursive: true })
  for (const [name, data] of Object.entries(files)) await writeFile(join(root, '.leo', name), name === 'credentials.json' ? JSON.stringify(data) : `// jsonc\n${JSON.stringify(data)}`)
  return { root, home }
}

/** 模拟一个子插件：注册驱动 */
const driverPlugin = (driver: ProviderDriver): PluginDefinition => ({
  name: `test-driver-${driver.id}`,
  inject: ['providers' as never],
  apply: async (ctx) => {
    await ctx.effect(() => (ctx.get('providers' as never) as unknown as ProviderRegistryService).registerDriver(driver))
  },
})

const fakeDriver: ProviderDriver = {
  id: 'fake',
  name: 'Fake AI',
  plugin: 'provider-fake',
  baseURL: 'https://fake.test/v1',
  envKeys: ['FAKE_API_KEY'],
  defaultModel: 'fm',
  models: [{ id: 'fm', contextWindow: 1_000_000 }],
  prepare: (body) => ({ ...body, vendor_flag: true }),
}

const notices = () => {
  const list: { message: string; level?: string }[] = []
  return { list, onNotice: (n: { message: string; level?: string }) => list.push(n) }
}

describe('provider registry', () => {
  it('connects a generic OpenAI-compatible endpoint from provider.json without any driver', async () => {
    const ep = endpoint()
    const { root, home } = await project({ 'provider.json': { providers: { vllm: { baseURL: 'http://gpu.test/v1', keyless: true, models: ['qwen3'] } } } })
    const app = await createLeoFromConfig({ cwd: root, userDir: home, env: {}, overrides: { tools: { builtin: false } }, plugins: [createProviderPlugin({ fetch: ep.fetch })] })
    expect(app.model).toBe('vllm/qwen3')
    expect(app.providers).toMatchObject([{ id: 'vllm', loaded: true, baseURL: 'http://gpu.test/v1', default: true }])
    expect((await app.createAgent({ tools: false }).run('ping')).text).toBe('pong')
    expect(ep.calls[0]).toMatchObject({ url: 'http://gpu.test/v1/chat/completions', auth: 'Bearer local', body: { model: 'qwen3' } })
    await app.dispose()
  })

  it('auto-detects a registered driver once its key is saved, and uses the driver defaults + prepare hook', async () => {
    const ep = endpoint()
    const { root, home } = await project({ 'credentials.json': { fake: 'sk-fake' } })
    const n = notices()
    const app = await createLeoFromConfig({
      cwd: root,
      userDir: home,
      env: {},
      overrides: { tools: { builtin: false } },
      onNotice: n.onNotice,
      plugins: [createProviderPlugin({ fetch: ep.fetch }), driverPlugin(fakeDriver)],
    })
    expect(app.model).toBe('fake/fm')
    expect(app.providers[0]).toMatchObject({ id: 'fake', name: 'Fake AI', via: 'provider-fake', loaded: true, credential: { configured: true, source: 'project' } })
    await app.createAgent({ tools: false }).run('ping')
    expect(ep.calls[0]).toMatchObject({ url: 'https://fake.test/v1/chat/completions', auth: 'Bearer sk-fake', body: { model: 'fm', vendor_flag: true } })
    await new Promise((r) => setTimeout(r, 250))
    expect(n.list).toEqual([{ plugin: 'provider', message: '已接入：fake（默认） fm' }])
    await app.dispose()
  })

  it('lists an installed driver without key as not ready (autoDetect), and connects a keyless generic endpoint as default', async () => {
    const { root, home } = await project({ 'provider.json': { providers: { local: { baseURL: 'http://l.test/v1', keyless: true, models: ['q'] } } } })
    const app = await createLeoFromConfig({ cwd: root, userDir: home, env: {}, overrides: { tools: { builtin: false } }, plugins: [createProviderPlugin(), driverPlugin(fakeDriver)] })
    expect(app.providers.map((p) => [p.id, p.loaded, p.default])).toEqual([
      ['local', true, true],
      ['fake', false, false],
    ])
    expect(app.model).toBe('local/q')
    await app.dispose()
  })

  it('registers a configured driver without key as not ready (no default model), with a hint', async () => {
    const { root, home } = await project({ 'provider.json': { providers: { fake: {} } } })
    const app = await createLeoFromConfig({ cwd: root, userDir: home, env: {}, overrides: { tools: { builtin: false } }, plugins: [createProviderPlugin(), driverPlugin(fakeDriver)] })
    expect(app.model).toBeUndefined()
    expect(app.providers[0]).toMatchObject({ id: 'fake', loaded: false })
    expect(app.providers[0]!.reason).toMatch(/leo auth set fake/)
    const reg = app.leo.ctx.get('providers' as never) as unknown as ProviderRegistryService
    expect(reg.status()[0]).toMatchObject({ id: 'fake', state: 'no_key', driver: 'fake' })
    await app.dispose()
  })

  it('keeps 0.1.x config working: providers + model in .leo/config.json', async () => {
    const ep = endpoint()
    const { root, home } = await project({
      'config.json': { model: 'local/m2', providers: { local: { baseURL: 'http://local.test/v1', models: ['m1', 'm2'] } } },
      'credentials.json': { local: 'sk-local' },
    })
    const app = await createLeoFromConfig({ cwd: root, userDir: home, env: {}, overrides: { tools: { builtin: false } }, plugins: [createProviderPlugin({ fetch: ep.fetch })] })
    expect(app.model).toBe('local/m2')
    await app.createAgent({ tools: false }).run('ping')
    expect(ep.calls[0]).toMatchObject({ auth: 'Bearer sk-local', body: { model: 'm2' } })
    await app.dispose()
  })

  it('waits for a missing driver and picks it up when the sub-plugin loads later, then drops it on unload', async () => {
    const { root, home } = await project({ 'provider.json': { providers: { fake: {} } }, 'credentials.json': { fake: 'k' } })
    const n = notices()
    const app = await createLeoFromConfig({ cwd: root, userDir: home, env: {}, overrides: { tools: { builtin: false } }, onNotice: n.onNotice, plugins: [createProviderPlugin()] })
    const reg = () => app.leo.ctx.get('providers' as never) as unknown as ProviderRegistryService
    expect(reg().status()[0]).toMatchObject({ id: 'fake', state: 'waiting_driver' })
    await new Promise((r) => setTimeout(r, 250))
    expect(n.list.some((x) => x.level === 'warn' && x.message.includes('leo plugin add provider-fake'))).toBe(true)
    expect(app.model).toBeUndefined()

    const rt = await app.leo.plugin(driverPlugin(fakeDriver))
    await Promise.resolve()
    expect(app.model).toBe('fake/fm')
    expect(reg().status()[0]).toMatchObject({ state: 'ready' })

    await rt.dispose()
    await Promise.resolve()
    expect(app.model).toBeUndefined()
    expect(app.providers).toEqual([])
    await app.dispose()
  })

  it('lets a second account reuse a driver, and honours default / host model', async () => {
    const { root, home } = await project({
      'config.json': { model: 'work/fm' },
      'provider.json': { providers: { fake: {}, work: { driver: 'fake' } } },
      'credentials.json': { fake: 'a', work: 'b' },
    })
    const app = await createLeoFromConfig({ cwd: root, userDir: home, env: {}, overrides: { tools: { builtin: false } }, plugins: [createProviderPlugin(), driverPlugin(fakeDriver)] })
    expect(app.providers.map((p) => [p.id, p.default, p.loaded])).toEqual([
      ['work', true, true],
      ['fake', false, true],
    ])
    expect(app.model).toBe('work/fm')
    await app.dispose()
  })

  it('rejects an invalid provider.json loudly', async () => {
    const { root, home } = await project({ 'provider.json': { providers: { bad: { baseURL: 'not a url' } } } })
    const app = await createLeoFromConfig({ cwd: root, userDir: home, env: {}, overrides: { tools: { builtin: false } }, plugins: [createProviderPlugin()] }).catch((e: Error) => e)
    expect(String(app)).toMatch(/provider: invalid configuration.*providers\.bad\.baseURL/)
  })
})
