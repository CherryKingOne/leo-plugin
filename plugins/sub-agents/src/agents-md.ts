import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { type AgentProfile, AgentProfileSchema } from './config.js'

const NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/

/**
 * 解析 Markdown 子 Agent 定义：
 *
 * ```md
 * ---
 * name: explorer            # 可选，默认取文件名
 * description: 只读调研
 * model: deepseek/deepseek-chat
 * tools: read_file, grep    # 或 [read_file, grep]，或多行 "- read_file"
 * maxSteps: 20
 * ---
 * 正文即系统提示（可选）
 * ```
 */
export function parseAgentMarkdown(text: string, fallbackName: string): { name: string; profile: AgentProfile } {
  const m = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) throw new Error('missing front matter (--- ... ---)')
  const meta: Record<string, string | string[]> = {}
  let listKey: string | undefined
  for (const raw of m[1]!.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '')
    if (!line.trim()) continue
    const item = line.match(/^\s+-\s+(.+)$/) ?? line.match(/^-\s+(.+)$/)
    if (item && listKey) {
      ;(meta[listKey] as string[]).push(unquote(item[1]!))
      continue
    }
    const kv = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/)
    if (!kv) throw new Error(`cannot parse front matter line: ${raw}`)
    const [, key, value] = kv as unknown as [string, string, string]
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
  const name = str('name') ?? fallbackName
  if (!NAME.test(name)) throw new Error(`invalid agent name "${name}"`)
  const profile = AgentProfileSchema.parse({
    description: str('description'),
    ...(body ? { systemPrompt: body } : {}),
    ...(str('model') ? { model: str('model') } : {}),
    ...(tools ? { tools } : {}),
    ...(str('maxSteps') ? { maxSteps: Number(str('maxSteps')) } : {}),
  })
  return { name, profile }
}

function unquote(s: string): string {
  const t = s.trim()
  return /^(["']).*\1$/.test(t) ? t.slice(1, -1) : t
}

/** 读取目录下所有 *.md 定义；无效文件交给 onError，不中断加载 */
export async function loadAgentDir(dir: string, onError: (file: string, err: Error) => void): Promise<Record<string, AgentProfile>> {
  let files: string[]
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort()
  } catch {
    return {}
  }
  const out: Record<string, AgentProfile> = {}
  for (const f of files) {
    const file = join(dir, f)
    try {
      const { name, profile } = parseAgentMarkdown(await readFile(file, 'utf8'), basename(f, '.md'))
      out[name] = profile
    } catch (err) {
      onError(file, err as Error)
    }
  }
  return out
}
