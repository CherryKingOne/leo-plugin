/**
 * `trajectory` 服务：把会话日志投影成轨迹树，合并运行时数据，向订阅者推送变化。只读，不写会话日志。
 */
import { readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { LiveTracker } from './live.js'
import { addChild, childIds, findCall, projectSession, type ProjectOptions } from './project.js'
import type { ChildLink, RawEvent, SessionMetaLike, SessionSummary, TrajectoryService, TrajectoryTree, TrajectoryUpdate } from './types.js'

/** 会话存储的最小结构（`list` 是 leo-agents 0.2.2 的可选方法） */
export interface StoreLike {
  events(sessionId: string): Promise<RawEvent[]>
  list?(): Promise<{ sessionId: string; createdAt: number; updatedAt: number; events: number; meta?: SessionMetaLike }[]>
}

export interface ServiceDeps {
  store: () => StoreLike | undefined
  tracker: LiveTracker
  project: ProjectOptions
  /** 旧宿主的会话目录（FileSessionStore 的目录），用于列出历史会话 */
  sessionsDirs: () => string[]
  /** 运行中的 Agent 的会话（agentLoop.list()） */
  liveAgentSessions: () => string[]
  url: () => string | undefined
  /** 最多扫描的历史会话文件数 */
  maxListed?: number
}

const LIST_CACHE_MS = 2000
const MAX_CHILDREN_PER_SESSION = 50

export class Trajectories implements TrajectoryService {
  private readonly listeners = new Set<(u: TrajectoryUpdate) => void>()
  private listCache: { at: number; value: Promise<SessionSummary[]> } | undefined

  constructor(private readonly deps: ServiceDeps) {}

  url() {
    return this.deps.url()
  }

  subscribe(listener: (u: TrajectoryUpdate) => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  /** 由插件在 tracker 变化时调用 */
  publish(u: TrajectoryUpdate) {
    this.listCache = undefined
    for (const l of [...this.listeners]) {
      try {
        l(u)
      } catch {
        // 订阅者自己的错误不影响别人
      }
    }
  }

  /** 运行时已知的父会话（SSE 过滤用） */
  parentOf(sessionId: string): string | undefined {
    const t = this.deps.tracker
    return t.links.get(sessionId)?.parentSessionId ?? t.sessionInfo(sessionId)?.meta.parentSessionId
  }

  listenerCount() {
    return this.listeners.size
  }

  async events(sessionId: string): Promise<RawEvent[]> {
    const store = this.deps.store()
    if (!store) return []
    try {
      return await store.events(sessionId)
    } catch {
      return []
    }
  }

  async list(): Promise<SessionSummary[]> {
    const now = Date.now()
    if (this.listCache && now - this.listCache.at < LIST_CACHE_MS) return this.listCache.value
    const value = this.doList()
    this.listCache = { at: now, value }
    value.catch(() => (this.listCache = undefined))
    return value
  }

  private async doList(): Promise<SessionSummary[]> {
    const out = new Map<string, SessionSummary>()
    const tracker = this.deps.tracker
    const store = this.deps.store()
    if (store && typeof store.list === 'function') {
      for (const s of await store.list().catch(() => [])) {
        out.set(s.sessionId, {
          sessionId: s.sessionId,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          events: s.events,
          running: false,
          ...summaryMeta(s.meta),
        })
      }
    } else if (store) {
      // 旧宿主：扫描会话目录（只有文件存储有），按修改时间取最近的若干个
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
      for (const f of files.slice(0, this.deps.maxListed ?? 200)) {
        const ev = await this.events(f.id)
        if (!ev.length) continue
        const meta = ev.find((e) => e.type === 'session/meta')?.data as SessionMetaLike | undefined
        out.set(f.id, { sessionId: f.id, createdAt: ev[0]!.at, updatedAt: ev[ev.length - 1]!.at, events: ev.length, running: false, ...summaryMeta(meta) })
      }
    }
    // 运行时见过的会话（内存存储、或刚创建还没扫到的）
    const liveIds = new Set([...tracker.sessionIds(), ...this.deps.liveAgentSessions()])
    for (const id of liveIds) {
      const info = tracker.sessionInfo(id)
      const cur = out.get(id)
      if (cur) {
        cur.running = info?.running ?? false
        if (!cur.label && info?.meta.label) cur.label = info.meta.label
        if (!cur.origin && info?.meta.origin) cur.origin = info.meta.origin
        if (!cur.parentSessionId && info?.meta.parentSessionId) cur.parentSessionId = info.meta.parentSessionId
        continue
      }
      const ev = await this.events(id)
      if (!ev.length && !info) continue
      out.set(id, {
        sessionId: id,
        ...(ev.length ? { createdAt: ev[0]!.at, updatedAt: ev[ev.length - 1]!.at } : info ? { updatedAt: info.touchedAt } : {}),
        events: ev.length,
        running: info?.running ?? false,
        ...summaryMeta({ ...info?.meta, ...(ev.find((e) => e.type === 'session/meta')?.data as SessionMetaLike | undefined) }),
      })
    }
    return [...out.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  }

  async get(sessionId: string, opts: { depth?: number } = {}): Promise<TrajectoryTree | undefined> {
    return this.build(sessionId, opts.depth ?? 2, new Set())
  }

  private async build(sessionId: string, depth: number, seen: Set<string>): Promise<TrajectoryTree | undefined> {
    seen.add(sessionId)
    const events = await this.events(sessionId)
    const hints = this.deps.tracker.hints(sessionId)
    if (!events.length && !hints) return undefined
    const t = projectSession(sessionId, events, hints, this.deps.project) as TrajectoryTree
    t.childSessions = {}

    // —— 父链接（自己是谁的子会话）：日志 meta > 运行时 ——
    const live = this.deps.tracker.links.get(sessionId)
    if (live && t.metaSource !== 'log') {
      t.meta.parentSessionId ??= live.parentSessionId
      if (live.callId) t.meta.parentToolCallId ??= live.callId
    }

    // —— 子链接：其他会话的 meta 指向我；运行时捕获的链接 ——
    const attach = (child: string, callId: string | undefined, link: ChildLink) => {
      if (child === sessionId) return
      const call = callId ? findCall(t, callId) : undefined
      addChild(call ? call.children : t.children, link)
    }
    for (const s of await this.list()) {
      if (s.parentSessionId !== sessionId) continue
      const p = await this.parentOfChild(s.sessionId)
      attach(s.sessionId, p.callId, { sessionId: s.sessionId, ...(s.origin ? { origin: s.origin } : {}), ...(s.label ? { label: s.label } : {}), via: p.fromLog ? 'meta' : 'live' })
    }
    for (const [child, l] of this.deps.tracker.links) {
      if (l.parentSessionId !== sessionId) continue
      const info = this.deps.tracker.sessionInfo(child)
      attach(child, l.callId, { sessionId: child, ...(info?.meta.origin ? { origin: info.meta.origin } : {}), ...(info?.meta.label ? { label: info.meta.label } : {}), via: 'live' })
    }

    // —— 展开子会话 ——
    if (depth > 0) {
      for (const id of childIds(t).slice(0, MAX_CHILDREN_PER_SESSION)) {
        if (seen.has(id)) continue
        const child = await this.build(id, depth - 1, seen)
        if (child) t.childSessions[id] = child
      }
    }
    return t
  }

  /** 子会话的父调用：日志 meta 优先，其次运行时 */
  private async parentOfChild(sessionId: string): Promise<{ callId?: string; fromLog: boolean }> {
    const ev = await this.events(sessionId)
    const meta = ev.find((e) => e.type === 'session/meta')?.data as SessionMetaLike | undefined
    const callId = meta?.parentToolCallId ?? this.deps.tracker.links.get(sessionId)?.callId
    return { ...(callId ? { callId } : {}), fromLog: !!meta?.parentSessionId }
  }
}

function summaryMeta(m: SessionMetaLike | undefined): Partial<SessionSummary> {
  if (!m) return {}
  return {
    ...(m.label ? { label: m.label } : {}),
    ...(m.origin ? { origin: m.origin } : {}),
    ...(m.parentSessionId ? { parentSessionId: m.parentSessionId } : {}),
  }
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
