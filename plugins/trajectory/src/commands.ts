/**
 * `/trace` 命令（leo-agents ≥ 0.2.1 的 commands 服务；旧宿主没有就不注册）。
 * 这里不 import commands 的类型，用最小结构类型，旧宿主也能编译。
 */
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Trajectories } from './service.js'
import type { SessionSummary, StepRecord, ToolCallRecord, TrajectoryTree, UsageLike } from './types.js'

export interface CommandContext {
  args: string
  argv: string[]
  sessionId?: string
  surface: string
}
export interface CommandResult {
  text?: string
  isError?: boolean
}
export interface CommandDefinition {
  name: string
  description?: string
  usage?: string
  run(c: CommandContext): Promise<CommandResult>
}

export interface TraceCommandDeps {
  service: Trajectories
  /** 导出目录所在的 .leo（项目 .leo，没有时 ~/.leo） */
  leoDir: () => string
  /** 打开网页的提示（含令牌说明）；服务未启动时返回原因 */
  urlText: () => string
}

const USAGE = `/trace                 当前会话的摘要：turn、step、token、最慢的步骤与工具
/trace open            网页地址
/trace export [文件]   导出当前会话轨迹（JSON）到 .leo/trajectory/，或 .leo 内的指定路径
/trace list            最近的会话`

export function traceCommand(d: TraceCommandDeps): CommandDefinition {
  return {
    name: 'trace',
    description: '轨迹观测：会话摘要、网页地址、导出',
    usage: '[open|export [文件]|list]',
    async run(c) {
      const [sub = '', ...rest] = c.argv
      try {
        switch (sub) {
          case '':
          case 'summary':
            return await summary(d, c.sessionId, rest[0])
          case 'open':
          case 'url':
            return { text: d.urlText() }
          case 'list':
            return { text: formatList(await d.service.list()) }
          case 'export':
            return await exportTrace(d, c.sessionId, rest.join(' ').trim() || undefined)
          case 'help':
            return { text: USAGE }
          default:
            // `/trace <sessionId>`：看别的会话
            return await summary(d, sub)
        }
      } catch (err) {
        return { text: `trace: ${(err as Error).message}`, isError: true }
      }
    },
  }
}

async function pickSession(d: TraceCommandDeps, sessionId: string | undefined): Promise<string | undefined> {
  if (sessionId) return sessionId
  const list = await d.service.list()
  return (list.find((s) => s.running) ?? list.find((s) => !s.parentSessionId) ?? list[0])?.sessionId
}

async function summary(d: TraceCommandDeps, current: string | undefined, explicit?: string): Promise<CommandResult> {
  const sid = await pickSession(d, explicit ?? current)
  if (!sid) return { text: '还没有会话记录。' }
  const t = await d.service.get(sid, { depth: 3 })
  if (!t) return { text: `没有找到会话 ${sid}。`, isError: true }
  return { text: formatSummary(t, d.urlText()) }
}

export function formatSummary(t: TrajectoryTree, urlLine?: string): string {
  const steps: { s: StepRecord; label: string }[] = []
  const tools: { c: ToolCallRecord; label: string }[] = []
  const walk = (x: TrajectoryTree, prefix: string) => {
    for (const tr of x.turns) {
      for (const s of tr.steps) {
        steps.push({ s, label: `${prefix}turn ${tr.index} step ${s.index}${s.model ? ` (${s.model})` : ''}` })
        for (const c of s.tools) tools.push({ c, label: `${prefix}${c.name}` })
      }
    }
    for (const [id, ch] of Object.entries(x.childSessions ?? {})) walk(ch, `[${ch.meta.label ?? id}] `)
  }
  walk(t, '')
  const children = Object.keys(t.childSessions ?? {}).length
  const total = Object.values(t.childSessions ?? {}).reduce((u, ch) => sumUsage(u, ch.usage), { ...t.usage })
  const lines = [
    `会话 ${t.sessionId}${t.meta.label ? `（${t.meta.label}）` : ''}${t.running ? ' · 运行中' : ''}`,
    `turn ${t.stats.turns} · step ${t.stats.steps} · 工具调用 ${t.stats.toolCalls}${t.stats.toolErrors ? `（失败 ${t.stats.toolErrors}）` : ''}${t.stats.failedAttempts ? ` · 重试 ${t.stats.failedAttempts}` : ''}${t.stats.compactions ? ` · 压缩 ${t.stats.compactions}` : ''}`,
    `token：${fmtUsage(t.usage)}${children ? `；含 ${children} 个子会话共 ${fmtUsage(total)}` : ''}`,
  ]
  const slowSteps = steps.filter((x) => x.s.durationMs !== undefined).sort((a, b) => b.s.durationMs! - a.s.durationMs!).slice(0, 3)
  if (slowSteps.length) {
    lines.push('最慢的模型调用：')
    for (const { s, label } of slowSteps) lines.push(`  ${ms(s.durationMs)}  ${label}${s.ttftMs !== undefined ? ` · TTFT ${ms(s.ttftMs)}` : ''}${s.failures.length ? ` · 重试 ${s.failures.length}` : ''}`)
  }
  const slowTools = tools.filter((x) => x.c.durationMs !== undefined).sort((a, b) => b.c.durationMs! - a.c.durationMs!).slice(0, 3)
  if (slowTools.length) {
    lines.push('最慢的工具：')
    for (const { c, label } of slowTools) lines.push(`  ${ms(c.durationMs)}${c.timing === 'estimated' ? '≈' : ''}  ${label}${c.isError ? ' ✗' : ''}`)
  }
  if (!t.capabilities.ttft || !t.capabilities.toolEvents) {
    lines.push('注：宿主日志没有完整计时（需要 leo-agents ≥ 0.2.2）；TTFT 只有本次运行期间现场测到的，工具开始时间由耗时推算（≈）。')
  }
  if (urlLine) lines.push(urlLine)
  return lines.join('\n')
}

function formatList(list: SessionSummary[]): string {
  if (!list.length) return '还没有会话记录。'
  const top = list.slice(0, 20)
  const lines = top.map(
    (s) => `${s.running ? '● ' : '  '}${s.sessionId}${s.label ? `  ${s.label}` : ''}${s.origin && s.origin !== 'main' ? ` [${s.origin}]` : ''}${s.updatedAt ? `  ${new Date(s.updatedAt).toLocaleString()}` : ''}${s.events !== undefined ? `  ${s.events} 条` : ''}`,
  )
  if (list.length > top.length) lines.push(`…共 ${list.length} 个会话`)
  return lines.join('\n')
}

/** 导出路径必须在 .leo 内（默认 .leo/trajectory/<会话>-<时间>.json） */
export async function resolveExportPath(leoDir: string, sessionId: string, given: string | undefined, now = new Date()): Promise<string> {
  const base = resolve(leoDir)
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const target = given ? resolve(base, given) : join(base, 'trajectory', `${sessionId.replace(/[^\w.-]/g, '_')}-${stamp}.json`)
  const inside = (p: string, root: string) => {
    const r = relative(root, p)
    return r !== '' && !r.startsWith('..') && !isAbsolute(r) && !r.split(sep).includes('..')
  }
  if (!inside(target, base)) throw new Error(`导出路径必须在 ${base} 之内`)
  // 符号链接逃逸：检查已存在的最近一级父目录的真实路径
  await mkdir(dirname(target), { recursive: true })
  const realBase = await realpath(base)
  const realParent = await realpath(dirname(target))
  if (realParent !== realBase && !inside(realParent, realBase)) throw new Error(`导出路径必须在 ${base} 之内`)
  return target
}

async function exportTrace(d: TraceCommandDeps, current: string | undefined, file: string | undefined): Promise<CommandResult> {
  const sid = await pickSession(d, current)
  if (!sid) return { text: '还没有会话记录。', isError: true }
  const t = await d.service.get(sid, { depth: 4 })
  if (!t) return { text: `没有找到会话 ${sid}。`, isError: true }
  const path = await resolveExportPath(d.leoDir(), sid, file)
  const body = { format: 'leo-trajectory', version: 1, exportedAt: new Date().toISOString(), trajectory: t }
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  return { text: `已导出 ${sid} → ${path}` }
}

function sumUsage(a: UsageLike, b: UsageLike): UsageLike {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0),
    reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0),
    costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0),
  }
}

function fmtUsage(u: UsageLike): string {
  let s = `${u.inputTokens}↑ ${u.outputTokens}↓`
  if (u.cachedInputTokens) s += ` 缓存 ${u.cachedInputTokens}`
  if (u.reasoningTokens) s += ` 思考 ${u.reasoningTokens}`
  if (u.costUsd) s += ` $${u.costUsd.toFixed(4)}`
  return s
}

export function ms(v: number | undefined): string {
  if (v === undefined) return '—'
  if (v < 1000) return `${Math.round(v)}ms`
  if (v < 60_000) return `${(v / 1000).toFixed(v < 10_000 ? 2 : 1)}s`
  return `${Math.floor(v / 60_000)}m${Math.round((v % 60_000) / 1000)}s`
}
