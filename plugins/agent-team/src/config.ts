import { z } from 'zod'

/** 角色 id：kebab / snake 皆可，用作文件名 `.leo/team/<role>.md` 与会话名的一部分 */
export const ROLE_ID = /^[a-z][a-z0-9_-]{0,31}$/

/** 工作流阶段（顺序固定） */
export const PHASES = ['requirements', 'design', 'development', 'qa', 'delivery'] as const
export type Phase = (typeof PHASES)[number]

export const PHASE_LABELS: Record<Phase, string> = {
  requirements: '需求（PRD）',
  design: '设计与技术方案',
  development: '开发',
  qa: '测试（QA）',
  delivery: '交付验收',
}

/** 单个角色配置（内置默认 + 文件 + 配置逐层覆盖，字段级合并） */
export const RoleProfileSchema = z.object({
  /** 给人看的名字，如“产品经理” */
  name: z.string().min(1).optional(),
  /** 一句话职责，写进 Leader 的提示与 team_assign 工具说明 */
  description: z.string().min(1).optional(),
  /** 角色系统提示（Markdown 正文）。插件总会在末尾追加团队协作说明 */
  systemPrompt: z.string().optional(),
  /** `provider/model`，不填用团队默认模型（配置 `model` → 发起者的模型 → 宿主默认模型） */
  model: z.string().optional(),
  /** 允许的宿主工具（read_file、bash……）。无论怎么写都不会超出发起团队的 Agent 的工具集；团队工具由插件按角色自动加上 */
  tools: z.array(z.string()).optional(),
  /** 该角色每次任务的最大步数 */
  maxSteps: z.number().int().positive().optional(),
  /** 负责的阶段：该阶段需要它交付才算完成。不填表示可随时被指派的辅助角色 */
  phase: z.enum(PHASES).optional(),
  /** team_deliver 正文默认保存的产出物文件名，如 prd.md */
  artifact: z
    .string()
    .regex(/^[A-Za-z0-9][\w.-]{0,99}$/)
    .optional(),
  /** true 时删除该角色（leader 不能删除） */
  disabled: z.boolean().optional(),
})
export type RoleProfile = z.infer<typeof RoleProfileSchema>

/** 合并后生效的角色 */
export interface ResolvedRole {
  id: string
  name: string
  description: string
  systemPrompt: string
  model?: string
  tools: string[]
  maxSteps: number
  phase?: Phase
  artifact?: string
  /** 来源：builtin / 文件路径 / config */
  source: string[]
}

const GatesSchema = z
  .object({
    /** PRD 完成后请用户确认 */
    requirements: z.boolean().default(true),
    /** 设计稿与技术方案完成后请用户确认 */
    design: z.boolean().default(true),
    /** 开发完成后（进入 QA 前）请用户确认 */
    development: z.boolean().default(false),
    /** QA 通过后（进入交付前）请用户确认 */
    qa: z.boolean().default(false),
    /** 最终验收 */
    acceptance: z.boolean().default(true),
  })
  .default({ requirements: true, design: true, development: false, qa: false, acceptance: true })
export type Gates = z.infer<typeof GatesSchema>

export const AgentTeamConfigSchema = z
  .object({
    /** 团队默认模型 `provider/model`；不填用发起团队的 Agent 的模型，再不行用宿主默认模型 */
    model: z.string().optional(),
    /** 角色覆盖：同名字段覆盖内置与文件；值为 false 删除该角色；新 id 新增角色 */
    roles: z.record(z.string().regex(ROLE_ID), z.union([RoleProfileSchema, z.literal(false)])).default({}),
    /** 读取 ~/.leo/team/<role>.md 与项目 .leo/team/<role>.md（需要宿主提供 leoPaths） */
    loadRoleFiles: z.boolean().default(true),
    /** 人工关卡：阶段完成后暂停，等用户 /team approve 或 /team reject */
    gates: GatesSchema,
    /** QA 不通过打回开发的最多次数，超过后暂停交给用户决定 */
    maxBounces: z.number().int().min(0).max(20).default(3),
    /** team_ask 的最大嵌套深度（A 问 B 算 1 层，B 再问 C 算 2 层） */
    maxAskDepth: z.number().int().min(0).max(5).default(2),
    /** 一个成员在一次任务里最多提问次数 */
    maxAskRounds: z.number().int().min(0).max(20).default(3),
    /** 同时运行的成员上限（设计与技术方案可并行） */
    maxConcurrent: z.number().int().min(1).max(16).default(2),
    /** Leader 每次运行的最大步数（角色 maxSteps 优先） */
    leaderMaxSteps: z.number().int().positive().default(60),
    /** 成员每次任务的最大步数（角色 maxSteps 优先） */
    memberMaxSteps: z.number().int().positive().default(40),
    /** 成员单次任务超时（毫秒） */
    memberTimeoutMs: z.number().int().positive().default(900_000),
    /** Leader 一次运行（从开始到暂停 / 结束）的超时（毫秒） */
    timeoutMs: z.number().int().positive().default(3_600_000),
    /** 返回给主 Agent / Leader 的单段文本上限（字符） */
    maxOutputChars: z.number().int().positive().default(20_000),
    /** 项目数据目录（绝对路径）。默认 `<项目 .leo 或 ~/.leo>/team/projects` */
    dataDir: z.string().optional(),
    /** 不把团队内部工具（team_assign 等）暴露给团队以外的 Agent 的模型请求 */
    hideInternalTools: z.boolean().default(true),
  })
  .default({
    roles: {},
    loadRoleFiles: true,
    gates: { requirements: true, design: true, development: false, qa: false, acceptance: true },
    maxBounces: 3,
    maxAskDepth: 2,
    maxAskRounds: 3,
    maxConcurrent: 2,
    leaderMaxSteps: 60,
    memberMaxSteps: 40,
    memberTimeoutMs: 900_000,
    timeoutMs: 3_600_000,
    maxOutputChars: 20_000,
    hideInternalTools: true,
  })
export type AgentTeamConfig = z.infer<typeof AgentTeamConfigSchema>

/** 阶段完成后对应的关卡名 */
export const GATE_OF: Record<Phase, keyof Gates> = {
  requirements: 'requirements',
  design: 'design',
  development: 'development',
  qa: 'qa',
  delivery: 'acceptance',
}
