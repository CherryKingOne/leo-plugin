import { describe, expect, it } from 'vitest'
import { LiveTracker } from '../src/live.js'
import { childIds, projectSession } from '../src/project.js'
import { redactText, redactValue } from '../src/redact.js'
import { evt } from './helpers.js'

const O = { redact: true, maxPreviewChars: 4000 }
const usage = (i: number, o: number) => ({ inputTokens: i, outputTokens: o })
const user = (id: string, text: string) => ({ message: { id, role: 'user', content: [{ type: 'text', text }], createdAt: 0 } })
const assistant = (id: string, text: string, calls: { id: string; name: string; arguments: unknown }[] = []) => ({
  message: {
    id,
    role: 'assistant',
    content: [...(text ? [{ type: 'text', text }] : []), ...calls.map((c) => ({ type: 'tool_call', ...c, rawArguments: JSON.stringify(c.arguments) }))],
    createdAt: 0,
  },
})
const toolMsg = (id: string, callId: string, name: string, text: string, meta: Record<string, unknown>, isError = false) => ({
  message: { id, role: 'tool', toolCallId: callId, toolName: name, isError, content: [{ type: 'text', text }], createdAt: 0, meta },
})

/** 0.2.1 宿主写出来的日志：没有 tool/start、tool/end、firstTokenAt、session/meta */
function legacyLog(sid = 's1') {
  let n = 0
  const e = (type: string, at: number, data: unknown) => evt(sid, ++n, type, at, data)
  return [
    e('turn/start', 1000, { turnId: 't1' }),
    e('message', 1001, user('u1', '列出文件，并帮我查 api_key=sk-abcdefghijklmnopqrstuvwxyz123456')),
    e('llm/request', 1010, { turnId: 't1', stepId: 'st1', model: 'mock/m', system: 'sys', messageIds: ['u1'], tools: ['echo', 'task'], params: {}, fingerprint: 'f', estimatedTokens: 50 }),
    e('llm/attempt-failed', 1100, { turnId: 't1', stepId: 'st1', attempt: 1, code: 'network', message: 'ECONNRESET' }),
    e('llm/response', 1500, { turnId: 't1', stepId: 'st1', messageId: 'a1', finishReason: 'tool_calls', usage: usage(100, 20), attempts: 2 }),
    e('message', 1501, assistant('a1', '', [
      { id: 'c1', name: 'echo', arguments: { text: 'hi', password: 'hunter2' } },
      { id: 'c2', name: 'missing', arguments: {} },
      { id: 'c3', name: 'task', arguments: { prompt: 'explore' } },
    ])),
    e('message', 1800, toolMsg('m1', 'c1', 'echo', 'hi', { durationMs: 250 })),
    e('message', 1801, toolMsg('m2', 'c2', 'missing', 'Error: Unknown tool', { durationMs: 0, errorCode: 'tool_not_found' }, true)),
    e('message', 1802, toolMsg('m3', 'c3', 'task', 'done', { durationMs: 280, details: { agentId: 'agent_x', agent: 'explorer', sessionId: 'child1' } })),
    e('llm/request', 1810, { turnId: 't1', stepId: 'st2', model: 'mock/m', system: 'sys', messageIds: ['u1', 'a1', 'm1', 'm2', 'm3'], tools: [], params: {}, fingerprint: 'f', estimatedTokens: 80 }),
    e('compaction', 1820, { summary: { id: 'sum', role: 'user', content: [{ type: 'text', text: '摘要' }], createdAt: 0 }, replacesUpTo: 'm1', strategy: 'summarize' }),
    e('llm/response', 2000, { turnId: 't1', stepId: 'st2', messageId: 'a2', finishReason: 'stop', usage: usage(150, 30), attempts: 1 }),
    e('message', 2001, assistant('a2', '完成了')),
    e('custom', 2002, { kind: 'my-plugin/note', data: { x: 1 } }),
    e('turn/end', 2010, { turnId: 't1', reason: 'completed', usage: usage(250, 50), steps: 2 }),
  ]
}

describe('投影：旧宿主日志（0.2.1，优雅降级）', () => {
  const t = projectSession('s1', legacyLog(), undefined, O)

  it('turn / step / 工具树与累计用量', () => {
    expect(t.turns).toHaveLength(1)
    const tr = t.turns[0]!
    expect(tr.status).toBe('done')
    expect(tr.reason).toBe('completed')
    expect(tr.durationMs).toBe(1010)
    expect(tr.steps.map((s) => s.stepId)).toEqual(['st1', 'st2'])
    expect(t.usage.inputTokens).toBe(250)
    expect(t.usage.outputTokens).toBe(50)
    expect(t.stats).toMatchObject({ turns: 1, steps: 2, toolCalls: 3, toolErrors: 1, failedAttempts: 1, compactions: 1 })
    expect(tr.records.map((r) => r.kind)).toEqual(['compaction', 'custom'])
  })

  it('step 耗时来自事件时间，TTFT 标为不可用', () => {
    const s = t.turns[0]!.steps[0]!
    expect(s.durationMs).toBe(490)
    expect(s.ttftMs).toBeUndefined()
    expect(s.ttftSource).toBe('unavailable')
    expect(s.attempts).toBe(2)
    expect(s.failures[0]).toMatchObject({ attempt: 1, code: 'network' })
    expect(s.inputTools).toBe(2)
    expect(t.capabilities).toMatchObject({ toolEvents: false, ttft: false, sessionMeta: false })
  })

  it('工具耗时用结果里的自报耗时，开始时间推算；预检失败的标为未执行', () => {
    const [c1, c2, c3] = t.turns[0]!.steps[0]!.tools
    expect(c1).toMatchObject({ name: 'echo', status: 'done', durationMs: 250, timing: 'estimated', startedAt: 1550, endedAt: 1800 })
    expect(c2).toMatchObject({ name: 'missing', status: 'not_run', isError: true, errorCode: 'tool_not_found' })
    expect(c3!.children).toEqual([{ sessionId: 'child1', origin: 'sub-agent', label: 'sub-agent:explorer', via: 'result' }])
    expect(childIds(t)).toEqual(['child1'])
  })

  it('默认脱敏：参数里的密码字段与文本里的密钥', () => {
    const c1 = t.turns[0]!.steps[0]!.tools[0]!
    expect(c1.args).toContain('"password": "***"')
    expect(c1.args).not.toContain('hunter2')
    expect(t.turns[0]!.input).not.toContain('sk-abcdefghijklmnop')
    const raw = projectSession('s1', legacyLog(), undefined, { redact: false, maxPreviewChars: 4000 })
    expect(raw.turns[0]!.steps[0]!.tools[0]!.args).toContain('hunter2')
  })

  it('运行时数据补齐 TTFT 与工具时间（live）', () => {
    const live = {
      running: false,
      meta: { label: 'main' },
      steps: new Map([['st2', { requestAt: 1810, attemptStartedAt: 1810, firstTokenAt: 1900 }]]),
      tools: new Map([['c1', { name: 'echo', startedAt: 1540, endedAt: 1795, progress: ['50%'] }]]),
    }
    const l = projectSession('s1', legacyLog(), live, O)
    const s2 = l.turns[0]!.steps[1]!
    expect(s2.ttftSource).toBe('live')
    expect(s2.ttftMs).toBe(90)
    expect(s2.decodeMs).toBe(100)
    const c1 = l.turns[0]!.steps[0]!.tools[0]!
    expect(c1).toMatchObject({ timing: 'live', startedAt: 1540, endedAt: 1795, durationMs: 250, progress: ['50%'] })
    expect(l.metaSource).toBe('live')
  })

  it('截断预览', () => {
    const short = projectSession('s1', legacyLog(), undefined, { redact: true, maxPreviewChars: 80 })
    expect(short.turns[0]!.input!.length).toBeLessThan(120)
  })
})

describe('投影：新宿主日志（leo-agents ≥ 0.2.2）', () => {
  function newLog() {
    let n = 0
    const e = (type: string, at: number, data: unknown) => evt('p', ++n, type, at, data)
    return [
      e('session/meta', 999, { origin: 'main', label: '主会话', agentId: 'ag', model: 'mock/m' }),
      e('turn/start', 1000, { turnId: 't1' }),
      e('message', 1001, user('u1', 'go')),
      e('llm/request', 1010, { turnId: 't1', stepId: 'st1', model: 'mock/m', system: '', messageIds: ['u1'], tools: ['echo'], params: {}, fingerprint: 'f', estimatedTokens: 5 }),
      e('llm/response', 1300, { turnId: 't1', stepId: 'st1', messageId: 'a1', finishReason: 'tool_calls', usage: usage(10, 5), attempts: 1, startedAt: 1020, firstTokenAt: 1200 }),
      e('message', 1301, assistant('a1', '', [{ id: 'c1', name: 'echo', arguments: { text: 'x' } }, { id: 'c2', name: 'nope', arguments: {} }])),
      e('tool/start', 1305, { turnId: 't1', stepId: 'st1', callId: 'c1', name: 'echo', messageId: 'a1', at: 1304 }),
      e('tool/end', 1400, { turnId: 't1', stepId: 'st1', callId: 'c1', name: 'echo', isError: false, durationMs: 95, startedAt: 1304, endedAt: 1399 }),
      e('message', 1401, toolMsg('m1', 'c1', 'echo', 'x', { durationMs: 95 })),
      e('message', 1402, toolMsg('m2', 'c2', 'nope', 'Error', { durationMs: 0, errorCode: 'tool_denied' }, true)),
      e('turn/end', 1500, { turnId: 't1', reason: 'terminated_by_tool', usage: usage(10, 5), steps: 1 }),
    ]
  }

  it('使用精确的工具时间、TTFT 与 session/meta', () => {
    const t = projectSession('p', newLog(), undefined, O)
    expect(t.capabilities).toMatchObject({ toolEvents: true, ttft: true, sessionMeta: true })
    expect(t.meta).toMatchObject({ origin: 'main', label: '主会话' })
    expect(t.metaSource).toBe('log')
    const s = t.turns[0]!.steps[0]!
    expect(s).toMatchObject({ ttftMs: 180, decodeMs: 100, durationMs: 290, ttftSource: 'log', startedAt: 1020 })
    const [c1, c2] = s.tools
    expect(c1).toMatchObject({ timing: 'log', startedAt: 1304, endedAt: 1399, durationMs: 95, status: 'done', isError: false })
    expect(c2).toMatchObject({ status: 'not_run', errorCode: 'tool_denied' })
  })

  it('运行中的会话：没有 turn/end 的 turn 与 step 标为运行中', () => {
    const log = newLog().slice(0, 7)
    const t = projectSession('p', log, { running: true, steps: new Map(), tools: new Map() }, O)
    expect(t.running).toBe(true)
    expect(t.turns[0]!.status).toBe('running')
    expect(t.turns[0]!.steps[0]!.tools[0]!.status).toBe('running')
    // 不再运行时（进程重启后）同一份日志：turn 视为结束
    const after = projectSession('p', log, undefined, O)
    expect(after.turns[0]!.status).toBe('done')
  })

  it('agent-team：team_start 结果挂 Leader，Leader 的 team_assign 挂成员', () => {
    const main = [
      evt('m', 1, 'turn/start', 1, { turnId: 't' }),
      evt('m', 2, 'llm/request', 2, { turnId: 't', stepId: 's', model: 'm', messageIds: [], tools: [] }),
      evt('m', 3, 'llm/response', 3, { turnId: 't', stepId: 's', messageId: 'a', finishReason: 'tool_calls', usage: usage(1, 1), attempts: 1 }),
      evt('m', 4, 'message', 4, assistant('a', '', [{ id: 'k1', name: 'team_start', arguments: { requirement: 'x' } }])),
      evt('m', 5, 'message', 5, toolMsg('r', 'k1', 'team_start', 'ok', { durationMs: 5, details: { projectId: 'tp1', status: 'running' } })),
    ]
    expect(projectSession('m', main, undefined, O).turns[0]!.steps[0]!.tools[0]!.children[0]).toMatchObject({ sessionId: 'team-tp1-leader', via: 'naming' })
    const leader = [
      evt('team-tp1-leader', 1, 'turn/start', 1, { turnId: 't' }),
      evt('team-tp1-leader', 2, 'llm/request', 2, { turnId: 't', stepId: 's', model: 'm', messageIds: [], tools: [] }),
      evt('team-tp1-leader', 3, 'llm/response', 3, { turnId: 't', stepId: 's', messageId: 'a', finishReason: 'tool_calls', usage: usage(1, 1), attempts: 1 }),
      evt('team-tp1-leader', 4, 'message', 4, assistant('a', '', [{ id: 'k2', name: 'team_assign', arguments: { role: 'tech-lead', task: 'design' } }])),
    ]
    expect(projectSession('team-tp1-leader', leader, undefined, O).turns[0]!.steps[0]!.tools[0]!.children[0]).toMatchObject({ sessionId: 'team-tp1-tech-lead', label: 'agent-team:tech-lead' })
  })

  it('不认识的事件被忽略', () => {
    const t = projectSession('p', [...newLog(), evt('p', 99, 'future/thing', 2000, { a: 1 })], undefined, O)
    expect(t.stats.events).toBe(12)
    expect(t.turns).toHaveLength(1)
  })
})

describe('脱敏', () => {
  it('常见密钥格式', () => {
    const s = redactText('token ghp_abcdefghijklmnopqrstuvwxyz0123 and Bearer abcdefghijklmnop12345 url https://u:pw123@host/x AKIAABCDEFGHIJKLMNOP')
    expect(s).not.toMatch(/ghp_abcdefghij|abcdefghijklmnop12345|pw123|AKIAABCDEFGHIJKLMNOP/)
    expect(redactValue({ headers: { Authorization: 'x', ok: 'fine' }, apiKey: 'k' })).toEqual({ headers: { Authorization: '***', ok: 'fine' }, apiKey: '***' })
  })
})

describe('运行时观察', () => {
  it('最多保留 maxLiveSessions 个会话，运行中的不丢', () => {
    const changes: string[] = []
    let now = 0
    const tr = new LiveTracker(2, (s) => void changes.push(s), () => ++now)
    tr.onAgentEvent({ id: 'a1', sessionId: 's1' }, { type: 'turn_start' })
    tr.onAppended({ sessionId: 's2', type: 'custom', at: 1, data: {} })
    tr.onAppended({ sessionId: 's3', type: 'custom', at: 1, data: {} })
    expect(tr.sessionIds().sort()).toEqual(['s1', 's3'])
    expect(tr.isRunning('s1')).toBe(true)
  })

  it('重试后重新测首 token；tool_update 的 agentId 把子会话挂到父调用', () => {
    let now = 1000
    const tr = new LiveTracker(10, () => {}, () => now)
    const parent = { id: 'pa', sessionId: 'ps' }
    tr.onAgentEvent(parent, { type: 'turn_start' })
    tr.onAppended({ sessionId: 'ps', type: 'llm/request', at: 1000, data: { stepId: 'st' } })
    now = 1050
    tr.onAgentEvent(parent, { type: 'text_delta', stepId: 'st', text: 'x' })
    now = 1100
    tr.onAgentEvent(parent, { type: 'retry', stepId: 'st', attempt: 1, delayMs: 100 })
    now = 1400
    tr.onAgentEvent(parent, { type: 'text_delta', stepId: 'st', text: 'y' })
    expect(tr.hints('ps')!.steps.get('st')).toMatchObject({ attemptStartedAt: 1200, firstTokenAt: 1400 })

    tr.onAgentEvent(parent, { type: 'tool_start', call: { id: 'c1', name: 'task' } })
    tr.onAgentEvent(parent, { type: 'tool_update', callId: 'c1', partial: { type: 'progress', message: 'working', agentId: 'child-agent' } })
    tr.onSubAgentStarted({ id: 'child-agent', sessionId: 'cs', parentAgentId: 'pa', agent: 'explorer' })
    expect(tr.links.get('cs')).toEqual({ parentSessionId: 'ps', callId: 'c1', via: 'live' })
    expect(tr.sessionInfo('cs')!.meta).toMatchObject({ origin: 'sub-agent', label: 'sub-agent:explorer', parentSessionId: 'ps', parentToolCallId: 'c1' })
    expect(tr.hints('ps')!.tools.get('c1')!.progress).toEqual(['working'])
  })
})
