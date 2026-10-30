import type { AgentEvent, ToolDefinition, ToolOutput } from 'leo-agents'
import { z } from 'zod'
import type { SubAgentsConfig } from './config.js'
import { toolDescription } from './prompt.js'
import { SubAgentError, type SubAgentService } from './service.js'

/** 等价于 leo-agents 的 toolOutput()；插件不运行时依赖 leo-agents（见 PROTOCOL.md 第 3 节） */
const output = (out: ToolOutput): ToolOutput => Object.assign(out, { [Symbol.for('leo.toolOutput')]: true })

/**
 * 子 Agent 进度，经 tool_update 事件转发。遵循 leo-agents 的 ToolProgress 约定：
 * 界面显示 message，其余字段供程序化消费
 */
export interface SubAgentProgress {
  type: 'progress'
  message: string
  agentId: string
  agent: string
  tool: string
}

function preview(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const a = args as Record<string, unknown>
  const v = a.command ?? a.path ?? a.url ?? a.pattern ?? a.description
  const s = typeof v === 'string' ? v : JSON.stringify(a)
  return s.length > 80 ? `${s.slice(0, 80)}…` : s
}

function progressOf(agent: string, ev: AgentEvent): SubAgentProgress | undefined {
  if (ev.type !== 'tool_start') return undefined
  const p = preview(ev.call.arguments)
  return { type: 'progress', message: `[${agent}] ${ev.call.name}${p ? ` ${p}` : ''}`, agentId: '', agent, tool: ev.call.name }
}

export function createTaskTool(
  config: SubAgentsConfig,
  service: SubAgentService,
): ToolDefinition<{ description: string; prompt: string; agent?: string }> {
  const agents = service.profiles()
  const names = Object.keys(agents)
  return {
    name: config.toolName,
    title: 'Sub-agent',
    description: toolDescription(config.toolName, agents),
    parameters: z.object({
      description: z.string().min(1).max(80).describe('A short (3-8 words) title for the task, shown to the user'),
      prompt: z.string().min(1).describe('The complete brief for the sub-agent. It sees nothing else: include goal, context, constraints and the expected result'),
      agent: z
        .enum(names as [string, ...string[]])
        .optional()
        .describe(`Which agent to use. Default: general`),
    }),
    permissions: [{ kind: 'agent.spawn' }],
    executionMode: 'parallel',
    // 子 Agent 自己有 turnTimeoutMs；这里多留余量，让它先体面地结束
    timeoutMs: config.timeoutMs + 15_000,
    async execute({ description, prompt, agent }, exec) {
      try {
        const r = await service.run({
          prompt,
          description,
          ...(agent ? { agent } : {}),
          parentAgentId: exec.agentId,
          signal: exec.signal,
          onEvent: (ev, info) => {
            const p = progressOf(info.agent, ev)
            if (p) exec.onUpdate({ ...p, agentId: info.id })
          },
        })
        const details = { agentId: r.id, agent: r.agent, sessionId: r.sessionId, reason: r.reason, steps: r.steps, usage: r.usage, durationMs: r.durationMs, truncated: r.truncated }
        if (r.reason === 'completed') {
          return output({ content: r.text || '(sub-agent returned an empty reply)', details })
        }
        const why = r.error ? `${r.reason}: ${r.error.message}` : r.reason
        return output({
          content: `Sub-agent did not finish (${why}).${r.text ? `\nPartial result:\n${r.text}` : ''}`,
          isError: true,
          details,
        })
      } catch (err) {
        if (err instanceof SubAgentError) return output({ content: err.message, isError: true })
        throw err
      }
    },
  }
}
