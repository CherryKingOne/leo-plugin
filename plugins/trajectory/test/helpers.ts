import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLeo, type LlmRequest, MockProvider, type MockResponse, type PluginDefinition, type ToolDefinition } from 'leo-agents'
import { z } from 'zod'
import plugin, { type TrajectoryConfig } from '../src/index.js'
import type { RawEvent } from '../src/types.js'

export interface Notice {
  plugin: string
  message: string
  level?: string
}

/** 测试宿主：mock 模型 + 文件会话存储 + leoPaths + 最小 commands 服务 + 收集 plugin/notice */
export async function setup(route: (req: LlmRequest, i: number) => MockResponse, config: Partial<TrajectoryConfig> = {}, extra: PluginDefinition<any>[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'leo-traj-'))
  const leoDir = join(root, '.leo')
  const sessionsDir = join(leoDir, 'sessions')
  await mkdir(sessionsDir, { recursive: true })
  const mock = new MockProvider({ script: Array.from({ length: 200 }, () => (req: LlmRequest, i: number) => route(req, i)) })
  const notices: Notice[] = []
  const commands = new Map<string, any>()
  const host: PluginDefinition = {
    name: 'test-host',
    apply(ctx) {
      ctx.provide('leoPaths' as never, { cwd: root, projectRoot: root, projectDir: leoDir, userDir: join(root, 'home') } as never)
      ctx.provide('commands' as never, {
        register(def: any) {
          commands.set(def.name, def)
          return () => void commands.delete(def.name)
        },
      } as never)
      ctx.on('plugin/notice' as never, ((n: Notice) => void notices.push(n)) as never)
    },
  }
  const leo = await createLeo({ logLevel: 'silent', providers: [mock], sessions: { dir: sessionsDir }, plugins: [host, ...extra] })
  const rt = await leo.plugin(plugin, { port: 0, sessionsDir, ...config } as TrajectoryConfig)
  const command = (args: string, sessionId?: string) => {
    const def = commands.get('trace')
    if (!def) throw new Error('/trace not registered')
    return def.run({ args, argv: args.split(/\s+/).filter(Boolean), surface: 'test', ...(sessionId ? { sessionId } : {}) }) as Promise<{ text?: string; isError?: boolean }>
  }
  return { leo, rt, mock, notices, commands, command, root, leoDir, sessionsDir }
}

export const echoTool = (delayMs = 0): ToolDefinition<{ text: string }> => ({
  name: 'echo',
  description: 'echo',
  parameters: z.object({ text: z.string() }),
  execute: async ({ text }) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
    return text
  },
})

/** 宿主是否写 tool/start（leo-agents ≥ 0.2.2） */
export const hasToolEvents = (events: RawEvent[]) => events.some((e) => e.type === 'tool/start')

export function evt(sessionId: string, seq: number, type: string, at: number, data: unknown): RawEvent {
  return { id: `e${seq}`, sessionId, seq, type, at, data }
}

export async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 3000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}
