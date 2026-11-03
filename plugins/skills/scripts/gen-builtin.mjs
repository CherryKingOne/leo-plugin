#!/usr/bin/env node
/**
 * 把 builtin/ 下的内置技能打包成 src/builtin.generated.ts（插件发布成单个 JS 文件，内置技能只能随代码走）。
 * 运行时插件把它们释放到 ~/.leo/skills/.builtin/<name>/。
 *
 * 用法：node scripts/gen-builtin.mjs（npm run build 会先跑它）
 */
import { createHash } from 'node:crypto'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const src = join(root, 'builtin')

async function walk(dir) {
  const out = []
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name === '.DS_Store' || e.name === '__pycache__') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(p)))
    else if (e.isFile()) out.push(p)
  }
  return out
}

const skills = {}
const hash = createHash('sha256')
for (const e of (await readdir(src, { withFileTypes: true })).filter((d) => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
  const files = {}
  for (const f of await walk(join(src, e.name))) {
    const rel = relative(join(src, e.name), f).split(sep).join('/')
    const buf = await readFile(f)
    if (buf.includes(0)) throw new Error(`内置技能只支持文本文件：${e.name}/${rel}`)
    const mode = (await stat(f)).mode & 0o111 || rel.endsWith('.py') || rel.endsWith('.sh') ? 0o755 : 0o644
    files[rel] = { text: buf.toString('utf8'), mode }
    hash.update(`${e.name}/${rel}\0${mode}\0`).update(buf)
  }
  skills[e.name] = files
}

const body = `// 由 scripts/gen-builtin.mjs 生成，不要手改。内置技能的源文件在 builtin/ 目录。
export interface BuiltinFile {
  text: string
  mode: number
}

/** 内置技能内容的指纹：变化时重新释放到 ~/.leo/skills/.builtin/ */
export const BUILTIN_DIGEST = ${JSON.stringify(hash.digest('hex').slice(0, 16))}

/** 技能名 → 相对路径 → 文件 */
export const BUILTIN_SKILLS: Record<string, Record<string, BuiltinFile>> = ${JSON.stringify(skills, null, 1)}
`
await writeFile(join(root, 'src', 'builtin.generated.ts'), body)
console.log(`内置技能：${Object.keys(skills).join(', ')}`)
