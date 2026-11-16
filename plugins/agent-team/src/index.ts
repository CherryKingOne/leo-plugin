/**
 * leo-plugin-agent-team：常驻的 Agent 团队（Leader、产品经理、产品设计、技术负责人、全栈开发、QA）。
 *
 * - 主 Agent 工具 `team_start` / `team_reply`：发起团队、转达用户的审批与回复；Leader 的汇报作为工具结果返回
 * - Leader 工具 `team_assign` / `team_board` / `team_artifact` / `team_request_approval`
 * - 成员工具 `team_deliver` / `team_ask` / `team_task_update` / `team_artifact`（只读）
 * - 命令 `/team status|list|approve|reject|stop|resume`（leo-agents ≥ 0.2.1）
 * - 服务 `agentTeam`；事件 `agent-team/phase-started|phase-finished|bounced|awaiting-approval|finished`
 *
 * 与 sub-agents 的区别：成员是常驻 Agent，整个项目期间保留会话，记得之前的工作；状态写在
 * `<.leo>/team/projects/<id>/`，新会话可以恢复。
 *
 * 安全：成员工具集 ⊆ 发起者工具集 ∩ 角色工具（执行时由预检与守卫强制）；团队内部工具只有团队成员能调用；
 * 并发、步数、超时、打回次数、提问深度与次数都有上限；取消逐级传递。
 */
import type { EventDef, PluginDefinition, PreExecutePayload, ToolDecision } from 'leo-agents'
import { join } from 'node:path'
import { teamCommand } from './commands.js'
import { type AgentTeamConfig, AgentTeamConfigSchema, type RoleProfile } from './config.js'
import { INTERNAL_TOOLS, TEAM_MARKER } from './prompts.js'
import { loadRoleDir, type RoleLayer, resolveRoles } from './roles.js'
import { ProjectStore } from './store.js'
import { type AgentTeamService, TeamEngine, type TeamEvents } from './team.js'
import { createTools } from './tools.js'

export type { AgentTeamConfig, Gates, Phase, ResolvedRole, RoleProfile } from './config.js'
export { AgentTeamConfigSchema, PHASES } from './config.js'
export { BUILTIN_ROLES } from './builtin-roles.js'
export { parseRoleMarkdown, resolveRoles } from './roles.js'
export type { PendingGate, ProjectStatus, TeamBoard, TeamProject, TeamTask } from './store.js'
export type { AgentTeamService, ProjectSummary, ReplyDecision, RunOpts, TeamProgress, TeamRunResult } from './team.js'
export { TeamError } from './team.js'

declare module 'leo-agents' {
  interface Services {
    agentTeam: AgentTeamService
  }
  interface Events {
    'agent-team/phase-started': EventDef<'emit', TeamEvents['agent-team/phase-started']>
    'agent-team/phase-finished': EventDef<'emit', TeamEvents['agent-team/phase-finished']>
    'agent-team/bounced': EventDef<'emit', TeamEvents['agent-team/bounced']>
    'agent-team/awaiting-approval': EventDef<'emit', TeamEvents['agent-team/awaiting-approval']>
    'agent-team/finished': EventDef<'emit', TeamEvents['agent-team/finished']>
  }
}

/** 内置角色的覆盖文件（相对 .leo/）。新增自定义角色文件后需要 /plugins reload，或在配置 roles 里声明 */
export const ROLE_FILES = ['team/leader.md', 'team/pm.md', 'team/designer.md', 'team/tech-lead.md', 'team/dev.md', 'team/qa.md'] as const

interface PathsLike {
  cwd: string
  projectDir?: string
  userDir: string
}

// watch 只列角色文件，不监听整个 team/：项目状态写在 team/projects/ 下，监听它会让每次写盘都重新加载插件
const plugin: PluginDefinition<AgentTeamConfig> & { watch?: readonly string[] } = {
  name: 'leo-plugin-agent-team',
  inject: ['agentLoop', 'tools'],
  config: AgentTeamConfigSchema,
  watch: ROLE_FILES,
  async apply(ctx, config) {
    const paths = ctx.maybe('leoPaths' as never) as PathsLike | undefined
    const layers: RoleLayer[] = []
    if (config.loadRoleFiles && paths) {
      const onError = (file: string, err: Error) => ctx.logger.warn({ file, err: err.message }, 'agent-team: skipped invalid role file')
      for (const dir of [join(paths.userDir, 'team'), ...(paths.projectDir ? [join(paths.projectDir, 'team')] : [])]) {
        const files = await loadRoleDir(dir, onError)
        for (const f of files) layers.push({ source: f.file, roles: { [f.id]: f.profile } })
      }
    }
    layers.push({ source: 'config', roles: config.roles as Record<string, RoleProfile | false> })
    const roles = resolveRoles(layers, config)

    const dataDir = config.dataDir ?? join(paths?.projectDir ?? paths?.userDir ?? join(process.cwd(), '.leo'), 'team', 'projects')
    const engine = new TeamEngine(ctx, config, roles, new ProjectStore(dataDir))
    // 先挂清理：卸载 / 热重载时取消运行中的团队并释放成员 Agent（状态在磁盘上，可 /team resume）
    await ctx.effect(() => () => engine.dispose())

    const service: AgentTeamService = {
      roles: () => roles,
      start: (o) => engine.start(o),
      reply: (o) => engine.reply(o),
      approve: (id, note) => engine.approve(id, note),
      reject: (id, reason) => engine.reject(id, reason),
      stop: (id) => engine.stop(id),
      list: () => engine.list(),
      get: (id) => engine.get(id),
      status: (id) => engine.status(id),
      current: () => engine.current(),
    }
    ctx.provide('agentTeam', service)

    // 工具权限：团队成员只能调用自己的工具集；团队内部工具只给团队成员。
    // 在预检最前面拒绝（不会为越权调用弹审批），守卫兜底（其他策略插件放行也拦得住）。
    const deny = (p: PreExecutePayload): string | undefined => {
      const member = engine.members.get(p.agentId)
      if (member) {
        return member.tools.includes(p.tool.name) ? undefined : `Tool "${p.tool.name}" is not available to team role "${member.role}"`
      }
      if (INTERNAL_TOOLS.includes(p.tool.name)) return `Tool "${p.tool.name}" is internal to agent-team members`
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
    ctx.on('tools/guard', (p) => {
      const reason = deny(p)
      return reason ? { deny: reason } : undefined
    })

    // 团队以外的 Agent（用户对话的主 Agent、子 Agent）看不到团队内部工具
    if (config.hideInternalTools) {
      ctx.on('llm/stream', (p, next) => {
        const tools = p.request.tools
        if (!tools?.some((t) => INTERNAL_TOOLS.includes(t.name)) || (p.request.system ?? '').includes(TEAM_MARKER)) return next()
        return next({ ...p, request: { ...p.request, tools: tools.filter((t) => !INTERNAL_TOOLS.includes(t.name)) } })
      })
    }

    const registry = ctx.get('tools')
    for (const tool of createTools(engine, config, roles)) await ctx.effect(() => registry.register(tool))

    const commands = ctx.maybe('commands' as never) as { register(def: ReturnType<typeof teamCommand>): () => void } | undefined
    if (commands) await ctx.effect(() => commands.register(teamCommand(engine)))
  },
}

export default plugin
