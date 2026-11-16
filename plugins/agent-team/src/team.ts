import type { Agent, AgentEvent, AgentMessage, AgentOptions, Context, StopReason, Usage } from 'leo-agents'
import { type AgentTeamConfig, GATE_OF, PHASE_LABELS, PHASES, type Phase, type ResolvedRole } from './config.js'
import { INTERNAL_TOOLS, LEADER_TOOLS, MAIN_TOOLS, MEMBER_TOOLS, leaderInstructions, memberInstructions } from './prompts.js'
import type { PendingGate, ProjectStatus, ProjectStore, TeamBoard, TeamProject, TeamTask } from './store.js'

// ───────────────────────── 公共类型 ─────────────────────────

/** 进度（ToolProgress 约定：界面显示 message） */
export interface TeamProgress {
  type: 'progress'
  message: string
  projectId: string
  role: string
  tool?: string
}

export interface TeamRunResult {
  projectId: string
  title: string
  status: ProjectStatus
  phase: Phase
  /** Leader 本轮的汇报（已截断） */
  report: string
  /** Leader 本轮的停止原因 */
  reason: StopReason
  awaiting?: { kind: PendingGate['kind']; gate: string; question: string }
  error?: { code: string; message: string }
}

export interface RunOpts {
  /** 发起者 Agent id：模型、工具集、租户从它继承 */
  parentAgentId?: string
  signal?: AbortSignal
  onProgress?(p: TeamProgress): void
}

export type ReplyDecision = 'approve' | 'reject' | 'message' | 'continue'

export interface ProjectSummary {
  id: string
  title: string
  status: ProjectStatus
  phase: Phase
  bounces: number
  awaiting?: string
  running: boolean
  updatedAt: string
}

/** `ctx.get('agentTeam')` */
export interface AgentTeamService {
  /** 生效的角色（内置 + 文件 + 配置） */
  roles(): Readonly<Record<string, ResolvedRole>>
  /** 新建项目并运行 Leader，直到暂停（等待审批）、结束或本轮结束 */
  start(opts: RunOpts & { requirement: string; title?: string }): Promise<TeamRunResult>
  /** 把用户的决定 / 消息交给 Leader 并继续运行 */
  reply(opts: RunOpts & { projectId?: string; decision: ReplyDecision; text?: string }): Promise<TeamRunResult>
  /** 只记录审批（不运行 Leader），返回说明；之后用 reply({ decision: 'continue' }) 继续 */
  approve(projectId: string | undefined, note?: string): Promise<string>
  reject(projectId: string | undefined, reason: string): Promise<string>
  /** 停止项目：取消正在运行的 Leader 与成员 */
  stop(projectId?: string): Promise<string>
  list(): Promise<ProjectSummary[]>
  get(projectId?: string): Promise<{ project: TeamProject; board: TeamBoard } | undefined>
  /** 人类可读的状态 */
  status(projectId?: string): Promise<string>
  /** 当前项目：最近更新的未结束项目 */
  current(): Promise<string | undefined>
}

export class TeamError extends Error {
  constructor(
    readonly code: 'no_project' | 'busy' | 'invalid' | 'no_model' | 'cancelled',
    message: string,
  ) {
    super(message)
    this.name = 'TeamError'
  }
}

export interface TeamEvents {
  'agent-team/phase-started': { projectId: string; phase: Phase }
  'agent-team/phase-finished': { projectId: string; phase: Phase }
  'agent-team/bounced': { projectId: string; bounces: number; maxBounces: number; reason: string }
  'agent-team/awaiting-approval': { projectId: string; phase: Phase; kind: PendingGate['kind']; gate: string; question: string }
  'agent-team/finished': { projectId: string; status: 'finished' | 'stopped' }
}

// ───────────────────────── 内部结构 ─────────────────────────

export interface Delivery {
  summary: string
  artifacts: string[]
  verdict?: 'pass' | 'fail'
}

/** 一个团队 Agent 当前这一轮在做什么（工具据此判断权限与上下文） */
export interface MemberRun {
  projectId: string
  role: string
  kind: 'leader' | 'assign' | 'ask'
  taskId?: string
  /** team_ask 的嵌套深度：被指派的任务为 0 */
  depth: number
  /** 当前提问链上的角色，防止 A 问 B、B 又问 A 的死锁 */
  chain: string[]
  asks: number
  delivery?: Delivery
}

interface Entry {
  project: TeamProject
  board: TeamBoard
  saving: Promise<void>
  /** 正在运行的 Leader（同一项目同时只有一个） */
  controller?: AbortController
  progress?: (p: TeamProgress) => void
}

/** 公平的计数信号量，等待可被取消 */
class Semaphore {
  private active = 0
  private readonly waiters: (() => void)[] = []
  constructor(private readonly limit: number) {}
  get busy(): boolean {
    return this.active >= this.limit
  }
  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new TeamError('cancelled', 'Cancelled before start'))
    if (this.active < this.limit) {
      this.active++
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener('abort', onAbort)
        this.active++
        resolve()
      }
      const onAbort = () => {
        const i = this.waiters.indexOf(grant)
        if (i >= 0) this.waiters.splice(i, 1)
        reject(new TeamError('cancelled', 'Cancelled while waiting'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(grant)
    })
  }
  release(): void {
    this.active--
    this.waiters.shift()?.()
  }
}

const now = () => new Date().toISOString()
const zeroUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0 })

function textOf(message: AgentMessage | undefined): string {
  if (!message) return ''
  return message.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

function preview(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const a = args as Record<string, unknown>
  const v = a.role ?? a.command ?? a.path ?? a.name ?? a.url ?? a.pattern ?? a.title
  const s = typeof v === 'string' ? v : ''
  return s.length > 60 ? `${s.slice(0, 60)}…` : s
}

function newProjectId(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`
}

// ───────────────────────── 引擎 ─────────────────────────

export class TeamEngine {
  private readonly entries = new Map<string, Entry>()
  /** `${projectId}:${role}` → Agent */
  private readonly agents = new Map<string, Agent>()
  /** agentId → 团队身份与允许的工具（工具守卫用） */
  readonly members = new Map<string, { projectId: string; role: string; tools: string[] }>()
  /** agentId → 当前这一轮 */
  readonly runs = new Map<string, MemberRun>()
  /** 每个成员一把锁：同一成员（尤其唯一的开发）同时只做一件事 */
  private readonly locks = new Map<string, Promise<void>>()
  private readonly lockHeld = new Set<string>()
  private readonly semaphore: Semaphore
  private disposed = false

  constructor(
    private readonly ctx: Context<any>,
    readonly config: AgentTeamConfig,
    readonly roles: Record<string, ResolvedRole>,
    readonly store: ProjectStore,
  ) {
    this.semaphore = new Semaphore(config.maxConcurrent)
  }

  // ── 项目存取 ──

  async entry(projectId: string): Promise<Entry> {
    const cached = this.entries.get(projectId)
    if (cached) return cached
    const loaded = await this.store.load(projectId)
    if (!loaded) throw new TeamError('no_project', `Unknown team project "${projectId}"`)
    const again = this.entries.get(projectId)
    if (again) return again
    const e: Entry = { ...loaded, saving: Promise.resolve() }
    this.entries.set(projectId, e)
    return e
  }

  /** 串行写盘：每次都序列化最新状态，避免并发写乱序 */
  save(e: Entry): Promise<void> {
    e.project.updatedAt = now()
    const run = e.saving.then(() => this.store.save(e.project, e.board))
    e.saving = run.catch((err) => this.ctx.logger.error({ err }, 'agent-team: failed to save project'))
    return run
  }

  async resolveId(projectId?: string): Promise<string> {
    if (projectId) return projectId
    const cur = await this.current()
    if (!cur) throw new TeamError('no_project', 'No active team project. Start one with team_start, or pass a project id (/team list).')
    return cur
  }

  async current(): Promise<string | undefined> {
    const list = await this.list()
    return list.filter((p) => p.status !== 'finished').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id
  }

  async list(): Promise<ProjectSummary[]> {
    const ids = new Set([...(await this.store.ids()), ...this.entries.keys()])
    const out: ProjectSummary[] = []
    for (const id of ids) {
      const e = this.entries.get(id) ?? (await this.store.load(id))
      if (!e) continue
      const p = e.project
      out.push({
        id: p.id,
        title: p.title,
        status: p.status,
        phase: p.phase,
        bounces: p.bounces,
        ...(p.pendingGate ? { awaiting: p.pendingGate.gate } : {}),
        running: Boolean(this.entries.get(id)?.controller),
        updatedAt: p.updatedAt,
      })
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  private log(e: Entry, event: string, detail?: string) {
    e.project.history.push({ at: now(), event, ...(detail ? { detail: detail.slice(0, 500) } : {}) })
    if (e.project.history.length > 200) e.project.history.splice(0, e.project.history.length - 200)
  }

  private emit<K extends keyof TeamEvents>(event: K, payload: TeamEvents[K]) {
    ;(this.ctx.emit as (e: string, p: unknown) => void)(event, payload)
  }

  // ── 阶段状态机 ──

  requiredRoles(phase: Phase): string[] {
    return Object.values(this.roles)
      .filter((r) => r.phase === phase)
      .map((r) => r.id)
  }

  /** 进入阶段；没有负责角色的阶段（交付除外）自动跳过 */
  private enterPhase(e: Entry, phase: Phase): string {
    let p = phase
    const skipped: Phase[] = []
    while (p !== 'delivery' && this.requiredRoles(p).length === 0) {
      skipped.push(p)
      p = PHASES[PHASES.indexOf(p) + 1]!
    }
    e.project.phase = p
    e.project.delivered = []
    this.log(e, 'phase-started', p)
    this.emit('agent-team/phase-started', { projectId: e.project.id, phase: p })
    const owners = this.requiredRoles(p)
    return `Phase now: ${p} (${PHASE_LABELS[p]})${skipped.length ? `; skipped ${skipped.join(', ')} (no role)` : ''}. ${
      p === 'delivery' ? 'Write delivery.md with team_artifact, then call team_request_approval for final acceptance.' : `Needs deliveries from: ${owners.join(', ')}.`
    }`
  }

  private finish(e: Entry, status: 'finished' | 'stopped') {
    e.project.status = status
    delete e.project.pendingGate
    if (status === 'finished') e.project.finishedAt = now()
    this.log(e, status)
    this.emit('agent-team/finished', { projectId: e.project.id, status })
  }

  /** 当前阶段还差什么（恢复运行时告诉 Leader） */
  private phaseHint(e: Entry): string {
    const p = e.project
    if (p.phase === 'delivery') return `Phase now: delivery (${PHASE_LABELS.delivery}). Write delivery.md with team_artifact, then call team_request_approval.`
    const missing = this.requiredRoles(p.phase).filter((r) => !p.delivered.includes(r))
    return `Phase now: ${p.phase} (${PHASE_LABELS[p.phase]}). Still needs deliveries from: ${missing.join(', ') || '(none)'}.`
  }

  /** 当前阶段的必需交付都到齐：进入关卡或下一阶段 */
  private completePhase(e: Entry): string {
    const phase = e.project.phase
    this.log(e, 'phase-finished', phase)
    this.emit('agent-team/phase-finished', { projectId: e.project.id, phase })
    const gate = GATE_OF[phase]
    if (this.config.gates[gate]) {
      e.project.status = 'awaiting_approval'
      e.project.pendingGate = { kind: 'gate', gate, phase, at: now() }
      return `Phase ${phase} is complete and needs the user's approval (gate: ${gate}). Do not assign more work: call team_request_approval with a short summary and question for the user, then end your turn.`
    }
    if (phase === 'delivery') {
      this.finish(e, 'finished')
      return 'Project finished (no acceptance gate configured). Give the user a final summary.'
    }
    return `Phase ${phase} complete. ${this.enterPhase(e, PHASES[PHASES.indexOf(phase) + 1]!)}`
  }

  /** 记录一次交付并推进状态机，返回给 Leader 的阶段说明 */
  private onDelivery(e: Entry, role: string, task: TeamTask, d: Delivery): string {
    const p = e.project
    if (p.status !== 'running' || task.phase !== p.phase || !this.requiredRoles(p.phase).includes(role)) return ''
    if (p.phase === 'qa' && d.verdict === 'fail') return this.bounce(e, d.summary)
    if (p.phase === 'qa' && d.verdict !== 'pass') return 'QA delivered without a verdict; ask QA to deliver again with verdict pass or fail.'
    if (!p.delivered.includes(role)) p.delivered.push(role)
    const missing = this.requiredRoles(p.phase).filter((r) => !p.delivered.includes(r))
    if (missing.length) return `Phase ${p.phase}: still waiting for ${missing.join(', ')}.`
    return this.completePhase(e)
  }

  private bounce(e: Entry, reason: string): string {
    const p = e.project
    if (p.bounces >= this.config.maxBounces) {
      p.status = 'awaiting_approval'
      p.pendingGate = { kind: 'bounce-limit', gate: 'bounce-limit', phase: p.phase, at: now() }
      this.log(e, 'bounce-limit', reason)
      return `QA failed again and the bounce limit (${this.config.maxBounces}) is reached. Stop and ask the user how to proceed with team_request_approval (approve = deliver as is, reject = another fix round), then end your turn.`
    }
    p.bounces++
    this.log(e, 'bounced', reason)
    this.emit('agent-team/bounced', { projectId: p.id, bounces: p.bounces, maxBounces: this.config.maxBounces, reason: reason.slice(0, 500) })
    return `QA failed (bounce ${p.bounces}/${this.config.maxBounces}). ${this.enterPhase(e, 'development')} Give the developer the failures from test-report.md to fix, then send it back to QA.`
  }

  // ── 审批 ──

  async approve(projectId: string | undefined, note?: string): Promise<string> {
    const e = await this.entry(await this.resolveId(projectId))
    if (e.controller) throw new TeamError('busy', `Team project ${e.project.id} is running; wait until the Leader pauses.`)
    const p = e.project
    const g = p.pendingGate
    let msg: string
    if (!g) {
      if (p.status === 'running' && p.phase === 'delivery') {
        this.finish(e, 'finished')
        msg = 'Final acceptance approved; project finished.'
      } else {
        throw new TeamError('invalid', `Project ${p.id} is not waiting for approval (status: ${p.status}, phase: ${p.phase}).`)
      }
    } else if (g.kind === 'gate' && g.phase === 'delivery') {
      this.finish(e, 'finished')
      msg = 'Final acceptance approved; project finished.'
    } else {
      p.status = 'running'
      delete p.pendingGate
      if (g.kind === 'gate') msg = `Gate ${g.gate} approved. ${this.enterPhase(e, PHASES[PHASES.indexOf(g.phase) + 1]!)}`
      else if (g.kind === 'bounce-limit') msg = `User accepted the result despite failing QA. ${this.enterPhase(e, 'delivery')} Mention the open QA failures in delivery.md.`
      else msg = 'User approved / answered your question.'
    }
    this.log(e, 'approved', note)
    if (p.status !== 'finished') p.inbox.push(`[用户批准] ${msg}${note ? `\n用户意见：${note}` : ''}`)
    await this.save(e)
    return msg
  }

  async reject(projectId: string | undefined, reason: string): Promise<string> {
    if (!reason.trim()) throw new TeamError('invalid', 'A reason is required to reject.')
    const e = await this.entry(await this.resolveId(projectId))
    if (e.controller) throw new TeamError('busy', `Team project ${e.project.id} is running; wait until the Leader pauses.`)
    const p = e.project
    const g = p.pendingGate
    if (!g && !(p.status === 'running' && p.phase === 'delivery')) {
      throw new TeamError('invalid', `Project ${p.id} is not waiting for approval (status: ${p.status}, phase: ${p.phase}).`)
    }
    p.status = 'running'
    delete p.pendingGate
    let msg: string
    if (!g || (g.kind === 'gate' && g.phase === 'delivery') || g.kind === 'bounce-limit') {
      p.bounces = 0
      msg = `User rejected ${g?.kind === 'bounce-limit' ? 'delivering with failing QA' : 'the final delivery'}. ${this.enterPhase(e, 'development')} Fix what the user asked, then QA again.`
    } else if (g.kind === 'gate') {
      msg = `Gate ${g.gate} rejected: redo phase ${g.phase}. ${this.enterPhase(e, g.phase)}`
    } else {
      msg = 'User declined your request.'
    }
    this.log(e, 'rejected', reason)
    p.inbox.push(`[用户驳回] ${msg}\n原因：${reason}`)
    await this.save(e)
    return msg
  }

  // ── 成员 ──

  private key(projectId: string, role: string) {
    return `${projectId}:${role}`
  }

  /** 成员可用的工具：发起者工具集 ∩ 角色工具 + 角色的团队工具 */
  private allowedTools(p: TeamProject, role: ResolvedRole): string[] {
    const registry = this.ctx.get('tools')
    const base = p.baseTools ?? registry.list().map((t) => t.name)
    const wanted = new Set(role.tools)
    const host = base.filter((n) => wanted.has(n) && !INTERNAL_TOOLS.includes(n) && !(MAIN_TOOLS as readonly string[]).includes(n))
    const team = role.id === 'leader' ? [...LEADER_TOOLS] : [...MEMBER_TOOLS]
    return [...new Set([...host, ...team])].filter((n) => registry.get(n))
  }

  private ensureAgent(e: Entry, roleId: string): Agent {
    const k = this.key(e.project.id, roleId)
    const existing = this.agents.get(k)
    if (existing && existing.status !== 'disposed') return existing
    const role = this.roles[roleId]
    if (!role) throw new TeamError('invalid', `Unknown role "${roleId}". Available: ${Object.keys(this.roles).join(', ')}`)
    const p = e.project
    const factory = this.ctx.maybe('agentFactory' as never) as { defaultModel?: string; create(o: Partial<AgentOptions>): Agent } | undefined
    const model = role.model ?? this.config.model ?? p.model ?? factory?.defaultModel
    if (!model) throw new TeamError('no_model', `No model for role "${roleId}": set the plugin option "model" or the role's model`)
    const tools = this.allowedTools(p, role)
    const record = p.members[roleId] ?? { sessionId: `team-${p.id}-${roleId}` }
    record.model = model
    p.members[roleId] = record
    const systemPrompt = [
      role.systemPrompt,
      roleId === 'leader' ? leaderInstructions(p, this.roles, this.config) : memberInstructions(p, role, this.roles),
    ].join('\n\n')
    const opts: AgentOptions = {
      model,
      sessionId: record.sessionId,
      systemPrompt,
      tools: { names: tools },
      label: `agent-team:${roleId}`,
      limits: {
        maxSteps: role.maxSteps,
        turnTimeoutMs: roleId === 'leader' ? this.config.timeoutMs : this.config.memberTimeoutMs,
      },
      state: { agentTeam: { projectId: p.id, role: roleId } },
    }
    const agent = factory ? factory.create(opts) : this.ctx.get('agentLoop').create(opts)
    this.agents.set(k, agent)
    this.members.set(agent.id, { projectId: p.id, role: roleId, tools })
    return agent
  }

  isBusy(projectId: string, role: string): boolean {
    return this.lockHeld.has(this.key(projectId, role))
  }

  /** 成员锁：排队等待，可取消 */
  private async lock(projectId: string, role: string, signal?: AbortSignal): Promise<() => void> {
    const k = this.key(projectId, role)
    const prev = this.locks.get(k) ?? Promise.resolve()
    let release!: () => void
    const mine = new Promise<void>((r) => (release = r))
    const chained = prev.then(() => mine)
    this.locks.set(k, chained)
    const cancelled = new Promise<never>((_, reject) => {
      if (signal?.aborted) reject(new TeamError('cancelled', 'Cancelled'))
      signal?.addEventListener('abort', () => reject(new TeamError('cancelled', 'Cancelled')), { once: true })
    })
    try {
      await Promise.race([prev, cancelled])
    } catch (err) {
      // 放弃排队：等前一个结束后直接释放自己的位置
      void prev.then(release)
      throw err
    }
    this.lockHeld.add(k)
    return () => {
      this.lockHeld.delete(k)
      if (this.locks.get(k) === chained) this.locks.delete(k)
      release()
    }
  }

  /** 运行团队 Agent 的一轮 */
  private async runTurn(
    e: Entry,
    agent: Agent,
    input: string,
    run: MemberRun,
    signal: AbortSignal | undefined,
  ): Promise<{ text: string; reason: StopReason; usage: Usage; steps: number; error?: { code: string; message: string } }> {
    this.runs.set(agent.id, run)
    let last: AgentMessage | undefined
    let end: Extract<AgentEvent, { type: 'turn_end' }> | undefined
    try {
      for await (const ev of agent.prompt(input, signal ? { signal } : {})) {
        if (ev.type === 'message' && ev.message.role === 'assistant') last = ev.message
        if (ev.type === 'turn_end') end = ev
        if (ev.type === 'tool_start' && e.progress) {
          const pv = preview(ev.call.arguments)
          e.progress({
            type: 'progress',
            message: `[${run.role}] ${ev.call.name}${pv ? ` ${pv}` : ''}`,
            projectId: e.project.id,
            role: run.role,
            tool: ev.call.name,
          })
        }
      }
    } finally {
      this.runs.delete(agent.id)
    }
    return {
      text: textOf(last).trim(),
      reason: end?.reason ?? 'error',
      usage: end?.usage ?? zeroUsage(),
      steps: end?.steps ?? 0,
      ...(end?.error ? { error: { code: end.error.code, message: end.error.message } } : {}),
    }
  }

  truncate(text: string): string {
    const max = this.config.maxOutputChars
    return text.length > max ? `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]` : text
  }

  /** Leader 指派任务（team_assign） */
  async assign(leaderAgentId: string, args: { role: string; task: string; title?: string; taskId?: string }, signal: AbortSignal): Promise<{ text: string; isError?: boolean; details?: unknown }> {
    const who = this.members.get(leaderAgentId)
    if (!who || who.role !== 'leader') return { text: 'team_assign is only available to the team Leader.', isError: true }
    const e = await this.entry(who.projectId)
    const p = e.project
    if (p.status !== 'running') {
      return { text: `Cannot assign: project is ${p.status}${p.pendingGate ? ` (waiting for the user on gate ${p.pendingGate.gate})` : ''}. Call team_request_approval if you haven't, then end your turn.`, isError: true }
    }
    const role = this.roles[args.role]
    if (!role || role.id === 'leader') return { text: `Unknown member "${args.role}". Members: ${Object.keys(this.roles).filter((r) => r !== 'leader').join(', ')}`, isError: true }

    let task = args.taskId ? e.board.tasks.find((t) => t.id === args.taskId) : undefined
    if (args.taskId && !task) return { text: `Unknown task ${args.taskId}`, isError: true }
    if (!task) {
      task = {
        id: `T${e.board.nextTaskNo++}`,
        role: role.id,
        title: (args.title ?? args.task.split('\n')[0] ?? '').slice(0, 80),
        detail: args.task,
        phase: p.phase,
        status: 'todo',
        createdAt: now(),
        updatedAt: now(),
      }
      e.board.tasks.push(task)
    } else {
      task.role = role.id
      task.phase = p.phase
      task.detail = args.task
    }
    task.status = 'in_progress'
    task.updatedAt = now()
    this.log(e, 'assigned', `${task.id} → ${role.id}: ${task.title}`)
    await this.save(e)

    const release = await this.lock(p.id, role.id, signal)
    let r: Awaited<ReturnType<TeamEngine['runTurn']>>
    const run: MemberRun = { projectId: p.id, role: role.id, kind: 'assign', taskId: task.id, depth: 0, chain: [role.id], asks: 0 }
    try {
      await this.semaphore.acquire(signal)
      try {
        const agent = this.ensureAgent(e, role.id)
        const artifacts = await this.store.listArtifacts(p.id)
        const input = `任务 ${task.id}（阶段：${p.phase}，来自 Leader）：\n${args.task}\n\n项目需求原文：\n${p.requirement}\n\n已有产出物：${artifacts.length ? artifacts.join(', ') : '（无）'}\n完成后调用 team_deliver 提交。`
        r = await this.runTurn(e, agent, input, run, signal)
      } finally {
        this.semaphore.release()
      }
    } finally {
      release()
    }

    const d = run.delivery
    let phaseMsg = ''
    if (d) {
      task.status = 'done'
      task.result = d.summary
      task.artifacts = d.artifacts
      if (d.verdict) task.verdict = d.verdict
      phaseMsg = this.onDelivery(e, role.id, task, d)
    } else if (r.reason === 'completed' && r.text && !(p.phase === 'qa' && role.phase === 'qa')) {
      // 成员没有调用 team_deliver 但给出了最终回复：按交付处理（不保存产出物）
      task.status = 'done'
      task.result = r.text.slice(0, 2000)
      phaseMsg = this.onDelivery(e, role.id, task, { summary: r.text, artifacts: [] })
    } else {
      task.status = r.reason === 'cancelled' ? 'todo' : 'failed'
      task.notes = [...(task.notes ?? []), `${r.reason}${r.error ? `: ${r.error.message}` : ''}`]
    }
    task.updatedAt = now()
    this.log(e, 'delivered', `${task.id} ${role.id} ${task.status}`)
    await this.save(e)

    const details = { projectId: p.id, taskId: task.id, role: role.id, status: task.status, reason: r.reason, steps: r.steps, usage: r.usage, phase: p.phase, projectStatus: p.status }
    if (task.status === 'done') {
      const body = d?.summary ?? r.text
      return {
        text: this.truncate(
          `${role.name}（${role.id}）完成 ${task.id}${task.verdict ? `，结论：${task.verdict}` : ''}。\n${body}${task.artifacts?.length ? `\n产出物：${task.artifacts.join(', ')}` : ''}${phaseMsg ? `\n\n[team] ${phaseMsg}` : ''}`,
        ),
        details,
      }
    }
    const why = r.error ? `${r.reason}: ${r.error.message}` : r.reason
    return {
      text: this.truncate(`${role.id} did not finish ${task.id} (${why}).${r.text ? `\nPartial output:\n${r.text}` : ''}${p.phase === 'qa' && role.phase === 'qa' && r.reason === 'completed' ? '\nQA must call team_deliver with a verdict.' : ''}`),
      isError: true,
      details,
    }
  }

  /** 成员向另一个成员提问（team_ask） */
  async ask(agentId: string, args: { role: string; question: string }, signal: AbortSignal): Promise<{ text: string; isError?: boolean }> {
    const run = this.runs.get(agentId)
    const who = this.members.get(agentId)
    if (!run || !who || who.role === 'leader') return { text: 'team_ask is only available to team members while working on a task.', isError: true }
    const target = this.roles[args.role]
    if (!target || target.id === 'leader') return { text: `Unknown member "${args.role}". To reach the Leader, mark the task blocked with team_task_update.`, isError: true }
    if (run.chain.includes(target.id)) return { text: `${target.id} is already waiting on you in this conversation chain; answer with what you have instead of asking back.`, isError: true }
    if (run.depth + 1 > this.config.maxAskDepth) return { text: `Ask depth limit reached (maxAskDepth=${this.config.maxAskDepth}). Make a reasonable assumption and state it.`, isError: true }
    if (run.asks >= this.config.maxAskRounds) return { text: `Ask limit reached for this task (maxAskRounds=${this.config.maxAskRounds}). Make a reasonable assumption and state it.`, isError: true }
    if (this.isBusy(run.projectId, target.id)) return { text: `${target.id} is busy with another task right now. Make a reasonable assumption and state it, or ask later.`, isError: true }
    run.asks++
    const e = await this.entry(run.projectId)
    const release = await this.lock(run.projectId, target.id, signal)
    try {
      const agent = this.ensureAgent(e, target.id)
      const sub: MemberRun = { projectId: run.projectId, role: target.id, kind: 'ask', depth: run.depth + 1, chain: [...run.chain, target.id], asks: 0 }
      this.log(e, 'ask', `${run.role} → ${target.id}`)
      const r = await this.runTurn(e, agent, `${this.roles[run.role]?.name ?? run.role}（${run.role}）向你提问（直接用文字回答，不要调用 team_deliver）：\n${args.question}`, sub, signal)
      if (r.reason !== 'completed') return { text: `${target.id} did not answer (${r.reason}).${r.text ? `\n${r.text}` : ''}`, isError: true }
      return { text: this.truncate(`${target.name}（${target.id}）回答：\n${r.text || '（空）'}`) }
    } finally {
      release()
    }
  }

  async deliver(
    agentId: string,
    args: { summary: string; content?: string; files?: { name: string; content: string }[]; verdict?: 'pass' | 'fail' },
  ): Promise<{ text: string; isError?: boolean; terminate?: boolean }> {
    const run = this.runs.get(agentId)
    if (!run || run.role === 'leader') return { text: 'team_deliver is only available to team members working on an assigned task.', isError: true }
    if (run.kind === 'ask') return { text: 'You are answering a question from a teammate: reply in plain text instead of calling team_deliver.', isError: true }
    const e = await this.entry(run.projectId)
    const role = this.roles[run.role]!
    const task = e.board.tasks.find((t) => t.id === run.taskId)
    if (role.phase === 'qa' && task?.phase === 'qa' && !args.verdict) return { text: 'QA must give a verdict: "pass" if every acceptance criterion passes, otherwise "fail".', isError: true }
    const artifacts: string[] = []
    try {
      if (args.content?.trim()) {
        const name = role.artifact ?? `${role.id}.md`
        await this.store.writeArtifact(run.projectId, name, args.content)
        artifacts.push(name)
      }
      for (const f of args.files ?? []) {
        await this.store.writeArtifact(run.projectId, f.name, f.content)
        artifacts.push(f.name)
      }
    } catch (err) {
      return { text: (err as Error).message, isError: true }
    }
    run.delivery = { summary: args.summary, artifacts, ...(args.verdict ? { verdict: args.verdict } : {}) }
    return { text: `Delivered${artifacts.length ? ` (${artifacts.join(', ')})` : ''}. Your turn ends here.`, terminate: true }
  }

  async taskUpdate(agentId: string, args: { status: 'in_progress' | 'blocked'; note: string }): Promise<{ text: string; isError?: boolean }> {
    const run = this.runs.get(agentId)
    if (!run || run.role === 'leader' || !run.taskId) return { text: 'team_task_update is only available to team members working on an assigned task.', isError: true }
    const e = await this.entry(run.projectId)
    const task = e.board.tasks.find((t) => t.id === run.taskId)
    if (!task) return { text: `Task ${run.taskId} not found`, isError: true }
    task.status = args.status
    task.notes = [...(task.notes ?? []), `[${run.role}] ${args.note}`].slice(-20)
    task.updatedAt = now()
    e.progress?.({ type: 'progress', message: `[${run.role}] ${task.id} ${args.status}: ${args.note.slice(0, 80)}`, projectId: run.projectId, role: run.role })
    await this.save(e)
    return { text: `Task ${task.id} marked ${args.status}.` }
  }

  async board(agentId: string, args: { action: 'view' | 'add' | 'update'; role?: string; title?: string; detail?: string; taskId?: string; status?: TeamTask['status']; note?: string }): Promise<{ text: string; isError?: boolean }> {
    const who = this.members.get(agentId)
    if (!who || who.role !== 'leader') return { text: 'team_board is only available to the team Leader.', isError: true }
    const e = await this.entry(who.projectId)
    if (args.action === 'add') {
      if (!args.role || !this.roles[args.role] || !args.title) return { text: 'add needs a valid role and a title', isError: true }
      const t: TeamTask = { id: `T${e.board.nextTaskNo++}`, role: args.role, title: args.title, ...(args.detail ? { detail: args.detail } : {}), phase: e.project.phase, status: 'todo', createdAt: now(), updatedAt: now() }
      e.board.tasks.push(t)
      await this.save(e)
      return { text: `Added ${t.id}.` }
    }
    if (args.action === 'update') {
      const t = e.board.tasks.find((x) => x.id === args.taskId)
      if (!t) return { text: `Unknown task ${args.taskId}`, isError: true }
      if (args.status) t.status = args.status
      if (args.note) t.notes = [...(t.notes ?? []), `[leader] ${args.note}`].slice(-20)
      t.updatedAt = now()
      await this.save(e)
      return { text: `Updated ${t.id}.` }
    }
    return { text: this.truncate(formatStatus(e.project, e.board, this.roles, await this.store.listArtifacts(e.project.id))) }
  }

  async artifact(agentId: string, args: { action: 'list' | 'read' | 'write'; name?: string; content?: string }): Promise<{ text: string; isError?: boolean }> {
    const who = this.members.get(agentId)
    if (!who) return { text: 'team_artifact is only available to team agents.', isError: true }
    const id = who.projectId
    if (args.action === 'list') {
      const list = await this.store.listArtifacts(id)
      return { text: list.length ? `Artifacts (${this.store.artifactsDir(id)}):\n${list.join('\n')}` : 'No artifacts yet.' }
    }
    if (!args.name) return { text: 'name is required', isError: true }
    if (args.action === 'read') {
      const text = await this.store.readArtifact(id, args.name)
      return text === undefined ? { text: `Artifact ${args.name} not found`, isError: true } : { text: this.truncate(text) }
    }
    if (who.role !== 'leader') return { text: 'Only the Leader can write artifacts directly; members submit with team_deliver.', isError: true }
    try {
      const file = await this.store.writeArtifact(id, args.name, args.content ?? '')
      return { text: `Saved ${args.name} (${file}).` }
    } catch (err) {
      return { text: (err as Error).message, isError: true }
    }
  }

  async requestApproval(agentId: string, args: { summary: string; question?: string }): Promise<{ text: string; isError?: boolean }> {
    const who = this.members.get(agentId)
    if (!who || who.role !== 'leader') return { text: 'team_request_approval is only available to the team Leader.', isError: true }
    const e = await this.entry(who.projectId)
    const p = e.project
    if (p.status === 'finished' || p.status === 'stopped') return { text: `Project is ${p.status}.`, isError: true }
    const question = [args.summary, args.question].filter(Boolean).join('\n\n')
    if (p.status === 'running' && p.phase === 'delivery') {
      if (!this.config.gates.acceptance) {
        this.finish(e, 'finished')
        await this.save(e)
        return { text: 'Project finished (no acceptance gate configured). Give the user your final summary.' }
      }
      this.log(e, 'phase-finished', 'delivery')
      this.emit('agent-team/phase-finished', { projectId: p.id, phase: 'delivery' })
      p.status = 'awaiting_approval'
      p.pendingGate = { kind: 'gate', gate: 'acceptance', phase: 'delivery', at: now() }
    } else if (p.status === 'running') {
      p.status = 'awaiting_approval'
      p.pendingGate = { kind: 'question', gate: 'question', phase: p.phase, at: now() }
    }
    p.pendingGate!.question = question
    p.pendingGate!.notified = false
    await this.save(e)
    return { text: 'Approval requested. Do not call any more tools: end your turn now with a short message to the user (it is relayed to them as is). The team resumes after the user answers.' }
  }

  // ── Leader 运行 ──

  async start(opts: RunOpts & { requirement: string; title?: string }): Promise<TeamRunResult> {
    const parent = opts.parentAgentId ? this.ctx.get('agentLoop').get(opts.parentAgentId) : undefined
    const registry = this.ctx.get('tools')
    const baseTools =
      parent && parent.options.tools !== undefined
        ? parent.options.tools === false
          ? []
          : registry.list(parent.options.tools).map((t) => t.name)
        : undefined
    const id = newProjectId()
    const title = (opts.title ?? opts.requirement.split('\n')[0] ?? '').trim().slice(0, 60) || id
    const project: TeamProject = {
      id,
      title,
      requirement: opts.requirement,
      status: 'running',
      phase: 'requirements',
      delivered: [],
      bounces: 0,
      inbox: [],
      ...(parent?.options.model ? { model: parent.options.model } : {}),
      ...(baseTools ? { baseTools } : {}),
      members: {},
      history: [],
      createdAt: now(),
      updatedAt: now(),
    }
    const e: Entry = { project, board: { projectId: id, nextTaskNo: 1, tasks: [] }, saving: Promise.resolve() }
    this.entries.set(id, e)
    this.log(e, 'created', title)
    const phaseMsg = this.enterPhase(e, 'requirements')
    await this.save(e)
    const input = `新的团队项目「${title}」（id: ${id}）。\n\n用户需求：\n${opts.requirement}\n\n[team] ${phaseMsg}\n请开始推进。`
    return this.runLeader(e, input, opts)
  }

  async reply(opts: RunOpts & { projectId?: string; decision: ReplyDecision; text?: string }): Promise<TeamRunResult> {
    const id = await this.resolveId(opts.projectId)
    const e = await this.entry(id)
    if (e.controller) throw new TeamError('busy', `Team project ${id} is already running.`)
    const p = e.project
    if (p.status === 'finished') throw new TeamError('invalid', `Project ${id} is already finished.`)
    if (opts.decision === 'approve') await this.approve(id, opts.text)
    else if (opts.decision === 'reject') await this.reject(id, opts.text ?? '')
    else if (opts.decision === 'message') {
      if (!opts.text?.trim()) throw new TeamError('invalid', 'text is required for decision "message"')
      if (p.pendingGate?.kind === 'question') {
        p.status = 'running'
        delete p.pendingGate
      }
      p.inbox.push(`[用户消息] ${opts.text}`)
    }
    if (p.status === 'stopped') {
      p.status = p.pendingGate ? 'awaiting_approval' : 'running'
      this.log(e, 'resumed')
    }
    if ((p.status as ProjectStatus) === 'finished') {
      await this.save(e)
      this.disposeProject(p.id)
      return this.result(e, { text: '项目已验收完成。', reason: 'completed' })
    }
    await this.save(e)
    const input =
      p.status === 'awaiting_approval'
        ? `[team] 用户还没有对关卡 ${p.pendingGate?.gate} 作出决定。${p.inbox.length ? '' : '请简短提醒用户需要决定的事，然后结束本轮。'}`
        : `[team] 请继续推进项目（可先用 team_board 查看任务）。${this.phaseHint(e)}`
    return this.runLeader(e, input, opts)
  }

  private async runLeader(e: Entry, message: string, opts: RunOpts): Promise<TeamRunResult> {
    if (this.disposed) throw new TeamError('cancelled', 'agent-team plugin is unloading')
    if (e.controller) throw new TeamError('busy', `Team project ${e.project.id} is already running.`)
    const controller = new AbortController()
    const onAbort = () => controller.abort(opts.signal?.reason)
    if (opts.signal?.aborted) controller.abort(opts.signal.reason)
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    e.controller = controller
    if (opts.onProgress) e.progress = opts.onProgress
    const p = e.project
    try {
      if (!p.model && opts.parentAgentId) {
        const parent = this.ctx.get('agentLoop').get(opts.parentAgentId)
        if (parent?.options.model) p.model = parent.options.model
      }
      const leader = this.ensureAgent(e, 'leader')
      const inbox = p.inbox.splice(0)
      const input = [...inbox, message, `\n当前状态：阶段 ${p.phase}，状态 ${p.status}，QA 打回 ${p.bounces}/${this.config.maxBounces}。`].join('\n\n')
      await this.save(e)
      const r = await this.runTurn(e, leader, input, { projectId: p.id, role: 'leader', kind: 'leader', depth: 0, chain: ['leader'], asks: 0 }, controller.signal)
      if (r.reason !== 'completed' && r.reason !== 'terminated_by_tool') this.log(e, 'leader-stopped', `${r.reason}${r.error ? `: ${r.error.message}` : ''}`)
      if (p.status === 'awaiting_approval' && p.pendingGate && !p.pendingGate.notified) {
        if (!p.pendingGate.question) {
          p.pendingGate.question = r.text || `阶段「${PHASE_LABELS[p.pendingGate.phase]}」已完成，请确认是否继续。`
        }
        p.pendingGate.notified = true
        this.emit('agent-team/awaiting-approval', { projectId: p.id, phase: p.pendingGate.phase, kind: p.pendingGate.kind, gate: p.pendingGate.gate, question: p.pendingGate.question })
      }
      await this.save(e)
      if (p.status === 'finished' || p.status === 'stopped') this.disposeProject(p.id)
      return this.result(e, r)
    } finally {
      opts.signal?.removeEventListener('abort', onAbort)
      if (e.controller === controller) e.controller = undefined
      if (e.progress === opts.onProgress) e.progress = undefined
    }
  }

  private result(e: Entry, r: { text: string; reason: StopReason; error?: { code: string; message: string } }): TeamRunResult {
    const p = e.project
    return {
      projectId: p.id,
      title: p.title,
      status: p.status,
      phase: p.phase,
      report: this.truncate(r.text),
      reason: r.reason,
      ...(p.status === 'awaiting_approval' && p.pendingGate ? { awaiting: { kind: p.pendingGate.kind, gate: p.pendingGate.gate, question: p.pendingGate.question ?? '' } } : {}),
      ...(r.error ? { error: r.error } : {}),
    }
  }

  async stop(projectId?: string): Promise<string> {
    const e = await this.entry(await this.resolveId(projectId))
    const p = e.project
    if (p.status === 'finished') return `Project ${p.id} is already finished.`
    e.controller?.abort('stopped by user')
    for (const [k, a] of this.agents) if (k.startsWith(`${p.id}:`) && a.status === 'running') a.abort('stopped by user')
    // 暂停的关卡保留：恢复时继续等待用户
    p.status = 'stopped'
    this.log(e, 'stopped')
    this.emit('agent-team/finished', { projectId: p.id, status: 'stopped' })
    await this.save(e)
    this.disposeProject(p.id)
    return `Project ${p.id} stopped.`
  }

  async status(projectId?: string): Promise<string> {
    const e = await this.entry(await this.resolveId(projectId))
    return formatStatus(e.project, e.board, this.roles, await this.store.listArtifacts(e.project.id), Boolean(e.controller))
  }

  async get(projectId?: string): Promise<{ project: TeamProject; board: TeamBoard } | undefined> {
    try {
      const e = await this.entry(await this.resolveId(projectId))
      return { project: e.project, board: e.board }
    } catch {
      return undefined
    }
  }

  private disposeProject(projectId: string) {
    for (const [k, a] of this.agents) {
      if (!k.startsWith(`${projectId}:`)) continue
      this.agents.delete(k)
      this.members.delete(a.id)
      void a.dispose().catch(() => {})
    }
  }

  /** 插件卸载：取消运行中的团队，释放所有 Agent（状态已在磁盘上，可恢复） */
  async dispose(): Promise<void> {
    this.disposed = true
    for (const e of this.entries.values()) e.controller?.abort('agent-team unloaded')
    const all = [...this.agents.values()]
    this.agents.clear()
    this.members.clear()
    for (const a of all) if (a.status === 'running') a.abort('agent-team unloaded')
    await Promise.all(all.map((a) => a.dispose().catch(() => {})))
    await Promise.all([...this.entries.values()].map((e) => e.saving))
  }
}

export function formatStatus(p: TeamProject, board: TeamBoard, roles: Record<string, ResolvedRole>, artifacts: string[], running = false): string {
  const lines = [
    `项目 ${p.id}「${p.title}」`,
    `状态：${p.status}${running ? '（运行中）' : ''}　阶段：${p.phase}（${PHASE_LABELS[p.phase]}）　QA 打回：${p.bounces}`,
  ]
  if (p.pendingGate) lines.push(`等待用户：${p.pendingGate.gate}${p.pendingGate.question ? ` — ${p.pendingGate.question.split('\n')[0]}` : ''}（/team approve [意见] 或 /team reject <原因>）`)
  const owners = Object.values(roles)
    .filter((r) => r.phase === p.phase)
    .map((r) => `${r.id}${p.delivered.includes(r.id) ? ' ✓' : ''}`)
  if (owners.length) lines.push(`本阶段交付：${owners.join('、')}`)
  lines.push('任务：')
  if (!board.tasks.length) lines.push('  （暂无）')
  for (const t of board.tasks.slice(-30)) lines.push(`  ${t.id} [${t.status}] ${t.role}：${t.title}${t.verdict ? `（${t.verdict}）` : ''}`)
  lines.push(`产出物：${artifacts.length ? artifacts.join(', ') : '（无）'}`)
  return lines.join('\n')
}
