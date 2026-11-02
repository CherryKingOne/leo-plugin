/**
 * 主动搭话配置 `speakup.json`（JSONC）：
 *
 *   ~/.leo/speakup.json         用户级（leo plugin add speakup 时生成模板）
 *   <项目>/.leo/speakup.json    项目级，覆盖用户级
 *   .leo/config.json 里的插件选项 优先级最高
 *
 * 合并规则：顶层按键覆盖。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stripJsonc } from './jsonc.js'

export const CONFIG_FILE_NAME = 'speakup.json'

export interface SpeakUpConfig {
  /** 总开关 */
  enabled: boolean
  /**
   * 找谁说话：会话键或它的前缀，如 "qq"（所有 QQ 私聊）、"qq:main"（某个机器人账号）、
   * "qq:main:direct:<openid>"（某个人）。空 = 所有私聊会话。
   * 群聊 / 频道只有写出含 ":group:" / ":channel:" 的完整前缀时才会主动发
   */
  targets: string[]
  /** 和对方多久没来往（分钟）才主动找 */
  idleMinutes: number
  /** 两次主动搭话之间的随机间隔（分钟） */
  minIntervalMinutes: number
  maxIntervalMinutes: number
  /** 每个会话每天最多主动找几次 */
  maxPerDay: number
  /** 清醒时段：[awakeFrom, awakeTo) 点之间才会主动找（0-24） */
  awakeFrom: number
  awakeTo: number
  /** 计算清醒时段与「每天」用的时区（IANA，如 "Asia/Shanghai"）；空 = 系统时区 */
  timezone: string
  /** 追问：Agent 上一句是在问对方、对方一阵子没回时，有一半机会轻轻追一句（不占每天次数） */
  nudge: boolean
  /** 追问窗口（分钟）：对方超过 min 分钟没回、但还不到 max 分钟 */
  nudgeMinMinutes: number
  nudgeMaxMinutes: number
  /** 提示词里怎么称呼对方；空 = 用平台上的昵称，没有就叫「对方」 */
  name: string
}

export const DEFAULT_CONFIG: SpeakUpConfig = {
  enabled: true,
  targets: [],
  idleMinutes: 120,
  minIntervalMinutes: 90,
  maxIntervalMinutes: 240,
  maxPerDay: 3,
  awakeFrom: 9,
  awakeTo: 23,
  timezone: '',
  nudge: true,
  nudgeMinMinutes: 15,
  nudgeMaxMinutes: 40,
  name: '',
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

export function normalizeConfig(raw: Obj): SpeakUpConfig {
  const bad = (key: string, want: string) => new Error(`speakup: ${key} 应为 ${want}`)
  const d = DEFAULT_CONFIG
  const pick = <T>(key: keyof SpeakUpConfig, type: string): T => {
    const v = raw[key]
    if (v === undefined) return d[key] as T
    if (typeof v !== type) throw bad(key, type)
    return v as T
  }
  const num = (key: keyof SpeakUpConfig, min: number, max = Infinity) => {
    const v = pick<number>(key, 'number')
    if (!Number.isFinite(v) || v < min || v > max) throw bad(key, `${min}${max === Infinity ? ' 以上' : ` ~ ${max}`} 的数字`)
    return v
  }
  let targets = raw.targets ?? d.targets
  if (typeof targets === 'string') targets = targets.trim() ? [targets] : []
  if (!Array.isArray(targets) || targets.some((t) => typeof t !== 'string')) throw bad('targets', '字符串数组')
  const timezone = pick<string>('timezone', 'string').trim()
  if (timezone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    } catch {
      throw bad('timezone', 'IANA 时区名（如 "Asia/Shanghai"）')
    }
  }
  const cfg: SpeakUpConfig = {
    enabled: pick('enabled', 'boolean'),
    targets: (targets as string[]).map((t) => t.trim()).filter(Boolean),
    idleMinutes: num('idleMinutes', 1),
    minIntervalMinutes: num('minIntervalMinutes', 1),
    maxIntervalMinutes: num('maxIntervalMinutes', 1),
    maxPerDay: num('maxPerDay', 0),
    awakeFrom: num('awakeFrom', 0, 24),
    awakeTo: num('awakeTo', 0, 24),
    timezone,
    nudge: pick('nudge', 'boolean'),
    nudgeMinMinutes: num('nudgeMinMinutes', 1),
    nudgeMaxMinutes: num('nudgeMaxMinutes', 1),
    name: pick<string>('name', 'string').trim(),
  }
  if (cfg.maxIntervalMinutes < cfg.minIntervalMinutes) throw bad('maxIntervalMinutes', '不小于 minIntervalMinutes 的数字')
  if (cfg.nudgeMaxMinutes < cfg.nudgeMinMinutes) throw bad('nudgeMaxMinutes', '不小于 nudgeMinMinutes 的数字')
  if (!Number.isInteger(cfg.maxPerDay)) throw bad('maxPerDay', '非负整数')
  return cfg
}

/** 读一个 speakup.json；不存在返回 undefined，格式错误抛错（带文件名） */
export async function readConfigFile(dir: string): Promise<Obj | undefined> {
  const file = join(dir, CONFIG_FILE_NAME)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
  if (!text.trim()) return undefined
  try {
    const data = JSON.parse(stripJsonc(text)) as unknown
    if (!isObj(data)) throw new Error('顶层应为对象')
    return data
  } catch (err) {
    throw new Error(`speakup: ${file} 格式错误：${(err as Error).message}`)
  }
}

export interface ConfigPaths {
  userDir: string
  projectDir?: string
}

export async function loadConfig(paths: ConfigPaths | undefined, options: Obj): Promise<SpeakUpConfig> {
  const merged: Obj = {}
  if (paths && options.loadConfigFiles !== false) {
    for (const dir of [paths.userDir, paths.projectDir]) {
      if (!dir) continue
      const data = await readConfigFile(dir)
      if (data) Object.assign(merged, data)
    }
  }
  for (const [k, v] of Object.entries(options)) if (v !== undefined && k !== 'loadConfigFiles' && k !== '$schema') merged[k] = v
  delete merged.$schema
  return normalizeConfig(merged)
}
