/**
 * 读取 mcp-servers.json：
 *   1. `~/.leo/mcp-servers.json`（用户级）
 *   2. `<项目>/.leo/mcp-servers.json`（项目级，同名服务器覆盖用户级）
 * 每个目录也接受 `mcp-server.json`（单数）作为文件名。文件可以带注释（JSONC），
 * 顶层键为 `mcpServers`（与 Claude / Cursor 相同）或 `servers`。
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const SERVER_FILE_NAMES = ['mcp-servers.json', 'mcp-server.json'] as const

export interface ServerSource {
  /** 原始（未校验）配置 */
  raw: unknown
  /** 声明它的文件；插件配置中声明的为 undefined */
  file?: string
  /** 相对路径（cwd）的基准目录 */
  baseDir: string
}

/** 去掉 JSONC 的注释与尾随逗号（字符串内容保持不变） */
export function stripJsonc(text: string): string {
  // 第一遍：去注释
  let src = ''
  for (let i = 0, inStr = false; i < text.length; ) {
    const ch = text[i]!
    const next = text[i + 1]
    if (inStr) {
      src += ch
      if (ch === '\\') {
        src += next ?? ''
        i += 2
        continue
      }
      if (ch === '"') inStr = false
      i++
    } else if (ch === '"') {
      inStr = true
      src += ch
      i++
    } else if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (ch === '/' && next === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i += 2
    } else {
      src += ch
      i++
    }
  }
  // 第二遍：去掉字符串外、后面只跟空白和 } / ] 的逗号
  let out = ''
  for (let i = 0, inStr = false; i < src.length; i++) {
    const ch = src[i]!
    if (inStr) {
      out += ch
      if (ch === '\\') out += src[++i] ?? ''
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    if (ch === ',') {
      let j = i + 1
      while (j < src.length && /\s/.test(src[j]!)) j++
      if (src[j] === '}' || src[j] === ']') continue
    }
    out += ch
  }
  return out
}

export async function readServerFile(file: string): Promise<Record<string, unknown> | undefined> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
  let data: unknown
  try {
    data = JSON.parse(stripJsonc(text))
  } catch (err) {
    throw new Error(`${file}: invalid JSON (${(err as Error).message})`)
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${file}: must be a JSON object`)
  const obj = data as Record<string, unknown>
  const servers = obj.mcpServers ?? obj.servers ?? {}
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error(`${file}: "mcpServers" must be an object`)
  return servers as Record<string, unknown>
}

/** 按 用户级 → 项目级 的顺序读取，后者覆盖前者；返回 名称 → 来源 */
export async function loadServerFiles(
  dirs: { userDir?: string; projectDir?: string },
  onError: (file: string, err: Error) => void,
): Promise<Record<string, ServerSource>> {
  const out: Record<string, ServerSource> = {}
  for (const dir of [dirs.userDir, dirs.projectDir]) {
    if (!dir) continue
    for (const name of SERVER_FILE_NAMES) {
      const file = join(dir, name)
      try {
        const servers = await readServerFile(file)
        if (!servers) continue
        // 项目级 .leo/ 的相对路径基于项目根；用户级基于 ~/.leo
        const baseDir = dir === dirs.projectDir ? dirname(dir) : dir
        for (const [k, raw] of Object.entries(servers)) out[k] = { raw, file, baseDir }
        break // 同一目录只读第一个存在的文件
      } catch (err) {
        onError(file, err as Error)
        break
      }
    }
  }
  return out
}
