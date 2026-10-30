/**
 * leo-plugin-sub-agents：把任务委派给独立上下文的子 Agent 执行并汇总结果。
 *
 * - 工具 `task`：主 Agent 调用它创建子 Agent，同一 step 多次调用会并发执行
 * - 服务 `subAgents`：代码中直接委派
 * - 事件 `sub-agents/started`、`sub-agents/finished`
 *
 * 安全：子 Agent 工具集 ⊆ 父 Agent 工具集（通过工具预检与守卫强制，而非仅隐藏），
 * 嵌套深度、并发数、步数、超时均有上限，父 turn 取消时子 Agent 一起取消。
 */
import type { EventDef, PluginDefinition, PreExecutePayload, ToolDecision } from 'leo-agents'
import { type AgentProfile, DEFAULT_PROFILES, type SubAgentsConfig, SubAgentsConfigSchema } from './config.js'
import { createSubAgentService, type SubAgentInfo, type SubAgentService } from './service.js'
import { createTaskTool } from './tool.js'

export type { AgentProfile, SubAgentsConfig } from './config.js'
export { SubAgentsConfigSchema } from './config.js'
export type { SubAgentInfo, SubAgentResult, SubAgentRunOptions, SubAgentService } from './service.js'
export { SubAgentError } from './service.js'
export type { SubAgentProgress } from './tool.js'

export interface SubAgentFinished extends SubAgentInfo {
  reason: string
  usage: { inputTokens: number; outputTokens: number }
  steps: number
  durationMs: number
}

declare module 'leo-agents' {
  interface Services {
    subAgents: SubAgentService
  }
  interface Events {
    'sub-agents/started': EventDef<'emit', SubAgentInfo>
    'sub-agents/finished': EventDef<'emit', SubAgentFinished>
  }
}

const plugin: PluginDefinition<SubAgentsConfig> = {
  name: 'leo-plugin-sub-agents',
  inject: ['agentLoop', 'tools'],
  config: SubAgentsConfigSchema,
  async apply(ctx, config) {
    const profiles: Record<string, AgentProfile> = { ...DEFAULT_PROFILES, ...config.agents }
    const { service, children } = createSubAgentService(ctx, config, profiles)
    ctx.provide('subAgents', service)

    // 强制子 Agent 只能调用被允许的工具。模型看不到的工具也可能被“猜”出来调用，
    // 所以不能只靠不暴露 schema：在预检最前面拒绝，避免为越权调用弹出审批。
    const deny = (p: PreExecutePayload): string | undefined => {
      const child = children.get(p.agentId)
      if (child && !child.tools.includes(p.tool.name)) {
        return `Tool "${p.tool.name}" is not available to sub-agent "${child.agent}"`
      }
      return undefined
    }
    ctx.on(
      'tools/pre-execute',
      (p, next) => {
        const reason = deny(p)
        return reason ? ({ action: 'deny', reason } satisfies ToolDecision) : next()
      },
      { prepend: true },
    )
    // 守卫兜底：即使其他策略插件放行，也不可绕过
    ctx.on('tools/guard', (p) => {
      const reason = deny(p)
      return reason ? { deny: reason } : undefined
    })

    const tool = createTaskTool(config, service)
    await ctx.effect(() => ctx.get('tools').register(tool))
  },
}

export default plugin
