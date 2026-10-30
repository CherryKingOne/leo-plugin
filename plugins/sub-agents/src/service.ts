import type { Agent, AgentEvent, AgentLoopService, AgentMessage, Context, StopReason, ToolRegistry, Usage } from 'leo-agents'
import type { AgentProfile, SubAgentsConfig } from './config.js'
import { SUB_AGENT_INSTRUCTIONS } from './prompt.js'

export interface SubAgentRunOptions {
  /** 交给子 Agent 的完整任务说明 */
  prompt: string
  /** 子 Agent 配置名，默认 general */
  agent?: string
  /** 简短标题，用于事件与界面 */
  description?: string
  /** 发起委派的 Agent id。提供时：模型、工具集、租户从它继承，并据此计算嵌套深度 */
  parentAgentId?: string
  signal?: AbortSignal
  /** 子 Agent 的事件流（进度展示） */
  onEvent?(event: AgentEvent): void
}

export interface SubAgentResult {
  /** 子 Agent 的 Agent id */
  id: string
  agent: string
  sessionId: string
  /** 最终回复（已按 maxOutputChars 截断） */
  text: string
  truncated: boolean
  reason: StopReason
  usage: Usage
  steps: number
  durationMs: number
  error?: { code: string; message: string }
}

export interface SubAgentInfo {
  id: string
  agent: string
  description?: string
  sessionId: string
  parentAgentId?: string
  depth: number
  /** 子 Agent 被允许使用的工具 */
  tools: string[]
  startedAt: number
}

/** `ctx.get('subAgents')` */
export interface SubAgentService {
  run(opts: SubAgentRunOptions): Promise<SubAgentResult>
  /** 正在运行的子 Agent */
  list(): SubAgentInfo[]
  get(agentId: string): SubAgentInfo | undefined
  /** 生效的子 Agent 配置（内置 + 用户配置） */
  profiles(): Readonly<Record<string, AgentProfile>>
}

export class SubAgentError extends Error {
  constructor(
    readonly code: 'unknown_agent' | 'max_depth' | 'no_model' | 'cancelled',
    message: string,
  ) {
    super(message)
    this.name = 'SubAgentError'
  }
}

/** 公平的计数信号量，等待可被取消 */
class Semaphore {
  private active = 0
  private readonly waiters: (() => void)[] = []
  constructor(private readonly limit: number) {}

  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new SubAgentError('cancelled', 'Cancelled before start'))
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
        reject(new SubAgentError('cancelled', 'Cancelled while waiting for a free slot'))
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

function textOf(message: AgentMessage | undefined): string {
  if (!message) return ''
  return message.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

const zeroUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0 })

export function createSubAgentService(ctx: Context<any>, config: SubAgentsConfig, profiles: Record<string, AgentProfile>): {
  service: SubAgentService
  /** 子 Agent id → 运行信息（供工具守卫使用） */
  children: Map<string, SubAgentInfo>
} {
  const children = new Map<string, SubAgentInfo>()
  const semaphore = new Semaphore(config.maxConcurrent)
  const loop = (): AgentLoopService => ctx.get('agentLoop')
  const tools = (): ToolRegistry => ctx.get('tools')

  /** 父 Agent 当前可用的工具名 */
  function parentToolNames(parent: Agent | undefined): string[] {
    if (parent) {
      const asChild = children.get(parent.id)
      if (asChild) return asChild.tools
      if (parent.options.tools === false) return []
      return tools()
        .list(parent.options.tools)
        .map((t) => t.name)
    }
    return tools()
      .list()
      .map((t) => t.name)
  }

  async function run(opts: SubAgentRunOptions): Promise<SubAgentResult> {
    const agentName = opts.agent ?? 'general'
    const profile = profiles[agentName]
    if (!profile) {
      throw new SubAgentError('unknown_agent', `Unknown sub-agent "${agentName}". Available: ${Object.keys(profiles).join(', ')}`)
    }

    const parent = opts.parentAgentId ? loop().get(opts.parentAgentId) : undefined
    const depth = (parent ? (children.get(parent.id)?.depth ?? 0) : 0) + 1
    if (depth > config.maxDepth) {
      throw new SubAgentError('max_depth', `Sub-agent nesting limit reached (maxDepth=${config.maxDepth})`)
    }

    // 工具集：父 Agent 工具 ∩ 配置工具；到达最大深度时去掉委派工具本身
    let allowed = parentToolNames(parent)
    if (profile.tools) {
      const wanted = new Set(profile.tools)
      allowed = allowed.filter((n) => wanted.has(n))
    }
    if (depth >= config.maxDepth) allowed = allowed.filter((n) => n !== config.toolName)

    const model = profile.model ?? parent?.options.model
    if (!model) throw new SubAgentError('no_model', `Sub-agent "${agentName}" has no model: set agents.${agentName}.model or call from a parent agent`)
    const sameModel = model === parent?.options.model
    const basePrompt = profile.systemPrompt ?? parent?.options.systemPrompt
    const systemPrompt = [basePrompt, SUB_AGENT_INSTRUCTIONS].filter(Boolean).join('\n\n')

    await semaphore.acquire(opts.signal)
    const started = Date.now()
    let child: Agent | undefined
    let info: SubAgentInfo | undefined
    let result: SubAgentResult | undefined
    try {
      child = loop().create({
        model,
        systemPrompt,
        tools: allowed.length ? { names: allowed } : false,
        ...(parent?.options.tenant ? { tenant: parent.options.tenant } : {}),
        ...(sameModel && parent?.options.temperature !== undefined ? { temperature: parent.options.temperature } : {}),
        ...(sameModel && parent?.options.maxOutputTokens ? { maxOutputTokens: parent.options.maxOutputTokens } : {}),
        ...(sameModel && parent?.options.providerOptions ? { providerOptions: parent.options.providerOptions } : {}),
        limits: { maxSteps: profile.maxSteps ?? config.maxSteps, turnTimeoutMs: config.timeoutMs },
        state: { subAgent: { agent: agentName, depth, ...(parent ? { parentAgentId: parent.id } : {}) } },
      })
      info = {
        id: child.id,
        agent: agentName,
        ...(opts.description ? { description: opts.description } : {}),
        sessionId: child.sessionId,
        ...(parent ? { parentAgentId: parent.id } : {}),
        depth,
        tools: allowed,
        startedAt: started,
      }
      // 先登记再运行：守卫依赖这份登记限制子 Agent 的工具
      children.set(child.id, info)
      ctx.emit('sub-agents/started', info)

      let last: AgentMessage | undefined
      let end: Extract<AgentEvent, { type: 'turn_end' }> | undefined
      for await (const ev of child.prompt(opts.prompt, opts.signal ? { signal: opts.signal } : {})) {
        if (ev.type === 'message' && ev.message.role === 'assistant') last = ev.message
        if (ev.type === 'turn_end') end = ev
        opts.onEvent?.(ev)
      }

      const full = textOf(last).trim()
      const truncated = full.length > config.maxOutputChars
      result = {
        id: child.id,
        agent: agentName,
        sessionId: child.sessionId,
        text: truncated ? `${full.slice(0, config.maxOutputChars)}\n…[truncated ${full.length - config.maxOutputChars} chars]` : full,
        truncated,
        reason: end?.reason ?? 'error',
        usage: end?.usage ?? zeroUsage(),
        steps: end?.steps ?? 0,
        durationMs: Date.now() - started,
        ...(end?.error ? { error: { code: end.error.code, message: end.error.message } } : {}),
      }
      return result
    } finally {
      if (child) {
        children.delete(child.id)
        await child.dispose().catch(() => {})
      }
      semaphore.release()
      if (info) {
        ctx.emit('sub-agents/finished', {
          ...info,
          reason: result?.reason ?? (opts.signal?.aborted ? 'cancelled' : 'error'),
          usage: result?.usage ?? zeroUsage(),
          steps: result?.steps ?? 0,
          durationMs: Date.now() - started,
        })
      }
    }
  }

  const service: SubAgentService = {
    run,
    list: () => [...children.values()],
    get: (id) => children.get(id),
    profiles: () => profiles,
  }
  return { service, children }
}
