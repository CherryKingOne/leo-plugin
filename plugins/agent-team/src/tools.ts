import type { ToolDefinition, ToolOutput } from 'leo-agents'
import { z } from 'zod'
import type { AgentTeamConfig, ResolvedRole } from './config.js'
import { MAIN_REPLY_DESCRIPTION, MAIN_START_DESCRIPTION, assignToolDescription } from './prompts.js'
import { TeamError, type TeamEngine, type TeamRunResult } from './team.js'

/** 等价于 leo-agents 的 toolOutput()；插件不运行时依赖 leo-agents（见 PROTOCOL.md 第 3 节） */
const output = (out: ToolOutput): ToolOutput => Object.assign(out, { [Symbol.for('leo.toolOutput')]: true })

const fromResult = (r: { text: string; isError?: boolean; terminate?: boolean; details?: unknown }): ToolOutput =>
  output({ content: r.text, ...(r.isError ? { isError: true } : {}), ...(r.terminate ? { terminate: true } : {}), ...(r.details ? { details: r.details } : {}) })

/** 团队一次运行的结果 → 给主 Agent 的文本 */
export function formatRun(r: TeamRunResult): string {
  const head = `[agent-team] 项目 ${r.projectId}「${r.title}」 状态：${r.status}，阶段：${r.phase}`
  const lines = [head, '', 'Leader 汇报：', r.report || '（无）']
  if (r.awaiting) {
    lines.push('', `需要用户决定（${r.awaiting.gate}）：${r.awaiting.question}`, '用户可以直接回复（你再用 team_reply 转达），或使用 /team approve [意见]、/team reject <原因>。')
  }
  if (r.reason !== 'completed' && r.reason !== 'terminated_by_tool') {
    lines.push('', `注意：Leader 本轮未正常结束（${r.reason}${r.error ? `：${r.error.message}` : ''}）。可以用 team_reply（continue）或 /team resume 继续。`)
  }
  if (r.status === 'finished') lines.push('', '项目已完成。')
  return lines.join('\n')
}

function mainTools(engine: TeamEngine, config: AgentTeamConfig): ToolDefinition[] {
  const run = async (fn: () => Promise<TeamRunResult>): Promise<ToolOutput> => {
    try {
      const r = await fn()
      const failed = r.reason !== 'completed' && r.reason !== 'terminated_by_tool'
      return output({ content: formatRun(r), ...(failed ? { isError: true } : {}), details: r })
    } catch (err) {
      if (err instanceof TeamError) return output({ content: err.message, isError: true })
      throw err
    }
  }
  const timeoutMs = config.timeoutMs + 30_000
  return [
    {
      name: 'team_start',
      title: 'Agent team',
      description: MAIN_START_DESCRIPTION,
      parameters: z.object({
        requirement: z.string().min(1).describe("The user's requirement, in full and in the user's words"),
        title: z.string().max(60).optional().describe('Short project title'),
      }),
      permissions: [{ kind: 'agent.spawn' }],
      timeoutMs,
      execute: ({ requirement, title }, exec) =>
        run(() =>
          engine.start({ requirement, ...(title ? { title } : {}), parentAgentId: exec.agentId, signal: exec.signal, onProgress: (p) => exec.onUpdate(p) }),
        ),
    } satisfies ToolDefinition<{ requirement: string; title?: string }>,
    {
      name: 'team_reply',
      title: 'Agent team',
      description: MAIN_REPLY_DESCRIPTION,
      parameters: z.object({
        decision: z.enum(['approve', 'reject', 'message', 'continue']).describe('What the user decided'),
        text: z.string().optional().describe('Approval note, rejection reason (required for reject) or the message for the Leader'),
        projectId: z.string().optional().describe('Team project id; default: the most recent unfinished project'),
      }),
      permissions: [{ kind: 'agent.spawn' }],
      timeoutMs,
      execute: ({ decision, text, projectId }, exec) =>
        run(() =>
          engine.reply({ decision, ...(text ? { text } : {}), ...(projectId ? { projectId } : {}), parentAgentId: exec.agentId, signal: exec.signal, onProgress: (p) => exec.onUpdate(p) }),
        ),
    } satisfies ToolDefinition<{ decision: 'approve' | 'reject' | 'message' | 'continue'; text?: string; projectId?: string }>,
  ]
}

function leaderTools(engine: TeamEngine, config: AgentTeamConfig, roles: Record<string, ResolvedRole>): ToolDefinition[] {
  const members = Object.keys(roles).filter((r) => r !== 'leader')
  return [
    {
      name: 'team_assign',
      title: 'Assign to team member',
      description: assignToolDescription(roles),
      parameters: z.object({
        role: (members.length ? z.enum(members as [string, ...string[]]) : z.string()).describe('Member role id'),
        task: z.string().min(1).describe('Complete task brief for the member'),
        title: z.string().max(80).optional().describe('Short task title for the board'),
        taskId: z.string().optional().describe('Existing board task id to (re)assign'),
      }),
      permissions: [{ kind: 'agent.spawn' }],
      executionMode: 'parallel',
      timeoutMs: config.memberTimeoutMs + 15_000,
      execute: async (args, exec) => fromResult(await engine.assign(exec.agentId, args, exec.signal)),
    } satisfies ToolDefinition<{ role: string; task: string; title?: string; taskId?: string }>,
    {
      name: 'team_board',
      title: 'Team task board',
      description: 'Leader only. View the project state and task board (action "view"), add a task ("add": role, title, detail) or update one ("update": taskId, status, note).',
      parameters: z.object({
        action: z.enum(['view', 'add', 'update']).describe('view / add / update'),
        role: z.string().optional().describe('add: member role id'),
        title: z.string().optional().describe('add: task title'),
        detail: z.string().optional().describe('add: task detail'),
        taskId: z.string().optional().describe('update: task id, e.g. T3'),
        status: z.enum(['todo', 'in_progress', 'blocked', 'done', 'failed']).optional().describe('update: new status'),
        note: z.string().optional().describe('update: note'),
      }),
      execute: async (args, exec) => fromResult(await engine.board(exec.agentId, args)),
    },
    {
      name: 'team_request_approval',
      title: 'Ask the user',
      description:
        'Leader only. Pause the team and ask the user: at an approval gate (after a phase completes), for final acceptance in the delivery phase, or for any decision only the user can make. Write a short summary of what was done and the exact question, then end your turn with a short message to the user.',
      parameters: z.object({
        summary: z.string().min(1).describe('Short summary for the user: what was done, which artifacts to look at'),
        question: z.string().optional().describe('The question or decision for the user'),
      }),
      execute: async (args, exec) => fromResult(await engine.requestApproval(exec.agentId, args)),
    },
  ]
}

function memberTools(engine: TeamEngine, config: AgentTeamConfig, roles: Record<string, ResolvedRole>): ToolDefinition[] {
  const members = Object.keys(roles).filter((r) => r !== 'leader')
  return [
    {
      name: 'team_deliver',
      title: 'Deliver',
      description:
        'Team members only. Submit the result of your current task: summary (short conclusion for the Leader), content (the full main artifact, saved under your role\'s artifact name, e.g. prd.md) and optional extra files (e.g. prototype.html). QA must set verdict. Your turn ends after this call.',
      parameters: z.object({
        summary: z.string().min(1).describe('Short conclusion for the Leader'),
        content: z.string().optional().describe('Full content of your main artifact (Markdown)'),
        files: z
          .array(z.object({ name: z.string().describe('File name, no directories, e.g. prototype.html'), content: z.string().describe('File content') }))
          .max(10)
          .optional()
          .describe('Extra artifact files'),
        verdict: z.enum(['pass', 'fail']).optional().describe('QA only: pass if every acceptance criterion passes, otherwise fail'),
      }),
      execute: async (args, exec) => fromResult(await engine.deliver(exec.agentId, args)),
    },
    {
      name: 'team_ask',
      title: 'Ask a teammate',
      description: `Team members only. Ask another member a question and wait for the answer. Limited: at most ${config.maxAskRounds} per task, nesting depth ${config.maxAskDepth}; busy members cannot be asked. Prefer reasonable assumptions.`,
      parameters: z.object({
        role: (members.length ? z.enum(members as [string, ...string[]]) : z.string()).describe('Member role id to ask'),
        question: z.string().min(1).describe('A specific question with the context needed to answer it'),
      }),
      permissions: [{ kind: 'agent.spawn' }],
      executionMode: 'sequential',
      timeoutMs: config.memberTimeoutMs + 15_000,
      execute: async (args, exec) => fromResult(await engine.ask(exec.agentId, args, exec.signal)),
    },
    {
      name: 'team_task_update',
      title: 'Update task',
      description: 'Team members only. Report progress on your current task, or mark it blocked with the reason (the Leader sees it on the board).',
      parameters: z.object({
        status: z.enum(['in_progress', 'blocked']).describe('in_progress or blocked'),
        note: z.string().min(1).describe('Progress note or blocking reason'),
      }),
      execute: async (args, exec) => fromResult(await engine.taskUpdate(exec.agentId, args)),
    },
    {
      name: 'team_artifact',
      title: 'Team artifacts',
      description: 'Team agents only. List ("list") or read ("read", name) the project artifacts such as prd.md, design.md, tech-plan.md, test-report.md. The Leader can also write one ("write", name, content), e.g. delivery.md.',
      parameters: z.object({
        action: z.enum(['list', 'read', 'write']).describe('list / read / write (Leader only)'),
        name: z.string().optional().describe('Artifact file name, e.g. prd.md'),
        content: z.string().optional().describe('write: full content'),
      }),
      execute: async (args, exec) => fromResult(await engine.artifact(exec.agentId, args)),
    },
  ]
}

export function createTools(engine: TeamEngine, config: AgentTeamConfig, roles: Record<string, ResolvedRole>): ToolDefinition[] {
  return [...mainTools(engine, config), ...leaderTools(engine, config, roles), ...memberTools(engine, config, roles)]
}
