/**
 * 技能配置 `skills.json`（JSONC）：
 *
 *   ~/.leo/skills.json         用户级（leo plugin add skills 时生成模板）
 *   <项目>/.leo/skills.json    项目级，覆盖用户级
 *   .leo/config.json 里的插件选项 优先级最高
 *
 * 合并规则：顶层按键覆盖；disabled、paths 两级合并（项目级追加在用户级后面）。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setJsonc, stripJsonc } from './jsonc.js'

export const CONFIG_FILE_NAME = 'skills.json'

export interface SkillsConfig {
  /** 总开关：关掉后不注入技能目录、不注册 skill 工具 */
  enabled: boolean
  /** 是否启用随插件发布的内置技能 */
  builtin: boolean
  /** 禁用的技能名（内置和外部都算） */
  disabled: string[]
  /** 额外的技能目录（每个子目录一个技能），如 "~/.claude/skills"；优先级在项目和用户目录之间 */
  paths: string[]
  /** 目录里每条描述最多多少字，超出截断（只影响系统提示，不影响加载） */
  maxDescriptionChars: number
  /** 是否允许在聊天渠道（网关：QQ、飞书、Telegram）里用 /skills add / remove / enable / disable；默认只允许终端 */
  remoteManage: boolean
}

export const DEFAULT_CONFIG: SkillsConfig = {
  enabled: true,
  builtin: true,
  disabled: [],
  paths: [],
  maxDescriptionChars: 500,
  remoteManage: false,
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

export function normalizeConfig(raw: Obj): SkillsConfig {
  const bad = (key: string, want: string) => new Error(`skills: ${key} 应为 ${want}`)
  const d = DEFAULT_CONFIG
  const bool = (key: 'enabled' | 'builtin' | 'remoteManage') => {
    const v = raw[key]
    if (v === undefined) return d[key]
    if (typeof v !== 'boolean') throw bad(key, 'true / false')
    return v
  }
  const list = (key: 'disabled' | 'paths') => {
    let v = raw[key]
    if (v === undefined) return [...d[key]]
    if (typeof v === 'string') v = v.trim() ? [v] : []
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw bad(key, '字符串数组')
    return [...new Set((v as string[]).map((x) => x.trim()).filter(Boolean))]
  }
  const max = raw.maxDescriptionChars ?? d.maxDescriptionChars
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 20) throw bad('maxDescriptionChars', '20 以上的整数')
  return { enabled: bool('enabled'), builtin: bool('builtin'), disabled: list('disabled'), paths: list('paths'), maxDescriptionChars: max, remoteManage: bool('remoteManage') }
}

export interface ConfigPaths {
  cwd?: string
  userDir: string
  projectDir?: string
  projectRoot?: string
}

async function readConfigFile(dir: string): Promise<Obj | undefined> {
  let text: string
  try {
    text = await readFile(join(dir, CONFIG_FILE_NAME), 'utf8')
  } catch {
    return undefined
  }
  const data = JSON.parse(stripJsonc(text)) as unknown
  if (!isObj(data)) throw new Error(`skills: ${join(dir, CONFIG_FILE_NAME)} 应为 JSON 对象`)
  return data
}

export async function loadConfig(paths: ConfigPaths | undefined, options: Obj): Promise<SkillsConfig> {
  const merged: Obj = {}
  const append = (data: Obj) => {
    for (const [k, v] of Object.entries(data)) {
      if (k === '$schema' || v === undefined) continue
      if ((k === 'disabled' || k === 'paths') && Array.isArray(merged[k]) && Array.isArray(v)) merged[k] = [...(merged[k] as unknown[]), ...v]
      else merged[k] = v
    }
  }
  if (paths && options.loadConfigFiles !== false) {
    for (const dir of [paths.userDir, paths.projectDir]) {
      if (!dir) continue
      const data = await readConfigFile(dir)
      if (data) append(data)
    }
  }
  const { loadConfigFiles: _, ...rest } = options
  append(rest)
  return normalizeConfig(merged)
}

/** 把 disabled 列表写回某一级的 skills.json（保留注释与排版；文件不存在就新建） */
export async function writeDisabled(dir: string, disabled: string[]): Promise<string> {
  const file = join(dir, CONFIG_FILE_NAME)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    text = '{\n}\n'
  }
  await writeFile(file, setJsonc(text, ['disabled'], disabled))
  return file
}

/** 读某一级 skills.json 里自己的 disabled（不合并） */
export async function readDisabled(dir: string): Promise<string[]> {
  const data = await readConfigFile(dir).catch(() => undefined)
  const v = data?.disabled
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' && v ? [v] : []
}
