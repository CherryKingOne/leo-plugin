/**
 * 互动层配置 `interaction.json`（JSONC）：
 *
 *   ~/.leo/interaction.json         用户级（leo plugin add interaction 时生成模板）
 *   <项目>/.leo/interaction.json    项目级，覆盖用户级
 *   .leo/config.json 里的插件选项    优先级最高
 *
 * 合并规则：顶层按键覆盖，`stickers` 再按键覆盖一层。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setJsonc, stripJsonc } from './jsonc.js'

export const CONFIG_FILE_NAME = 'interaction.json'

export type StickerDisplayMode = 'art' | 'image' | 'off'

export interface InteractionConfig {
  /** 当前人设：子插件注册的人设 id；"auto" = 第一个注册的人设；"off" = 不用人设 */
  persona: string
  stickers: {
    /** 是否让 Agent 发表情（关掉后不注册 send_sticker 工具，也不注入表情提示词） */
    enabled: boolean
    /** 默认角色（variant id）；空 = 表情包自己的默认角色 */
    variant: string
    /** 是否允许 Agent 发“只有 Agent 能发”的彩蛋表情 */
    hidden: boolean
    /** 每轮对话最多发几张 */
    maxPerTurn: number
    /** 展示方式：art = 终端字符画 + 图片地址；image = 只给图片地址（聊天平台 / Web）；off = 只有文字 */
    display: StickerDisplayMode
    /** 用户 `/sticker` 发表情后，是否把它作为一条消息发给 Agent，让它接话 */
    userPrompt: boolean
  }
}

export const DEFAULT_CONFIG: InteractionConfig = {
  persona: 'auto',
  stickers: { enabled: true, variant: '', hidden: true, maxPerTurn: 1, display: 'art', userPrompt: true },
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

export function mergeConfig(...layers: (Obj | undefined)[]): Obj {
  const out: Obj = {}
  for (const layer of layers) {
    if (!layer) continue
    for (const [k, v] of Object.entries(layer)) {
      if (v === undefined || k === '$schema') continue
      out[k] = isObj(v) && isObj(out[k]) ? { ...(out[k] as Obj), ...v } : v
    }
  }
  return out
}

/** 校验并补默认值；字段类型不对时抛错（带字段名） */
export function normalizeConfig(raw: Obj): InteractionConfig {
  const bad = (path: string, want: string) => new Error(`interaction: ${path} 应为 ${want}`)
  const persona = raw.persona ?? DEFAULT_CONFIG.persona
  if (typeof persona !== 'string') throw bad('persona', '字符串（人设 id / "auto" / "off"）')
  const s = (raw.stickers ?? {}) as Obj
  if (!isObj(s)) throw bad('stickers', '对象')
  const d = DEFAULT_CONFIG.stickers
  const pick = <T>(key: string, type: string, def: T): T => {
    const v = s[key]
    if (v === undefined) return def
    if (typeof v !== type) throw bad(`stickers.${key}`, type)
    return v as T
  }
  const display = pick('display', 'string', d.display)
  if (!['art', 'image', 'off'].includes(display)) throw bad('stickers.display', '"art" / "image" / "off"')
  const maxPerTurn = pick('maxPerTurn', 'number', d.maxPerTurn)
  if (!Number.isInteger(maxPerTurn) || maxPerTurn < 0) throw bad('stickers.maxPerTurn', '非负整数')
  return {
    persona: persona.trim() || 'auto',
    stickers: {
      enabled: pick('enabled', 'boolean', d.enabled),
      variant: pick('variant', 'string', d.variant),
      hidden: pick('hidden', 'boolean', d.hidden),
      maxPerTurn,
      display,
      userPrompt: pick('userPrompt', 'boolean', d.userPrompt),
    },
  }
}

/** 读一个 interaction.json；不存在返回 undefined，格式错误抛错（带文件名） */
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
    throw new Error(`interaction: ${file} 格式错误：${(err as Error).message}`)
  }
}

export interface ConfigPaths {
  userDir: string
  projectDir?: string
}

export async function loadConfig(paths: ConfigPaths | undefined, options: Obj): Promise<InteractionConfig> {
  const layers: Obj[] = []
  if (paths && options.loadConfigFiles !== false) {
    for (const dir of [paths.userDir, paths.projectDir]) {
      if (!dir) continue
      const data = await readConfigFile(dir)
      if (data) layers.push(data)
    }
  }
  const { loadConfigFiles: _, ...rest } = options
  layers.push(rest)
  return normalizeConfig(mergeConfig(...layers))
}

/** 写回的文件：项目里有 interaction.json 就写它，否则写用户级（不存在时新建） */
export function targetFile(paths: ConfigPaths): string {
  const project = paths.projectDir ? join(paths.projectDir, CONFIG_FILE_NAME) : undefined
  return project && existsSync(project) ? project : join(paths.userDir, CONFIG_FILE_NAME)
}

/** 把 persona 写回 interaction.json，保留注释与排版；返回是否有改动 */
export async function persistPersona(paths: ConfigPaths, persona: string): Promise<boolean> {
  const file = targetFile(paths)
  let text = ''
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  if (!text.trim()) text = '{\n}\n'
  const next = setJsonc(text, ['persona'], persona)
  if (next === text) return false
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, next)
  await rename(tmp, file)
  return true
}
