import { describe, expect, it } from 'vitest'
import { analyzeSession, approxTokens, messageComposition, programOf } from '../src/analyze.js'
import { CATEGORIES } from '../src/types.js'
import { evt } from './helpers.js'

const S = 's1'
const msg = (id: string, role: string, content: unknown[], extra: Record<string, unknown> = {}) => ({ message: { id, role, content, createdAt: 1, ...extra } })

/** 一段带 breakdown 的会话：两轮、一次工具调用、一次压缩、换模型 */
function sessionWithBreakdown() {
  const bd = (tools: Record<string, number>, sections = [{ id: 'agent.system', layer: 'agent', owner: 'agent', tokens: 10 }, { id: 'skills.catalog', layer: 'runtime', owner: 'skills', tokens: 30 }]) => ({
    tokenizer: 'approx',
    sections,
    tools,
    messages: 0,
    contextWindow: 1000,
    reserveOutputTokens: 100,
    limitTokens: 900,
    softLimitTokens: 765,
  })
  const ev = [
    evt(S, 'session/meta', 1, { label: 'main', origin: 'main', model: 'p/a' }),
    evt(S, 'turn/start', 1000, { turnId: 't1' }),
    evt(S, 'message', 1001, msg('u1', 'user', [{ type: 'text', text: 'please read README.md and run ls' }])),
    evt(S, 'llm/request', 1010, { turnId: 't1', stepId: 'st1', model: 'p/a', system: 'sys', messageIds: ['u1'], tools: ['read_file', 'bash', 'skill'], params: {}, fingerprint: 'f', estimatedTokens: 120, breakdown: bd({ read_file: 20, bash: 15, skill: 12 }) }),
    evt(S, 'llm/attempt-failed', 1020, { turnId: 't1', stepId: 'st1', attempt: 1, code: 'rate_limited', message: 'slow down' }),
    evt(S, 'message', 1100, msg('a1', 'assistant', [
      { type: 'reasoning', text: 'thinking about it' },
      { type: 'tool_call', id: 'c1', name: 'read_file', arguments: { path: 'README.md' }, rawArguments: '{"path":"README.md"}' },
      { type: 'tool_call', id: 'c2', name: 'bash', arguments: { command: 'FOO=1 sudo ls -la' }, rawArguments: '' },
      { type: 'tool_call', id: 'c3', name: 'skill', arguments: { name: 'pdf' }, rawArguments: '' },
    ])),
    evt(S, 'llm/response', 1100, { turnId: 't1', stepId: 'st1', messageId: 'a1', finishReason: 'tool_calls', usage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20 }, attempts: 2, startedAt: 1040, firstTokenAt: 1060 }),
    evt(S, 'tool/start', 1101, { turnId: 't1', stepId: 'st1', callId: 'c1', name: 'read_file', messageId: 'a1', at: 1101 }),
    evt(S, 'tool/start', 1101, { turnId: 't1', stepId: 'st1', callId: 'c2', name: 'bash', messageId: 'a1', at: 1101 }),
    evt(S, 'tool/end', 1150, { turnId: 't1', stepId: 'st1', callId: 'c1', name: 'read_file', isError: false, durationMs: 49, startedAt: 1101, endedAt: 1150 }),
    evt(S, 'tool/end', 1200, { turnId: 't1', stepId: 'st1', callId: 'c2', name: 'bash', isError: true, durationMs: 99, startedAt: 1101, endedAt: 1200 }),
    evt(S, 'tool/start', 1201, { turnId: 't1', stepId: 'st1', callId: 'c3', name: 'skill', messageId: 'a1', at: 1201 }),
    evt(S, 'tool/end', 1210, { turnId: 't1', stepId: 'st1', callId: 'c3', name: 'skill', isError: false, durationMs: 9, startedAt: 1201, endedAt: 1210 }),
    evt(S, 'message', 1150, msg('r1', 'tool', [{ type: 'text', text: '# README\nhello world' }], { toolCallId: 'c1', toolName: 'read_file' })),
    evt(S, 'message', 1200, msg('r2', 'tool', [{ type: 'text', text: 'exit 1' }], { toolCallId: 'c2', toolName: 'bash', isError: true })),
    evt(S, 'message', 1210, msg('r3', 'tool', [{ type: 'text', text: 'skill body' }], { toolCallId: 'c3', toolName: 'skill' })),
    evt(S, 'llm/request', 1220, { turnId: 't1', stepId: 'st2', model: 'p/a', system: 'sys', messageIds: ['u1', 'a1', 'r1', 'r2', 'r3', 'ghost'], tools: ['read_file', 'bash'], params: {}, fingerprint: 'f', estimatedTokens: 300, breakdown: { ...bd({ read_file: 20, bash: 15 }), messages: 999999 } }),
    evt(S, 'message', 1300, msg('a2', 'assistant', [{ type: 'text', text: 'done' }])),
    evt(S, 'llm/response', 1300, { turnId: 't1', stepId: 'st2', messageId: 'a2', finishReason: 'stop', usage: { inputTokens: 200, outputTokens: 10, costUsd: 0.5 }, attempts: 1 }),
    evt(S, 'turn/end', 1300, { turnId: 't1', reason: 'stop', usage: {}, steps: 2 }),
    evt(S, 'turn/start', 2000, { turnId: 't2' }),
    evt(S, 'message', 2001, msg('u2', 'user', [{ type: 'text', text: 'next' }])),
    evt(S, 'compaction', 2002, { summary: { id: 'sum1', role: 'user', content: [{ type: 'text', text: 'summary of earlier work' }], createdAt: 2002, meta: { compaction: true } }, replacesUpTo: 'r3', strategy: 'truncate' }),
    evt(S, 'llm/request', 2010, { turnId: 't2', stepId: 'st3', model: 'p/b', system: 'sys', messageIds: ['sum1', 'a2', 'u2'], tools: ['read_file', 'bash'], params: {}, fingerprint: 'g', estimatedTokens: 200, breakdown: bd({ read_file: 20, bash: 15 }, [{ id: 'agent.system', layer: 'agent', owner: 'agent', tokens: 10 }]) }),
    evt(S, 'message', 2100, msg('a3', 'assistant', [{ type: 'text', text: 'ok' }])),
    evt(S, 'llm/response', 2100, { turnId: 't2', stepId: 'st3', messageId: 'a3', finishReason: 'stop', usage: { inputTokens: 50, outputTokens: 5 }, attempts: 1 }),
    evt(S, 'turn/end', 2100, { turnId: 't2', reason: 'stop', usage: {}, steps: 1 }),
  ]
  return ev
}

describe('analyzeSession', () => {
  it('有 breakdown：组成、当前上下文、事件、用量、工具 / 文件 / 命令 / 技能', () => {
    const { report: r, detail } = analyzeSession(S, sessionWithBreakdown(), {
      pricing: (m) => (m === 'p/a' || m === 'p/b' ? { inputPerMTok: 1_000_000, outputPerMTok: 2_000_000, cachedInputPerMTok: 0 } : undefined),
    })
    expect(r.completeness).toEqual({ breakdown: true, toolTiming: true })
    expect(r.meta.label).toBe('main')
    expect(r.models).toEqual(['p/a', 'p/b'])
    expect(r.stats.turns).toBe(2)
    expect(r.stats.steps).toBe(3)
    expect(r.stats.userInputs).toBe(2)
    expect(r.stats.toolCalls).toBe(3)
    expect(r.stats.toolErrors).toBe(1)
    expect(r.stats.compactions).toBe(1)
    expect(r.stats.failedAttempts).toBe(1)

    // 第一次请求：system 10、插件注入 30（skills）、工具 47、用户消息
    const p0 = r.trend[0]!
    expect(p0.source).toBe('log')
    expect(p0.composition.system).toBe(10)
    expect(p0.composition.injected).toBe(30)
    expect(p0.composition.tools).toBe(47)
    expect(p0.composition.user).toBeGreaterThan(0)
    expect(p0.failedAttempts).toBe(1)
    expect(p0.ttftMs).toBe(20)
    expect(p0.durationMs).toBe(90)
    // 第二次请求：日志外的消息（ghost）按残差归到插件注入
    const p1 = r.trend[1]!
    expect(p1.composition.reasoning).toBeGreaterThan(0)
    expect(p1.composition.toolCalls).toBeGreaterThan(0)
    expect(p1.composition.toolResults).toBeGreaterThan(0)
    expect(p1.composition.injected).toBeGreaterThan(30)
    // 第三次：压缩后
    expect(r.trend[2]!.compacted).toBe(true)
    expect(r.trend[2]!.composition.summary).toBeGreaterThan(0)

    const c = r.current!
    expect(c.requestIndex).toBe(2)
    expect(c.model).toBe('p/b')
    expect(c.window).toEqual({ contextWindow: 1000, reserveOutputTokens: 100, limitTokens: 900, softLimitTokens: 765, source: 'log' })
    expect(c.occupancy).toBeCloseTo(0.2)
    expect(c.untilCompaction).toBe(565)
    expect(c.injectedBy).toEqual({})

    const kinds = r.contextEvents.map((e) => e.kind)
    expect(kinds).toContain('retry')
    expect(kinds).toContain('tools')
    expect(kinds).toContain('compaction')
    expect(kinds).toContain('model')
    expect(kinds).toContain('sections')
    const comp = r.contextEvents.find((e) => e.kind === 'compaction')!
    expect(comp.before).toBe(300)
    expect(comp.after).toBe(200)

    // 用量：第二次厂商给了 costUsd，其余按价目
    const u = r.stats.usage
    expect(u.inputTokens).toBe(350)
    expect(u.cachedInputTokens).toBe(40)
    expect(u.outputTokens).toBe(35)
    expect(u.billedTokens).toBe(385)
    expect(u.cacheHitRate).toBeCloseTo(40 / 350)
    expect(u.costSource).toBe('mixed')
    // 价目：请求 1 = (60*1 + 40*0 + 20*2)，请求 3 = (50*1 + 5*2)；厂商 0.5
    expect(u.costUsd).toBeCloseTo(0.5 + 100 + 60)

    // 耗时：两个 turn 共 300 + 100；工具按 step 取墙钟 1101→1210
    expect(r.stats.timing.activeMs).toBe(400)
    expect(r.stats.timing.modelMs).toBe(90 + 80 + 90)
    expect(r.stats.timing.toolMs).toBe(109)
    expect(r.stats.timing.toolSource).toBe('log')

    expect(r.tools.map((t) => t.name).sort()).toEqual(['bash', 'read_file', 'skill'])
    expect(r.tools.find((t) => t.name === 'bash')!.errors).toBe(1)
    expect(r.files).toEqual([{ path: 'README.md', ops: { read: 1 }, errors: 0, lastAt: 1100 }])
    expect(r.commands).toEqual([{ at: 1100, callId: 'c2', command: 'FOO=1 sudo ls -la', program: 'ls', ok: false, durationMs: 99 }])
    expect(r.skills).toEqual([{ name: 'pdf', loads: 1, lastAt: 1100 }])

    // 浏览器：片段、工具、消息；分类过滤与分页
    const d = detail(1, { preview: (v) => String(v) })!
    expect(d.items.filter((i) => i.kind === 'section').map((i) => i.id)).toEqual(['agent.system', 'skills.catalog'])
    expect(d.items.filter((i) => i.kind === 'tool').map((i) => i.id)).toEqual(['read_file', 'bash'])
    expect(d.items.find((i) => i.id === 'ghost')!.category).toBe('injected')
    expect(d.items.find((i) => i.id === 'r2')!.label).toContain('出错')
    const only = detail(1, { category: 'toolResults', preview: (v) => String(v) })!
    expect(only.items.every((i) => i.category === 'toolResults')).toBe(true)
    expect(only.total).toBe(3)
    const page = detail(1, { offset: 1, limit: 2, preview: (v) => String(v) })!
    expect(page.items).toHaveLength(2)
    expect(page.offset).toBe(1)
    expect(detail(99, { preview: String })).toBeUndefined()
  })

  it('没有 breakdown（旧宿主）：System 整体一类，工具定义按估算总量推算，窗口取模型信息', () => {
    const ev = sessionWithBreakdown().map((e) => (e.type === 'llm/request' ? { ...e, data: { ...(e.data as object), breakdown: undefined } } : e))
    const { report: r } = analyzeSession(S, ev, { modelInfo: (m) => (m === 'p/b' ? { contextWindow: 64_000, maxOutputTokens: 4000 } : undefined) })
    expect(r.completeness.breakdown).toBe(false)
    const p0 = r.trend[0]!
    expect(p0.source).toBe('estimate')
    expect(p0.composition.system).toBe(approxTokens('sys'))
    expect(p0.composition.injected).toBe(0)
    expect(p0.composition.tools).toBe(120 - approxTokens('sys') - p0.composition.user)
    const c = r.current!
    expect(c.window).toEqual({ contextWindow: 64_000, reserveOutputTokens: 4000, limitTokens: 60_000, softLimitTokens: 51_000, source: 'model' })
    expect(r.stats.usage.costSource).toBe('provider')
    expect(r.stats.usage.costUsd).toBeCloseTo(0.5)
  })

  it('不认识的模型用底座默认窗口；丢弃最早的消息记为 truncation', () => {
    const ev = [
      evt('x', 'turn/start', 1, { turnId: 't' }),
      evt('x', 'message', 2, msg('m1', 'user', [{ type: 'text', text: 'a' }])),
      evt('x', 'message', 3, msg('m2', 'user', [{ type: 'text', text: 'b' }])),
      evt('x', 'llm/request', 4, { turnId: 't', stepId: 's1', model: 'zz', system: '', messageIds: ['m1', 'm2'], tools: [], params: {}, estimatedTokens: 5 }),
      evt('x', 'llm/request', 5, { turnId: 't', stepId: 's2', model: 'zz', system: '', messageIds: ['m2'], tools: [], params: { maxOutputTokens: 1000 }, estimatedTokens: 3 }),
    ]
    const { report: r } = analyzeSession('x', ev)
    expect(r.current!.window).toMatchObject({ contextWindow: 128_000, reserveOutputTokens: 1000, source: 'default' })
    expect(r.contextEvents.map((e) => e.kind)).toEqual(['truncation'])
    // 进行中的 turn 算到最后一条事件
    expect(r.stats.timing.activeMs).toBe(4)
  })

  it('messageComposition：块分类，字段开销归到主分类，合计等于整条消息', () => {
    const m = { id: 'a', role: 'assistant', content: [{ type: 'text', text: 'hi' }, { type: 'tool_call', id: 'c', name: 'x', arguments: { a: 'long argument value here' }, rawArguments: '' }], createdAt: 1 }
    const c = messageComposition(m)
    const total = CATEGORIES.reduce((n, k) => n + c[k], 0)
    expect(total).toBe(approxTokens(JSON.stringify(m)))
    expect(c.toolCalls).toBeGreaterThan(c.answers)
    expect(messageComposition({ ...m, meta: { compaction: true } }).summary).toBe(approxTokens(JSON.stringify({ ...m, meta: { compaction: true } })))
  })

  it('不同轮次复用同一个 tool call id（call_0）：分别计数与配对', () => {
    const ev: ReturnType<typeof evt>[] = []
    for (let t = 0; t < 3; t++) {
      const base = t * 100
      ev.push(evt('r', 'message', base + 1, msg(`a${t}`, 'assistant', [{ type: 'tool_call', id: 'call_0', name: 'bash', arguments: { command: `echo ${t}` }, rawArguments: '' }])))
      ev.push(evt('r', 'tool/start', base + 2, { turnId: 't', stepId: `s${t}`, callId: 'call_0', name: 'bash', messageId: `a${t}`, at: base + 2 }))
      ev.push(evt('r', 'tool/end', base + 5, { turnId: 't', stepId: `s${t}`, callId: 'call_0', name: 'bash', isError: t === 1, durationMs: 3, startedAt: base + 2, endedAt: base + 5 }))
      ev.push(evt('r', 'message', base + 5, msg(`r${t}`, 'tool', [{ type: 'text', text: 'x' }], { toolCallId: 'call_0', toolName: 'bash', isError: t === 1 })))
    }
    const { report: r } = analyzeSession('r', ev)
    expect(r.stats.toolCalls).toBe(3)
    expect(r.stats.toolErrors).toBe(1)
    expect(r.tools[0]).toMatchObject({ name: 'bash', calls: 3, errors: 1, totalMs: 9 })
    expect(r.commands.map((c) => [c.command, c.ok])).toEqual([['echo 2', true], ['echo 1', false], ['echo 0', true]])
    expect(r.stats.timing.toolMs).toBe(9)
  })

  it('programOf', () => {
    expect(programOf('ls -la')).toBe('ls')
    expect(programOf('FOO=1 BAR=2 sudo -E npm test && echo ok')).toBe('npm')
    expect(programOf('/usr/bin/python3 x.py | head')).toBe('python3')
    expect(programOf('env NODE_ENV=prod node app.js')).toBe('node')
    expect(programOf('  ')).toBe('')
  })
})
