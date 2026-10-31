/**
 * 注册层：驱动表 + 协议表 + provider 配置 → 注册到 leo 的 `llm` 服务。
 *
 * 任何变化（驱动注册 / 撤销、协议注册 / 撤销）都会整体重新同步：先撤销本插件注册过的全部 provider，
 * 再按当前的驱动与配置重新注册。所以子插件先装、后装、热重载都得到同样的结果。
 */
import type { CredentialService, Disposer, LlmProvider, LlmService, ModelInfo, ProviderStatusInfo } from 'leo-agents'
import type { ProviderConfig, ProviderSettingsParsed } from './config.js'
import { OpenAICompatibleProvider } from './openai.js'
import type {
  DriverInfo,
  DriverInput,
  ProviderDriver,
  ProviderEntryStatus,
  ProviderProtocol,
  ProviderRegistryService,
  ProviderSettings,
  ResolvedProvider,
} from './types.js'

export const OPENAI_COMPATIBLE = 'openai-compatible'

export interface RegistryDeps {
  llm: () => LlmService
  credentials: () => CredentialService | undefined
  config: ProviderConfig
  /** 宿主 .leo/config.json 的 model（优先于 provider.json 的 model） */
  hostModel?: string
  logger?: { warn(o: unknown, msg?: string): void; debug(o: unknown, msg?: string): void }
  /** 状态变化时给用户的一行提示 */
  notify?(message: string, level?: 'info' | 'warn' | 'error'): void
  /** 提示合并的等待时间（毫秒），默认 200 */
  noticeDelayMs?: number
  /** 测试用 */
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
}

export interface ProviderRegistry extends ProviderRegistryService {
  /** 立即同步（平时由注册 / 撤销自动触发，合并到一个微任务里） */
  sync(): void
  dispose(): void
}

/** 字符串模型 → ModelInfo（上下文窗口未知时按 128K） */
export function normalizeModels(models: ProviderSettings['models'], fallback: ModelInfo[] = []): ModelInfo[] {
  if (!models?.length) return fallback
  const byId = new Map(fallback.map((m) => [m.id, m]))
  return models.map((m) => (typeof m === 'string' ? (byId.get(m) ?? { id: m, contextWindow: 128_000 }) : m))
}

const splitModel = (m: string | undefined): [string, string] | undefined => {
  if (!m) return undefined
  const i = m.indexOf('/')
  return i > 0 ? [m.slice(0, i), m.slice(i + 1)] : undefined
}

/** 内置协议：OpenAI Chat Completions 兼容 */
export function openaiCompatibleProtocol(fetchImpl?: typeof fetch): ProviderProtocol {
  return ({ id, resolved, apiKey }) => {
    if (!resolved.baseURL) throw new Error(`provider "${id}" needs a baseURL`)
    return new OpenAICompatibleProvider({
      id,
      name: resolved.name,
      baseURL: resolved.baseURL,
      apiKey: () => apiKey() ?? (resolved.keyless ? 'local' : undefined),
      requireApiKey: !resolved.keyless,
      ...(resolved.envKeys[0] ? { apiKeyEnv: resolved.envKeys[0] } : {}),
      ...(resolved.defaultModel ? { defaultModel: resolved.defaultModel } : {}),
      ...(resolved.headers ? { headers: resolved.headers } : {}),
      ...(resolved.models.length ? { models: resolved.models } : {}),
      ...(resolved.maxTokensField ? { maxTokensField: resolved.maxTokensField } : {}),
      ...(resolved.sendReasoning !== undefined ? { sendReasoning: resolved.sendReasoning } : {}),
      ...(resolved.connectTimeoutMs ? { connectTimeoutMs: resolved.connectTimeoutMs } : {}),
      ...(resolved.idleTimeoutMs ? { idleTimeoutMs: resolved.idleTimeoutMs } : {}),
      ...(resolved.prepare ? { prepare: resolved.prepare } : {}),
      fetchModels: resolved.fetchModels,
      ...(resolved.mapModel ? { mapModel: resolved.mapModel } : {}),
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    })
  }
}

interface Entry {
  id: string
  settings: ProviderSettings
  /** 自动探测出来的（配置里没写） */
  detected: boolean
}

export function createProviderRegistry(deps: RegistryDeps): ProviderRegistry {
  const drivers = new Map<string, ProviderDriver>()
  const protocols = new Map<string, ProviderProtocol>([[OPENAI_COMPATIBLE, openaiCompatibleProtocol(deps.fetch)]])
  let registrations: Disposer[] = []
  let statuses: Omit<ProviderEntryStatus, 'state' | 'reason'>[] = []
  /** 每个 provider 的“动态”状态（密钥可能随时 leo auth set 进来） */
  const live = new Map<string, () => Pick<ProviderEntryStatus, 'state' | 'reason'>>()
  let scheduled = false
  let disposed = false
  let lastSummary = ''
  let noticeTimer: ReturnType<typeof setTimeout> | undefined

  const env = deps.env ?? process.env
  const describeKey = (id: string, settings: ProviderSettings, envKeys: string[]) => {
    const lookup = { id, ...(settings.apiKey ? { configured: settings.apiKey } : {}), envKeys }
    const creds = deps.credentials()
    if (creds) {
      try {
        return { desc: creds.describe(lookup), get: () => creds.get(lookup) }
      } catch (err) {
        return { desc: { configured: false, masked: `(error: ${(err as Error).message})` }, get: () => creds.get(lookup) }
      }
    }
    // 没有 credentials 服务（代码里 createLeo 直接用）：只看环境变量
    const get = () => envKeys.map((k) => env[k]).find(Boolean)
    const v = get()
    return { desc: { configured: Boolean(v), masked: v ? `${v.slice(0, 3)}…${v.slice(-4)}` : '(not set)', ...(v ? { source: 'env' } : {}) }, get }
  }

  const envKeysOf = (settings: ProviderSettings, driver?: ProviderDriver) => [
    ...new Set([...(settings.apiKeyEnv ? [settings.apiKeyEnv] : []), ...(driver?.envKeys ?? [])]),
  ]

  /** 配置里写的 + 自动探测到的 provider */
  const entries = (): Entry[] => {
    const out: Entry[] = Object.entries(deps.config.providers).map(([id, s]) => ({ id, settings: toSettings(s), detected: false }))
    if (deps.config.autoDetect) {
      // 装了驱动就接入：有密钥即可用；没密钥也列出来（leo models / doctor 能看到缺什么），但不会被选作默认
      for (const d of drivers.values()) {
        if (out.some((e) => e.id === d.id || (e.settings.driver ?? e.id) === d.id)) continue
        out.push({ id: d.id, settings: { enabled: true }, detected: true })
      }
    }
    return out
  }

  const resolveEntry = (e: Entry, driver: ProviderDriver | undefined, defaultModelOverride?: string): ResolvedProvider => {
    const s = e.settings
    const models = normalizeModels(s.models, driver?.models ?? [])
    const firstModel = s.models?.[0]
    const defaultModel =
      defaultModelOverride ?? s.defaultModel ?? (typeof firstModel === 'string' ? firstModel : firstModel?.id) ?? driver?.defaultModel
    const baseURL = s.baseURL ?? driver?.baseURL
    const headers = driver?.headers || s.headers ? { ...driver?.headers, ...s.headers } : undefined
    const maxTokensField = s.maxTokensField ?? driver?.maxTokensField
    const sendReasoning = s.sendReasoning ?? driver?.sendReasoning
    const prepare = driver?.prepare
    const mapModel = driver?.mapModel
    return {
      id: e.id,
      name: driver?.name ?? e.id,
      ...(baseURL ? { baseURL } : {}),
      envKeys: envKeysOf(s, driver),
      ...(defaultModel ? { defaultModel } : {}),
      models,
      keyless: s.keyless ?? driver?.keyless ?? false,
      ...(maxTokensField ? { maxTokensField } : {}),
      ...(sendReasoning !== undefined ? { sendReasoning } : {}),
      ...(headers ? { headers } : {}),
      ...(s.connectTimeoutMs ? { connectTimeoutMs: s.connectTimeoutMs } : {}),
      ...(s.idleTimeoutMs ? { idleTimeoutMs: s.idleTimeoutMs } : {}),
      ...(prepare ? { prepare: (body, request, model) => prepare.call(driver, body, { request, settings: s, ...(model ? { model } : {}) }) } : {}),
      fetchModels: s.fetchModels ?? driver?.fetchModels ?? true,
      ...(mapModel ? { mapModel: (raw, builtin) => mapModel.call(driver, raw, builtin) } : {}),
      via: driver ? (driver.plugin ?? `driver ${driver.id}`) : `provider（通用 ${OPENAI_COMPATIBLE}）`,
    }
  }

  const clear = () => {
    for (const d of registrations.reverse()) {
      try {
        d()
      } catch {}
    }
    registrations = []
  }

  const sync = () => {
    scheduled = false
    if (disposed) return
    clear()
    live.clear()
    statuses = []
    if (!deps.config.enabled) return report()

    const target = splitModel(deps.hostModel) ?? splitModel(deps.config.model)
    const list = entries()
    const explicitDefault = list.find((e) => e.settings.default)?.id
    const defaultId = target && list.some((e) => e.id === target[0]) ? target[0] : explicitDefault
    const built: { provider: LlmProvider; ready: boolean; id: string }[] = []

    for (const e of list) {
      const s = e.settings
      const driverId = s.driver ?? e.id
      const driver = drivers.get(driverId)
      const base = { id: e.id, ...(driver ? { driver: driver.id } : {}), name: driver?.name ?? e.id, default: e.id === defaultId }
      if (!s.enabled) {
        statuses.push(base)
        live.set(e.id, () => ({ state: 'disabled', reason: 'enabled=false' }))
        continue
      }
      const protocolName = s.protocol ?? (typeof s.type === 'string' ? s.type : undefined) ?? driver?.protocol ?? OPENAI_COMPATIBLE
      if (!driver && !s.baseURL && protocolName === OPENAI_COMPATIBLE) {
        statuses.push(base)
        const reason = `缺少驱动 ${driverId}：运行 leo plugin add provider-${driverId}（或在 provider.json 的 providers.${e.id} 里写 baseURL，当作通用 OpenAI 兼容端点）`
        live.set(e.id, () => ({ state: 'waiting_driver', reason }))
        continue
      }
      const resolved = resolveEntry(e, driver, target && target[0] === e.id ? target[1] : undefined)
      const key = describeKey(e.id, s, resolved.envKeys)
      const input: DriverInput = { id: e.id, settings: s, apiKey: () => describeKey(e.id, s, resolved.envKeys).get(), resolved }
      const status = (): ProviderStatusInfo => {
        const k = describeKey(e.id, s, resolved.envKeys).desc
        const ready = resolved.keyless || k.configured
        return {
          ready,
          ...(ready ? {} : { reason: `no API key（leo auth set ${e.id}${resolved.envKeys[0] ? ` 或 export ${resolved.envKeys[0]}` : ''}）` }),
          ...(resolved.baseURL ? { baseURL: resolved.baseURL } : {}),
          credential: k,
          via: resolved.via,
        }
      }
      let provider: LlmProvider
      try {
        if (driver?.create) provider = driver.create(input)
        else {
          const protocol = protocols.get(protocolName)
          if (!protocol) {
            statuses.push({ ...base, ...(resolved.baseURL ? { baseURL: resolved.baseURL } : {}) })
            const reason = `协议 ${protocolName} 未注册（已注册：${[...protocols.keys()].join(', ')}）`
            live.set(e.id, () => ({ state: 'waiting_driver', reason }))
            continue
          }
          provider = protocol(input)
        }
      } catch (err) {
        statuses.push(base)
        const reason = (err as Error).message
        live.set(e.id, () => ({ state: 'error', reason }))
        continue
      }
      const wrapped = decorate(provider, e.id, resolved, status)
      built.push({ provider: wrapped, ready: key.desc.configured || resolved.keyless, id: e.id })
      statuses.push({
        ...base,
        name: resolved.name,
        ...(resolved.baseURL ? { baseURL: resolved.baseURL } : {}),
        ...(resolved.defaultModel ? { defaultModel: resolved.defaultModel } : {}),
        via: resolved.via,
      })
      live.set(e.id, () => {
        const st = status()
        return st.ready ? { state: 'ready' } : { state: 'no_key', ...(st.reason ? { reason: st.reason } : {}) }
      })
    }

    // 可用的先注册：没有显式默认时，llm 服务把第一个注册的当默认
    built.sort((a, b) => Number(b.id === defaultId) - Number(a.id === defaultId) || Number(b.ready) - Number(a.ready))
    const effectiveDefault = defaultId ?? built[0]?.id
    statuses = statuses.map((st) => ({ ...st, default: st.id === effectiveDefault }))
    const llm = deps.llm()
    for (const b of built) {
      try {
        registrations.push(llm.registerProvider(b.provider, b.id === defaultId ? { default: true } : {}))
      } catch (err) {
        // 例如别的插件已经注册了同 id 的 provider
        const reason = (err as Error).message
        live.set(b.id, () => ({ state: 'error', reason }))
      }
    }
    report()
  }

  const status = (): ProviderEntryStatus[] =>
    statuses.map((s) => {
      const l = live.get(s.id)?.() ?? { state: 'error' as const, reason: 'unknown' }
      return { ...s, state: l.state, ...(l.reason ? { reason: l.reason } : {}) }
    })

  const report = () => {
    const st = status()
    const ready = st.filter((s) => s.state === 'ready')
    const lines: [string, 'info' | 'warn'][] = []
    if (ready.length) lines.push([`已接入：${ready.map((s) => `${s.id}${s.default ? '（默认）' : ''}${s.defaultModel ? ` ${s.defaultModel}` : ''}`).join('、')}`, 'info'])
    for (const s of st) if (s.state !== 'ready' && s.state !== 'disabled') lines.push([`${s.id}：${s.reason ?? s.state}`, 'warn'])
    if (!st.length && deps.config.enabled) {
      lines.push([drivers.size ? `还没有可用的模型：leo auth set ${[...drivers.keys()][0]} 保存密钥后自动接入` : '还没有模型驱动：leo plugin add provider-deepseek，或在 provider.json 里配置 OpenAI 兼容端点', 'warn'])
    }
    // 启动时子插件陆续注册驱动，会连续同步几次：提示合并到最后一次，只说结果
    clearTimeout(noticeTimer)
    noticeTimer = setTimeout(() => {
      if (disposed) return
      const summary = JSON.stringify(lines)
      if (summary === lastSummary) return
      lastSummary = summary
      for (const [m, level] of lines) deps.notify?.(m, level)
    }, deps.noticeDelayMs ?? 200)
    noticeTimer.unref?.()
  }

  const schedule = () => {
    if (scheduled || disposed) return
    scheduled = true
    queueMicrotask(sync)
  }

  return {
    registerDriver(driver) {
      if (!driver?.id || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(driver.id)) throw new Error(`invalid provider driver id: ${String(driver?.id)}`)
      if (drivers.has(driver.id)) throw new Error(`provider driver "${driver.id}" is already registered`)
      drivers.set(driver.id, driver)
      schedule()
      return () => {
        if (drivers.get(driver.id) !== driver) return
        drivers.delete(driver.id)
        schedule()
      }
    },
    registerProtocol(name, protocol) {
      if (protocols.has(name)) throw new Error(`provider protocol "${name}" is already registered`)
      protocols.set(name, protocol)
      schedule()
      return () => {
        if (protocols.get(name) !== protocol) return
        protocols.delete(name)
        schedule()
      }
    },
    drivers: (): DriverInfo[] =>
      [...drivers.values()].map((d) => ({ id: d.id, name: d.name, ...(d.plugin ? { plugin: d.plugin } : {}), ...(d.defaultModel ? { defaultModel: d.defaultModel } : {}) })),
    protocols: () => [...protocols.keys()],
    status,
    sync,
    dispose() {
      disposed = true
      clearTimeout(noticeTimer)
      clear()
    },
  }
}

function toSettings(s: ProviderSettingsParsed): ProviderSettings {
  return s as ProviderSettings
}

/** 给任意 LlmProvider 补上 name / defaultModel / listModels / status（不改原对象） */
function decorate(p: LlmProvider, id: string, r: ResolvedProvider, status: () => ProviderStatusInfo): LlmProvider {
  const info = (model: string) => p.getModelInfo?.(model) ?? r.models.find((m) => m.id === model)
  const defaultModel = r.defaultModel ?? p.defaultModel
  return {
    id,
    name: p.name && p.name !== id ? p.name : r.name,
    ...(defaultModel ? { defaultModel } : {}),
    stream: (req, opts) => p.stream(req, opts),
    ...(p.countTokens ? { countTokens: (req: Parameters<NonNullable<LlmProvider['countTokens']>>[0]) => p.countTokens!(req) } : {}),
    getModelInfo: info,
    listModels: () => (p.listModels?.().length ? p.listModels() : r.models),
    ...(p.refreshModels ? { refreshModels: (o?: { signal?: AbortSignal }) => p.refreshModels!(o) } : {}),
    status: () => {
      const own = p instanceof OpenAICompatibleProvider ? undefined : p.status?.()
      const base = status()
      return own ? { ...base, ...own, ready: base.ready && own.ready } : base
    },
  }
}
