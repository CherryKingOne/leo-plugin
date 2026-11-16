import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createLeo } from 'leo-agents'
import { describe, expect, it } from 'vitest'
import agentTeam from '../src/index.js'
import { leaderPolicy, recordEvents, roleOf, setup, sinceLastAssistant, toolNames } from './helpers.js'

const ALL_GATES_OFF = { requirements: false, design: false, development: false, qa: false, acceptance: false }

describe('加载与卸载', () => {
  it('无配置可加载，注册工具、服务与 /team 命令', async () => {
    const leo = await createLeo({ logLevel: 'silent', plugins: [agentTeam] })
    const names = leo.ctx.get('tools').list().map((t) => t.name).sort()
    expect(names).toEqual(['team_artifact', 'team_ask', 'team_assign', 'team_board', 'team_deliver', 'team_reply', 'team_request_approval', 'team_start', 'team_task_update'])
    expect(Object.keys(leo.ctx.get('agentTeam').roles())).toEqual(['leader', 'pm', 'designer', 'tech-lead', 'dev', 'qa'])
    await leo.dispose()
  })

  it('卸载后工具、服务、命令被撤销，再次加载正常', async () => {
    const { leo, commands, loadTeam } = await setup({}, { commands: true, defer: true })
    const rt = await loadTeam()
    expect(commands.has('team')).toBe(true)
    await rt.dispose()
    expect(commands.has('team')).toBe(false)
    expect(leo.ctx.get('tools').get('team_assign')).toBeUndefined()
    expect(leo.ctx.has('agentTeam' as never)).toBe(false)
    const rt2 = await loadTeam()
    expect(commands.has('team')).toBe(true)
    expect(leo.ctx.get('tools').list().filter((t) => t.name.startsWith('team_'))).toHaveLength(9)
    await rt2.dispose()
    await leo.dispose()
  })

  it('watch 只声明角色文件；卸载 / 再加载后工具只注册一份', async () => {
    expect((agentTeam as { watch?: string[] }).watch).toEqual(['team/leader.md', 'team/pm.md', 'team/designer.md', 'team/tech-lead.md', 'team/dev.md', 'team/qa.md'])
    const leo = await createLeo({ logLevel: 'silent' })
    const rt1 = await leo.plugin(agentTeam)
    await rt1.dispose()
    expect(leo.ctx.get('tools').get('team_start')).toBeUndefined()
    expect(leo.ctx.has('agentTeam' as never)).toBe(false)
    const rt2 = await leo.plugin(agentTeam)
    expect(leo.ctx.get('tools').list().filter((t) => t.name === 'team_assign')).toHaveLength(1)
    await rt2.dispose()
    await leo.dispose()
  })

  it('非法配置在加载时报错', async () => {
    const leo = await createLeo({ logLevel: 'silent' })
    await expect(leo.plugin(agentTeam, { maxBounces: -1 } as never)).rejects.toThrow(/Invalid config/)
    await leo.dispose()
  })
})

describe('完整流程与人工关卡', () => {
  it('PRD → 设计+技术方案（并行）→ 开发 → QA → 交付，三个默认关卡都要用户批准', async () => {
    const { leo, mock, team, dataDir } = await setup({})
    const events = recordEvents(leo as never)

    const r1 = await team().start({ requirement: '做一个待办应用', title: 'Todo' })
    expect(r1).toMatchObject({ status: 'awaiting_approval', phase: 'requirements', awaiting: { gate: 'requirements', kind: 'gate' } })
    expect(r1.awaiting?.question).toContain('SUMMARY')
    expect(r1.report).toBe('LEADER: 已请用户确认')
    const prd = await readFile(join(dataDir, r1.projectId, 'artifacts', 'prd.md'), 'utf8')
    expect(prd).toContain('# PRD')

    // 等待审批时 Leader 不能继续指派
    const r2 = await team().reply({ decision: 'approve', text: '范围可以' })
    expect(r2).toMatchObject({ status: 'awaiting_approval', phase: 'design', awaiting: { gate: 'design' } })
    // 审批意见转告 Leader
    const leaderReqs = mock.requests.filter((q) => roleOf(q) === 'leader')
    expect(leaderReqs.some((q) => sinceLastAssistant(q).includes('用户意见：范围可以'))).toBe(true)

    const r3 = await team().reply({ decision: 'approve' })
    expect(r3).toMatchObject({ status: 'awaiting_approval', phase: 'delivery', awaiting: { gate: 'acceptance' } })
    expect(r3.awaiting?.question).toContain('请验收')

    const r4 = await team().reply({ decision: 'approve' })
    expect(r4.status).toBe('finished')

    const state = await team().get(r1.projectId)
    expect(state?.board.tasks.map((t) => `${t.id}:${t.role}:${t.status}`)).toEqual(['T1:pm:done', 'T2:designer:done', 'T3:tech-lead:done', 'T4:dev:done', 'T5:qa:done'])
    const files = (await import('node:fs/promises')).readdir(join(dataDir, r1.projectId, 'artifacts'))
    expect((await files).sort()).toEqual(['delivery.md', 'design.md', 'dev-notes.md', 'prd.md', 'prototype.html', 'tech-plan.md', 'test-report.md'])
    expect(events).toEqual([
      'phase-started:requirements',
      'phase-finished:requirements',
      'awaiting-approval:requirements',
      'phase-started:design',
      'phase-finished:design',
      'awaiting-approval:design',
      'phase-started:development',
      'phase-finished:development',
      'phase-started:qa',
      'phase-finished:qa',
      'phase-started:delivery',
      'phase-finished:delivery',
      'awaiting-approval:acceptance',
      'finished:finished',
    ])
    await leo.dispose()
  })

  it('设计与技术方案并行执行', async () => {
    let active = 0
    let peak = 0
    const { leo, team } = await setup(
      {
        member: (role, req) => {
          if (role !== 'designer' && role !== 'tech-lead') return undefined
          return { toolCalls: [{ id: `d-${role}`, name: 'team_deliver', arguments: { summary: `${role} ok`, content: 'x' } }], delayMs: 10, ...(req ? {} : {}) }
        },
      },
      { config: { gates: { ...ALL_GATES_OFF, design: true } } },
    )
    leo.ctx.on('agent/event', ({ agent, event }) => {
      if (!/agent-team:(designer|tech-lead)/.test(agent.options.label ?? '')) return
      if (event.type === 'turn_start') peak = Math.max(peak, ++active)
      if (event.type === 'turn_end') active--
    })
    const r = await team().start({ requirement: 'x' })
    expect(r).toMatchObject({ phase: 'design', awaiting: { gate: 'design' } })
    expect(peak).toBe(2)
    await leo.dispose()
  })

  it('驳回：带原因重做本阶段', async () => {
    const { leo, mock, team } = await setup({})
    const r1 = await team().start({ requirement: '做一个待办应用' })
    expect(r1.awaiting?.gate).toBe('requirements')
    const r2 = await team().reply({ decision: 'reject', text: '还要支持登录' })
    expect(r2).toMatchObject({ status: 'awaiting_approval', phase: 'requirements', awaiting: { gate: 'requirements' } })
    const pmReqs = mock.requests.filter((q) => roleOf(q) === 'pm')
    // PM 是常驻成员：第二个任务的请求里有第一个任务的历史
    const second = pmReqs[pmReqs.length - 1]!
    expect(second.messages.filter((m) => m.role === 'user')).toHaveLength(2)
    const leaderReq = mock.requests.filter((q) => roleOf(q) === 'leader').find((q) => sinceLastAssistant(q).includes('还要支持登录'))
    expect(leaderReq).toBeDefined()
    const state = await team().get()
    expect(state?.board.tasks.map((t) => t.role)).toEqual(['pm', 'pm'])
    await expect(team().reply({ decision: 'reject' })).rejects.toThrow(/reason is required/)
    await leo.dispose()
  })

  it('关卡全部关闭时一次运行到结束', async () => {
    const { leo, team } = await setup({}, { config: { gates: ALL_GATES_OFF } })
    const events = recordEvents(leo as never)
    const r = await team().start({ requirement: 'x' })
    expect(r.status).toBe('finished')
    expect(r.report).toBe('LEADER: 项目完成')
    expect(events.filter((e) => e.startsWith('awaiting'))).toEqual([])
    expect(events[events.length - 1]).toBe('finished:finished')
    await leo.dispose()
  })

  it('删除角色后没有负责人的阶段自动跳过', async () => {
    const { leo, team } = await setup({}, { config: { gates: ALL_GATES_OFF, roles: { designer: false, 'tech-lead': false } } })
    const events = recordEvents(leo as never)
    const r = await team().start({ requirement: 'x' })
    expect(r.status).toBe('finished')
    expect(events.filter((e) => e.startsWith('phase-started'))).toEqual(['phase-started:requirements', 'phase-started:development', 'phase-started:qa', 'phase-started:delivery'])
    await leo.dispose()
  })
})

describe('Leader 与成员的其他工具', () => {
  it('team_board / team_artifact / team_task_update；Leader 主动提问，用户用消息回答；等待时不能指派', async () => {
    let n = 0
    const { leo, mock, team } = await setup(
      {
        leader: (req) => {
          const t = sinceLastAssistant(req)
          n++
          if (n === 1) return { toolCalls: [{ id: 'b1', name: 'team_board', arguments: { action: 'add', role: 'pm', title: '调研竞品' } }] }
          if (n === 2) return { toolCalls: [{ id: 'q1', name: 'team_request_approval', arguments: { summary: '开始前确认', question: '面向个人还是团队？' } }] }
          if (n === 3) return { toolCalls: [{ id: 'a1', name: 'team_assign', arguments: { role: 'pm', task: 'x' } }] }
          if (n === 4) return { text: `LEADER saw: ${t}` }
          if (n === 5) return { toolCalls: [{ id: 'a2', name: 'team_assign', arguments: { role: 'pm', task: '写 PRD', taskId: 'T1' } }] }
          if (n === 6) return { toolCalls: [{ id: 'v', name: 'team_board', arguments: { action: 'view' } }, { id: 'r', name: 'team_artifact', arguments: { action: 'read', name: 'prd.md' } }] }
          if (n === 7) return { text: `LEADER board: ${t}` }
          return leaderPolicy(req)
        },
        member: (role, req) => {
          if (role !== 'pm') return undefined
          const t = sinceLastAssistant(req)
          if (t.startsWith('任务')) return { toolCalls: [{ id: 'u', name: 'team_task_update', arguments: { status: 'blocked', note: '缺少目标用户' } }] }
          if (t.includes('marked blocked')) return { toolCalls: [{ id: 'l', name: 'team_artifact', arguments: { action: 'write', name: 'hack.md', content: 'x' } }] }
          return { toolCalls: [{ id: 'd', name: 'team_deliver', arguments: { summary: 'PRD', content: '# PRD 个人版' } }] }
        },
      },
      { config: { gates: { ...ALL_GATES_OFF, requirements: true } } },
    )
    const r1 = await team().start({ requirement: 'x' })
    expect(r1).toMatchObject({ status: 'awaiting_approval', awaiting: { kind: 'question', question: '开始前确认\n\n面向个人还是团队？' } })
    expect(r1.report).toContain('Cannot assign: project is awaiting_approval')
    const r2 = await team().reply({ decision: 'message', text: '面向个人' })
    expect(r2.report).toContain('LEADER board:')
    expect(r2.report).toContain('T1 [done] pm：调研竞品')
    expect(r2.report).toContain('# PRD 个人版')
    expect(r2.awaiting?.gate).toBe('requirements')
    const leaderInputs = mock.requests.filter((q) => roleOf(q) === 'leader').map(sinceLastAssistant)
    expect(leaderInputs.some((t) => t.includes('[用户消息] 面向个人'))).toBe(true)
    const pmInputs = mock.requests.filter((q) => roleOf(q) === 'pm').map(sinceLastAssistant)
    expect(pmInputs.some((t) => t.includes('Only the Leader can write artifacts'))).toBe(true)
    const task = (await team().get(r1.projectId))!.board.tasks[0]!
    expect(task.notes).toEqual(['[pm] 缺少目标用户'])
    await leo.dispose()
  })
})

describe('QA 打回', () => {
  it('QA 不通过打回开发，修复后通过', async () => {
    const { leo, team } = await setup({ verdicts: ['fail', 'pass'] }, { config: { gates: ALL_GATES_OFF } })
    const events = recordEvents(leo as never)
    const r = await team().start({ requirement: 'x' })
    expect(r.status).toBe('finished')
    expect(events).toContain('bounced:1')
    const st = (await team().get(r.projectId))!
    expect(st.project.bounces).toBe(1)
    expect(st.board.tasks.map((t) => `${t.role}:${t.verdict ?? ''}`)).toEqual(['pm:', 'designer:', 'tech-lead:', 'dev:', 'qa:fail', 'dev:', 'qa:pass'])
    await leo.dispose()
  })

  it('超过最大打回次数后暂停交给用户；批准 = 按现状交付', async () => {
    const { leo, team } = await setup({ verdicts: ['fail', 'fail', 'fail'] }, { config: { gates: ALL_GATES_OFF, maxBounces: 1 } })
    const events = recordEvents(leo as never)
    const r = await team().start({ requirement: 'x' })
    expect(r).toMatchObject({ status: 'awaiting_approval', phase: 'qa', awaiting: { kind: 'bounce-limit', gate: 'bounce-limit' } })
    expect(events.filter((e) => e.startsWith('bounced'))).toEqual(['bounced:1'])
    const r2 = await team().reply({ decision: 'approve' })
    expect(r2.status).toBe('finished')
    await leo.dispose()
  })

  it('打回上限时驳回 = 再修一轮（计数清零）', async () => {
    const { leo, team } = await setup({ verdicts: ['fail', 'fail'] }, { config: { gates: ALL_GATES_OFF, maxBounces: 1 } })
    const r = await team().start({ requirement: 'x' })
    expect(r.awaiting?.kind).toBe('bounce-limit')
    const r2 = await team().reply({ decision: 'reject', text: '再修一次' })
    expect(r2.status).toBe('finished')
    expect((await team().get(r.projectId))!.project.bounces).toBe(0)
    await leo.dispose()
  })

  it('QA 交付缺少结论会被要求补上', async () => {
    let tries = 0
    const { leo, team } = await setup(
      {
        member: (role, req) => {
          if (role !== 'qa') return undefined
          tries++
          if (sinceLastAssistant(req).includes('must give a verdict')) return { toolCalls: [{ id: 'q2', name: 'team_deliver', arguments: { summary: 'ok', verdict: 'pass' } }] }
          return { toolCalls: [{ id: 'q1', name: 'team_deliver', arguments: { summary: 'no verdict' } }] }
        },
      },
      { config: { gates: ALL_GATES_OFF } },
    )
    const r = await team().start({ requirement: 'x' })
    expect(r.status).toBe('finished')
    expect(tries).toBe(2)
    await leo.dispose()
  })
})

describe('权限', () => {
  it('成员工具集 = 角色工具 + 团队工具；越权调用被拒绝且不执行；标签 agent-team:<role>', async () => {
    let pmCalls = 0
    const { leo, mock, team, executed } = await setup(
      {
        member: (role, req) => {
          if (role !== 'pm') return undefined
          pmCalls++
          if (pmCalls === 1) return { toolCalls: [{ id: 'b1', name: 'bash', arguments: { command: 'rm -rf /' } }] }
          if (pmCalls === 2) return { toolCalls: [{ id: 'b2', name: 'team_assign', arguments: { role: 'dev', task: 'x' } }] }
          return { toolCalls: [{ id: 'd', name: 'team_deliver', arguments: { summary: `saw: ${sinceLastAssistant(req).slice(0, 80)}`, content: 'p' } }] }
        },
      },
      { config: { gates: { requirements: true, design: false, development: false, qa: false, acceptance: false } } },
    )
    const labels = new Set<string>()
    leo.ctx.on('agent/event', ({ agent }) => void labels.add(agent.options.label ?? ''))
    await team().start({ requirement: 'x' })
    expect(executed).not.toContain('bash')
    const pmReq = mock.requests.find((q) => roleOf(q) === 'pm')!
    expect(toolNames(pmReq).sort()).toEqual(['grep', 'list_dir', 'read_file', 'team_artifact', 'team_ask', 'team_deliver', 'team_task_update', 'web_fetch'])
    const denied = mock.requests.filter((q) => roleOf(q) === 'pm').map((q) => sinceLastAssistant(q))
    // 宿主自己按 Agent 的工具筛选拒绝（旧宿主没有这一层时由插件的预检拒绝）
    expect(denied.some((t) => /Tool "bash" is not available/.test(t))).toBe(true)
    expect(denied.some((t) => /Tool "team_assign" is not available/.test(t))).toBe(true)
    // 插件自己的预检 / 守卫：不带 Agent 筛选直接执行也拦得住
    const pm = leo.ctx.get('agentLoop').list().find((a) => a.options.label === 'agent-team:pm')!
    const exec = (agentId: string, name: string, args: Record<string, unknown> = {}) =>
      leo.ctx.get('tools').executeBatch([{ type: 'tool_call', id: 'g1', name, arguments: args, rawArguments: JSON.stringify(args) }], {
        agentId,
        sessionId: 's',
        turnId: 't',
        signal: new AbortController().signal,
        ctx: leo.ctx,
      })
    const [byPm] = await exec(pm.id, 'bash')
    expect(byPm).toMatchObject({ isError: true, errorCode: 'tool_denied' })
    expect(JSON.stringify(byPm!.content)).toContain('Tool \\"bash\\" is not available to team role \\"pm\\"')
    const [byOutsider] = await exec('someone-else', 'team_deliver', { summary: 'x' })
    expect(JSON.stringify(byOutsider!.content)).toContain('internal to agent-team members')
    const leaderReq = mock.requests.find((q) => roleOf(q) === 'leader')!
    expect(toolNames(leaderReq).sort()).toEqual(['grep', 'list_dir', 'read_file', 'team_artifact', 'team_assign', 'team_board', 'team_request_approval'])
    expect([...labels].filter((l) => l.startsWith('agent-team:')).sort()).toEqual(['agent-team:leader', 'agent-team:pm'])
    await leo.dispose()
  })

  it('开发是唯一默认能写文件和执行命令的角色', async () => {
    const { leo, mock, team } = await setup({}, { config: { gates: ALL_GATES_OFF } })
    await team().start({ requirement: 'x' })
    const byRole = new Map<string, string[]>()
    for (const q of mock.requests) {
      const r = roleOf(q)
      if (r && !byRole.has(r)) byRole.set(r, toolNames(q))
    }
    for (const [role, names] of byRole) {
      const writes = names.filter((n) => ['write_file', 'edit_file', 'bash'].includes(n))
      expect(writes, role).toEqual(role === 'dev' ? ['write_file', 'edit_file', 'bash'] : [])
    }
    await leo.dispose()
  })

  it('主 Agent 通过 team_start 发起：看不到团队内部工具、调用不了它们；成员工具不超出主 Agent 的工具集；进度经 tool_update', async () => {
    let mainCalls = 0
    const { leo, mock } = await setup(
      {
        main: (req) => {
          mainCalls++
          if (mainCalls === 1) return { toolCalls: [{ id: 'x', name: 'team_assign', arguments: { role: 'dev', task: 'hack' } }] }
          if (mainCalls === 2) return { toolCalls: [{ id: 's', name: 'team_start', arguments: { requirement: '做一个待办应用' } }] }
          return { text: `MAIN: ${sinceLastAssistant(req).slice(0, 200)}` }
        },
      },
      { config: { gates: ALL_GATES_OFF } },
    )
    const progress: { message: string }[] = []
    leo.ctx.on('agent/event', ({ event }) => void (event.type === 'tool_update' && progress.push(event.partial as never)))
    const main = leo.createAgent({ model: 'm', tools: { names: ['team_start', 'team_reply', 'team_assign', 'read_file', 'grep'] } })
    const r = await main.run('帮我组队做个待办应用')
    expect(r.text).toContain('[agent-team]')
    expect(r.text).toContain('状态：finished')
    const mainReq = mock.requests.find((q) => !roleOf(q))!
    // team_assign 在主 Agent 的筛选里，但被隐藏且执行时被拒绝
    expect(toolNames(mainReq).sort()).toEqual(['grep', 'read_file', 'team_reply', 'team_start'])
    const firstTool = r.messages.find((m) => m.role === 'tool')!
    expect(firstTool.content.map((b) => (b.type === 'text' ? b.text : '')).join('')).toMatch(/internal to agent-team members/)
    // 开发的工具 = 主 Agent 的工具 ∩ 开发角色工具
    const devReq = mock.requests.find((q) => roleOf(q) === 'dev')!
    expect(toolNames(devReq).filter((n) => !n.startsWith('team_')).sort()).toEqual(['grep', 'read_file'])
    expect(progress.some((p) => p.message.startsWith('[leader] team_assign pm'))).toBe(true)
    expect(progress.some((p) => p.message.startsWith('[pm] team_deliver'))).toBe(true)
    await leo.dispose()
  })

  it('每个角色可以用不同的模型', async () => {
    const { leo, mock, team } = await setup({}, { config: { gates: ALL_GATES_OFF, roles: { qa: { model: 'cheap' } } } })
    await team().start({ requirement: 'x' })
    expect(mock.requests.find((q) => roleOf(q) === 'qa')!.model).toBe('cheap')
    expect(mock.requests.find((q) => roleOf(q) === 'dev')!.model).toBe('m')
    await leo.dispose()
  })
})

describe('team_ask', () => {
  const asking = (plan: Record<string, (req: Parameters<NonNullable<import('./helpers.js').Script['member']>>[1], n: number) => ReturnType<NonNullable<import('./helpers.js').Script['member']>>>) => {
    const counts: Record<string, number> = {}
    return (role: string, req: Parameters<NonNullable<import('./helpers.js').Script['member']>>[1]) => {
      const f = plan[role]
      if (!f) return undefined
      counts[role] = (counts[role] ?? 0) + 1
      return f(req, counts[role]!)
    }
  }

  it('成员互相提问；反问提问者被拒绝（防死锁）', async () => {
    const { leo, mock, team } = await setup(
      {
        member: asking({
          dev: (req, n) => {
            const t = sinceLastAssistant(req)
            if (t.includes('直接用文字回答')) return { text: 'dev answer' }
            if (n === 1) return { toolCalls: [{ id: 'a1', name: 'team_ask', arguments: { role: 'tech-lead', question: '接口怎么定？' } }] }
            return { toolCalls: [{ id: 'dd', name: 'team_deliver', arguments: { summary: `got: ${t.slice(0, 120)}`, content: 'x' } }] }
          },
          'tech-lead': (req) => {
            const t = sinceLastAssistant(req)
            if (t.includes('接口怎么定')) return { toolCalls: [{ id: 'a2', name: 'team_ask', arguments: { role: 'dev', question: '你想怎么定？' } }] }
            if (t.includes('already waiting on you')) return { text: '用 REST' }
            return { toolCalls: [{ id: 'tl', name: 'team_deliver', arguments: { summary: 'plan', content: 'x' } }] }
          },
        }),
      },
      { config: { gates: ALL_GATES_OFF } },
    )
    const r = await team().start({ requirement: 'x' })
    expect(r.status).toBe('finished')
    const tl = mock.requests.filter((q) => roleOf(q) === 'tech-lead').map(sinceLastAssistant)
    expect(tl.some((t) => t.includes('dev is already waiting on you'))).toBe(true)
    const dev = (await team().get(r.projectId))!.board.tasks.find((t) => t.role === 'dev')!
    expect(dev.result).toContain('技术负责人（tech-lead）回答：\n用 REST')
    await leo.dispose()
  })

  it('提问次数与深度有上限', async () => {
    const { leo, mock, team } = await setup(
      {
        member: asking({
          dev: (req, n) => {
            const t = sinceLastAssistant(req)
            if (n <= 2) return { toolCalls: [{ id: `q${n}`, name: 'team_ask', arguments: { role: 'pm', question: `问题 ${n}` } }] }
            return { toolCalls: [{ id: 'dd', name: 'team_deliver', arguments: { summary: t.slice(0, 300), content: 'x' } }] }
          },
          pm: (req) => {
            const t = sinceLastAssistant(req)
            if (t.includes('问题')) return { toolCalls: [{ id: 'deep', name: 'team_ask', arguments: { role: 'designer', question: '再问' } }] }
            if (t.includes('Ask depth limit')) return { text: 'pm 自己判断' }
            return undefined
          },
        }),
      },
      { config: { gates: ALL_GATES_OFF, maxAskRounds: 1, maxAskDepth: 1 } },
    )
    const r = await team().start({ requirement: 'x' })
    expect(r.status).toBe('finished')
    const pm = mock.requests.filter((q) => roleOf(q) === 'pm').map(sinceLastAssistant)
    expect(pm.some((t) => t.includes('Ask depth limit reached (maxAskDepth=1)'))).toBe(true)
    const devTask = (await team().get(r.projectId))!.board.tasks.find((t) => t.role === 'dev')!
    expect(devTask.result).toContain('Ask limit reached for this task (maxAskRounds=1)')
    expect(mock.requests.filter((q) => roleOf(q) === 'designer' && sinceLastAssistant(q).includes('再问'))).toHaveLength(0)
    await leo.dispose()
  })
})

describe('取消与停止', () => {
  it('发起者取消时 Leader 与成员一起取消，项目可恢复', async () => {
    const { leo, team } = await setup({ delayMs: 30 })
    const ac = new AbortController()
    leo.ctx.on('agent/event', ({ agent, event }) => {
      if (!ac.signal.aborted && agent.options.label === 'agent-team:pm' && event.type === 'turn_start') setTimeout(() => ac.abort('user cancel'), 20)
    })
    const r = await team().start({ requirement: 'x', signal: ac.signal })
    expect(r.reason).toBe('cancelled')
    expect(r.status).toBe('running')
    const st = (await team().get(r.projectId))!
    expect(st.board.tasks[0]!.status).toBe('todo')
    expect(leo.ctx.get('agentLoop').list().filter((a) => a.status === 'running')).toHaveLength(0)
    // 恢复：继续后 PM 重新交付
    const r2 = await team().reply({ decision: 'continue', projectId: r.projectId })
    expect(r2.awaiting?.gate).toBe('requirements')
    await leo.dispose()
  })

  it('/team stop 停止运行中的团队', async () => {
    const { leo, team, runCommand } = await setup({ delayMs: 30 }, { commands: true })
    const events = recordEvents(leo as never)
    let stopped: Promise<{ text?: string }> | undefined
    leo.ctx.on('agent/event', ({ agent, event }) => {
      if (!stopped && agent.options.label === 'agent-team:pm' && event.type === 'turn_start') {
        stopped = new Promise((resolve) => setTimeout(() => resolve(runCommand('stop')), 20))
      }
    })
    const r = await team().start({ requirement: 'x' })
    expect(r.reason).toBe('cancelled')
    expect((await stopped)?.text).toMatch(/stopped/)
    expect(r.status).toBe('stopped')
    expect(events).toContain('finished:stopped')
    expect(leo.ctx.get('agentLoop').list().filter((a) => (a.options.label ?? '').startsWith('agent-team:'))).toHaveLength(0)
    // 停止的项目可以恢复
    const r2 = await team().reply({ decision: 'continue', projectId: r.projectId })
    expect(r2.awaiting?.gate).toBe('requirements')
    await leo.dispose()
  })
})

describe('持久化与恢复', () => {
  it('状态写在磁盘上；新实例（新会话）读取后继续', async () => {
    const { leo, team, config } = await setup({})
    const r1 = await team().start({ requirement: '做一个待办应用' })
    expect(r1.awaiting?.gate).toBe('requirements')
    const state = JSON.parse(await readFile(join(config.dataDir!, r1.projectId, 'state.json'), 'utf8'))
    expect(state).toMatchObject({ status: 'awaiting_approval', phase: 'requirements', pendingGate: { gate: 'requirements' } })
    expect(state.members.pm.sessionId).toBe(`team-${r1.projectId}-pm`)
    const board = JSON.parse(await readFile(join(config.dataDir!, r1.projectId, 'board.json'), 'utf8'))
    expect(board.tasks).toHaveLength(1)
    await leo.dispose()

    const again = await setup({}, { config: { dataDir: config.dataDir } })
    expect((await again.team().list()).map((p) => p.id)).toEqual([r1.projectId])
    expect(await again.team().current()).toBe(r1.projectId)
    const r2 = await again.team().reply({ decision: 'approve' })
    expect(r2).toMatchObject({ projectId: r1.projectId, phase: 'design', awaiting: { gate: 'design' } })
    // 成员沿用项目里记录的会话 id（会话持久化时即可续上历史）
    expect(again.mock.requests.length).toBeGreaterThan(0)
    await again.leo.dispose()
  })

  it('插件热重载后成员续上同一个会话，记得之前的工作', async () => {
    const { leo, mock, team, loadTeam } = await setup({}, { defer: true })
    const rt = await loadTeam()
    const r1 = await team().start({ requirement: '做一个待办应用' })
    expect(r1.awaiting?.gate).toBe('requirements')
    await rt.dispose()
    expect(leo.ctx.get('agentLoop').list().filter((a) => (a.options.label ?? '').startsWith('agent-team:'))).toHaveLength(0)

    await loadTeam()
    const before = mock.requests.length
    const r2 = await team().reply({ decision: 'reject', text: '加上登录' })
    expect(r2.awaiting?.gate).toBe('requirements')
    const after = mock.requests.slice(before)
    const leaderReq = after.find((q) => roleOf(q) === 'leader')!
    // Leader 的新请求包含重载前的对话
    expect(leaderReq.messages.some((m) => m.role === 'user' && m.content.some((b) => b.type === 'text' && b.text.includes('新的团队项目')))).toBe(true)
    const pmReq = after.find((q) => roleOf(q) === 'pm')!
    expect(pmReq.messages.filter((m) => m.role === 'user')).toHaveLength(2)
    await leo.dispose()
  })
})

describe('/team 命令', () => {
  it('status / list / approve / reject / resume', async () => {
    const { leo, team, runCommand } = await setup({}, { commands: true })
    expect((await runCommand('status')).isError).toBe(true)
    expect((await runCommand('list')).text).toMatch(/还没有团队项目/)
    const r = await team().start({ requirement: '做一个待办应用', title: 'Todo' })
    const status = (await runCommand('status')).text!
    expect(status).toContain(`项目 ${r.projectId}「Todo」`)
    expect(status).toContain('等待用户：requirements')
    expect(status).toContain('T1 [done] pm')
    expect(status).toContain('产出物：prd.md')
    expect((await runCommand('list')).text).toContain('[awaiting_approval] requirements（等待 requirements）')
    expect((await runCommand('reject')).isError).toBe(true)

    const approved = await runCommand('approve 好的')
    expect(approved.text).toMatch(/已批准/)
    expect(approved.prompt).toContain(`team_reply（decision: "continue", projectId: "${r.projectId}"）`)
    // 已批准、尚未继续：再次批准报错
    expect((await runCommand('approve')).isError).toBe(true)
    const r2 = await team().reply({ decision: 'continue' })
    expect(r2.awaiting?.gate).toBe('design')

    const rejected = await runCommand('reject 设计太复杂')
    expect(rejected.text).toMatch(/已驳回/)
    expect((await runCommand('resume')).prompt).toContain('continue')
    expect((await runCommand('nope')).isError).toBe(true)
    await leo.dispose()
  })
})
