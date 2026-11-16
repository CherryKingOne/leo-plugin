/**
 * 会话日志 → 轨迹（只读投影，纯函数）。
 *
 * 新旧宿主都能用：
 * - leo-agents ≥ 0.2.2（分支 feat/trajectory-log）：用 `tool/start` / `tool/end` 的精确时间、`llm/response.startedAt/firstTokenAt`（TTFT）、`session/meta`
 * - leo-agents 0.2.1 及更早：step 耗时取 `llm/request` → `llm/response` 的事件时间；工具耗时取结果消息里工具自报的 `meta.durationMs`，
 *   开始时间据此推算（estimated）；TTFT 只有插件运行期间现场测到的（live，内存里），历史数据标为 unavailable
 */
import { clip, preview, type PreviewOptions } from './redact.js'
import type {
  ChildLink,
  CompactionRecord,
  CustomRecord,
  RawEvent,
  SessionMetaLike,
  SessionTrajectory,
  StepRecord,
  ToolCallRecord,
  TurnRecord,
  UsageLike,
} from './types.js'

/** 运行时测得的数据（见 live.ts），投影时用来补齐日志里没有的时间 */
export interface LiveHints {
  running: boolean
  meta?: SessionMetaLike
  steps: Map<string, { requestAt?: number; attemptStartedAt?: number; firstTokenAt?: number }>
  tools: Map<string, { name: string; startedAt?: number; endedAt?: number; progress: string[] }>
}

export interface ProjectOptions extends PreviewOptions {
  /** 存储是否实现了 list()（只用于 capabilities 展示） */
  storeList?: boolean
}

export const emptyUsage = (): UsageLike => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, costUsd: 0 })

export function addUsage(a: UsageLike, b: Partial<UsageLike> | undefined): UsageLike {
  if (!b) return a
  return {
    inputTokens: a.inputTokens + (b.inputTokens ?? 0),
    outputTokens: a.outputTokens + (b.outputTokens ?? 0),
    cachedInputTokens: (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0),
    reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0),
    costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0),
  }
}

/** agent-team 成员会话的命名约定：team-<项目 id>-<角色> */
export const TEAM_SESSION = /^team-(.+)-(leader|pm|designer|tech-lead|dev|qa)$/

/** 预检阶段就被拦下（从未执行）的错误码 */
const NOT_RUN_CODES = new Set(['tool_not_found', 'tool_invalid_args', 'tool_denied'])

interface Block {
  type: string
  text?: string
  id?: string
  name?: string
  arguments?: unknown
  rawArguments?: string
}

const blocksOf = (m: any): Block[] => (Array.isArray(m?.content) ? (m.content as Block[]) : [])
const textOf = (m: any, type = 'text') =>
  blocksOf(m)
    .filter((b) => b.type === type && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')

export function projectSession(sessionId: string, events: readonly RawEvent[], live: LiveHints | undefined, o: ProjectOptions): SessionTrajectory {
  const t: SessionTrajectory = {
    sessionId,
    meta: {},
    metaSource: 'none',
    ...(events.length ? { createdAt: events[0]!.at, updatedAt: events[events.length - 1]!.at } : {}),
    running: live?.running ?? false,
    capabilities: { toolEvents: false, ttft: false, sessionMeta: false, storeList: o.storeList ?? false },
    usage: emptyUsage(),
    turns: [],
    children: [],
    stats: { turns: 0, steps: 0, toolCalls: 0, toolErrors: 0, failedAttempts: 0, compactions: 0, events: events.length },
  }

  let turn: TurnRecord | undefined
  /** turn/start 之前的记录（如插件写的 custom）放进一个虚拟 turn，避免丢失 */
  const orphanTurn = (at: number): TurnRecord => {
    turn = { turnId: `(pre-${at})`, index: t.turns.length + 1, startedAt: at, status: 'done', steps: [], records: [], children: [] }
    t.turns.push(turn)
    return turn
  }
  const steps = new Map<string, StepRecord>()
  const byResponseMessage = new Map<string, StepRecord>()
  const calls = new Map<string, ToolCallRecord>()
  const lastStep = () => turn?.steps[turn.steps.length - 1]

  for (const e of events) {
    const d = e.data ?? {}
    switch (e.type) {
      case 'session/meta':
        if (t.metaSource !== 'log') {
          t.meta = { ...d }
          t.metaSource = 'log'
        }
        t.capabilities.sessionMeta = true
        break
      case 'turn/start':
        turn = { turnId: String(d.turnId), index: t.turns.length + 1, startedAt: e.at, status: 'running', steps: [], records: [], children: [] }
        t.turns.push(turn)
        break
      case 'turn/end': {
        const tr = t.turns.find((x) => x.turnId === d.turnId) ?? turn
        if (!tr) break
        tr.endedAt = e.at
        tr.durationMs = e.at - tr.startedAt
        tr.reason = d.reason
        tr.status = 'done'
        if (d.usage) tr.usage = d.usage
        if (d.error) tr.error = { code: String(d.error.code), message: String(d.error.message) }
        for (const s of tr.steps) if (s.status === 'running') s.status = 'failed'
        break
      }
      case 'llm/request': {
        const tr = turn ?? orphanTurn(e.at)
        const s: StepRecord = {
          kind: 'step',
          stepId: String(d.stepId),
          index: tr.steps.length + 1,
          ...(d.model ? { model: String(d.model) } : {}),
          requestAt: e.at,
          timing: 'log',
          ttftSource: 'unavailable',
          failures: [],
          ...(typeof d.estimatedTokens === 'number' ? { estimatedTokens: d.estimatedTokens } : {}),
          ...(Array.isArray(d.messageIds) ? { inputMessages: d.messageIds.length } : {}),
          ...(Array.isArray(d.tools) ? { inputTools: d.tools.length } : {}),
          ...(typeof d.system === 'string' ? { systemChars: d.system.length } : {}),
          status: 'running',
          tools: [],
        }
        steps.set(s.stepId, s)
        tr.steps.push(s)
        break
      }
      case 'llm/attempt-failed': {
        const s = steps.get(d.stepId)
        if (!s) break
        s.failures.push({
          attempt: Number(d.attempt),
          code: String(d.code),
          message: clip(String(d.message ?? ''), o.maxPreviewChars),
          at: e.at,
          ...(typeof d.startedAt === 'number' ? { startedAt: d.startedAt } : {}),
        })
        t.stats.failedAttempts++
        break
      }
      case 'llm/response': {
        const s = steps.get(d.stepId)
        if (!s) break
        s.endedAt = e.at
        if (s.requestAt !== undefined) s.durationMs = e.at - s.requestAt
        s.usage = d.usage
        s.finishReason = d.finishReason
        s.attempts = d.attempts
        s.status = 'done'
        if (typeof d.startedAt === 'number') s.startedAt = d.startedAt
        if (typeof d.firstTokenAt === 'number') {
          s.firstTokenAt = d.firstTokenAt
          s.ttftSource = 'log'
          t.capabilities.ttft = true
        }
        t.usage = addUsage(t.usage, d.usage)
        if (d.messageId) byResponseMessage.set(String(d.messageId), s)
        break
      }
      case 'message': {
        const m = d.message
        if (!m) break
        if (m.role === 'user') {
          const tr = turn ?? orphanTurn(e.at)
          if (tr.input === undefined) tr.input = preview(textOf(m) || '(非文本输入)', o)
        } else if (m.role === 'assistant') {
          const s = byResponseMessage.get(m.id) ?? (m.meta?.partial ? lastStep() : undefined) ?? lastStep()
          if (!s) break
          const text = textOf(m)
          const reasoning = textOf(m, 'reasoning')
          s.output = {
            messageId: m.id,
            ...(text ? { text: preview(text, o) } : {}),
            ...(reasoning ? { reasoning: preview(reasoning, o) } : {}),
            ...(m.meta?.partial ? { partial: true } : {}),
          }
          for (const b of blocksOf(m)) {
            if (b.type !== 'tool_call' || !b.id) continue
            const c: ToolCallRecord = {
              kind: 'tool',
              callId: b.id,
              name: String(b.name ?? '?'),
              args: preview(b.arguments !== undefined ? b.arguments : (b.rawArguments ?? ''), o),
              status: 'running',
              timing: 'unavailable',
              children: [],
            }
            calls.set(c.callId, c)
            s.tools.push(c)
            t.stats.toolCalls++
            // agent-team：Leader 的 team_assign、成员的 team_ask 指向会话 team-<项目>-<角色>
            const team = TEAM_SESSION.exec(sessionId)
            const role = (b.arguments as { role?: unknown } | undefined)?.role
            if (team && (c.name === 'team_assign' || c.name === 'team_ask') && typeof role === 'string') {
              const pid = team[1]!
              addChild(c.children, { sessionId: `team-${pid}-${role}`, origin: 'team-member', label: `agent-team:${role}`, via: 'naming' })
            }
          }
        } else if (m.role === 'tool') {
          const c = calls.get(m.toolCallId)
          if (!c) break
          const meta = m.meta ?? {}
          c.status = 'done'
          c.isError = !!m.isError
          if (c.isError) t.stats.toolErrors++
          if (meta.errorCode) c.errorCode = String(meta.errorCode)
          c.result = preview(textOf(m) || '(无文本结果)', o)
          if (c.timing === 'unavailable') {
            if (typeof meta.durationMs === 'number') {
              c.durationMs = meta.durationMs
              c.endedAt = e.at
              c.startedAt = e.at - meta.durationMs
              c.timing = 'estimated'
            }
          }
          if (c.timing !== 'log' && !t.capabilities.toolEvents && c.isError && c.durationMs === 0 && NOT_RUN_CODES.has(c.errorCode ?? '')) {
            c.status = 'not_run'
          }
          // 子会话：sub-agents 的 task 结果 details 带 sessionId；agent-team 的结果带 projectId
          const details = meta.details
          if (details && typeof details === 'object') {
            const sid = (details as any).sessionId
            if (typeof sid === 'string' && sid !== sessionId) addChild(c.children, { sessionId: sid, origin: 'sub-agent', via: 'result', ...(typeof (details as any).agent === 'string' ? { label: `sub-agent:${(details as any).agent}` } : {}) })
            const pid = (details as any).projectId
            if (typeof pid === 'string' && c.name.startsWith('team_')) {
              addChild(c.children, { sessionId: `team-${pid}-leader`, origin: 'team-member', label: 'agent-team:leader', via: 'naming' })
            }
          }
        }
        break
      }
      case 'tool/start': {
        t.capabilities.toolEvents = true
        let c = calls.get(d.callId)
        if (!c) {
          // assistant 消息缺失（理论上不会）：仍然记一条
          c = { kind: 'tool', callId: String(d.callId), name: String(d.name), args: '', status: 'running', timing: 'log', children: [] }
          calls.set(c.callId, c)
          ;(steps.get(d.stepId) ?? lastStep())?.tools.push(c)
          t.stats.toolCalls++
        }
        c.startedAt = typeof d.at === 'number' ? d.at : e.at
        c.timing = 'log'
        break
      }
      case 'tool/end': {
        t.capabilities.toolEvents = true
        const c = calls.get(d.callId)
        if (!c) break
        c.timing = 'log'
        c.startedAt = typeof d.startedAt === 'number' ? d.startedAt : c.startedAt
        const endedAt: number = typeof d.endedAt === 'number' ? d.endedAt : e.at
        c.endedAt = endedAt
        c.durationMs = typeof d.durationMs === 'number' ? d.durationMs : endedAt - (c.startedAt ?? endedAt)
        c.isError = !!d.isError
        if (d.errorCode) c.errorCode = String(d.errorCode)
        break
      }
      case 'compaction': {
        const tr = turn ?? orphanTurn(e.at)
        const r: CompactionRecord = {
          kind: 'compaction',
          at: e.at,
          strategy: String(d.strategy ?? ''),
          replacesUpTo: String(d.replacesUpTo ?? ''),
          summary: preview(textOf(d.summary) || '', o),
        }
        tr.records.push(r)
        t.stats.compactions++
        break
      }
      case 'custom': {
        const tr = turn ?? orphanTurn(e.at)
        const r: CustomRecord = { kind: 'custom', at: e.at, name: String(d.kind ?? 'custom'), data: preview(d.data, o) }
        tr.records.push(r)
        break
      }
      default:
        // 不认识的事件：忽略（新宿主可能新增）
        break
    }
  }

  // —— 有了 tool/start 后，没有开始记录的调用就是“未执行” ——
  if (t.capabilities.toolEvents) {
    for (const c of calls.values()) if (c.timing !== 'log' && c.status === 'done') c.status = 'not_run'
  }

  // —— 运行时数据补齐 ——
  if (live) {
    if (t.metaSource === 'none' && live.meta && Object.keys(live.meta).length) {
      t.meta = { ...live.meta }
      t.metaSource = 'live'
    }
    for (const s of steps.values()) {
      const h = live.steps.get(s.stepId)
      if (!h) continue
      if (s.ttftSource === 'unavailable' && h.firstTokenAt !== undefined) {
        s.firstTokenAt = h.firstTokenAt
        s.startedAt ??= h.attemptStartedAt ?? s.requestAt
        s.ttftSource = 'live'
      }
    }
    for (const c of calls.values()) {
      const h = live.tools.get(c.callId)
      if (!h) continue
      if (h.progress.length) c.progress = [...h.progress]
      if (c.timing === 'log') continue
      if (h.startedAt !== undefined) {
        c.startedAt = h.startedAt
        if (h.endedAt !== undefined) c.endedAt = h.endedAt
        if (c.durationMs === undefined && h.endedAt !== undefined) c.durationMs = h.endedAt - h.startedAt
        c.timing = 'live'
        if (c.status === 'not_run') c.status = 'done'
      }
    }
  }

  // —— 派生字段 ——
  for (const tr of t.turns) {
    if (tr.status === 'running' && !t.running) tr.status = 'done'
    for (const s of tr.steps) {
      if (s.status === 'running' && !t.running) s.status = 'failed'
      if (s.firstTokenAt !== undefined) {
        const start = s.startedAt ?? s.requestAt
        if (start !== undefined) s.ttftMs = Math.max(0, s.firstTokenAt - start)
        if (s.endedAt !== undefined) s.decodeMs = Math.max(0, s.endedAt - s.firstTokenAt)
      }
      for (const c of s.tools) if (c.status === 'running' && !t.running) c.status = 'done'
    }
    t.stats.steps += tr.steps.length
  }
  t.stats.turns = t.turns.length
  return t
}

export function addChild(list: ChildLink[], link: ChildLink): void {
  const existing = list.find((x) => x.sessionId === link.sessionId)
  if (existing) {
    // 更可靠的依据覆盖较弱的
    const rank = { meta: 4, result: 3, live: 2, naming: 1 } as const
    if (rank[link.via] > rank[existing.via]) Object.assign(existing, link)
    else {
      existing.origin ??= link.origin
      existing.label ??= link.label
    }
    return
  }
  list.push(link)
}

/** 在投影里找一次工具调用 */
export function findCall(t: SessionTrajectory, callId: string): ToolCallRecord | undefined {
  for (const tr of t.turns) for (const s of tr.steps) for (const c of s.tools) if (c.callId === callId) return c
  return undefined
}

/** 所有已挂上的子会话 id */
export function childIds(t: SessionTrajectory): string[] {
  const out = new Set<string>()
  for (const l of t.children) out.add(l.sessionId)
  for (const tr of t.turns) {
    for (const l of tr.children) out.add(l.sessionId)
    for (const s of tr.steps) for (const c of s.tools) for (const l of c.children) out.add(l.sessionId)
  }
  return [...out]
}
