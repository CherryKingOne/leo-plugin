import { createLeo, type LlmRequest, MockProvider, type MockResponse, type ToolDefinition } from 'leo-agents'
import { z } from 'zod'
import subAgents, { type SubAgentsConfig } from '../src/index.js'

/** 用 system prompt 区分父 / 子 Agent 的请求 */
export const isChild = (req: LlmRequest) => (req.system ?? '').includes('You are running as a sub-agent')
export const lastUserText = (req: LlmRequest) => {
  const users = req.messages.filter((m) => m.role === 'user')
  const m = users[users.length - 1]
  return m ? m.content.map((b) => (b.type === 'text' ? b.text : '')).join('') : ''
}
export const hasToolResult = (req: LlmRequest) => req.messages.some((m) => m.role === 'tool')
export const toolNames = (req: LlmRequest) => (req.tools ?? []).map((t) => t.name)

/** 按请求内容路由的 mock：并发时调用顺序不确定，所以不用固定脚本顺序 */
export async function setup(route: (req: LlmRequest) => MockResponse, config?: Partial<SubAgentsConfig>, extraTools: ToolDefinition[] = []) {
  const mock = new MockProvider({ script: Array.from({ length: 200 }, () => (req: LlmRequest) => route(req)) })
  const executed: string[] = []
  const tools: ToolDefinition[] = [
    {
      name: 'echo',
      description: 'echo',
      parameters: z.object({ text: z.string() }),
      execute: ({ text }) => {
        executed.push(`echo:${text}`)
        return text
      },
    },
    {
      name: 'secret',
      description: 'secret',
      parameters: z.object({}),
      execute: () => {
        executed.push('secret')
        return 'the secret'
      },
    },
    ...extraTools,
  ]
  const leo = await createLeo({
    logLevel: 'silent',
    providers: [mock],
    plugins: [
      { name: 'test-tools', inject: ['tools'], apply: async (ctx) => { for (const t of tools) await ctx.effect(() => ctx.get('tools').register(t)) } },
      config ? [subAgents, config] : subAgents,
    ],
  })
  return { leo, mock, executed }
}
