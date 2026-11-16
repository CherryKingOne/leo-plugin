/**
 * leo-plugin-trajectory：轨迹观测（只读）。
 *
 * 把会话日志投影成一棵树：会话 → turn → step（模型调用：模型、用量、重试、错误、耗时、TTFT）→ 工具调用
 * （参数、结果预览、错误、耗时）→ 子会话（sub-agents / agent-team 成员），附压缩记录与累计用量；
 * 订阅 `session/appended` 与 `agent/event` 实时更新。提供：
 * - 服务 `trajectory`（get / list / subscribe / url）
 * - 命令 `/trace`（leo-agents ≥ 0.2.1）
 * - 本机网页 + JSON API + SSE（默认 http://127.0.0.1:18791/）
 * 不注册任何工具：不占模型上下文，零 token 成本。也不写会话日志。
 *
 * 宿主兼容：leo-agents 0.2.1 也能用（用已有事件推算，TTFT 只在运行期间现场测得）；
 * leo-agents ≥ 0.2.2（分支 feat/trajectory-log）的 tool/start、tool/end、firstTokenAt、session/meta、sessions.list() 会被直接使用。
 */
import type { PluginDefinition } from 'leo-agents'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { traceCommand } from './commands.js'
import { LiveTracker } from './live.js'
import { LOOPBACK, TrajectoryServer } from './server.js'
import { defaultSessionsDirs, type StoreLike, Trajectories } from './service.js'
import { resolveValue } from './secrets.js'
import type { TrajectoryService } from './types.js'

export type * from './types.js'
export { projectSession } from './project.js'
export { redactText, redactValue } from './redact.js'

declare module 'leo-agents' {
  interface Services {
    trajectory: TrajectoryService
  }
}

export const Config = z.object({
  /** 是否启动本机网页 / API */
  server: z.boolean().default(true),
  /** 监听地址。默认只监听本机；监听非本机地址必须设置 token */
  host: z.string().default('127.0.0.1'),
  /** 端口（0 = 随机） */
  port: z.number().int().min(0).max(65535).default(18791),
  /** 访问令牌，写 `$LEO_TRAJECTORY_TOKEN` 这样的引用（不要写明文）。设置后网页与 API 都要带 */
  token: z.string().optional(),
  /** 内存里保留运行时数据（TTFT、工具时间、父子关系）的会话数 */
  maxLiveSessions: z.number().int().min(1).max(10_000).default(200),
  /** 展示前遮住像密钥的字符串（不修改会话日志） */
  redact: z.boolean().default(true),
  /** 参数 / 结果 / 输出预览的最大字符数 */
  maxPreviewChars: z.number().int().min(80).max(200_000).default(4000),
  /** 旧宿主（没有 sessions.list()）时扫描的会话目录；默认按宿主配置推断（.leo/sessions） */
  sessionsDir: z.string().optional(),
})
export type TrajectoryConfig = z.infer<typeof Config>

interface LeoPathsLike {
  cwd?: string
  projectRoot?: string
  projectDir?: string
  userDir?: string
}

const plugin: PluginDefinition<TrajectoryConfig> = {
  name: 'leo-plugin-trajectory',
  inject: ['sessions'],
  config: Config,
  async apply(ctx, config) {
    const cfg = Config.parse(config ?? {})
    const maybe = <T>(key: string): T | undefined => (ctx as unknown as { maybe(k: string): T | undefined }).maybe(key)
    const notice = (message: string, level?: 'warn' | 'error') =>
      ctx.emit('plugin/notice' as never, { plugin: 'trajectory', message, ...(level ? { level } : {}) } as never)

    let server: TrajectoryServer | undefined
    const tracker = new LiveTracker(cfg.maxLiveSessions, (sessionId, type) => service.publish({ sessionId, kind: type.includes('/') ? 'event' : 'live', type, at: Date.now() }))
    const paths = () => maybe<LeoPathsLike>('leoPaths')
    const service = new Trajectories({
      store: () => maybe<StoreLike>('sessions'),
      tracker,
      project: { redact: cfg.redact, maxPreviewChars: cfg.maxPreviewChars, storeList: typeof maybe<StoreLike>('sessions')?.list === 'function' },
      sessionsDirs: () => (cfg.sessionsDir ? [cfg.sessionsDir] : defaultSessionsDirs(paths(), maybe<{ sessions?: { dir?: string; persist?: boolean } }>('leoConfig'))),
      liveAgentSessions: () => {
        try {
          return (maybe<{ list(): { sessionId: string }[] }>('agentLoop')?.list() ?? []).map((a) => a.sessionId)
        } catch {
          return []
        }
      },
      url: () => server?.url(),
    })

    // —— 订阅（插件卸载时自动撤销） ——
    ctx.on('session/appended' as never, ((e: { sessionId: string; type: string; at: number; data: unknown }) => tracker.onAppended(e)) as never)
    ctx.on('agent/event' as never, ((p: { agent: any; event: any }) => tracker.onAgentEvent(p.agent, p.event)) as never)
    ctx.on('sub-agents/started' as never, ((info: any) => tracker.onSubAgentStarted(info)) as never)
    await ctx.effect(() => () => tracker.clear())

    ctx.provide('trajectory', service)

    // —— 命令 ——
    const leoDir = () => {
      const p = paths()
      return p?.projectDir ?? (p?.cwd ? join(p.cwd, '.leo') : p?.userDir ?? join(homedir(), '.leo'))
    }
    const urlText = () => {
      const u = server?.url()
      if (!u) return cfg.server ? '轨迹网页没有启动（见启动提示）。' : '轨迹网页已关闭（插件选项 server: false）。'
      return cfg.token ? `轨迹网页：${u}?token=<令牌>（令牌即插件选项 token 的值）` : `轨迹网页：${u}`
    }
    const commands = maybe<{ register(def: ReturnType<typeof traceCommand>): () => void }>('commands')
    if (commands) await ctx.effect(() => commands.register(traceCommand({ service, leoDir, urlText })))

    // —— 网页 / API ——
    if (!cfg.server) return
    let token: string | undefined
    try {
      token = cfg.token ? resolveValue(cfg.token) : undefined
    } catch (err) {
      notice(`令牌解析失败（${(err as Error).message}），网页未启动`, 'error')
      return
    }
    const s = new TrajectoryServer({ host: cfg.host, port: cfg.port, ...(token ? { token } : {}) }, service)
    // 先挂清理再启动：启动中被卸载也能关掉
    await ctx.effect(() => () => void s.close())
    try {
      await s.start()
    } catch (err) {
      notice(`网页未启动：${(err as Error).message}`, 'error')
      ctx.logger.warn({ err: (err as Error).message }, 'trajectory: server not started')
      return
    }
    server = s
    const url = s.url()!
    notice(
      `轨迹网页 ${url}${token ? '（需要令牌：?token=<token> 或 Authorization: Bearer <token>）' : LOOPBACK.has(cfg.host) ? '（仅本机）' : ''} · 命令 /trace`,
    )
  },
}

export default plugin
