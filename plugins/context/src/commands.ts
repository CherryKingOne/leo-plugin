/**
 * `/context` 命令（需要 leo-agents ≥ 0.2.1 的 commands 服务）：
 *   /context            当前会话的上下文：占用、离自动压缩多远、组成、用量与成本
 *   /context <会话 id>   指定会话
 *   /context open       网页地址
 *   /context list       最近 10 个会话的上下文大小
 */
import type { ContextInsights } from './service.js'
import { CATEGORIES, type Category, type Composition, type SessionReport } from './types.js'

export const CATEGORY_LABEL: Record<Category, string> = {
  system: 'System 提示词',
  injected: '插件注入',
  tools: '工具定义',
  user: '用户消息',
  answers: '回答',
  reasoning: '思考',
  toolCalls: '工具调用',
  toolResults: '工具结果',
  summary: '压缩摘要',
}

export const fmtTokens = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)))
export const fmtCost = (usd: number): string => (usd <= 0 ? '$0' : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`)
const pct = (x: number) => `${(x * 100).toFixed(1)}%`

export function compositionLines(c: Composition, total: number): string[] {
  return CATEGORIES.filter((k) => c[k] > 0)
    .sort((a, b) => c[b] - c[a])
    .map((k) => `  ${CATEGORY_LABEL[k].padEnd(8, '　')} ${fmtTokens(c[k]).padStart(7)}  ${total ? pct(c[k] / total) : '—'}`)
}

export function summaryText(r: SessionReport): string {
  const lines: string[] = []
  const name = r.meta.label ? `${r.meta.label}（${r.sessionId}）` : r.sessionId
  lines.push(`上下文 · ${name}`)
  const cur = r.current
  if (!cur) {
    lines.push('还没有模型请求。')
    return lines.join('\n')
  }
  const w = cur.window
  lines.push(
    `模型 ${cur.model} · 当前约 ${fmtTokens(cur.estimatedTokens)} / ${fmtTokens(w.contextWindow)}（${pct(cur.occupancy)}）` +
      ` · ${cur.untilCompaction >= 0 ? `离自动压缩还有约 ${fmtTokens(cur.untilCompaction)}` : `已超过自动压缩阈值 ${fmtTokens(-cur.untilCompaction)}`}`,
  )
  const total = CATEGORIES.reduce((n, k) => n + cur.composition[k], 0)
  lines.push(`组成${cur.source === 'estimate' ? '（推算：宿主日志没有 breakdown，需要 leo-agents ≥ 0.2.3）' : ''}：`)
  lines.push(...compositionLines(cur.composition, total))
  const owners = Object.entries(cur.injectedBy).sort((a, b) => b[1] - a[1])
  if (owners.length) lines.push(`  插件注入来自：${owners.map(([o, t]) => `${o} ${fmtTokens(t)}`).join('，')}`)
  const s = r.stats
  const u = s.usage
  lines.push(
    `${s.turns} 轮 · ${s.steps} 次请求 · ${s.toolCalls} 次工具调用${s.compactions ? ` · 压缩 ${s.compactions} 次` : ''}` +
      ` · 计费 ${fmtTokens(u.billedTokens)}（输入 ${fmtTokens(u.inputTokens)}，输出 ${fmtTokens(u.outputTokens)}${u.cacheHitRate !== undefined ? `，缓存命中 ${pct(u.cacheHitRate)}` : ''}）` +
      (u.costSource !== 'none' ? ` · ${u.costSource === 'pricing' ? '约 ' : ''}${fmtCost(u.costUsd)}` : ''),
  )
  return lines.join('\n')
}

export function contextCommand(deps: { service: ContextInsights; urlText: () => string }) {
  return {
    name: 'context',
    description: '查看上下文：占用、离自动压缩多远、由什么组成（open 网页地址，list 最近会话）',
    usage: '[open | list | <会话 id>]',
    async run(c: { args: string; argv: string[]; sessionId?: string }) {
      const sub = c.argv[0]
      if (sub === 'open') return { text: deps.urlText() }
      if (sub === 'list') {
        const list = (await deps.service.list()).slice(0, 10)
        if (!list.length) return { text: '还没有会话。' }
        return {
          text: list
            .map((s) => `${s.sessionId}${s.label ? `（${s.label}）` : ''} · ${s.contextTokens !== undefined ? `上下文 ${fmtTokens(s.contextTokens)}${s.occupancy !== undefined ? `（${pct(s.occupancy)}）` : ''}` : '无请求'} · 计费 ${fmtTokens(s.billedTokens ?? 0)}`)
            .join('\n'),
        }
      }
      const id = sub ?? c.sessionId
      if (!id) return { text: '没有当前会话。用法：/context [open | list | <会话 id>]', isError: true }
      const r = await deps.service.report(id)
      if (!r) return { text: `找不到会话 ${id}。`, isError: true }
      return { text: `${summaryText(r)}\n${deps.urlText()}` }
    },
  }
}
