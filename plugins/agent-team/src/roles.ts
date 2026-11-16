import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { BUILTIN_ROLES, READ_ONLY_TOOLS } from './builtin-roles.js'
import { type AgentTeamConfig, ROLE_ID, type ResolvedRole, type RoleProfile, RoleProfileSchema } from './config.js'

/**
 * 解析角色 Markdown（与 sub-agents 的 `.leo/agents/*.md` 同一格式，多了 name / phase / artifact / disabled）：
 *
 * ```md
 * ---
 * name: 产品经理
 * description: 写 PRD
 * model: deepseek/deepseek-flash
 * tools: read_file, grep        # 或 [a, b]，或多行 "- a"
 * maxSteps: 30
 * phase: requirements           # 负责的阶段（可选）
 * artifact: prd.md              # 默认产出物文件名（可选）
 * ---
 * 正文 = 系统提示（可选，不写保留内置 / 上一层的提示）
 * ```
 *
 * 文件名即角色 id。返回的 profile 只包含文件里写了的字段，便于逐层覆盖。
 */
export function parseRoleMarkdown(text: string, fallbackId: string): { id: string; profile: RoleProfile } {
  const m = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) throw new Error('missing front matter (--- ... ---)')
  const meta: Record<string, string | string[]> = {}
  let listKey: string | undefined
  for (const raw of m[1]!.split(/\r?\n/)) {
    if (/^\s*#/.test(raw)) continue
    const line = raw.replace(/\s+#.*$/, '')
    if (!line.trim()) continue
    const item = line.match(/^\s+-\s+(.+)$/) ?? line.match(/^-\s+(.+)$/)
    if (item && listKey) {
      ;(meta[listKey] as string[]).push(unquote(item[1]!))
      continue
    }
    const kv = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/)
    if (!kv) throw new Error(`cannot parse front matter line: ${raw}`)
    const key = kv[1]!
    const value = kv[2]!
    if (value === '') {
      meta[key] = []
      listKey = key
    } else {
      listKey = undefined
      meta[key] = value.startsWith('[') ? value.replace(/^\[|\]$/g, '').split(',').map(unquote).filter(Boolean) : unquote(value)
    }
  }
  const str = (k: string) => (typeof meta[k] === 'string' ? (meta[k] as string) : undefined)
  const toolsRaw = meta.tools
  const tools = toolsRaw === undefined ? undefined : Array.isArray(toolsRaw) ? toolsRaw : toolsRaw.split(',').map((s) => s.trim()).filter(Boolean)
  const body = m[2]!.trim()
  const id = str('id') ?? fallbackId
  if (!ROLE_ID.test(id)) throw new Error(`invalid role id "${id}" (lowercase letters, digits, - and _)`)
  const disabled = str('disabled')
  const profile = RoleProfileSchema.parse({
    ...(str('name') ? { name: str('name') } : {}),
    ...(str('description') ? { description: str('description') } : {}),
    ...(body ? { systemPrompt: body } : {}),
    ...(str('model') ? { model: str('model') } : {}),
    ...(tools ? { tools } : {}),
    ...(str('maxSteps') ? { maxSteps: Number(str('maxSteps')) } : {}),
    ...(str('phase') ? { phase: str('phase') } : {}),
    ...(str('artifact') ? { artifact: str('artifact') } : {}),
    ...(disabled !== undefined ? { disabled: disabled === 'true' } : {}),
  })
  return { id, profile }
}

function unquote(s: string): string {
  const t = s.trim()
  return /^(["']).*\1$/.test(t) ? t.slice(1, -1) : t
}

/** 读取目录下的 `<role>.md`（只读一层，不进入 projects/ 等子目录）；无效文件交给 onError，不中断加载 */
export async function loadRoleDir(dir: string, onError: (file: string, err: Error) => void): Promise<{ id: string; file: string; profile: RoleProfile }[]> {
  let files: string[]
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    files = entries
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
  const out: { id: string; file: string; profile: RoleProfile }[] = []
  for (const f of files) {
    const file = join(dir, f)
    try {
      const { id, profile } = parseRoleMarkdown(await readFile(file, 'utf8'), basename(f, '.md'))
      out.push({ id, file, profile })
    } catch (err) {
      onError(file, err as Error)
    }
  }
  return out
}

export interface RoleLayer {
  source: string
  roles: Record<string, RoleProfile | false>
}

/**
 * 逐层合并角色：内置 < ~/.leo/team < 项目 .leo/team < 配置 roles。
 * 字段级覆盖；`disabled: true` 或配置里的 `false` 删除角色；leader 不能删除。
 */
export function resolveRoles(layers: RoleLayer[], config: Pick<AgentTeamConfig, 'leaderMaxSteps' | 'memberMaxSteps'>): Record<string, ResolvedRole> {
  const merged = new Map<string, { profile: RoleProfile; source: string[] }>()
  for (const [id, p] of Object.entries(BUILTIN_ROLES)) merged.set(id, { profile: { ...p }, source: ['builtin'] })
  for (const layer of layers) {
    for (const [id, p] of Object.entries(layer.roles)) {
      if (p === false || p.disabled) {
        if (id !== 'leader') merged.delete(id)
        continue
      }
      const prev = merged.get(id)
      merged.set(id, { profile: { ...prev?.profile, ...stripUndefined(p) }, source: [...(prev?.source ?? []), layer.source] })
    }
  }
  const out: Record<string, ResolvedRole> = {}
  for (const [id, { profile: p, source }] of merged) {
    const leader = id === 'leader'
    out[id] = {
      id,
      name: p.name ?? id,
      description: p.description ?? p.name ?? id,
      systemPrompt: p.systemPrompt ?? `你是团队的 ${p.name ?? id}。${p.description ?? ''}`.trim(),
      ...(p.model ? { model: p.model } : {}),
      tools: p.tools ?? READ_ONLY_TOOLS,
      maxSteps: p.maxSteps ?? (leader ? config.leaderMaxSteps : config.memberMaxSteps),
      // leader 不属于任何阶段
      ...(p.phase && !leader ? { phase: p.phase } : {}),
      ...(p.artifact ? { artifact: p.artifact } : {}),
      source,
    }
  }
  return out
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}
