/**
 * leo-plugin-speakup：主动搭话。
 *
 * 对方一阵子没找 Agent 时，Agent 在私聊里主动找对方说几句；Agent 问了话对方没回，会轻轻追一句。
 * 只依赖网关（gateway ≥ 0.3.0）已有的接口，不改网关和渠道驱动：
 *   - 监听 `gateway/message`、`gateway/turn-end`、`gateway/session-reset` 记录双方最近的来往
 *   - `gateway.chat()` 在原会话里跑一轮（塞一条【系统提醒】，Agent 用自己的人设和上下文写）
 *   - `gateway.send()` / `gateway.sendImage()` 把回复作为主动消息发到平台
 * 装了 interaction 时，人设和表情照常生效（表情图片一并发出）。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context, Disposer, PluginDefinition } from 'leo-agents'
import { CONFIG_FILE_NAME, type ConfigPaths, loadConfig, type SpeakUpConfig } from './config.js'
import { clock, type FireResult, type GatewayLike, SpeakUp, type StateMap } from './speakup.js'

export { CONFIG_FILE_NAME, DEFAULT_CONFIG, normalizeConfig, type SpeakUpConfig } from './config.js'
export * from './speakup.js'

const PLUGIN_NAME = 'leo-plugin-speakup'
export const STATE_FILE_NAME = 'speakup.state.json'
/** 检查间隔 */
export const TICK_MS = 60_000

interface CommandsLike {
  register(def: { name: string; aliases?: string[]; description?: string; usage?: string; plugin?: string; run(c: { args: string; argv: string[] }): unknown }): Disposer
}

async function readState(file: string): Promise<StateMap> {
  try {
    const data = JSON.parse(await readFile(file, 'utf8')) as unknown
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as StateMap) : {}
  } catch {
    return {}
  }
}

async function writeState(file: string, state: StateMap) {
  await mkdir(join(file, '..'), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`)
  await rename(tmp, file)
}

const fmtTime = (t: number, tz: string) =>
  t ? new Intl.DateTimeFormat('zh-CN', { ...(tz ? { timeZone: tz } : {}), month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t)) : '—'

export function statusText(sp: SpeakUp, cfg: SpeakUpConfig): string {
  const lines = [
    `主动搭话：${cfg.enabled ? '开' : '关'} · 清醒时段 ${cfg.awakeFrom}–${cfg.awakeTo} 点${cfg.timezone ? `（${cfg.timezone}）` : ''} · 空闲 ${cfg.idleMinutes} 分钟后 · 每天最多 ${cfg.maxPerDay} 次`,
  ]
  let targets: ReturnType<SpeakUp['targets']> = []
  try {
    targets = sp.targets()
  } catch {}
  if (!targets.length) lines.push(cfg.targets.length ? `没有匹配 ${cfg.targets.join(', ')} 的会话` : '还没有私聊会话：对方先给机器人发一条消息才会出现')
  const { day } = clock(Date.now(), cfg.timezone)
  for (const t of targets) {
    const s = sp.state[t.key]
    const count = s && s.day === day ? s.count : 0
    lines.push(`  ${t.key}${t.origin.userName ? `（${t.origin.userName}）` : ''} · 今天 ${count}/${cfg.maxPerDay} · 下次不早于 ${fmtTime(s?.nextAt ?? 0, cfg.timezone)} · 上次 ${fmtTime(s?.lastFireAt ?? 0, cfg.timezone)}`)
  }
  lines.push('立刻找一次：/speakup now [会话键前缀]')
  return lines.join('\n')
}

export function resultText(r: FireResult): string {
  switch (r.status) {
    case 'sent':
      return `已主动发给 ${r.sessionKey}：${r.text || `[图片 ${r.images ?? 0} 张]`}`
    case 'silent':
      return `Agent 这次不想说话（回了 [沉默]）：${r.sessionKey}`
    case 'busy':
      return `${r.sessionKey} 正在对话，稍后再试`
    default:
      return `发送失败：${r.sessionKey}：${r.error ?? '未知错误'}`
  }
}

export interface SpeakUpPluginOptions {
  /** 测试用：检查间隔（毫秒）；0 = 不启动定时器 */
  tickMs?: number
  now?: () => number
  random?: () => number
}

export function createSpeakUpPlugin(opts: SpeakUpPluginOptions = {}): PluginDefinition<Record<string, unknown>> & { watch?: readonly string[] } {
  return {
    name: PLUGIN_NAME,
    inject: ['gateway' as never],
    watch: [CONFIG_FILE_NAME],
    async apply(ctx: Context<any>, raw: Record<string, unknown> = {}) {
      const paths = ctx.maybe('leoPaths') as ConfigPaths | undefined
      const config = await loadConfig(paths, raw ?? {})
      const stateFile = paths && raw?.loadConfigFiles !== false ? join(paths.userDir, STATE_FILE_NAME) : undefined
      const state = stateFile ? await readState(stateFile) : {}
      const gateway = () => ctx.get('gateway' as never) as unknown as GatewayLike
      const log = {
        info: (m: string) => ctx.logger?.info?.(m),
        warn: (m: string) => ctx.logger?.warn?.(m),
      }
      let saving: Promise<void> = Promise.resolve()
      const sp = new SpeakUp({
        gateway,
        config: () => config,
        state,
        ...(stateFile ? { save: (s: StateMap) => (saving = saving.then(() => writeState(stateFile, s)).catch(() => {})) } : {}),
        ...(opts.now ? { now: opts.now } : {}),
        ...(opts.random ? { random: opts.random } : {}),
        log,
        notice: (message) => void ctx.emit('plugin/notice' as never, { plugin: 'speakup', message, level: 'warn' } as never),
      })
      ctx.provide('speakup' as never, sp as never)

      ctx.on('gateway/message' as never, ((p: { sessionKey?: string; message?: { timestamp?: number } }) => {
        if (p?.sessionKey) sp.onUserMessage(p.sessionKey, p.message?.timestamp || undefined)
      }) as never)
      ctx.on('gateway/turn-end' as never, ((p: { sessionKey?: string; text?: string; reason?: string }) => {
        if (p?.sessionKey && p.reason !== 'cancelled') sp.onTurnEnd(p.sessionKey, p.text ?? '')
      }) as never)
      ctx.on('gateway/session-reset' as never, ((p: { sessionKey?: string }) => {
        if (p?.sessionKey) sp.onReset(p.sessionKey)
      }) as never)

      const tickMs = opts.tickMs ?? TICK_MS
      if (tickMs > 0) {
        await ctx.effect(() => {
          const timer = setInterval(() => {
            sp.tick().catch((err: Error) => log.warn(`speakup: ${err.message}`))
          }, tickMs)
          timer.unref?.()
          return () => clearInterval(timer)
        })
      }

      const commands = ctx.maybe('commands' as never) as unknown as CommandsLike | undefined
      if (commands) {
        await ctx.effect(() =>
          commands.register({
            name: 'speakup',
            usage: '[now [会话键前缀]]',
            description: '主动搭话：查看状态，或让 Agent 立刻主动找对方说一句',
            plugin: 'speakup',
            run: async ({ argv }) => {
              if (argv[0] !== 'now') return { text: statusText(sp, config) }
              const prefix = argv[1]
              const list = sp.targets().filter((t) => !prefix || t.key === prefix || t.key.startsWith(`${prefix}:`))
              const target = list.sort((a, b) => b.updatedAt - a.updatedAt)[0]
              if (!target) return { text: prefix ? `没有匹配 ${prefix} 的会话` : '还没有可以主动找的私聊会话', isError: true }
              return { text: resultText(await sp.fire(target)) }
            },
          }),
        )
      }
    },
  }
}

const plugin = createSpeakUpPlugin()
export default plugin
