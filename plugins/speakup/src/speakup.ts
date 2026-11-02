/**
 * 主动搭话的本体（与宿主无关，便于测试）。
 *
 * 每分钟 tick 一次，对每个目标会话判断：
 *   - 追问：Agent 上一句是问句、对方 nudgeMin ~ nudgeMax 分钟没回 → 一半概率轻轻追一句（每句最多追一次，不占每天次数）
 *   - 主动找：清醒时段内、双方超过 idleMinutes 没来往、今天次数没满、到了随机的下次时间 → 找对方说话
 * 「说什么」交给 Agent：往会话里塞一条【系统提醒】，Agent 用自己的人设和记忆写；不想说就回 [沉默]。
 * 回复经 `gateway.send` / `gateway.sendImage` 作为主动消息发到平台。
 */
import type { SpeakUpConfig } from './config.js'

export type ChatType = 'direct' | 'group' | 'channel'

export interface SessionSourceLike {
  channel: string
  account: string
  chatId: string
  chatType: ChatType
  threadId?: string
  userId: string
  userName?: string
  extra?: Record<string, string>
}

export interface SessionInfoLike {
  key: string
  origin: SessionSourceLike
  updatedAt: number
  running: boolean
  queued: number
  pendingApproval?: unknown
}

export interface DeliveryTargetLike {
  account: string
  chatId: string
  chatType?: ChatType
  extra?: Record<string, string>
}

export type StreamEventLike = { type: string; url?: string; alt?: string }

/** `ctx.get('gateway')` 中本插件用到的部分（gateway ≥ 0.3.0） */
export interface GatewayLike {
  sessions(): SessionInfoLike[]
  chat(input: { sessionKey?: string; text: string; onEvent?: (ev: StreamEventLike) => void; signal?: AbortSignal }): Promise<{ reason: string; text: string; error?: string }>
  send(target: DeliveryTargetLike, text: string, signal?: AbortSignal): Promise<unknown>
  sendImage?(target: DeliveryTargetLike, image: { url: string; alt?: string }, signal?: AbortSignal): Promise<unknown>
}

/** 每个会话的状态（持久化，重启后每天次数不丢） */
export interface SessionState {
  day: string
  count: number
  nextAt: number
  /** 对方最近一次发消息 */
  lastUserAt: number
  /** Agent 最近一次说话（回复或主动） */
  lastBotAt: number
  lastBotText: string
  /** 已经追问过的那一句（lastBotAt） */
  nudgedFor: number
  /** 最近一次主动搭话 */
  lastFireAt: number
}

export type StateMap = Record<string, SessionState>

export interface FireResult {
  sessionKey: string
  status: 'sent' | 'silent' | 'failed' | 'busy'
  text?: string
  images?: number
  error?: string
}

export interface SpeakUpDeps {
  gateway: () => GatewayLike
  config: () => SpeakUpConfig
  state: StateMap
  save?: (state: StateMap) => void | Promise<void>
  now?: () => number
  random?: () => number
  log?: { info(msg: string): void; warn(msg: string): void }
  /** 发送失败时提醒运维（同一会话同一错误只提醒一次） */
  notice?: (message: string) => void
}

const MIN = 60_000
const SILENT = /\[\s*沉默\s*\]/g
const IS_SILENT = /\[\s*沉默\s*\]/
const QUESTION = /[？?]\s*$|[吗呢嘛没][~～。.!！\s]*$/

/** 每次换个由头，免得句句都是「在干嘛」 */
export const ANGLES = [
  '分享一件你最近注意到或想到的小事（符合你的人设，别编造具体的现实经历）',
  '接着你们上次聊的话题，问问后来怎么样了',
  '想起之前聊天里关于对方的一件事，顺口提一句或关心一下',
  '问问对方现在在干嘛、吃了没、累不累',
  '撒个娇或者吐槽一句，说你有点无聊',
  '随手发个表情或者一句没头没尾的感慨',
  '看看现在几点，按时间说点应景的（早上、饭点、深夜）',
]

/** 当前时区下的日期（YYYY-MM-DD）与小时 */
export function clock(t: number, timezone: string): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    ...(timezone ? { timeZone: timezone } : {}),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(t))
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24 }
}

/** 清醒时段：from < to 为当天区间；from > to 跨午夜（如 22 ~ 2）；相等 = 全天 */
export function isAwake(hour: number, from: number, to: number): boolean {
  if (from === to) return true
  return from < to ? hour >= from && hour < to : hour >= from || hour < to
}

/** 会话键是否在目标里 */
export function matchesTarget(session: Pick<SessionInfoLike, 'key' | 'origin'>, targets: string[]): boolean {
  if (session.origin.channel === 'api') return false
  const direct = session.origin.chatType === 'direct'
  if (!targets.length) return direct
  return targets.some((t) => {
    if (session.key !== t && !session.key.startsWith(`${t}:`)) return false
    // 群聊 / 频道必须明确写出来
    return direct || t.includes(`:${session.origin.chatType}:`)
  })
}

export function idleText(minutes: number): string {
  if (minutes >= 24 * 60) return `${Math.floor(minutes / (24 * 60))} 天多`
  if (minutes >= 120) return `${Math.floor(minutes / 60)} 个多小时`
  return `${Math.max(1, Math.round(minutes))} 分钟`
}

export function buildPrompt(opts: { name: string; idleMinutes: number; angle: string; nudge?: { lastText: string; quietMinutes: number } }): string {
  const { name } = opts
  if (opts.nudge) {
    return (
      `【系统提醒，不是${name}发的消息】你刚才跟${name}说「${opts.nudge.lastText.slice(-60)}」，${name}已经 ${Math.round(opts.nudge.quietMinutes)} 分钟没回了。` +
      `可以轻轻追一句（比如「人呢」「睡着啦？」，或者换个话题），别催、别抱怨；觉得${name}在忙就只回 [沉默]。`
    )
  }
  return (
    `【系统提醒，不是${name}发的消息】你已经${idleText(opts.idleMinutes)}没和${name}聊天了，想主动找${name}说点什么。` +
    `这次的由头可以是：${opts.angle}。用你自己的口气，一两句就好，别用模板、别解释为什么来找；实在不想说就只回 [沉默]。`
  )
}

export class SpeakUp {
  private readonly now: () => number
  private readonly random: () => number
  /** 正在主动搭话的会话（这些 turn 的 turn-end 不算 Agent 回复） */
  private readonly firing = new Set<string>()
  private readonly noticed = new Set<string>()
  private ticking = false

  constructor(private readonly deps: SpeakUpDeps) {
    this.now = deps.now ?? Date.now
    this.random = deps.random ?? Math.random
  }

  get state(): StateMap {
    return this.deps.state
  }

  private entry(key: string, fallbackAt = 0): SessionState {
    let s = this.deps.state[key]
    if (!s) {
      s = { day: '', count: 0, nextAt: 0, lastUserAt: fallbackAt, lastBotAt: 0, lastBotText: '', nudgedFor: 0, lastFireAt: 0 }
      this.deps.state[key] = s
    }
    return s
  }

  private persist() {
    void Promise.resolve(this.deps.save?.(this.deps.state)).catch((err: Error) => this.deps.log?.warn(`speakup: 保存状态失败：${err.message}`))
  }

  private schedule(s: SessionState, cfg: SpeakUpConfig) {
    const span = cfg.maxIntervalMinutes - cfg.minIntervalMinutes
    s.nextAt = this.now() + (cfg.minIntervalMinutes + this.random() * span) * MIN
  }

  /** 对方发来消息（gateway/message） */
  onUserMessage(sessionKey: string, at = this.now()) {
    const s = this.entry(sessionKey)
    s.lastUserAt = Math.max(s.lastUserAt, at)
    this.persist()
  }

  /** 一轮对话结束（gateway/turn-end）：Agent 回了话 */
  onTurnEnd(sessionKey: string, text: string) {
    if (this.firing.has(sessionKey) || !text.trim()) return
    const s = this.entry(sessionKey)
    s.lastBotAt = this.now()
    s.lastBotText = text.trim()
    this.persist()
  }

  /** 会话被 /new 重置：清掉追问记录（次数保留） */
  onReset(sessionKey: string) {
    const s = this.deps.state[sessionKey]
    if (!s) return
    s.lastBotText = ''
    this.persist()
  }

  /** 当前的目标会话 */
  targets(): SessionInfoLike[] {
    const cfg = this.deps.config()
    return this.deps.gateway().sessions().filter((s) => matchesTarget(s, cfg.targets))
  }

  async tick(): Promise<FireResult[]> {
    const cfg = this.deps.config()
    if (!cfg.enabled || this.ticking) return []
    this.ticking = true
    const out: FireResult[] = []
    try {
      const now = this.now()
      const { day, hour } = clock(now, cfg.timezone)
      const awake = isAwake(hour, cfg.awakeFrom, cfg.awakeTo)
      let dirty = false
      for (const session of this.targets()) {
        const s = this.entry(session.key, session.updatedAt)
        if (s.day !== day) Object.assign(s, { day, count: 0 }), (dirty = true)
        if (!s.nextAt) this.schedule(s, cfg), (dirty = true)
        if (!awake || session.running || session.queued > 0 || session.pendingApproval || this.firing.has(session.key)) continue

        // 追问
        const quiet = now - s.lastBotAt
        if (
          cfg.nudge &&
          s.lastBotAt > s.lastUserAt &&
          s.lastBotAt !== s.nudgedFor &&
          QUESTION.test(s.lastBotText) &&
          quiet > cfg.nudgeMinMinutes * MIN &&
          quiet < cfg.nudgeMaxMinutes * MIN
        ) {
          s.nudgedFor = s.lastBotAt
          dirty = true
          if (this.random() < 0.5) out.push(await this.fire(session, { nudge: true }))
          continue
        }

        // 主动找
        const last = Math.max(s.lastUserAt, s.lastBotAt, session.updatedAt)
        if (now - last > cfg.idleMinutes * MIN && s.count < cfg.maxPerDay && now >= s.nextAt) {
          s.count++
          this.schedule(s, cfg)
          dirty = true
          out.push(await this.fire(session))
        }
      }
      if (dirty) this.persist()
    } finally {
      this.ticking = false
    }
    return out
  }

  /** 立刻让 Agent 找某个会话说话（不看时段、空闲与次数） */
  async fire(session: SessionInfoLike, opts: { nudge?: boolean } = {}): Promise<FireResult> {
    const key = session.key
    if (this.firing.has(key) || session.running || session.queued > 0) return { sessionKey: key, status: 'busy' }
    const cfg = this.deps.config()
    const gw = this.deps.gateway()
    const s = this.entry(key, session.updatedAt)
    const now = this.now()
    const name = cfg.name || session.origin.userName || '对方'
    const angle = ANGLES[Math.floor(this.random() * ANGLES.length)] ?? ANGLES[0]!
    const prompt = buildPrompt({
      name,
      idleMinutes: (now - Math.max(s.lastUserAt, s.lastBotAt, session.updatedAt)) / MIN,
      angle,
      ...(opts.nudge ? { nudge: { lastText: s.lastBotText, quietMinutes: (now - s.lastBotAt) / MIN } } : {}),
    })
    const images: { url: string; alt?: string }[] = []
    this.firing.add(key)
    try {
      this.deps.log?.info(`speakup: ${opts.nudge ? '追问' : '主动搭话'} ${key}`)
      const res = await gw.chat({
        sessionKey: key,
        text: prompt,
        onEvent: (ev) => {
          if (ev.type === 'image' && ev.url) images.push({ url: ev.url, ...(ev.alt ? { alt: ev.alt } : {}) })
        },
      })
      const text = res.text.replace(SILENT, '').trim()
      if (res.reason !== 'completed' && !text) return { sessionKey: key, status: 'failed', error: res.error ?? res.reason }
      if (!text && (IS_SILENT.test(res.text) || !images.length)) return { sessionKey: key, status: 'silent' }
      const o = session.origin
      const target: DeliveryTargetLike = { account: o.account, chatId: o.chatId, chatType: o.chatType, ...(o.extra ? { extra: o.extra } : {}) }
      if (text) await gw.send(target, text)
      let sentImages = 0
      for (const image of images) {
        if (!gw.sendImage) break
        try {
          await gw.sendImage(target, image)
          sentImages++
        } catch (err) {
          this.deps.log?.warn(`speakup: 发图片失败 ${key}：${(err as Error).message}`)
        }
      }
      s.lastBotAt = this.now()
      s.lastFireAt = s.lastBotAt
      if (text) s.lastBotText = text
      this.persist()
      return { sessionKey: key, status: 'sent', text, images: sentImages }
    } catch (err) {
      const message = (err as Error).message
      this.deps.log?.warn(`speakup: 主动发消息失败 ${key}：${message}`)
      const tag = `${key}\n${message.slice(0, 80)}`
      if (!this.noticed.has(tag)) {
        this.noticed.add(tag)
        const hint = session.origin.channel === 'qq' ? '（QQ：对方可能在机器人资料卡关了「允许主动发送」，或超过了主动消息额度）' : ''
        this.deps.notice?.(`主动搭话发送失败：${key}：${message}${hint}`)
      }
      return { sessionKey: key, status: 'failed', error: message }
    } finally {
      this.firing.delete(key)
    }
  }
}
