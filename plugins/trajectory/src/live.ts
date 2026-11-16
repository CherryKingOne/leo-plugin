/**
 * 运行时观察：订阅 `agent/event`、`session/appended`、`sub-agents/started`，把日志里没有的数据记在内存里：
 *   - 模型调用的首 token 时间（TTFT）、重试后每次尝试的开始时间
 *   - 工具开始 / 结束时间、进度
 *   - 子会话归属（父会话、父工具调用）：旧宿主没有 session/meta 时靠这些挂树
 * 只在内存里，最多保留 maxLiveSessions 个会话（最久没动的先丢，运行中的不丢）。进程重启后没有。
 */
import type { LiveHints } from './project.js'
import type { SessionMetaLike } from './types.js'

export interface LiveLink {
  parentSessionId: string
  callId?: string
  via: 'live'
}

interface LiveSession extends LiveHints {
  sessionId: string
  touchedAt: number
  meta: SessionMetaLike
  /** 运行中的工具调用（按开始顺序） */
  runningTools: string[]
}

/** agent/event 载荷里用到的部分（结构类型，兼容各版本） */
export interface AgentLike {
  id: string
  sessionId: string
  options?: { label?: string; model?: string; state?: Record<string, unknown>; sessionMeta?: SessionMetaLike }
}

const MAX_PROGRESS = 20

export class LiveTracker {
  private readonly sessions = new Map<string, LiveSession>()
  /** agentId → sessionId */
  private readonly agents = new Map<string, string>()
  /** 子会话 → 父（运行时捕获） */
  readonly links = new Map<string, LiveLink>()
  /** 子 Agent id → 父调用（tool_update 先于 sub-agents/started 时暂存） */
  private readonly pendingAgentLinks = new Map<string, LiveLink>()
  /** agent-team 项目 → 发起它的主会话调用 */
  private readonly projects = new Map<string, LiveLink>()

  constructor(
    private readonly maxSessions: number,
    private readonly onChange: (sessionId: string, type: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  hints(sessionId: string): LiveHints | undefined {
    return this.sessions.get(sessionId)
  }

  isRunning(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.running ?? false
  }

  sessionIds(): string[] {
    return [...this.sessions.keys()]
  }

  sessionInfo(sessionId: string): { touchedAt: number; running: boolean; meta: SessionMetaLike } | undefined {
    const s = this.sessions.get(sessionId)
    return s ? { touchedAt: s.touchedAt, running: s.running, meta: s.meta } : undefined
  }

  private session(sessionId: string): LiveSession {
    let s = this.sessions.get(sessionId)
    if (!s) {
      s = { sessionId, running: false, touchedAt: this.now(), meta: {}, steps: new Map(), tools: new Map(), runningTools: [] }
      this.sessions.set(sessionId, s)
      this.evict()
    }
    s.touchedAt = this.now()
    return s
  }

  private evict() {
    if (this.sessions.size <= this.maxSessions) return
    const idle = [...this.sessions.values()].filter((s) => !s.running).sort((a, b) => a.touchedAt - b.touchedAt)
    while (this.sessions.size > this.maxSessions && idle.length) {
      const s = idle.shift()!
      this.sessions.delete(s.sessionId)
      for (const [a, sid] of this.agents) if (sid === s.sessionId) this.agents.delete(a)
    }
  }

  /** 会话日志新增（session/appended） */
  onAppended(e: { sessionId: string; type: string; at: number; data: any }) {
    const s = this.session(e.sessionId)
    if (e.type === 'llm/request' && e.data?.stepId) {
      const h = s.steps.get(e.data.stepId) ?? {}
      h.requestAt = e.at
      h.attemptStartedAt ??= e.at
      s.steps.set(e.data.stepId, h)
    } else if (e.type === 'session/meta' && e.data) {
      s.meta = { ...s.meta, ...e.data }
    }
    this.onChange(e.sessionId, e.type)
  }

  /** sub-agents 插件的 `sub-agents/started`（旧宿主上的父子关系来源之一） */
  onSubAgentStarted(info: { id?: string; sessionId?: string; parentAgentId?: string; agent?: string }) {
    if (!info.sessionId) return
    const s = this.session(info.sessionId)
    s.meta = { ...s.meta, origin: s.meta.origin ?? 'sub-agent', ...(info.agent ? { label: s.meta.label ?? `sub-agent:${info.agent}` } : {}) }
    if (info.id) this.agents.set(info.id, info.sessionId)
    if (info.parentAgentId) s.meta.parentAgentId ??= info.parentAgentId
    const pending = info.id ? this.pendingAgentLinks.get(info.id) : undefined
    if (pending) {
      this.links.set(info.sessionId, pending)
      this.pendingAgentLinks.delete(info.id!)
    } else if (!this.links.has(info.sessionId) && info.parentAgentId) {
      const parentSid = this.agents.get(info.parentAgentId)
      if (parentSid) this.links.set(info.sessionId, { parentSessionId: parentSid, ...this.runningCall(parentSid, ['task']), via: 'live' })
    }
    this.syncMetaParent(info.sessionId)
    this.onChange(info.sessionId, 'sub-agents/started')
  }

  /** agent/event */
  onAgentEvent(agent: AgentLike, ev: any) {
    if (!agent?.sessionId || !ev?.type) return
    const sid = agent.sessionId
    const s = this.session(sid)
    this.agents.set(agent.id, sid)
    const t = this.now()
    switch (ev.type) {
      case 'turn_start':
        s.running = true
        this.inferMeta(s, agent)
        break
      case 'turn_end':
        s.running = false
        s.runningTools = []
        break
      case 'text_delta':
      case 'reasoning_delta':
      case 'tool_call_delta': {
        const h = s.steps.get(ev.stepId) ?? {}
        if (h.firstTokenAt === undefined) {
          h.firstTokenAt = t
          s.steps.set(ev.stepId, h)
          this.onChange(sid, 'first_token')
        }
        return
      }
      case 'retry': {
        // 新的一次尝试：清掉上次的首 token，开始时间 = 退避结束
        const h = s.steps.get(ev.stepId) ?? {}
        delete h.firstTokenAt
        h.attemptStartedAt = t + (Number(ev.delayMs) || 0)
        s.steps.set(ev.stepId, h)
        break
      }
      case 'tool_start': {
        const call = ev.call
        if (!call?.id) return
        s.tools.set(call.id, { name: String(call.name), startedAt: t, progress: [] })
        s.runningTools.push(call.id)
        break
      }
      case 'tool_update': {
        const h = s.tools.get(ev.callId)
        const p = ev.partial
        if (h && p && typeof p === 'object' && typeof p.message === 'string') {
          h.progress.push(p.message.slice(0, 300))
          if (h.progress.length > MAX_PROGRESS) h.progress.splice(0, h.progress.length - MAX_PROGRESS)
        }
        if (p && typeof p === 'object') {
          // sub-agents 进度带子 Agent id；agent-team 进度带项目 id
          if (typeof p.agentId === 'string' && p.agentId !== agent.id) {
            const link: LiveLink = { parentSessionId: sid, callId: ev.callId, via: 'live' }
            const child = this.agents.get(p.agentId)
            if (child && child !== sid) {
              this.links.set(child, link)
              this.syncMetaParent(child)
            } else this.pendingAgentLinks.set(p.agentId, link)
          }
          if (typeof p.projectId === 'string' && h && (h.name === 'team_start' || h.name === 'team_reply')) {
            this.projects.set(p.projectId, { parentSessionId: sid, callId: ev.callId, via: 'live' })
          }
        }
        break
      }
      case 'tool_result': {
        const r = ev.result
        if (!r?.callId) return
        const h = s.tools.get(r.callId) ?? { name: String(r.name), progress: [] }
        h.endedAt = t
        if (h.startedAt === undefined && typeof r.durationMs === 'number') h.startedAt = t - r.durationMs
        s.tools.set(r.callId, h)
        s.runningTools = s.runningTools.filter((c) => c !== r.callId)
        const details = r.details
        if (details && typeof details === 'object') {
          if (typeof details.sessionId === 'string' && details.sessionId !== sid) {
            this.links.set(details.sessionId, { parentSessionId: sid, callId: r.callId, via: 'live' })
            this.syncMetaParent(details.sessionId)
          }
          if (typeof details.projectId === 'string' && String(r.name).startsWith('team_')) {
            this.projects.set(details.projectId, { parentSessionId: sid, callId: r.callId, via: 'live' })
          }
        }
        break
      }
      default:
        break
    }
    this.onChange(sid, ev.type)
  }

  /** 从 Agent 的 label / state 推断来源与父会话（旧宿主没有 session/meta） */
  private inferMeta(s: LiveSession, agent: AgentLike) {
    const o = agent.options ?? {}
    if (o.sessionMeta) s.meta = { ...o.sessionMeta, ...s.meta }
    if (o.label) s.meta.label ??= o.label
    if (o.model) s.meta.model ??= o.model
    s.meta.agentId ??= agent.id
    const st = (o.state ?? {}) as Record<string, any>
    if (this.links.has(s.sessionId)) return this.syncMetaParent(s.sessionId)
    if (st.subAgent) {
      s.meta.origin ??= 'sub-agent'
      const parentAgentId = st.subAgent.parentAgentId
      if (typeof parentAgentId === 'string') {
        s.meta.parentAgentId ??= parentAgentId
        const parentSid = this.agents.get(parentAgentId)
        if (parentSid && parentSid !== s.sessionId) this.links.set(s.sessionId, { parentSessionId: parentSid, ...this.runningCall(parentSid, ['task']), via: 'live' })
      }
    } else if (st.agentTeam) {
      s.meta.origin ??= 'team-member'
      const { projectId, role } = st.agentTeam as { projectId?: string; role?: string }
      if (typeof projectId === 'string') {
        if (role === 'leader') {
          const p = this.projects.get(projectId) ?? this.latestRunningCall(['team_start', 'team_reply'], s.sessionId)
          if (p) this.links.set(s.sessionId, p)
        } else {
          const leader = `team-${projectId}-leader`
          const viaLeader = this.sessions.has(leader) ? { parentSessionId: leader, ...this.runningCall(leader, ['team_assign']), via: 'live' as const } : undefined
          const asked = this.latestRunningCall(['team_ask'], s.sessionId)
          const link = asked && (!viaLeader?.callId || this.startedAt(asked) > this.startedAt(viaLeader)) ? asked : viaLeader
          if (link) this.links.set(s.sessionId, link)
        }
      }
    } else if (o.label?.startsWith('sub-agent:')) {
      s.meta.origin ??= 'sub-agent'
    }
    this.syncMetaParent(s.sessionId)
  }

  private startedAt(l: LiveLink): number {
    return (l.callId && this.sessions.get(l.parentSessionId)?.tools.get(l.callId)?.startedAt) || 0
  }

  private syncMetaParent(childSid: string) {
    const l = this.links.get(childSid)
    const s = this.sessions.get(childSid)
    if (!l || !s) return
    s.meta.parentSessionId ??= l.parentSessionId
    if (l.callId) s.meta.parentToolCallId ??= l.callId
  }

  /** 父会话里最近开始、仍在运行的调用（优先给定名字） */
  private runningCall(sessionId: string, names: string[]): { callId?: string } {
    const s = this.sessions.get(sessionId)
    if (!s) return {}
    const ids = [...s.runningTools].reverse()
    const id = ids.find((c) => names.includes(s.tools.get(c)?.name ?? '')) ?? ids[0]
    return id ? { callId: id } : {}
  }

  /** 所有会话里最近开始、仍在运行、名字匹配的调用 */
  private latestRunningCall(names: string[], exclude: string): LiveLink | undefined {
    let best: { link: LiveLink; at: number } | undefined
    for (const s of this.sessions.values()) {
      if (s.sessionId === exclude) continue
      for (const c of s.runningTools) {
        const h = s.tools.get(c)
        if (!h || !names.includes(h.name)) continue
        const at = h.startedAt ?? 0
        if (!best || at > best.at) best = { link: { parentSessionId: s.sessionId, callId: c, via: 'live' }, at }
      }
    }
    return best?.link
  }

  clear() {
    this.sessions.clear()
    this.agents.clear()
    this.links.clear()
    this.pendingAgentLinks.clear()
    this.projects.clear()
  }
}
