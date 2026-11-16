import { PHASE_LABELS } from './config.js'
import { TeamError, type TeamEngine } from './team.js'

/**
 * leo-agents ≥ 0.2.1 commands 服务的最小结构类型。这里不 import 它的类型，
 * 这样插件也能在没有 commands 的旧宿主上编译和运行（没有 commands 时不注册 /team）
 */
export interface CommandContext {
  args: string
  argv: string[]
  sessionId?: string
  surface: string
}
export interface CommandResult {
  text?: string
  isError?: boolean
  /** 作为用户消息发给当前 Agent */
  prompt?: string
}
export interface CommandDefinition {
  name: string
  description?: string
  usage?: string
  run(c: CommandContext): Promise<CommandResult>
}

const USAGE = `/team status [项目id]      查看进度
/team list                  列出团队项目
/team approve [意见]        批准当前关卡，团队继续
/team reject <原因>         驳回当前关卡，团队返工
/team stop [项目id]         停止团队
/team resume [项目id]       继续一个暂停 / 中断 / 停止的项目`

/** 让当前对话的 Agent 调用 team_reply 继续运行团队（进度在对话里可见） */
const continuePrompt = (projectId: string, what: string) =>
  `[agent-team] ${what} 请调用 team_reply（decision: "continue", projectId: "${projectId}"）让团队继续，并把 Leader 的汇报转告我。`

/** `/team` 命令（leo-agents ≥ 0.2.1 的 commands 服务；旧宿主没有则不注册） */
export function teamCommand(engine: TeamEngine): CommandDefinition {
  return {
    name: 'team',
    description: 'Agent 团队：查看进度、审批、停止、恢复',
    usage: '<status|list|approve|reject|stop|resume> [参数]',
    async run(c: CommandContext): Promise<CommandResult> {
      const [sub = 'status', ...rest] = c.argv
      const arg = rest.join(' ').trim()
      try {
        switch (sub) {
          case 'status':
            return { text: await engine.status(arg || undefined) }
          case 'list': {
            const list = await engine.list()
            if (!list.length) return { text: '还没有团队项目。让 Agent 用 team_start 发起一个。' }
            return {
              text: list
                .map((p) => `${p.id}  [${p.status}${p.running ? '·运行中' : ''}] ${p.phase}${p.awaiting ? `（等待 ${p.awaiting}）` : ''}  「${p.title}」`)
                .join('\n'),
            }
          }
          case 'approve': {
            const id = await engine.resolveId()
            await engine.approve(id, arg || undefined)
            const p = (await engine.get(id))?.project
            if (!p || p.status === 'finished') return { text: `已验收，项目 ${id} 完成。` }
            return { text: `已批准，团队进入「${PHASE_LABELS[p.phase]}」阶段。`, prompt: continuePrompt(id, `我已批准团队项目 ${id} 的关卡${arg ? `，意见：${arg}` : ''}。`) }
          }
          case 'reject': {
            if (!arg) return { text: '请写明驳回原因：/team reject <原因>', isError: true }
            const id = await engine.resolveId()
            await engine.reject(id, arg)
            const p = (await engine.get(id))?.project
            return { text: `已驳回，团队返工「${p ? PHASE_LABELS[p.phase] : ''}」阶段。`, prompt: continuePrompt(id, `我驳回了团队项目 ${id} 的关卡，原因：${arg}。`) }
          }
          case 'stop':
            return { text: await engine.stop(arg || undefined) }
          case 'resume': {
            const id = await engine.resolveId(arg || undefined)
            const p = (await engine.get(id))?.project
            if (!p) return { text: `找不到项目 ${id}`, isError: true }
            if (p.status === 'finished') return { text: `项目 ${id} 已完成。`, isError: true }
            return { text: `继续项目 ${id}…`, prompt: continuePrompt(id, `请继续团队项目 ${id}。`) }
          }
          default:
            return { text: USAGE, ...(sub === 'help' ? {} : { isError: true }) }
        }
      } catch (err) {
        if (err instanceof TeamError) return { text: err.message, isError: true }
        throw err
      }
    },
  }
}
