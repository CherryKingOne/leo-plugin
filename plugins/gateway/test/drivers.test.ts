/**
 * 0.2.0 注册层：插件驱动顶替同 id 的内置驱动（两种加载顺序）、撤销后恢复内置驱动、
 * 驱动汇报 waiting_bind（绑定链接）、restart 立即返回、rebind 透传给驱动。
 */
import { type Context, createLeo, type PluginLike } from 'leo-agents'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import plugin, { type ChannelDriver, type ChannelInit, createGatewayPlugin, type GatewayService } from '../src/index.js'

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition')
    await tick(10)
  }
}

/** 记录内置 qq 驱动发出的请求：拿 token 直接失败，账号进入 failed（说明确实是内置驱动在跑） */
function builtinQqFetch() {
  const calls: string[] = []
  const impl = (async (input: string | URL) => {
    calls.push(String(input))
    return new Response(JSON.stringify({ code: 100, message: 'builtin says no' }), { status: 401 })
  }) as typeof fetch
  return { impl, calls }
}

/** 插件提供的 qq 驱动 */
function externalQq(name = 'QQ（插件）') {
  const created: ChannelInit<unknown>[] = []
  let stopped = 0
  const driver: ChannelDriver<{ appId?: string }> = {
    id: 'qq',
    name,
    options: z.object({ appId: z.string().optional() }).passthrough(),
    receive: 'websocket',
    create(init) {
      created.push(init as ChannelInit<unknown>)
      return {
        send: async () => ({ messageIds: ['x'] }),
        stop: () => void stopped++,
      }
    },
  }
  return { driver, created, stopped: () => stopped }
}

/** 一个依赖 gateway 服务、注册驱动的“子插件” */
function channelPlugin(driver: ChannelDriver, name = 'test-qq-plugin'): PluginLike {
  return {
    name,
    inject: ['gateway'],
    async apply(ctx: Context<any>) {
      await ctx.effect(() => ctx.get('gateway').registerChannel(driver))
    },
  } as PluginLike
}

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
})

const accounts = { q: { channel: 'qq', appId: '1', appSecret: 's' } }
const gwConfig = (extra: Record<string, unknown> = {}) => ({ server: { enabled: false }, channels: accounts, loadConfigFiles: false, ...extra })

describe('驱动顶替与恢复', () => {
  it('网关先加载：内置 qq 先跑，插件驱动注册后顶替；撤销插件后恢复内置驱动', async () => {
    const f = builtinQqFetch()
    const notices: string[] = []
    const listener = { name: 'n', apply: (c: Context<any>) => void c.on('plugin/notice' as never, ((n: { message: string }) => void notices.push(n.message)) as never) } as PluginLike
    const leo = await createLeo({ logLevel: 'silent', plugins: [listener, [createGatewayPlugin({ fetch: f.impl }), gwConfig()]] })
    cleanup.push(() => leo.dispose())
    const gw = leo.ctx.get('gateway') as GatewayService
    await until(() => gw.accounts()[0]!.state === 'failed')
    expect(gw.accounts()[0]!.error).toMatch(/builtin says no/)
    expect(gw.channels().find((c) => c.id === 'qq')).toMatchObject({ builtin: true })

    const ext = externalQq()
    const rt = await leo.plugin(channelPlugin(ext.driver))
    await until(() => gw.accounts()[0]!.state === 'running')
    expect(ext.created).toHaveLength(1)
    expect(gw.channels().find((c) => c.id === 'qq')).toMatchObject({ name: 'QQ（插件）', builtin: false, overridesBuiltin: true })
    expect(gw.channels().filter((c) => c.id === 'qq')).toHaveLength(1)
    expect(notices.some((n) => n.includes('渠道 qq 改用插件提供的驱动 QQ（插件）（qq）'))).toBe(true)

    const before = f.calls.length
    await rt.dispose()
    await until(() => gw.accounts()[0]!.state === 'failed')
    expect(ext.stopped()).toBe(1)
    expect(f.calls.length).toBeGreaterThan(before)
    expect(gw.channels().find((c) => c.id === 'qq')).toMatchObject({ builtin: true })
    expect(notices.some((n) => n.includes('恢复使用内置驱动'))).toBe(true)
  })

  it('子插件先加载（等待 gateway 服务）：内置 qq 从未启动；网关热重载后插件驱动自动重新注册', async () => {
    const f = builtinQqFetch()
    const ext = externalQq()
    const leo = await createLeo({ logLevel: 'silent', plugins: [channelPlugin(ext.driver), [createGatewayPlugin({ fetch: f.impl }), gwConfig()]] })
    cleanup.push(() => leo.dispose())
    let gw = leo.ctx.get('gateway') as GatewayService
    await until(() => gw.accounts()[0]?.state === 'running')
    await tick(50)
    expect(f.calls.filter((u) => u.includes('getAppAccessToken'))).toHaveLength(0)
    expect(gw.channels().find((c) => c.id === 'qq')).toMatchObject({ builtin: false, overridesBuiltin: true })

    // 网关卸载再加载（gateway.json 热重载时宿主就是这么做的）
    const gwRt = leo.kernel.plugins.find((p) => p.name === 'leo-plugin-gateway')!
    await gwRt.dispose()
    await leo.plugin(createGatewayPlugin({ fetch: f.impl }), gwConfig())
    gw = leo.ctx.get('gateway') as GatewayService
    await until(() => gw.accounts()[0]?.state === 'running')
    expect(ext.created).toHaveLength(2)
    expect(f.calls.filter((u) => u.includes('getAppAccessToken'))).toHaveLength(0)
  })

  it('builtin 去掉 qq：只用插件驱动；没有插件时账号等待驱动', async () => {
    const leo = await createLeo({ logLevel: 'silent', plugins: [[plugin, gwConfig({ builtin: ['telegram', 'feishu'] })]] })
    cleanup.push(() => leo.dispose())
    const gw = leo.ctx.get('gateway') as GatewayService
    await tick()
    expect(gw.accounts()[0]!.state).toBe('waiting_driver')
    const ext = externalQq()
    const rt = await leo.plugin(channelPlugin(ext.driver))
    await until(() => gw.accounts()[0]!.state === 'running')
    expect(gw.channels().find((c) => c.id === 'qq')).toMatchObject({ builtin: false })
    expect(gw.channels().find((c) => c.id === 'qq')!.overridesBuiltin).toBeUndefined()
    await rt.dispose()
    await until(() => gw.accounts()[0]!.state === 'waiting_driver')
  })

  it('两个插件注册同一 id：后者报错', async () => {
    const leo = await createLeo({ logLevel: 'silent', plugins: [[plugin, gwConfig({ builtin: [] })]] })
    cleanup.push(() => leo.dispose())
    const gw = leo.ctx.get('gateway') as GatewayService
    gw.registerChannel(externalQq().driver)
    expect(() => gw.registerChannel(externalQq().driver)).toThrow(/already registered/)
  })
})

describe('等待绑定（waiting_bind）', () => {
  /** 没有 appId 时汇报绑定链接并一直等，直到 signal 取消或测试调用 bind() */
  function bindingDriver() {
    const inits: ChannelInit<{ appId?: string }>[] = []
    const resolvers: (() => void)[] = []
    const driver: ChannelDriver<{ appId?: string }> = {
      id: 'binder',
      name: 'Binder',
      options: z.object({ appId: z.string().optional() }),
      async create(init) {
        inits.push(init)
        if (!init.options.appId || init.rebind) {
          let n = 0
          await new Promise<void>((resolve, reject) => {
            const show = () => init.report({ state: 'waiting_bind', bindUrl: `https://bind.example/${inits.length}-${++n}`, detail: '扫码' })
            show()
            resolvers.push(() => {
              init.report()
              resolve()
            })
            // 模拟二维码过期刷新
            ;(init as unknown as { refresh?: () => void }).refresh = show
            init.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
          })
          init.notify('绑定成功')
        }
        return { send: async () => ({ messageIds: [] }) }
      },
    }
    return { driver, inits, bind: () => resolvers.shift()!() }
  }

  it('状态带 bindUrl，提示里给出链接；过期刷新再提示；扫码后进入 running', async () => {
    const notices: { message: string; level?: string }[] = []
    const listener = { name: 'n', apply: (c: Context<any>) => void c.on('plugin/notice' as never, ((n: { message: string; level?: string }) => void notices.push(n)) as never) } as PluginLike
    const port = 0
    const leo = await createLeo({ logLevel: 'silent', plugins: [listener, [plugin, { loadConfigFiles: false, server: { port }, builtin: [], channels: { b: { channel: 'binder' } } }]] })
    cleanup.push(() => leo.dispose())
    const gw = leo.ctx.get('gateway') as GatewayService
    const d = bindingDriver()
    gw.registerChannel(d.driver)
    await until(() => gw.accounts()[0]!.state === 'waiting_bind')
    expect(gw.accounts()[0]).toMatchObject({ state: 'waiting_bind', bindUrl: 'https://bind.example/1-1', detail: '扫码' })
    const base = `http://127.0.0.1:${gw.address()!.port}`
    const ch = (await (await fetch(`${base}/v1/channels`)).json()) as { accounts: unknown[] }
    expect(ch.accounts[0]).toMatchObject({ state: 'waiting_bind', bindUrl: 'https://bind.example/1-1' })
    expect(notices.some((n) => n.message === 'b（binder） 等待绑定：扫码 https://bind.example/1-1' && n.level === 'warn')).toBe(true)
    ;(d.inits[0] as unknown as { refresh: () => void }).refresh()
    await until(() => notices.some((n) => n.message.endsWith('https://bind.example/1-2')))
    d.bind()
    await until(() => gw.accounts()[0]!.state === 'running')
    expect(gw.accounts()[0]!.bindUrl).toBeUndefined()
    expect(notices.some((n) => n.message === 'b（binder）：绑定成功')).toBe(true)
    expect(notices.some((n) => n.message === '已连接 b（binder）')).toBe(true)
  })

  it('restart 在进入 waiting_bind 时立即返回；rebind 透传；卸载时取消等待中的绑定', async () => {
    const leo = await createLeo({ logLevel: 'silent', plugins: [[plugin, { loadConfigFiles: false, server: { port: 0 }, builtin: [], channels: { b: { channel: 'binder', appId: 'A' } } }]] })
    cleanup.push(() => leo.dispose())
    const gw = leo.ctx.get('gateway') as GatewayService
    const d = bindingDriver()
    gw.registerChannel(d.driver)
    await until(() => gw.accounts()[0]!.state === 'running')
    expect(d.inits[0]!.rebind).toBe(false)

    // HTTP：POST /v1/channels/b/restart {"rebind":true}
    const base = `http://127.0.0.1:${gw.address()!.port}`
    const r = (await (await fetch(`${base}/v1/channels/b/restart`, { method: 'POST', body: JSON.stringify({ rebind: true }) })).json()) as Record<string, unknown>
    expect(r).toMatchObject({ account: 'b', state: 'waiting_bind', bindUrl: 'https://bind.example/2-1' })
    expect(d.inits[1]!.rebind).toBe(true)

    // 等待中再次 restart（不带 rebind）：打断旧的绑定，不会排队卡死
    const r2 = await gw.restartAccount('b')
    expect(r2.state).toBe('running')
    expect(d.inits[1]!.signal.aborted).toBe(true)
    expect(d.inits[2]!.rebind).toBe(false)

    await gw.restartAccount('b', { rebind: true })
    const pending = d.inits[3]!
    expect(gw.accounts()[0]!.state).toBe('waiting_bind')
    const rt = leo.kernel.plugins.find((p) => p.name === 'leo-plugin-gateway')!
    await rt.dispose()
    expect(pending.signal.aborted).toBe(true)
  })
})
