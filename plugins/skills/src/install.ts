/**
 * 安装 / 删除外部技能（只动用户级 ~/.leo/skills 或项目级 .leo/skills，内置技能不能删）。
 *
 * 来源可以是：
 *   - 本地目录（技能目录本身，或含多个技能的目录）
 *   - git 仓库：https://github.com/o/r、github:o/r、git@…、以 .git 结尾的地址
 *   - GitHub 子目录：https://github.com/o/r/tree/<分支>/<路径>
 */
import { execFile } from 'node:child_process'
import { cp, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expandHome, isSkillName } from './catalog.js'
import { parseSkillFile } from './frontmatter.js'

const run = promisify(execFile)

export interface GitSource {
  url: string
  ref?: string
  subdir?: string
}

/** 识别 git 来源；不是 git 地址时返回 undefined（当作本地路径） */
export function parseGitSource(src: string): GitSource | undefined {
  const s = src.trim()
  const tree = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/(?:tree|blob)\/([^/]+)(?:\/(.+?))?\/?$/.exec(s)
  if (tree) {
    const subdir = tree[4]?.replace(/\/SKILL\.md$/, '')
    return { url: `https://github.com/${tree[1]}/${tree[2]}.git`, ref: tree[3]!, ...(subdir ? { subdir } : {}) }
  }
  const gh = /^github:([^/\s]+)\/([^/\s#]+?)(?:\.git)?(?:#(.+))?$/.exec(s)
  if (gh) return { url: `https://github.com/${gh[1]}/${gh[2]}.git`, ...(gh[3] ? { ref: gh[3] } : {}) }
  if (/^https?:\/\/github\.com\/[^/]+\/[^/]+?\/?$/.test(s)) return { url: `${s.replace(/\/$/, '').replace(/\.git$/, '')}.git` }
  if (/^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(s)) return { url: s }
  return undefined
}

export interface FoundSkill {
  name: string
  description: string
  dir: string
}

/** 在目录里找技能：自己有 SKILL.md 就是一个技能，否则往下找（最多 depth 层，找到 SKILL.md 就不再往里） */
export async function findSkills(root: string, depth = 4): Promise<{ skills: FoundSkill[]; errors: string[] }> {
  const skills: FoundSkill[] = []
  const errors: string[] = []
  async function visit(dir: string, level: number) {
    const file = join(dir, 'SKILL.md')
    const st = await stat(file).catch(() => undefined)
    if (st?.isFile()) {
      const { data, hasFrontmatter } = parseSkillFile(await readFile(file, 'utf8'))
      const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : basename(dir)
      const description = typeof data.description === 'string' ? data.description.replace(/\s+/g, ' ').trim() : ''
      if (!hasFrontmatter || !description) errors.push(`${file}：缺少 frontmatter 的 description`)
      else if (!isSkillName(name)) errors.push(`${file}：技能名 "${name}" 不合法`)
      else skills.push({ name, description, dir })
      return
    }
    if (level >= depth) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue
      await visit(join(dir, e.name), level + 1)
    }
  }
  await visit(root, 0)
  return { skills, errors }
}

export interface InstallOptions {
  /** 来源：本地路径或 git 地址 */
  source: string
  /** 装到哪个目录（~/.leo/skills 或 <项目>/.leo/skills） */
  targetDir: string
  /** 来源里有多个技能时只装这些 */
  names?: string[]
  /** 装来源里的全部技能 */
  all?: boolean
  /** 同名已存在时覆盖 */
  force?: boolean
  /** 相对路径的基准目录 */
  cwd?: string
  /** 测试用：替换 git clone */
  clone?: (src: GitSource, dest: string) => Promise<void>
}

export interface InstallResult {
  installed: FoundSkill[]
  /** 来源里有多个技能、又没指定装哪个时，列出可选的 */
  choices?: FoundSkill[]
  skipped: string[]
}

async function gitClone(src: GitSource, dest: string) {
  const args = ['clone', '--depth', '1', ...(src.ref ? ['--branch', src.ref] : []), src.url, dest]
  try {
    await run('git', args, { timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  } catch (err) {
    const e = err as { code?: string; stderr?: string; message: string }
    if (e.code === 'ENOENT') throw new Error('没有找到 git 命令：请先安装 git，或者下载后用本地路径安装')
    throw new Error(`git clone 失败：${(e.stderr || e.message).trim().split('\n').slice(-2).join(' ')}`)
  }
}

export async function installSkills(o: InstallOptions): Promise<InstallResult> {
  const git = parseGitSource(o.source)
  let tmp: string | undefined
  try {
    let root: string
    if (git) {
      tmp = await mkdtemp(join(tmpdir(), 'leo-skill-'))
      await (o.clone ?? gitClone)(git, join(tmp, 'repo'))
      root = git.subdir ? join(tmp, 'repo', git.subdir) : join(tmp, 'repo')
      if (!(await stat(root).catch(() => undefined))?.isDirectory()) throw new Error(`仓库里没有目录 ${git.subdir}`)
    } else {
      root = resolve(o.cwd ?? process.cwd(), expandHome(o.source))
      const st = await stat(root).catch(() => undefined)
      if (!st) throw new Error(`找不到 ${o.source}`)
      if (st.isFile() && basename(root) === 'SKILL.md') root = resolve(root, '..')
      else if (!st.isDirectory()) throw new Error(`${o.source} 不是目录`)
    }
    const { skills: found, errors } = await findSkills(root)
    if (!found.length) throw new Error(`${o.source} 里没有找到技能（需要带 frontmatter 的 SKILL.md）${errors.length ? `：${errors.join('；')}` : ''}`)
    let picked = found
    if (o.names?.length) {
      picked = found.filter((s) => o.names!.includes(s.name) || o.names!.includes(basename(s.dir)))
      const missing = o.names.filter((n) => !picked.some((s) => s.name === n || basename(s.dir) === n))
      if (missing.length) throw new Error(`${o.source} 里没有技能 ${missing.join(', ')}；有：${found.map((s) => s.name).join(', ')}`)
    } else if (found.length > 1 && !o.all) {
      return { installed: [], choices: found, skipped: [] }
    }
    const installed: FoundSkill[] = []
    const skipped: string[] = []
    for (const s of picked) {
      const dest = join(o.targetDir, s.name)
      if (await stat(dest).catch(() => undefined)) {
        if (!o.force) {
          skipped.push(s.name)
          continue
        }
        await rm(dest, { recursive: true, force: true })
      }
      await cp(s.dir, dest, { recursive: true, filter: (p) => !/(^|[\\/])(\.git|node_modules|__pycache__)$/.test(p) })
      installed.push({ ...s, dir: dest })
    }
    return { installed, skipped }
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

/** 删除一个外部技能目录 */
export async function removeSkillDir(dir: string) {
  await rm(dir, { recursive: true, force: true })
}
