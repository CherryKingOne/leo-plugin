/**
 * `contextInsight` 服务：读会话日志 → 上下文报告 / 跨会话洞察，带有上限、有 TTL 的缓存；会话追加事件时失效并通知订阅者。
 * 只读，不写会话日志。
 */
import { readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { addComposition, type AnalyzeOptions, type Analysis, analyzeSession, emptyComposition } from './analyze.js'
import type {
  Category,
  ContextInsightService,
  ContextUpdate,
  Overview,
  OverviewDay,
  RawEvent,
  RequestDetail,
  SessionMetaLike,
  SessionReport,
  SessionSummary,
} from './types.js'

export interface StoreLike {
  events(sessionId: string): Promise<RawEvent[]>
  list?(): Promise<{ sessionId: string; createdAt: number; updatedAt: number; events: number; meta?: SessionMetaLike }[]>
}

export interface ServiceDeps {
  store: () => StoreLike | undefined
  analyze: () => AnalyzeOptions
  /** 旧宿主（没有 sessions.list()）扫描的会话目录 */
  sessionsDirs: () => string[]
  /** 运行中的 Agent 的会话 */
  liveAgentSessions: () => string[]
  url: () => string | undefined
  preview: (v: unknown) => string
  /** 列表 / 洞察最多扫描的会话数（最近更新的优先） */
  maxSessions: number
  /** 完整分析结果缓存多少个会话 */
  cacheSessions: number
  /** 缓存最长保留时间（毫秒），过期即重新读 */
  cacheTtlMs?: number
}

interface CacheEntry {
  key: string
  at: number
  analysis: Analysis
}

const LIST_CACHE_MS = 2000

export class ContextInsights implements ContextInsightService {
  private readonly listeners = new Set<(u: ContextUpdate) => void>()
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inflight = new Map<string, Promise<Analysis | undefined>>()
  /** 洞察用的小摘要缓存（远小于完整报告），按会话事件数失效 */
  private readonly digests = new Map<string, { key: string; digest: Digest }>()
  private listCache: { at: number; value: Promise<SessionSummary[]> } | undefined

  constructor(private readonly deps: ServiceDeps) {}

  url() {
    return this.deps.url()
  }

  subscribe(listener: (u: ContextUpdate) => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  /** 会话追加了事件：丢掉它的缓存，通知订阅者 */
  touch(u: ContextUpdate) {
    this.cache.delete(u.sessionId)
    this.listCache = undefined
    for (const l of [...this.listeners]) {
      try {
        l(u)
      } catch {
        // 订阅者的错误不影响别人
      }
    }
  }

  clear() {
    this.cache.clear()
    this.digests.clear()
    this.inflight.clear()
    this.listCache = undefined
  }

  private async events(sessionId: string): Promise<RawEvent[]> {
    const store = this.deps.store()
    if (!store) return []
    try {
      return await store.events(sessionId)
    } catch {
      return []
    }
  }

  private async analysis(sessionId: string): Promise<Analysis | undefined> {
    const hit = this.cache.get(sessionId)
    const ttl = this.deps.cacheTtlMs ?? 10 * 60_000
    if (hit && Date.now() - hit.at < ttl) {
      // LRU：挪到末尾
      this.cache.delete(sessionId)
      this.cache.set(sessionId, hit)
      return hit.analysis
    }
    const running = this.inflight.get(sessionId)
    if (running) return running
    const p = (async () => {
      const ev = await this.events(sessionId)
      if (!ev.length) return undefined
      const analysis = analyzeSession(sessionId, ev, this.deps.analyze())
      this.cache.set(sessionId, { key: `${ev.length}:${ev[ev.length - 1]!.seq}`, at: Date.now(), analysis })
      while (this.cache.size > this.deps.cacheSessions) this.cache.delete(this.cache.keys().next().value!)
      return analysis
    })().finally(() => this.inflight.delete(sessionId))
    this.inflight.set(sessionId, p)
    return p
  }

  async report(sessionId: string): Promise<SessionReport | undefined> {
    const a = await this.analysis(sessionId)
    if (!a) return undefined
    const children = (await this.list()).filter((s) => s.parentSessionId === sessionId)
    return { ...a.report, children }
  }

  async request(sessionId: string, index: number, opts: { offset?: number; limit?: number; category?: Category } = {}): Promise<RequestDetail | undefined> {
    const a = await this.analysis(sessionId)
    return a?.detail(index, { ...opts, preview: this.deps.preview })
  }

  async list(): Promise<SessionSummary[]> {
    const now = Date.now()
    if (this.listCache && now - this.listCache.at < LIST_CACHE_MS) return this.listCache.value
    const value = this.doList()
    this.listCache = { at: now, value }
    value.catch(() => (this.listCache = undefined))
    return value
  }

  /** 会话清单（最近更新优先，最多 maxSessions 个），附带用量、上下文大小这些小摘要 */
  private async doList(): Promise<SessionSummary[]> {
    const base = await this.baseList()
    const out: SessionSummary[] = []
    for (const s of base.slice(0, this.deps.maxSessions)) {
      const d = await this.digest(s.sessionId, s.events, s.updatedAt)
      out.push({ ...s, ...(d ? d.summary : {}) })
    }
    return out
  }

  private async baseList(): Promise<SessionSummary[]> {
    const out = new Map<string, SessionSummary>()
    const store = this.deps.store()
    if (store && typeof store.list === 'function') {
      for (const s of await store.list().catch(() => [])) {
        out.set(s.sessionId, { sessionId: s.sessionId, createdAt: s.createdAt, updatedAt: s.updatedAt, events: s.events, ...metaFields(s.meta) })
      }
    } else if (store) {
      const files: { id: string; mtime: number }[] = []
      for (const dir of this.deps.sessionsDirs()) {
        let names: string[] = []
        try {
          names = await readdir(dir)
        } catch {
          continue
        }
        for (const n of names) {
          if (!n.endsWith('.jsonl')) continue
          const id = n.slice(0, -6)
          if (!/^[\w.-]{1,128}$/.test(id) || files.some((f) => f.id === id)) continue
          try {
            files.push({ id, mtime: (await stat(join(dir, n))).mtimeMs })
          } catch {
            // 文件刚被删
          }
        }
      }
      files.sort((a, b) => b.mtime - a.mtime)
      for (const f of files.slice(0, this.deps.maxSessions)) out.set(f.id, { sessionId: f.id, updatedAt: f.mtime, events: -1 })
    }
    for (const id of this.deps.liveAgentSessions()) if (!out.has(id)) out.set(id, { sessionId: id, events: -1, updatedAt: Date.now() })
    return [...out.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  }

  /** 洞察摘要：按（事件数、更新时间）失效；只保留会话的小摘要与按日聚合，不留完整报告 */
  private async digest(sessionId: string, events: number, updatedAt: number | undefined): Promise<Digest | undefined> {
    const key = `${events}:${updatedAt ?? 0}`
    const hit = this.digests.get(sessionId)
    if (hit && hit.key === key && events >= 0) return hit.digest
    const a = await this.analysis(sessionId)
    if (!a) return undefined
    const digest = toDigest(a.report)
    this.digests.set(sessionId, { key, digest })
    // 上限：与扫描上限一致，多出来的（最旧加入的）丢掉
    while (this.digests.size > this.deps.maxSessions * 2) this.digests.delete(this.digests.keys().next().value!)
    return digest
  }

  async overview(opts: { days?: number } = {}): Promise<Overview> {
    const days = Math.max(1, Math.min(90, Math.floor(opts.days ?? 7)))
    const now = Date.now()
    const since = startOfDay(now) - (days - 1) * DAY
    const all = await this.baseList()
    const list = all.slice(0, this.deps.maxSessions)
    const sessions: SessionSummary[] = []
    const kpi: Overview['kpi'] = { sessions: 0, turns: 0, requests: 0, billedTokens: 0, costUsd: 0, toolCalls: 0, activeMs: 0 }
    let input = 0
    let cached = 0
    const composition = emptyComposition()
    const last7 = new Map<string, OverviewDay>()
    for (let i = 6; i >= 0; i--) {
      const date = dayKey(now - i * DAY)
      last7.set(date, { date, billedTokens: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0, requests: 0 })
    }
    const heat = new Map<string, number>()
    for (let i = 55; i >= 0; i--) heat.set(dayKey(now - i * DAY), 0)
    const tools = new Map<string, { name: string; calls: number; errors: number; lastAt: number }>()
    const skills = new Map<string, { name: string; loads: number; lastAt: number }>()
    const programs = new Map<string, { name: string; runs: number; failures: number; lastAt: number }>()

    for (const s of list) {
      const d = await this.digest(s.sessionId, s.events, s.updatedAt)
      if (!d) continue
      // 按日聚合：热力图看 56 天，最近 7 天图固定 7 天
      for (const [date, v] of Object.entries(d.daily)) {
        if (heat.has(date)) heat.set(date, heat.get(date)! + v.billedTokens)
        const l = last7.get(date)
        if (l) {
          l.billedTokens += v.billedTokens
          l.inputTokens += v.inputTokens
          l.outputTokens += v.outputTokens
          l.cachedInputTokens += v.cachedInputTokens
          l.costUsd += v.costUsd
          l.requests += v.requests
        }
      }
      // 范围内活跃：有请求落在范围内
      const inRange = Object.entries(d.daily).filter(([date]) => dayStart(date) >= since)
      if (!inRange.length) continue
      kpi.sessions++
      for (const [, v] of inRange) {
        kpi.requests += v.requests
        kpi.billedTokens += v.billedTokens
        kpi.costUsd += v.costUsd
        input += v.inputTokens
        cached += v.cachedInputTokens
        addComposition(composition, v.composition)
      }
      kpi.turns += d.summary.turns ?? 0
      kpi.toolCalls += d.toolCalls
      kpi.activeMs += d.activeMs
      for (const t of d.tools) merge(tools, t.name, { name: t.name, calls: t.calls, errors: t.errors, lastAt: t.lastAt }, (a, b) => ((a.calls += b.calls), (a.errors += b.errors), (a.lastAt = Math.max(a.lastAt, b.lastAt))))
      for (const k of d.skills) merge(skills, k.name, { ...k }, (a, b) => ((a.loads += b.loads), (a.lastAt = Math.max(a.lastAt, b.lastAt))))
      for (const p of d.programs) merge(programs, p.name, { ...p }, (a, b) => ((a.runs += b.runs), (a.failures += b.failures), (a.lastAt = Math.max(a.lastAt, b.lastAt))))
      sessions.push({ ...s, ...d.summary })
    }
    if (input > 0) kpi.cacheHitRate = cached / input
    return {
      generatedAt: now,
      rangeDays: days,
      kpi,
      last7: [...last7.values()],
      heatmap: [...heat.entries()].map(([date, billedTokens]) => ({ date, billedTokens })),
      composition,
      tools: [...tools.values()].sort((a, b) => b.calls - a.calls).slice(0, 20),
      skills: [...skills.values()].sort((a, b) => b.loads - a.loads).slice(0, 20),
      programs: [...programs.values()].sort((a, b) => b.runs - a.runs).slice(0, 20),
      sessions,
      truncated: all.length > list.length,
    }
  }
}

interface Digest {
  summary: Partial<SessionSummary>
  daily: Record<string, Omit<OverviewDay, 'date'> & { composition: ReturnType<typeof emptyComposition> }>
  toolCalls: number
  activeMs: number
  tools: { name: string; calls: number; errors: number; lastAt: number }[]
  skills: { name: string; loads: number; lastAt: number }[]
  programs: { name: string; runs: number; failures: number; lastAt: number }[]
}

function toDigest(r: SessionReport): Digest {
  const daily: Digest['daily'] = {}
  const priced = r.stats.usage.costSource === 'pricing' || r.stats.usage.costSource === 'mixed'
  // 没有逐请求成本时按 token 比例把会话成本摊到每次请求
  const perTokenCost = priced && r.stats.usage.billedTokens > 0 ? r.stats.usage.costUsd / r.stats.usage.billedTokens : 0
  for (const p of r.trend) {
    const k = dayKey(p.at)
    const d = (daily[k] ??= { billedTokens: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0, requests: 0, composition: emptyComposition() })
    d.requests++
    addComposition(d.composition, p.composition)
    if (!p.usage) continue
    const billed = p.usage.inputTokens + p.usage.outputTokens
    d.billedTokens += billed
    d.inputTokens += p.usage.inputTokens
    d.outputTokens += p.usage.outputTokens
    d.cachedInputTokens += p.usage.cachedInputTokens
    d.costUsd += p.usage.costUsd ?? billed * perTokenCost
  }
  const programs = new Map<string, { name: string; runs: number; failures: number; lastAt: number }>()
  for (const c of r.commands) merge(programs, c.program, { name: c.program, runs: 1, failures: c.ok ? 0 : 1, lastAt: c.at }, (a, b) => ((a.runs += b.runs), (a.failures += b.failures), (a.lastAt = Math.max(a.lastAt, b.lastAt))))
  return {
    summary: {
      ...(r.createdAt !== undefined ? { createdAt: r.createdAt } : {}),
      ...(r.updatedAt !== undefined ? { updatedAt: r.updatedAt } : {}),
      events: r.events,
      ...metaFields(r.meta),
      ...(r.models.length ? { model: r.models[r.models.length - 1]! } : {}),
      turns: r.stats.turns,
      billedTokens: r.stats.usage.billedTokens,
      costUsd: r.stats.usage.costUsd,
      ...(r.current ? { contextTokens: r.current.estimatedTokens, occupancy: r.current.occupancy, composition: r.current.composition } : {}),
    },
    daily,
    toolCalls: r.stats.toolCalls,
    activeMs: r.stats.timing.activeMs,
    tools: r.tools.map((t) => ({ name: t.name, calls: t.calls, errors: t.errors, lastAt: t.lastAt })),
    skills: r.skills,
    programs: [...programs.values()],
  }
}

function merge<T>(map: Map<string, T>, key: string, value: T, combine: (a: T, b: T) => unknown) {
  const cur = map.get(key)
  if (cur) combine(cur, value)
  else map.set(key, value)
}

function metaFields(m: SessionMetaLike | undefined): Partial<SessionSummary> {
  if (!m) return {}
  return {
    ...(m.label ? { label: m.label } : {}),
    ...(m.origin ? { origin: m.origin } : {}),
    ...(m.parentSessionId ? { parentSessionId: m.parentSessionId } : {}),
  }
}

const DAY = 86_400_000
const pad = (n: number) => String(n).padStart(2, '0')
/** 进程本地时区的日期 */
export function dayKey(t: number): string {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function startOfDay(t: number): number {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
function dayStart(key: string): number {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y!, m! - 1, d!).getTime()
}

/** 旧宿主的会话目录：与 leo-agents createLeoFromConfig 的规则一致 */
export function defaultSessionsDirs(paths: { cwd?: string; projectRoot?: string; projectDir?: string; userDir?: string } | undefined, config: { sessions?: { dir?: string; persist?: boolean } } | undefined): string[] {
  if (!paths) return []
  const s = config?.sessions
  if (s?.persist === false) return []
  if (s?.dir) return [resolve(paths.projectRoot ?? paths.cwd ?? '.', s.dir)]
  const dir = paths.projectDir ?? paths.userDir
  return dir ? [join(dir, 'sessions')] : []
}
