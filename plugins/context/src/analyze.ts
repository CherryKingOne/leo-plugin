/**
 * 会话日志 → 上下文报告（纯函数，不碰 IO）。
 *
 * 口径：所有“组成”数字都是本地近似 token，与 leo-agents 的 `estimatedTokens` 相同（UTF-8 字节 / 3.5），
 * 只用于看比例和趋势；真实计费以 `llm/response.usage` 为准。
 *
 * 宿主兼容：
 * - leo-agents ≥ 0.2.3：`llm/request.breakdown` 直接给出 system 各片段（含来源插件）、每个工具定义、窗口与预留
 * - 更早：system 整体算作 system，工具定义 = estimatedTokens − system − 消息（推算），窗口取模型信息或底座默认值
 */
import type {
  BrowserItem,
  Category,
  CommandRun,
  Composition,
  ContextEventRecord,
  ContextWindowInfo,
  CurrentContext,
  FileActivity,
  FileOp,
  RawEvent,
  RequestDetail,
  RequestPoint,
  SessionMetaLike,
  SessionReport,
  ToolStat,
  UsageTotals,
} from './types.js'
import { CATEGORIES } from './types.js'

// —— 宿主数据的最小结构 ——
interface Block {
  type: string
  text?: string
  id?: string
  name?: string
  arguments?: unknown
  rawArguments?: string
  url?: string
}
interface Msg {
  id: string
  role: string
  content: Block[]
  toolCallId?: string
  toolName?: string
  isError?: boolean
  createdAt?: number
  meta?: Record<string, unknown>
}
interface Breakdown {
  sections?: { id: string; layer: string; owner: string; tokens: number }[]
  tools?: Record<string, number>
  messages?: number
  contextWindow?: number
  reserveOutputTokens?: number
  limitTokens?: number
  softLimitTokens?: number
}
interface ReqData {
  turnId: string
  stepId: string
  model: string
  system?: string
  messageIds?: string[]
  tools?: string[]
  params?: Record<string, unknown>
  estimatedTokens?: number
  breakdown?: Breakdown
}
interface UsageLike {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  reasoningTokens?: number
  costUsd?: number
}

export interface PricingLike {
  inputPerMTok: number
  outputPerMTok: number
  cachedInputPerMTok?: number
}

export interface AnalyzeOptions {
  /** 模型价目（取自 llm 服务的 ModelInfo），没有返回 undefined */
  pricing?: (model: string) => PricingLike | undefined
  /** 模型窗口信息，没有返回 undefined */
  modelInfo?: (model: string) => { contextWindow?: number; maxOutputTokens?: number } | undefined
  /** 命令执行列表最多保留多少条（最近的） */
  maxCommands?: number
}

/** 与底座一致的默认预算 */
export const DEFAULT_WINDOW = 128_000
export const DEFAULT_RESERVE = 8192
export const DEFAULT_SOFT_RATIO = 0.85

export function approxTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3.5)
}

const json = (v: unknown): string => {
  try {
    return JSON.stringify(v) ?? ''
  } catch {
    return ''
  }
}

export const emptyComposition = (): Composition => Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Composition

export function addComposition(a: Composition, b: Composition): Composition {
  for (const c of CATEGORIES) a[c] += b[c]
  return a
}

const roleCategory = (role: string): Category => (role === 'user' ? 'user' : role === 'assistant' ? 'answers' : role === 'tool' ? 'toolResults' : role === 'system' ? 'system' : 'injected')

/** 一条消息按内容块拆分到各分类（块的 JSON 大小；消息自身的字段开销归到主分类） */
export function messageComposition(m: Msg): Composition {
  const out = emptyComposition()
  const total = approxTokens(json(m))
  if (m.meta?.compaction === true) {
    out.summary = total
    return out
  }
  const base = roleCategory(m.role)
  let used = 0
  let main: Category = base
  let mainTokens = -1
  for (const b of m.content ?? []) {
    const t = approxTokens(json(b))
    const cat: Category = b.type === 'reasoning' ? 'reasoning' : b.type === 'tool_call' ? 'toolCalls' : base
    out[cat] += t
    used += t
    if (t > mainTokens) {
      mainTokens = t
      main = cat
    }
  }
  out[main] += Math.max(0, total - used)
  return out
}

/** 解析 shell 命令里实际运行的程序名（跳过环境变量赋值与 sudo / env / time / nohup 之类前缀） */
export function programOf(command: string): string {
  const first = command.trim().split(/&&|\|\||;|\|/)[0] ?? ''
  const words = first.trim().split(/\s+/).filter(Boolean)
  const skip = new Set(['sudo', 'env', 'time', 'nohup', 'exec', 'command', 'builtin', 'nice'])
  for (const w of words) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue
    if (skip.has(w)) continue
    if (w.startsWith('-')) continue
    return w.split('/').pop() || w
  }
  return words[0] ?? ''
}

const FILE_TOOLS: Record<string, FileOp> = { read_file: 'read', write_file: 'write', edit_file: 'edit', list_dir: 'list', grep: 'search' }
const COMMAND_TOOLS = new Set(['bash'])
const SKILL_TOOL = 'skill'

interface CallInfo {
  callId: string
  name: string
  args: unknown
  argTokens: number
  at: number
  stepId?: string
  start?: number
  end?: number
  durationMs?: number
  result?: Msg
}

/** 一次请求的内部记录 */
interface Req {
  seq: number
  at: number
  data: ReqData
  usage?: UsageLike
  responseAt?: number
  startedAt?: number
  firstTokenAt?: number
  failed: number
  compactedBefore?: { strategy: string; summaryTokens: number }
}

export interface Analysis {
  report: SessionReport
  /** 浏览器用：按请求下标取明细 */
  detail(index: number, opts: { offset?: number; limit?: number; category?: Category | undefined; preview: (v: unknown) => string }): RequestDetail | undefined
}

export function analyzeSession(sessionId: string, events: RawEvent[], opts: AnalyzeOptions = {}): Analysis {
  const messages = new Map<string, Msg>()
  const msgComp = new Map<string, Composition>()
  const msgTokens = new Map<string, number>()
  const reqs: Req[] = []
  const reqByStep = new Map<string, Req>()
  // 工具调用按出现顺序记录；callId 只在“还没拿到结果”的调用里查找（有的厂商会在不同轮次复用 call_0 这类 id）
  const calls: CallInfo[] = []
  const openCalls = new Map<string, CallInfo>()
  const ctxEvents: ContextEventRecord[] = []
  const turnStart = new Map<string, number>()
  const turnIndex = new Map<string, number>()
  let meta: SessionMetaLike = {}
  let turns = 0
  let activeMs = 0
  let failedAttempts = 0
  let userInputs = 0
  let pendingCompaction: { strategy: string; summaryTokens: number; at: number } | undefined
  let hasToolEvents = false
  let hasBreakdown = false
  const lastAt = events.length ? events[events.length - 1]!.at : 0

  const compOf = (id: string): Composition | undefined => msgComp.get(id)
  const remember = (m: Msg) => {
    if (!m?.id) return
    messages.set(m.id, m)
    msgComp.set(m.id, messageComposition(m))
    msgTokens.set(m.id, approxTokens(json(m)))
  }

  for (const e of events) {
    const d = e.data as any
    switch (e.type) {
      case 'session/meta':
        meta = { ...meta, ...(d ?? {}) }
        break
      case 'turn/start':
        turns++
        turnStart.set(d?.turnId, e.at)
        turnIndex.set(d?.turnId, turns)
        break
      case 'turn/end': {
        const s = turnStart.get(d?.turnId)
        if (s !== undefined) {
          activeMs += Math.max(0, e.at - s)
          turnStart.delete(d?.turnId)
        }
        if (d?.error) ctxEvents.push({ kind: 'error', at: e.at, text: `turn 出错：${d.error.code}${d.error.message ? ` · ${String(d.error.message).slice(0, 160)}` : ''}` })
        break
      }
      case 'message': {
        const m = d?.message as Msg | undefined
        if (!m) break
        remember(m)
        if (m.role === 'user' && m.meta?.compaction !== true) userInputs++
        if (m.role === 'assistant') {
          for (const b of m.content ?? []) {
            if (b.type !== 'tool_call' || !b.id) continue
            const c: CallInfo = { callId: b.id, name: b.name ?? '?', args: b.arguments, argTokens: approxTokens(json(b)), at: e.at }
            calls.push(c)
            openCalls.set(b.id, c)
          }
        }
        if (m.role === 'tool' && m.toolCallId) {
          const c = openCalls.get(m.toolCallId)
          if (c) {
            c.result = m
            openCalls.delete(m.toolCallId)
          }
        }
        break
      }
      case 'compaction': {
        const summary = d?.summary as Msg | undefined
        if (summary) remember({ ...summary, meta: { ...(summary.meta ?? {}), compaction: true } })
        pendingCompaction = { strategy: String(d?.strategy ?? '?'), summaryTokens: summary ? approxTokens(json(summary)) : 0, at: e.at }
        break
      }
      case 'llm/request': {
        const r: Req = { seq: e.seq, at: e.at, data: d as ReqData, failed: 0 }
        if (r.data?.breakdown) hasBreakdown = true
        if (pendingCompaction) {
          r.compactedBefore = { strategy: pendingCompaction.strategy, summaryTokens: pendingCompaction.summaryTokens }
          pendingCompaction = undefined
        }
        reqs.push(r)
        if (r.data?.stepId) reqByStep.set(r.data.stepId, r)
        break
      }
      case 'llm/response': {
        const r = reqByStep.get(d?.stepId)
        if (!r) break
        r.usage = d?.usage
        r.responseAt = e.at
        if (typeof d?.startedAt === 'number') r.startedAt = d.startedAt
        if (typeof d?.firstTokenAt === 'number') r.firstTokenAt = d.firstTokenAt
        break
      }
      case 'llm/attempt-failed': {
        failedAttempts++
        const r = reqByStep.get(d?.stepId)
        if (r) r.failed++
        ctxEvents.push({ kind: 'retry', at: e.at, ...(r ? { requestIndex: reqs.indexOf(r) } : {}), text: `第 ${d?.attempt ?? '?'} 次尝试失败：${d?.code ?? '?'}${d?.message ? ` · ${String(d.message).slice(0, 160)}` : ''}` })
        break
      }
      case 'tool/start': {
        hasToolEvents = true
        const c = openCalls.get(d?.callId)
        if (c) {
          c.start = d?.at ?? e.at
          c.stepId = d?.stepId
        }
        break
      }
      case 'tool/end': {
        hasToolEvents = true
        const c = openCalls.get(d?.callId)
        if (c) {
          if (typeof d?.startedAt === 'number') c.start = d.startedAt
          c.end = d?.endedAt ?? e.at
          if (typeof d?.durationMs === 'number') c.durationMs = d.durationMs
          c.stepId = d?.stepId ?? c.stepId
        }
        break
      }
      default:
        break
    }
  }
  // 进行中的 turn：算到最后一条事件
  for (const s of turnStart.values()) activeMs += Math.max(0, lastAt - s)

  // —— 每次请求的组成 ——
  const windowFor = (r: Req): ContextWindowInfo => {
    const b = r.data.breakdown
    if (b?.contextWindow && b.reserveOutputTokens !== undefined) {
      const limit = b.limitTokens ?? Math.max(1024, b.contextWindow - b.reserveOutputTokens)
      return { contextWindow: b.contextWindow, reserveOutputTokens: b.reserveOutputTokens, limitTokens: limit, softLimitTokens: b.softLimitTokens ?? Math.floor(limit * DEFAULT_SOFT_RATIO), source: 'log' }
    }
    const info = opts.modelInfo?.(r.data.model)
    const p = r.data.params ?? {}
    const reserve = (typeof p.maxOutputTokens === 'number' ? p.maxOutputTokens : undefined) ?? info?.maxOutputTokens ?? DEFAULT_RESERVE
    const window = info?.contextWindow ?? DEFAULT_WINDOW
    const limit = Math.max(1024, window - reserve)
    return { contextWindow: window, reserveOutputTokens: reserve, limitTokens: limit, softLimitTokens: Math.floor(limit * DEFAULT_SOFT_RATIO), source: info?.contextWindow ? 'model' : 'default' }
  }

  const compositionOf = (r: Req): { comp: Composition; injectedBy: Record<string, number>; source: 'log' | 'estimate' } => {
    const comp = emptyComposition()
    const injectedBy: Record<string, number> = {}
    const ids = r.data.messageIds ?? []
    let known = 0
    for (const id of ids) {
      const c = compOf(id)
      if (!c) continue
      addComposition(comp, c)
      known += msgTokens.get(id) ?? 0
    }
    const b = r.data.breakdown
    if (b?.sections) {
      for (const s of b.sections) {
        if (s.owner === 'agent') comp.system += s.tokens
        else {
          comp.injected += s.tokens
          injectedBy[s.owner] = (injectedBy[s.owner] ?? 0) + s.tokens
        }
      }
      comp.tools = Object.values(b.tools ?? {}).reduce((n, t) => n + t, 0)
      // 日志里没有的消息（context/transform 注入、修补的工具结果）：归到插件注入
      const residual = Math.max(0, (b.messages ?? known) - known)
      if (residual) {
        comp.injected += residual
        injectedBy['(messages)'] = (injectedBy['(messages)'] ?? 0) + residual
      }
      return { comp, injectedBy, source: 'log' }
    }
    comp.system = r.data.system ? approxTokens(r.data.system) : 0
    const est = r.data.estimatedTokens ?? 0
    comp.tools = (r.data.tools?.length ?? 0) > 0 ? Math.max(0, est - comp.system - known) : 0
    return { comp, injectedBy, source: 'estimate' }
  }

  const trend: RequestPoint[] = []
  let prev: Req | undefined
  reqs.forEach((r, index) => {
    const { comp, source } = compositionOf(r)
    const u = r.usage
    const point: RequestPoint = {
      index,
      at: r.at,
      turnId: r.data.turnId,
      stepId: r.data.stepId,
      turn: turnIndex.get(r.data.turnId) ?? 0,
      model: r.data.model,
      estimatedTokens: r.data.estimatedTokens ?? 0,
      composition: comp,
      source,
      messages: r.data.messageIds?.length ?? 0,
      tools: r.data.tools?.length ?? 0,
      failedAttempts: r.failed,
      ...(u
        ? {
            usage: {
              inputTokens: u.inputTokens ?? 0,
              cachedInputTokens: u.cachedInputTokens ?? 0,
              outputTokens: u.outputTokens ?? 0,
              reasoningTokens: u.reasoningTokens ?? 0,
              ...(u.costUsd ? { costUsd: u.costUsd } : {}),
            },
          }
        : {}),
      ...(r.responseAt !== undefined ? { durationMs: Math.max(0, r.responseAt - r.at) } : {}),
      ...(r.firstTokenAt !== undefined && r.startedAt !== undefined ? { ttftMs: Math.max(0, r.firstTokenAt - r.startedAt) } : {}),
      ...(r.compactedBefore ? { compacted: true } : {}),
    }
    trend.push(point)

    // —— 上下文事件 ——
    if (r.compactedBefore) {
      ctxEvents.push({
        kind: 'compaction',
        at: r.at,
        requestIndex: index,
        text: `压缩（${r.compactedBefore.strategy}）：较早的消息换成约 ${r.compactedBefore.summaryTokens} token 的摘要`,
        ...(prev ? { before: prev.data.estimatedTokens ?? 0 } : {}),
        after: point.estimatedTokens,
      })
    } else if (prev) {
      const prevIds = prev.data.messageIds ?? []
      const curIds = r.data.messageIds ?? []
      const pos = curIds.length ? prevIds.indexOf(curIds[0]!) : -1
      if (pos > 0) {
        ctxEvents.push({ kind: 'truncation', at: r.at, requestIndex: index, text: `超出上限，丢弃了最早的 ${pos} 条消息`, before: prev.data.estimatedTokens ?? 0, after: point.estimatedTokens })
      }
    }
    if (prev && prev.data.model !== r.data.model) ctxEvents.push({ kind: 'model', at: r.at, requestIndex: index, text: `模型切换：${prev.data.model} → ${r.data.model}` })
    if (prev) {
      const a = new Set(prev.data.tools ?? [])
      const b = new Set(r.data.tools ?? [])
      const added = [...b].filter((x) => !a.has(x))
      const removed = [...a].filter((x) => !b.has(x))
      if (added.length || removed.length) {
        ctxEvents.push({
          kind: 'tools',
          at: r.at,
          requestIndex: index,
          text: `工具变化：${added.length ? `+${added.join(', ')}` : ''}${added.length && removed.length ? '；' : ''}${removed.length ? `−${removed.join(', ')}` : ''}`,
          detail: { added, removed },
        })
      }
      const ps = prev.data.breakdown?.sections
      const cs = r.data.breakdown?.sections
      if (ps && cs) {
        const pa = new Set(ps.map((s) => s.id))
        const ca = new Set(cs.map((s) => s.id))
        const sAdded = [...ca].filter((x) => !pa.has(x))
        const sRemoved = [...pa].filter((x) => !ca.has(x))
        if (sAdded.length || sRemoved.length) {
          ctxEvents.push({
            kind: 'sections',
            at: r.at,
            requestIndex: index,
            text: `system 片段变化：${sAdded.length ? `+${sAdded.join(', ')}` : ''}${sAdded.length && sRemoved.length ? '；' : ''}${sRemoved.length ? `−${sRemoved.join(', ')}` : ''}`,
            detail: { added: sAdded, removed: sRemoved },
          })
        }
      }
    }
    prev = r
  })
  ctxEvents.sort((a, b) => a.at - b.at)

  // —— 当前上下文 ——
  let current: CurrentContext | undefined
  const last = reqs[reqs.length - 1]
  if (last) {
    const { comp, injectedBy, source } = compositionOf(last)
    const window = windowFor(last)
    const est = last.data.estimatedTokens ?? 0
    current = {
      requestIndex: reqs.length - 1,
      at: last.at,
      model: last.data.model,
      estimatedTokens: est,
      composition: comp,
      source,
      injectedBy,
      ...(last.data.breakdown?.sections ? { sections: last.data.breakdown.sections } : {}),
      ...(last.data.breakdown?.tools ? { toolDefs: last.data.breakdown.tools } : {}),
      window,
      occupancy: window.contextWindow ? est / window.contextWindow : 0,
      untilCompaction: window.softLimitTokens - est,
    }
  }

  // —— 用量与成本 ——
  const usage: UsageTotals = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, billedTokens: 0, costUsd: 0, costSource: 'none' }
  let provCost = 0
  let priceCost = 0
  for (const r of reqs) {
    const u = r.usage
    if (!u) continue
    const input = u.inputTokens ?? 0
    const cached = u.cachedInputTokens ?? 0
    const output = u.outputTokens ?? 0
    usage.inputTokens += input
    usage.cachedInputTokens += cached
    usage.outputTokens += output
    usage.reasoningTokens += u.reasoningTokens ?? 0
    if (u.costUsd && u.costUsd > 0) provCost += u.costUsd
    else {
      const p = opts.pricing?.(r.data.model)
      if (p) priceCost += ((input - cached) * p.inputPerMTok + cached * (p.cachedInputPerMTok ?? p.inputPerMTok) + output * p.outputPerMTok) / 1e6
    }
  }
  usage.billedTokens = usage.inputTokens + usage.outputTokens
  usage.costUsd = provCost + priceCost
  usage.costSource = provCost && priceCost ? 'mixed' : provCost ? 'provider' : priceCost ? 'pricing' : 'none'
  if (usage.inputTokens > 0) usage.cacheHitRate = usage.cachedInputTokens / usage.inputTokens

  // —— 工具、文件、命令、技能 ——
  const toolStats = new Map<string, ToolStat>()
  const files = new Map<string, FileActivity>()
  const commands: CommandRun[] = []
  const skills = new Map<string, { name: string; loads: number; lastAt: number }>()
  let toolErrors = 0
  let toolCalls = 0
  let reportedToolMs = 0
  for (const c of calls) {
    const callId = c.callId
    const res = c.result
    if (!res && c.end === undefined) continue // 还没执行完 / 被打断：不计
    toolCalls++
    const isError = res?.isError === true
    if (isError) toolErrors++
    const reported = typeof res?.meta?.durationMs === 'number' ? (res.meta.durationMs as number) : undefined
    const dur = c.durationMs ?? (c.start !== undefined && c.end !== undefined ? c.end - c.start : reported)
    if (reported !== undefined) reportedToolMs += reported
    const s = toolStats.get(c.name) ?? { name: c.name, calls: 0, errors: 0, totalMs: 0, argTokens: 0, resultTokens: 0, lastAt: 0 }
    s.calls++
    if (isError) s.errors++
    s.totalMs += dur ?? 0
    s.argTokens += c.argTokens
    s.resultTokens += res ? (msgTokens.get(res.id) ?? 0) : 0
    s.lastAt = Math.max(s.lastAt, c.at)
    toolStats.set(c.name, s)

    const args = (c.args ?? {}) as Record<string, unknown>
    const op = FILE_TOOLS[c.name]
    if (op) {
      const path = typeof args.path === 'string' && args.path ? args.path : '.'
      const f = files.get(path) ?? { path, ops: {}, errors: 0, lastAt: 0 }
      f.ops[op] = (f.ops[op] ?? 0) + 1
      if (isError) f.errors++
      f.lastAt = Math.max(f.lastAt, c.at)
      files.set(path, f)
    }
    if (COMMAND_TOOLS.has(c.name) && typeof args.command === 'string') {
      commands.push({ at: c.at, callId, command: args.command, program: programOf(args.command), ok: !isError, ...(dur !== undefined ? { durationMs: dur } : {}) })
    }
    if (c.name === SKILL_TOOL && typeof args.name === 'string' && !isError) {
      const k = skills.get(args.name) ?? { name: args.name, loads: 0, lastAt: 0 }
      k.loads++
      k.lastAt = Math.max(k.lastAt, c.at)
      skills.set(args.name, k)
    }
  }

  // —— 耗时 ——
  let modelMs = 0
  for (const r of reqs) if (r.responseAt !== undefined) modelMs += Math.max(0, r.responseAt - r.at)
  let toolMs = 0
  let toolSource: SessionReport['stats']['timing']['toolSource'] = 'none'
  if (hasToolEvents) {
    toolSource = 'log'
    const spans = new Map<string, { start: number; end: number }>()
    for (const t of calls) {
      if (t.start === undefined || t.end === undefined) continue
      const key = t.stepId ?? '?'
      const s = spans.get(key)
      spans.set(key, s ? { start: Math.min(s.start, t.start), end: Math.max(s.end, t.end) } : { start: t.start, end: t.end })
    }
    for (const s of spans.values()) toolMs += Math.max(0, s.end - s.start)
  } else if (reportedToolMs > 0) {
    toolSource = 'reported'
    toolMs = reportedToolMs
  }

  const keepCommands = opts.maxCommands ?? 500
  const report: SessionReport = {
    sessionId,
    ...(events.length ? { createdAt: events[0]!.at, updatedAt: lastAt } : {}),
    events: events.length,
    meta,
    models: [...new Set(reqs.map((r) => r.data.model))],
    stats: {
      turns,
      steps: reqs.length,
      userInputs,
      toolCalls,
      toolErrors,
      compactions: ctxEvents.filter((x) => x.kind === 'compaction').length,
      failedAttempts,
      usage,
      timing: { activeMs, modelMs, toolMs, overheadMs: Math.max(0, activeMs - modelMs - toolMs), toolSource },
    },
    ...(current ? { current } : {}),
    trend,
    contextEvents: ctxEvents,
    tools: [...toolStats.values()].sort((a, b) => b.calls - a.calls || b.lastAt - a.lastAt),
    files: [...files.values()].sort((a, b) => b.lastAt - a.lastAt),
    commands: commands.slice(-keepCommands).reverse(),
    skills: [...skills.values()].sort((a, b) => b.loads - a.loads),
    children: [],
    completeness: { breakdown: hasBreakdown, toolTiming: hasToolEvents },
  }

  const detail: Analysis['detail'] = (index, o) => {
    const r = reqs[index]
    if (!r) return undefined
    const { comp, source } = compositionOf(r)
    const items: BrowserItem[] = []
    const b = r.data.breakdown
    if (b?.sections) {
      for (const s of b.sections) items.push({ kind: 'section', id: s.id, category: s.owner === 'agent' ? 'system' : 'injected', tokens: s.tokens, label: `${s.layer} · ${s.owner}`, preview: '' })
    } else if (r.data.system) {
      items.push({ kind: 'section', id: 'system', category: 'system', tokens: comp.system, label: 'system（日志没有片段明细）', preview: '' })
    }
    // system 全文只存了一份：片段预览按顺序从全文里切（片段之间以空行分隔，和底座拼接方式一致）
    if (r.data.system) {
      const sys = r.data.system
      const sectionItems = items.filter((i) => i.kind === 'section')
      if (sectionItems.length === 1) sectionItems[0]!.preview = o.preview(sys)
      else if (sectionItems.length > 1) {
        let rest = sys
        sectionItems.forEach((it, i) => {
          if (i === sectionItems.length - 1) {
            it.preview = o.preview(rest)
            return
          }
          // 按 token 估算的字节数切：近似，但足够定位
          const bytes = Math.max(1, Math.round(it.tokens * 3.5))
          const buf = Buffer.from(rest, 'utf8')
          const cut = buf.subarray(0, bytes).toString('utf8').replace(/\uFFFD$/, '')
          it.preview = o.preview(cut.trim())
          rest = rest.slice(cut.length).replace(/^\s+/, '')
        })
      }
    }
    if (b?.tools) for (const [name, t] of Object.entries(b.tools)) items.push({ kind: 'tool', id: name, category: 'tools', tokens: t, label: 'tool', preview: '' })
    else for (const name of r.data.tools ?? []) items.push({ kind: 'tool', id: name, category: 'tools', tokens: 0, label: 'tool（日志没有单个工具的大小）', preview: '' })
    for (const id of r.data.messageIds ?? []) {
      const m = messages.get(id)
      if (!m) {
        items.push({ kind: 'message', id, category: 'injected', tokens: 0, label: '（不在日志里：插件注入或修补的消息）', preview: '' })
        continue
      }
      const c = msgComp.get(id)!
      let cat: Category = 'user'
      let best = -1
      for (const k of CATEGORIES) if (c[k] > best) ((best = c[k]), (cat = k))
      const label = m.role === 'tool' ? `tool · ${m.toolName ?? '?'}${m.isError ? ' · 出错' : ''}` : m.meta?.compaction === true ? 'summary' : m.role
      items.push({ kind: 'message', id, category: cat, tokens: msgTokens.get(id) ?? 0, label, preview: o.preview(messagePreview(m)) })
    }
    const filtered = o.category ? items.filter((i) => i.category === o.category) : items
    const offset = Math.max(0, o.offset ?? 0)
    const limit = Math.max(1, Math.min(200, o.limit ?? 50))
    return {
      index,
      at: r.at,
      model: r.data.model,
      composition: comp,
      source,
      total: filtered.length,
      offset,
      limit,
      items: filtered.slice(offset, offset + limit),
    }
  }

  return { report, detail }
}

function messagePreview(m: Msg): string {
  const parts: string[] = []
  for (const b of m.content ?? []) {
    if (b.type === 'text') parts.push(b.text ?? '')
    else if (b.type === 'reasoning') parts.push(`〔思考〕${b.text ?? ''}`)
    else if (b.type === 'tool_call') parts.push(`〔调用 ${b.name}〕${b.rawArguments ?? json(b.arguments)}`)
    else if (b.type === 'image') parts.push(`〔图片〕${(b.url ?? '').startsWith('data:') ? `${(b.url ?? '').slice(0, 30)}…` : (b.url ?? '')}`)
  }
  return parts.join('\n')
}
