/**
 * leo-plugin-context：上下文观测（只读）。
 *
 * 回答“Agent 现在带着什么、这些东西从哪来、怎么一步步变成这样”：
 * - 每次模型请求的上下文组成：System 提示词、插件注入（按来源插件拆）、工具定义、用户消息、回答、思考、工具调用、工具结果、压缩摘要
 * - 当前上下文离窗口、离自动压缩还有多远；逐请求趋势；压缩 / 丢弃 / 换模型 / 工具与片段变化等事件
 * - 用量、缓存命中、成本、耗时；工具、文件活动、命令执行、技能加载
 * - 跨会话洞察：KPI、最近 7 天、8 周热力图、工具 / 技能 / 程序排行、会话卡片
 * 提供：
 * - 独立网页 + JSON API + SSE（默认 http://127.0.0.1:18792/，与 trajectory 的网页分开）
 * - 命令 `/context`（leo-agents ≥ 0.2.1）
 * - 服务 `contextInsight`
 * 不注册任何工具（零 token），不写会话日志。
 *
 * 设计参考 DeepSeek Harness 的 dsh-context 插件（bowenliang123/dsh-context，Apache-2.0）；代码为 leo 重新实现。
 * 宿主兼容：leo-agents ≥ 0.2.3（分支 feat/context-log）的 `llm/request.breakdown` 给出精确的片段与工具明细；
 * 更早的宿主按同口径推算（System 整体一类、工具定义 = 估算总量 − System − 消息）。
 */
import type { PluginDefinition } from 'leo-agents'
import { z } from 'zod'
import { contextCommand } from './commands.js'
import { preview } from './redact.js'
import { resolveValue } from './secrets.js'
import { ContextServer, LOOPBACK } from './server.js'
import { ContextInsights, defaultSessionsDirs, type StoreLike } from './service.js'
import type { ContextInsightService } from './types.js'

export type * from './types.js'
export { analyzeSession, approxTokens, messageComposition, programOf } from './analyze.js'
export { summaryText } from './commands.js'

declare module 'leo-agents' {
  interface Services {
    contextInsight: ContextInsightService
  }
}

export const Config = z.object({
  /** 是否启动网页 / API */
  server: z.boolean().default(true),
  /** 监听地址。默认只监听本机；监听非本机地址（如 Docker 里的 0.0.0.0）必须设置 token */
  host: z.string().default('127.0.0.1'),
  /** 端口（0 = 随机）。gateway 默认 18790、trajectory 默认 18791，这里错开 */
  port: z.number().int().min(0).max(65535).default(18792),
  /** 访问令牌，写 `$LEO_CONTEXT_TOKEN` 这样的引用（不要写明文） */
  token: z.string().optional(),
  /** 展示前遮住像密钥的字符串（不修改会话日志） */
  redact: z.boolean().default(true),
  /** 上下文浏览器里每条内容预览的最大字符数 */
  maxPreviewChars: z.number().int().min(80).max(200_000).default(2000),
  /** 列表与洞察最多扫描的会话数（最近更新的优先） */
  maxSessions: z.number().int().min(1).max(5000).default(300),
  /** 内存里缓存完整分析结果的会话数 */
  cacheSessions: z.number().int().min(1).max(500).default(20),
  /** 每个会话最多保留多少条命令执行记录（最近的） */
  maxCommands: z.number().int().min(0).max(10_000).default(500),
  /** 旧宿主（没有 sessions.list()）时扫描的会话目录；默认按宿主配置推断（.leo/sessions） */
  sessionsDir: z.string().optional(),
})
export type ContextConfig = z.infer<typeof Config>

interface LlmLike {
  resolve(model: string): { info?: { contextWindow?: number; maxOutputTokens?: number; pricing?: { inputPerMTok: number; outputPerMTok: number; cachedInputPerMTok?: number } } }
}

const plugin: PluginDefinition<ContextConfig> = {
  name: 'leo-plugin-context',
  inject: ['sessions'],
  config: Config,
  async apply(ctx, config) {
    const cfg = Config.parse(config ?? {})
    const maybe = <T>(key: string): T | undefined => (ctx as unknown as { maybe(k: string): T | undefined }).maybe(key)
    const notice = (message: string, level?: 'warn' | 'error') =>
      ctx.emit('plugin/notice' as never, { plugin: 'context', message, ...(level ? { level } : {}) } as never)
    const modelInfo = (model: string) => {
      try {
        return maybe<LlmLike>('llm')?.resolve(model).info
      } catch {
        return undefined
      }
    }

    let server: ContextServer | undefined
    const service = new ContextInsights({
      store: () => maybe<StoreLike>('sessions'),
      analyze: () => ({ modelInfo, pricing: (m) => modelInfo(m)?.pricing, maxCommands: cfg.maxCommands }),
      sessionsDirs: () => (cfg.sessionsDir ? [cfg.sessionsDir] : defaultSessionsDirs(maybe('leoPaths'), maybe('leoConfig'))),
      liveAgentSessions: () => {
        try {
          return (maybe<{ list(): { sessionId: string }[] }>('agentLoop')?.list() ?? []).map((a) => a.sessionId)
        } catch {
          return []
        }
      },
      url: () => server?.url(),
      preview: (v) => preview(v, { redact: cfg.redact, maxPreviewChars: cfg.maxPreviewChars }),
      maxSessions: cfg.maxSessions,
      cacheSessions: cfg.cacheSessions,
    })

    ctx.on('session/appended' as never, ((e: { sessionId: string; type: string; at: number }) => service.touch({ sessionId: e.sessionId, type: e.type, at: e.at })) as never)
    await ctx.effect(() => () => service.clear())
    ctx.provide('contextInsight', service)

    const urlText = () => {
      const u = server?.url()
      if (!u) return cfg.server ? '上下文网页没有启动（见启动提示）。' : '上下文网页已关闭（插件选项 server: false）。'
      return cfg.token ? `上下文网页：${u}?token=<令牌>（令牌即插件选项 token 的值）` : `上下文网页：${u}`
    }
    const commands = maybe<{ register(def: ReturnType<typeof contextCommand>): () => void }>('commands')
    if (commands) await ctx.effect(() => commands.register(contextCommand({ service, urlText })))

    if (!cfg.server) return
    let token: string | undefined
    try {
      token = cfg.token ? resolveValue(cfg.token) : undefined
    } catch (err) {
      notice(`令牌解析失败（${(err as Error).message}），网页未启动`, 'error')
      return
    }
    const s = new ContextServer({ host: cfg.host, port: cfg.port, ...(token ? { token } : {}) }, service)
    await ctx.effect(() => () => void s.close())
    try {
      await s.start()
    } catch (err) {
      notice(`网页未启动：${(err as Error).message}`, 'error')
      ctx.logger.warn({ err: (err as Error).message }, 'context: server not started')
      return
    }
    server = s
    notice(`上下文网页 ${s.url()}${token ? '（需要令牌：?token=<token> 或 Authorization: Bearer <token>）' : LOOPBACK.has(cfg.host) ? '（仅本机）' : ''} · 命令 /context`)
  },
}

export default plugin
