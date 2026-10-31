import { z } from 'zod'

const ID = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'provider id: letters, digits, . _ -')

const modelInfo = z.object({
  id: z.string().min(1),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive().optional(),
  pricing: z.object({ inputPerMTok: z.number(), outputPerMTok: z.number(), cachedInputPerMTok: z.number().optional() }).optional(),
})

export const ProviderSettingsSchema = z
  .object({
    driver: ID.optional(),
    protocol: z.string().min(1).optional(),
    /** 0.1.x 写法，等同 protocol */
    type: z.string().min(1).optional(),
    enabled: z.boolean().default(true),
    default: z.boolean().optional(),
    baseURL: z.string().url().optional(),
    apiKey: z.string().optional(),
    apiKeyEnv: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    models: z.array(z.union([z.string().min(1), modelInfo])).optional(),
    defaultModel: z.string().min(1).optional(),
    maxTokensField: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
    sendReasoning: z.boolean().optional(),
    connectTimeoutMs: z.number().int().positive().optional(),
    idleTimeoutMs: z.number().int().positive().optional(),
    keyless: z.boolean().optional(),
  })
  .passthrough()

export const ProviderConfigSchema = z
  .object({
    /** false 时不接入任何 provider */
    enabled: z.boolean().default(true),
    /**
     * 已安装的驱动自动接入，不用写进 providers：有密钥（credentials.json / 环境变量）即可用，
     * 没有密钥时列为不可用并提示 `leo auth set <id>`。例如装了 provider-deepseek 并 `leo auth set deepseek` 后直接可用
     */
    autoDetect: z.boolean().default(true),
    /** 默认模型 `<provider>/<model>`；`.leo/config.json` 的 model 优先 */
    model: z.string().regex(/^[^/]+\/.+$/, 'model must be "<provider>/<model>"').optional(),
    /** key 为 provider id */
    providers: z.record(ID, ProviderSettingsSchema).default({}),
    /** 读取 ~/.leo/provider.json 与 .leo/provider.json，默认 true（测试可关） */
    loadConfigFiles: z.boolean().default(true),
  })
  .passthrough()

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>
export type ProviderSettingsParsed = z.infer<typeof ProviderSettingsSchema>
