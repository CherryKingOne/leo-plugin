import { z } from 'zod'

/** 单个子 Agent 配置 */
export const AgentProfileSchema = z.object({
  /** 告诉主 Agent 什么时候用它（会写进 task 工具说明） */
  description: z.string().min(1),
  /** 子 Agent 的基础系统提示；不填则沿用父 Agent 的系统提示 */
  systemPrompt: z.string().optional(),
  /** `provider/model`；不填则继承父 Agent */
  model: z.string().optional(),
  /** 允许的工具名；不填则继承父 Agent。无论如何都不会超出父 Agent 的工具集 */
  tools: z.array(z.string()).optional(),
  /** 覆盖全局 maxSteps */
  maxSteps: z.number().int().positive().optional(),
})
export type AgentProfile = z.infer<typeof AgentProfileSchema>

export const DEFAULT_PROFILES: Record<string, AgentProfile> = {
  general: {
    description: '通用子 Agent：可使用与你相同的工具，适合需要多步搜索、阅读或执行的独立子任务。',
  },
}

export const SubAgentsConfigSchema = z
  .object({
    /** 最大嵌套层数。1 表示子 Agent 不能再创建子 Agent */
    maxDepth: z.number().int().min(1).max(5).default(1),
    /** 同时运行的子 Agent 上限（全局） */
    maxConcurrent: z.number().int().min(1).max(32).default(4),
    /** 单个子 Agent 每次任务的最大步数 */
    maxSteps: z.number().int().positive().default(30),
    /** 单个子 Agent 的超时（毫秒） */
    timeoutMs: z.number().int().positive().default(600_000),
    /** 返回给主 Agent 的文本上限（字符） */
    maxOutputChars: z.number().int().positive().default(20_000),
    /** 子 Agent 配置；与内置的 general 合并，同名覆盖 */
    agents: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/), AgentProfileSchema).default({}),
    /** 工具名，默认 task */
    toolName: z
      .string()
      .regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/)
      .default('task'),
  })
  .default({
    maxDepth: 1,
    maxConcurrent: 4,
    maxSteps: 30,
    timeoutMs: 600_000,
    maxOutputChars: 20_000,
    agents: {},
    toolName: 'task',
  })

export type SubAgentsConfig = z.infer<typeof SubAgentsConfigSchema>
