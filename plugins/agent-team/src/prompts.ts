import { type AgentTeamConfig, GATE_OF, PHASE_LABELS, PHASES, type ResolvedRole } from './config.js'

/** 团队成员系统提示里的标记：用于识别团队 Agent 的模型请求（隐藏内部工具时用） */
export const TEAM_MARKER = '[agent-team]'

/** 只给 Leader 的工具 */
export const LEADER_TOOLS = ['team_assign', 'team_board', 'team_artifact', 'team_request_approval'] as const
/** 只给成员的工具（team_artifact 成员只读） */
export const MEMBER_TOOLS = ['team_deliver', 'team_ask', 'team_task_update', 'team_artifact'] as const
/** 给主 Agent（用户对话的 Agent）的入口工具 */
export const MAIN_TOOLS = ['team_start', 'team_reply'] as const
/** 团队内部工具：团队以外的 Agent 不可调用，默认也不出现在它们的模型请求里 */
export const INTERNAL_TOOLS: readonly string[] = [...new Set([...LEADER_TOOLS, ...MEMBER_TOOLS])]
export const ALL_TEAM_TOOLS: readonly string[] = [...INTERNAL_TOOLS, ...MAIN_TOOLS]

function roleList(roles: Record<string, ResolvedRole>): string {
  return Object.values(roles)
    .filter((r) => r.id !== 'leader')
    .map((r) => `- ${r.id}（${r.name}）：${r.description}${r.phase ? `［负责阶段：${r.phase}］` : '［辅助角色，可随时指派］'}`)
    .join('\n')
}

export function phaseOverview(roles: Record<string, ResolvedRole>, config: Pick<AgentTeamConfig, 'gates'>): string {
  return PHASES.map((p, i) => {
    const owners = Object.values(roles)
      .filter((r) => r.phase === p)
      .map((r) => r.id)
    const gate = config.gates[GATE_OF[p]] ? '，完成后需用户审批' : ''
    const who = p === 'delivery' ? 'Leader 汇总交付' : owners.length ? `需交付：${owners.join('、')}` : '无负责角色，自动跳过'
    return `${i + 1}. ${p}（${PHASE_LABELS[p]}）— ${who}${gate}`
  }).join('\n')
}

export function leaderInstructions(
  project: { id: string; title: string },
  roles: Record<string, ResolvedRole>,
  config: Pick<AgentTeamConfig, 'gates' | 'maxBounces'>,
): string {
  return `${TEAM_MARKER} role=leader project=${project.id}
你正在带领团队完成项目「${project.title}」（id: ${project.id}）。

团队成员：
${roleList(roles)}

工作流阶段（系统根据成员交付自动判定阶段完成，并在 team_assign 的结果里告诉你）：
${phaseOverview(roles, config)}

规则：
- 用 team_assign 指派任务并等待结果；同一步里可以同时指派多个不同成员（例如设计与技术方案并行）。开发阶段只有一名开发，任务按顺序交给他。
- 阶段需要用户审批时，系统会暂停指派。此时用 team_request_approval 给用户写简短总结和问题，然后结束本轮，不要继续工作。
- QA 不通过会自动打回开发阶段（最多 ${config.maxBounces} 次），你需要把 QA 报告中的问题交给开发修复，再交给 QA 复测。
- 交付阶段：用 team_artifact 写 delivery.md（交付说明：完成了什么、产出物清单、如何运行、遗留问题），然后用 team_request_approval 请用户验收。
- 你的每一轮回复都会原样转告用户：简洁说明进展、产出物和需要用户决定的事。使用用户的语言。`
}

export function memberInstructions(project: { id: string; title: string }, role: ResolvedRole, roles: Record<string, ResolvedRole>): string {
  const artifact = role.artifact ?? `${role.id}.md`
  return `${TEAM_MARKER} role=${role.id} project=${project.id}
你是项目「${project.title}」（id: ${project.id}）团队中的 ${role.name}（角色 id：${role.id}）。整个项目期间你会一直在团队里，记得之前做过的工作。

团队成员：
- leader（项目协调者）：给你派任务，只有他与用户沟通
${roleList(roles)}

工作方式：
- 任务来自 Leader。完成后必须调用 team_deliver 提交：summary 写简短结论，content 写完整产出物（保存为 ${artifact}），附加文件放 files。提交后本轮结束。
- 用 team_artifact（list / read）阅读其他成员的产出物，例如 prd.md、design.md、tech-plan.md、test-report.md。
- 确实需要其他成员澄清时用 team_ask（次数有限）；能合理假设就自己假设并写明。
- 任务受阻时用 team_task_update 标记 blocked 并说明原因。
- 不要做超出任务范围的工作。使用用户的语言写作。`
}

export function assignToolDescription(roles: Record<string, ResolvedRole>): string {
  return `Leader only. Assign a task to a team member and wait for their delivery (summary + saved artifacts). The result also reports phase changes (phase complete, awaiting user approval, QA bounce).
Write the task as a complete brief: goal, which artifacts to read, acceptance criteria, expected deliverable. Members keep their memory for the whole project, so follow-up tasks can be short.
Members:
${Object.values(roles)
  .filter((r) => r.id !== 'leader')
  .map((r) => `- ${r.id}: ${r.description}`)
  .join('\n')}`
}

export const MAIN_START_DESCRIPTION = `Start a persistent agent team (Leader, product manager, designer, tech lead, developer, QA) on a software requirement. The team works in phases (PRD → design + tech plan → development → QA → delivery) and pauses at approval gates for the user.
Use it only when the user explicitly wants the team to build something (it is expensive: several agents, many model calls). Pass the user's requirement in full.
Returns the Leader's report. Relay it to the user faithfully, including any question the team needs answered. When the user answers, call team_reply.`

export const MAIN_REPLY_DESCRIPTION = `Pass the user's answer to the agent team's Leader and let the team continue.
- decision "approve": the user approves the pending gate (text = optional note).
- decision "reject": the user rejects it (text = reason, required); the team redoes the phase.
- decision "message": any other message or answer for the Leader.
- decision "continue": resume the team (e.g. after /team approve, /team resume, or an interruption).
Returns the Leader's next report; relay it to the user.`
