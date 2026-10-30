import { createLeo } from 'leo-agents'
import { describe, expect, it } from 'vitest'
import subAgents from '../src/index.js'
import { hasToolResult, isChild, lastUserText, setup, toolNames } from './helpers.js'

const task = (prompt: string, extra: Record<string, unknown> = {}, id = 'call_task') => ({
  id,
  name: 'task',
  arguments: { description: 'Look something up', prompt, ...extra },
})

describe('加载与卸载', () => {
  it('无配置可加载，注册 task 工具与 subAgents 服务', async () => {
    const leo = await createLeo({ logLevel: 'silent', plugins: [subAgents] })
    expect(leo.ctx.get('tools').get('task')).toBeDefined()
    expect(Object.keys(leo.ctx.get('subAgents').profiles())).toEqual(['general'])
    await leo.dispose()
  })

  it('卸载后工具与服务被撤销', async () => {
    const leo = await createLeo({ logLevel: 'silent' })
    const rt = await leo.plugin(subAgents)
    await rt.dispose()
    expect(leo.ctx.get('tools').get('task')).toBeUndefined()
    expect(leo.ctx.has('subAgents')).toBe(false)
    await leo.dispose()
  })

  it('非法配置在加载时报错', async () => {
    const leo = await createLeo({ logLevel: 'silent' })
    await expect(leo.plugin(subAgents, { maxDepth: 0 } as never)).rejects.toThrow(/Invalid config/)
    await leo.dispose()
  })

  it('自定义工具名与 agents 写进工具说明', async () => {
    const leo = await createLeo({ logLevel: 'silent' })
    await leo.plugin(subAgents, { toolName: 'delegate', agents: { explorer: { description: 'read-only research' } } } as never)
    const tool = leo.ctx.get('tools').get('delegate')
    expect(tool?.description).toContain('explorer: read-only research')
    expect(tool?.description).toContain('general:')
    await leo.dispose()
  })
})

describe('委派', () => {
  it('子 Agent 独立上下文运行，结果作为工具结果返回', async () => {
    const { leo, mock } = await setup((req) => {
      if (isChild(req)) return { text: 'FOUND: answer is 42' }
      if (!hasToolResult(req)) return { toolCalls: [task('find the answer')] }
      return { text: 'done' }
    })
    const events: string[] = []
    leo.ctx.on('sub-agents/started', (i) => void events.push(`start:${i.agent}:${i.depth}`))
    leo.ctx.on('sub-agents/finished', (i) => void events.push(`end:${i.reason}`))

    const agent = leo.createAgent({ model: 'm', systemPrompt: 'PARENT PROMPT' })
    const r = await agent.run('hi')
    expect(r.text).toBe('done')

    const toolMsg = r.messages.find((m) => m.role === 'tool')!
    expect(toolMsg.content[0]).toMatchObject({ type: 'text', text: 'FOUND: answer is 42' })
    expect(toolMsg.isError).toBeFalsy()

    const childReq = mock.requests.find(isChild)!
    // 子 Agent 只看到委派的 prompt，看不到父对话
    expect(childReq.messages.filter((m) => m.role === 'user')).toHaveLength(1)
    expect(lastUserText(childReq)).toBe('find the answer')
    // 继承父 Agent 的系统提示，并追加子 Agent 说明
    expect(childReq.system).toContain('PARENT PROMPT')
    // maxDepth=1：子 Agent 看不到 task
    expect(toolNames(childReq).sort()).toEqual(['echo', 'secret'])
    expect(events).toEqual(['start:general:1', 'end:completed'])
    expect(leo.ctx.get('subAgents').list()).toHaveLength(0)
    await leo.dispose()
  })

  it('子 Agent 工具集不超过父 Agent', async () => {
    const { leo, mock } = await setup((req) => {
      if (isChild(req)) return { text: 'ok' }
      if (!hasToolResult(req)) return { toolCalls: [task('x')] }
      return { text: 'done' }
    })
    const agent = leo.createAgent({ model: 'm', tools: { names: ['task', 'echo'] } })
    await agent.run('hi')
    expect(toolNames(mock.requests.find(isChild)!)).toEqual(['echo'])
    await leo.dispose()
  })

  it('越权调用未暴露的工具会被拒绝，且不会执行', async () => {
    let childCalls = 0
    const { leo, executed } = await setup(
      (req) => {
        if (isChild(req)) {
          childCalls++
          if (childCalls === 1) return { toolCalls: [{ id: 'c1', name: 'secret', arguments: {} }] }
          const denied = req.messages.find((m) => m.role === 'tool')
          return { text: `child saw: ${denied?.content.map((b) => (b.type === 'text' ? b.text : '')).join('')}` }
        }
        if (!hasToolResult(req)) return { toolCalls: [task('x', { agent: 'explorer' })] }
        return { text: 'done' }
      },
      { agents: { explorer: { description: 'echo only', tools: ['echo'] } } },
    )
    const r = await leo.createAgent({ model: 'm' }).run('hi')
    expect(executed).not.toContain('secret')
    const toolMsg = r.messages.find((m) => m.role === 'tool')!
    expect((toolMsg.content[0] as { text: string }).text).toMatch(/denied: Tool "secret" is not available to sub-agent "explorer"/)
    await leo.dispose()
  })

  it('同一 step 的多个 task 并发执行，受 maxConcurrent 限制', async () => {
    let active = 0
    let peak = 0
    const { leo } = await setup(
      (req) => {
        if (isChild(req)) return { text: `result for ${lastUserText(req)}`, delayMs: 5 }
        if (!hasToolResult(req)) return { toolCalls: [task('a', {}, 't1'), task('b', {}, 't2'), task('c', {}, 't3')] }
        return { text: 'done' }
      },
      { maxConcurrent: 2 },
    )
    leo.ctx.on('sub-agents/started', () => {
      active++
      peak = Math.max(peak, active)
    })
    leo.ctx.on('sub-agents/finished', () => void active--)
    const r = await leo.createAgent({ model: 'm' }).run('hi')
    const results = r.messages.filter((m) => m.role === 'tool').map((m) => (m.content[0] as { text: string }).text)
    expect(results).toEqual(['result for a', 'result for b', 'result for c'])
    expect(peak).toBe(2)
    await leo.dispose()
  })

  it('maxDepth=2 时子 Agent 可以再委派，孙 Agent 不能', async () => {
    const { leo, mock } = await setup(
      (req) => {
        const prompt = lastUserText(req)
        if (isChild(req) && prompt === 'level1') {
          return hasToolResult(req) ? { text: 'level1 done' } : { toolCalls: [task('level2')] }
        }
        if (isChild(req)) return { text: 'level2 done' }
        if (!hasToolResult(req)) return { toolCalls: [task('level1')] }
        return { text: 'done' }
      },
      { maxDepth: 2 },
    )
    const r = await leo.createAgent({ model: 'm' }).run('hi')
    expect(r.text).toBe('done')
    const l1 = mock.requests.find((q) => isChild(q) && lastUserText(q) === 'level1')!
    const l2 = mock.requests.find((q) => isChild(q) && lastUserText(q) === 'level2')!
    expect(toolNames(l1)).toContain('task')
    expect(toolNames(l2)).not.toContain('task')
    await leo.dispose()
  })

  it('父 turn 取消时子 Agent 一起取消', async () => {
    const { leo } = await setup((req) => {
      if (isChild(req)) return { text: 'x'.repeat(400), delayMs: 20 }
      return { toolCalls: [task('slow')] }
    })
    const reasons: string[] = []
    leo.ctx.on('sub-agents/finished', (i) => void reasons.push(i.reason))
    const agent = leo.createAgent({ model: 'm' })
    leo.ctx.on('sub-agents/started', () => setTimeout(() => agent.abort('stop'), 30))
    const r = await agent.run('hi')
    expect(r.reason).toBe('cancelled')
    expect(reasons).toEqual(['cancelled'])
    expect(leo.ctx.get('subAgents').list()).toHaveLength(0)
    await leo.dispose()
  })

  it('子 Agent 未完成时返回 isError，长输出被截断', async () => {
    const { leo } = await setup(
      (req) => {
        if (isChild(req)) return { toolCalls: [{ id: 'e', name: 'echo', arguments: { text: 'loop' } }], text: 'y'.repeat(50) }
        if (!hasToolResult(req)) return { toolCalls: [task('never ends')] }
        return { text: 'done' }
      },
      { maxSteps: 2, maxOutputChars: 10 },
    )
    const r = await leo.createAgent({ model: 'm' }).run('hi')
    const toolMsg = r.messages.find((m) => m.role === 'tool')!
    expect(toolMsg.isError).toBe(true)
    const text = (toolMsg.content[0] as { text: string }).text
    expect(text).toMatch(/did not finish \(max_steps\)/)
    expect(text).toMatch(/truncated 40 chars/)
    await leo.dispose()
  })

  it('subAgents 服务可在代码中直接调用', async () => {
    const { leo } = await setup(() => ({ text: 'direct result' }), { agents: { writer: { description: 'w', model: 'm' } } })
    const r = await leo.ctx.get('subAgents').run({ prompt: 'write', agent: 'writer' })
    expect(r).toMatchObject({ text: 'direct result', reason: 'completed', agent: 'writer', steps: 1 })
    await expect(leo.ctx.get('subAgents').run({ prompt: 'x' })).rejects.toThrow(/has no model/)
    await expect(leo.ctx.get('subAgents').run({ prompt: 'x', agent: 'nope' })).rejects.toThrow(/Unknown sub-agent/)
    await leo.dispose()
  })
})
