import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLeo, type LlmRequest, MockProvider, type MockResponse, type PluginDefinition, type ToolDefinition } from 'leo-agents'
import { z } from 'zod'
import agentTeam, { type AgentTeamConfig } from '../src/index.js'

type Msg = LlmRequest['messages'][number]
export const textOfMsg = (m: Msg | undefined) => (m ? m.content.map((b) => (b.type === 'text' ? b.text : '')).join('') : '')
/** 团队 Agent 的角色（主 Agent 返回 undefined） */
export const roleOf = (req: LlmRequest) => (req.system ?? '').match(/\[agent-team\] role=(\S+)/)?.[1]
export const toolNames = (req: LlmRequest) => (req.tools ?? []).map((t) => t.name)
/** 最后一条 assistant 消息之后的全部文本（本轮输入或工具结果） */
export const sinceLastAssistant = (req: LlmRequest) => {
  const msgs = req.messages
  let i = msgs.length - 1
  while (i >= 0 && msgs[i]!.role !== 'assistant') i--
  return msgs
    .slice(i + 1)
    .map(textOfMsg)
    .join('\n')
}
export const isFirstStep = (req: LlmRequest) => req.messages[req.messages.length - 1]?.role === 'user'

let callNo = 0
const call = (name: string, args: unknown) => ({ id: `c${++callNo}`, name, arguments: args })

/** 按阶段提示驱动的脚本化 Leader */
export function leaderPolicy(req: LlmRequest): MockResponse {
  const t = sinceLastAssistant(req)
  if (t.includes('Approval requested')) return { text: 'LEADER: 已请用户确认' }
  if (/project finished|Project finished/.test(t)) return { text: 'LEADER: 项目完成' }
  if (t.includes("needs the user's approval") || t.includes('bounce limit')) {
    return { toolCalls: [call('team_request_approval', { summary: 'SUMMARY', question: '可以继续吗？' })] }
  }
  if (t.includes('Saved delivery.md')) return { toolCalls: [call('team_request_approval', { summary: '交付完成', question: '请验收' })] }
  const phases = [...t.matchAll(/Phase now: (\w+)/g)].map((m) => m[1])
  const phase = phases[phases.length - 1]
  if (phase === 'requirements') return { toolCalls: [call('team_assign', { role: 'pm', task: 'write the PRD' })] }
  if (phase === 'design')
    return { toolCalls: [call('team_assign', { role: 'designer', task: 'design it' }), call('team_assign', { role: 'tech-lead', task: 'plan it' })] }
  if (phase === 'development') return { toolCalls: [call('team_assign', { role: 'dev', task: 'build it' })] }
  if (phase === 'qa') return { toolCalls: [call('team_assign', { role: 'qa', task: 'test it' })] }
  if (phase === 'delivery') return { toolCalls: [call('team_artifact', { action: 'write', name: 'delivery.md', content: '# 交付' })] }
  return { text: `LEADER: idle` }
}

export interface Script {
  /** QA 依次给出的结论，用完后一直 pass */
  verdicts?: ('pass' | 'fail')[]
  /** 覆盖某个角色的行为；返回 undefined 用默认 */
  member?: (role: string, req: LlmRequest) => MockResponse | undefined
  leader?: (req: LlmRequest) => MockResponse | undefined
  main?: (req: LlmRequest) => MockResponse
  delayMs?: number
}

export function memberDefault(role: string, req: LlmRequest, s: Script): MockResponse {
  if (sinceLastAssistant(req).includes('直接用文字回答')) return { text: `${role} answer` }
  const artifact: Record<string, { content: string; files?: { name: string; content: string }[] }> = {
    pm: { content: '# PRD\n验收标准：A' },
    designer: { content: '# Design', files: [{ name: 'prototype.html', content: '<html></html>' }] },
    'tech-lead': { content: '# Tech plan' },
    dev: { content: '# Dev notes' },
    qa: { content: '# Test report' },
  }
  const a = artifact[role] ?? { content: `# ${role}` }
  const args: Record<string, unknown> = { summary: `${role} done`, ...a }
  if (role === 'qa') args.verdict = s.verdicts?.length ? s.verdicts.shift() : 'pass'
  return { toolCalls: [call('team_deliver', args)], ...(s.delayMs ? { delayMs: s.delayMs } : {}) }
}

export function route(s: Script) {
  return (req: LlmRequest): MockResponse => {
    const role = roleOf(req)
    if (!role) {
      if (s.main) return s.main(req)
      return isFirstStep(req) ? { toolCalls: [call('team_start', { requirement: '做一个待办应用', title: 'Todo' })] } : { text: `MAIN: ${sinceLastAssistant(req).slice(0, 40)}` }
    }
    if (role === 'leader') return s.leader?.(req) ?? leaderPolicy(req)
    return s.member?.(role, req) ?? memberDefault(role, req, s)
  }
}

export const tmp = () => mkdtemp(join(tmpdir(), 'agent-team-'))

export async function writeRole(dir: string, role: string, text: string) {
  await mkdir(join(dir, 'team'), { recursive: true })
  await writeFile(join(dir, 'team', `${role}.md`), text)
}

/** 测试工具：名字与 leo 内置工具相同，记录执行 */
export function fakeTools(executed: string[]): ToolDefinition[] {
  return ['read_file', 'write_file', 'edit_file', 'list_dir', 'grep', 'bash', 'web_fetch'].map((name) => ({
    name,
    description: name,
    parameters: z.object({}).passthrough(),
    execute: () => {
      executed.push(name)
      return `${name} ok`
    },
  }))
}

export interface SetupOpts {
  config?: Partial<AgentTeamConfig>
  /** 提供 leoPaths（角色文件） */
  paths?: { projectDir?: string; userDir: string }
  /** 提供假的 commands 服务（当前开发依赖的 leo-agents 没有 commands） */
  commands?: boolean
  /** 不自动加载 agent-team，由测试调用 loadTeam() */
  defer?: boolean
}

export async function setup(s: Script, o: SetupOpts = {}) {
  const dataDir = await tmp()
  const mock = new MockProvider({ script: Array.from({ length: 400 }, () => route(s)) })
  const executed: string[] = []
  const commands = new Map<string, { run(c: unknown): Promise<unknown> }>()
  const plugins: (PluginDefinition<any> | [PluginDefinition<any>, unknown])[] = [
    { name: 'test-tools', inject: ['tools'], apply: async (ctx) => { for (const t of fakeTools(executed)) await ctx.effect(() => ctx.get('tools').register(t)) } },
  ]
  if (o.paths) plugins.push({ name: 'test-paths', apply: (ctx) => void ctx.provide('leoPaths' as never, { cwd: '/', ...o.paths } as never) })
  if (o.commands) {
    plugins.push({
      name: 'test-commands',
      apply: (ctx) =>
        void ctx.provide('commands' as never, {
          register: (d: { name: string; run(c: unknown): Promise<unknown> }) => {
            commands.set(d.name, d)
            return () => void commands.delete(d.name)
          },
        } as never),
    })
  }
  const config = { model: 'm', dataDir, ...o.config }
  if (!o.defer) plugins.push([agentTeam, config])
  const leo = await createLeo({ logLevel: 'silent', providers: [mock], plugins: plugins as never })
  const loadTeam = () => leo.plugin(agentTeam, config as never)
  const team = () => leo.ctx.get('agentTeam')
  const runCommand = (args: string) => {
    const argv = args.split(/\s+/).filter(Boolean)
    return commands.get('team')!.run({ args, argv, surface: 'test' }) as Promise<{ text?: string; isError?: boolean; prompt?: string }>
  }
  return { leo, mock, executed, dataDir, team, runCommand, config, commands, loadTeam }
}

/** 记录插件事件 */
export function recordEvents(leo: { ctx: { on: (e: never, h: (p: never) => void) => unknown } }) {
  const events: string[] = []
  const on = (name: string, fmt: (p: any) => string) => leo.ctx.on(name as never, ((p: any) => void events.push(`${name.replace('agent-team/', '')}:${fmt(p)}`)) as never)
  on('agent-team/phase-started', (p) => p.phase)
  on('agent-team/phase-finished', (p) => p.phase)
  on('agent-team/bounced', (p) => String(p.bounces))
  on('agent-team/awaiting-approval', (p) => p.gate)
  on('agent-team/finished', (p) => p.status)
  return events
}
