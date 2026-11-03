/**
 * 技能目录：按优先级扫描几个根目录，每个子目录里有 SKILL.md 就是一个技能。
 *
 *   project  <项目>/.leo/skills/<name>/SKILL.md     项目级，外部安装
 *   custom   skills.json 的 paths（如 ~/.claude/skills）
 *   user     ~/.leo/skills/<name>/SKILL.md          用户级，外部安装
 *   builtin  ~/.leo/skills/.builtin/<name>/SKILL.md 随插件发布，只读，升级时覆盖
 *
 * 同名技能前面的赢（项目 > 自定义 > 用户 > 内置），所以用户可以用同名技能替换内置技能。
 * 以 "." 开头的子目录不扫描（.builtin 不会被当成用户技能）。不递归：技能里的嵌套 SKILL.md 不算新技能。
 */
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseSkillFile } from './frontmatter.js'

export type SkillSource = 'project' | 'custom' | 'user' | 'builtin'

export const SOURCE_LABEL: Record<SkillSource, string> = { project: '项目', custom: '自定义目录', user: '用户', builtin: '内置' }

export interface SkillRoot {
  source: SkillSource
  dir: string
}

export interface SkillSummary {
  name: string
  description: string
  source: SkillSource
  /** 技能目录（绝对路径） */
  dir: string
  /** SKILL.md（绝对路径） */
  file: string
  /** 模型能不能自己加载（frontmatter `disable-model-invocation: true` 时为 false） */
  modelInvocable: boolean
  /** 用户能不能用 /skill 手动触发（frontmatter `user-invocable: false` 时为 false） */
  userInvocable: boolean
  /** skills.json 里禁用了 */
  disabled: boolean
  /** 被更高优先级的同名技能遮住了 */
  shadowedBy?: SkillSource
  license?: string
}

export interface SkillDiagnostic {
  file: string
  message: string
}

export interface CatalogSnapshot {
  /** 生效的技能（每个名字一个），按名字排序 */
  skills: SkillSummary[]
  /** 被遮住的同名技能 */
  shadowed: SkillSummary[]
  diagnostics: SkillDiagnostic[]
}

/** 技能名：小写字母、数字、连字符，1-64 个字符（Agent Skills 规范） */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const isSkillName = (s: string) => s.length <= 64 && SKILL_NAME_RE.test(s)

export function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith(`~${sep}`)) return join(homedir(), p.slice(2))
  return p
}

interface CacheEntry {
  mtimeMs: number
  size: number
  parsed: Omit<SkillSummary, 'source' | 'dir' | 'file' | 'disabled' | 'shadowedBy'> | { error: string }
}

export class SkillCatalog {
  private readonly cache = new Map<string, CacheEntry>()

  constructor(private readonly roots: () => SkillRoot[]) {}

  /** 读一个 SKILL.md 的元数据；改动时间与大小没变就用缓存 */
  private async readMeta(dirName: string, file: string): Promise<CacheEntry['parsed'] | undefined> {
    let st
    try {
      st = await stat(file)
    } catch {
      return undefined
    }
    if (!st.isFile()) return undefined
    const hit = this.cache.get(file)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.parsed
    let parsed: CacheEntry['parsed']
    try {
      const { data, hasFrontmatter } = parseSkillFile(await readFile(file, 'utf8'))
      const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : dirName
      const description = typeof data.description === 'string' ? data.description.replace(/\s+/g, ' ').trim() : ''
      if (!hasFrontmatter) parsed = { error: '缺少 frontmatter（--- name / description ---）' }
      else if (!isSkillName(name)) parsed = { error: `技能名 "${name}" 不合法：只能用小写字母、数字和连字符，最长 64 个字符` }
      else if (!description) parsed = { error: '缺少 description' }
      else
        parsed = {
          name,
          description,
          modelInvocable: data['disable-model-invocation'] !== true,
          userInvocable: data['user-invocable'] !== false,
          ...(typeof data.license === 'string' && data.license ? { license: data.license } : {}),
        }
    } catch (err) {
      parsed = { error: (err as Error).message }
    }
    this.cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, parsed })
    return parsed
  }

  async scanRoot(root: SkillRoot, diagnostics: SkillDiagnostic[]): Promise<SkillSummary[]> {
    let entries
    try {
      entries = await readdir(root.dir, { withFileTypes: true })
    } catch {
      return []
    }
    const out: SkillSummary[] = []
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.')) continue
      const dir = join(root.dir, e.name)
      if (!e.isDirectory()) {
        if (!e.isSymbolicLink()) continue
        const st = await stat(dir).catch(() => undefined)
        if (!st?.isDirectory()) continue
      }
      const file = join(dir, 'SKILL.md')
      const meta = await this.readMeta(e.name, file)
      if (!meta) continue
      if ('error' in meta) {
        diagnostics.push({ file, message: meta.error })
        continue
      }
      out.push({ ...meta, source: root.source, dir, file, disabled: false })
    }
    return out
  }

  async snapshot(disabled: readonly string[] = []): Promise<CatalogSnapshot> {
    const diagnostics: SkillDiagnostic[] = []
    const winners = new Map<string, SkillSummary>()
    const shadowed: SkillSummary[] = []
    const seen = new Set<string>()
    const off = new Set(disabled)
    for (const root of this.roots()) {
      const key = resolve(root.dir)
      if (seen.has(key)) continue
      seen.add(key)
      for (const s of await this.scanRoot(root, diagnostics)) {
        s.disabled = off.has(s.name)
        const win = winners.get(s.name)
        if (win) shadowed.push({ ...s, shadowedBy: win.source })
        else winners.set(s.name, s)
      }
    }
    return { skills: [...winners.values()].sort((a, b) => a.name.localeCompare(b.name)), shadowed, diagnostics }
  }
}

/** 技能目录里的资源文件（相对路径），不含 SKILL.md 与隐藏文件；最多 limit 个 */
export async function listResources(dir: string, limit = 80, depth = 3): Promise<{ files: string[]; more: boolean }> {
  const files: string[] = []
  let more = false
  async function walk(d: string, level: number) {
    let entries
    try {
      entries = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') || e.name === '__pycache__' || e.name === 'node_modules') continue
      const p = join(d, e.name)
      if (e.isDirectory()) {
        if (level < depth) await walk(p, level + 1)
        else if (files.length < limit) files.push(`${relative(dir, p).split(sep).join('/')}/`)
        continue
      }
      const rel = relative(dir, p).split(sep).join('/')
      if (rel === 'SKILL.md') continue
      if (files.length >= limit) {
        more = true
        return
      }
      files.push(rel)
    }
  }
  await walk(dir, 1)
  return { files, more }
}

const MAX_RESOURCE_BYTES = 256 * 1024

/** 读技能目录里的一个文件；路径不能跳出技能目录（含符号链接） */
export async function readResource(skillDir: string, file: string): Promise<string> {
  if (!file.trim()) throw new Error('file 不能为空')
  if (isAbsolute(file)) throw new Error('file 要写相对技能目录的路径，例如 references/schemas.md')
  const base = await realpath(skillDir)
  let target: string
  try {
    target = await realpath(resolve(base, file))
  } catch {
    throw new Error(`技能目录里没有 ${file}`)
  }
  if (target !== base && !target.startsWith(base + sep)) throw new Error(`${file} 不在技能目录里`)
  const st = await stat(target)
  if (st.isDirectory()) {
    const { files, more } = await listResources(target, 200, 1)
    return `${file} 是目录，里面有：\n${files.join('\n')}${more ? '\n…' : ''}`
  }
  const buf = await readFile(target)
  if (buf.subarray(0, 8000).includes(0)) throw new Error(`${file} 是二进制文件，不能直接读；需要的话用 bash 按绝对路径处理：${target}`)
  const text = buf.subarray(0, MAX_RESOURCE_BYTES).toString('utf8')
  return buf.length > MAX_RESOURCE_BYTES ? `${text}\n\n[文件过长，只显示前 ${MAX_RESOURCE_BYTES} 字节；完整内容：${target}]` : text
}
