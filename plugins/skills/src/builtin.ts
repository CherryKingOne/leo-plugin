/**
 * 内置技能：随插件代码发布，启动时释放到 ~/.leo/skills/.builtin/<name>/。
 * 这个目录归插件管：内容变了（插件升级）会整个重写，用户的改动不会保留。
 * 想改内置技能：复制到 ~/.leo/skills/<同名>/ 再改，同名的用户技能优先。
 */
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { BUILTIN_DIGEST, BUILTIN_SKILLS, type BuiltinFile } from './builtin.generated.js'

export { BUILTIN_DIGEST, BUILTIN_SKILLS }
export const BUILTIN_DIR_NAME = '.builtin'
const STAMP = '.digest'

const README = `# 内置技能

这个目录由 leo-plugin-skills 管理：插件升级时会整个重写，在这里的改动会丢失。

想改某个内置技能：把它复制到上一级目录（~/.leo/skills/<同名>/）再改，同名的用户技能优先于内置技能。
不想用某个内置技能：/skills disable <名字>，或在 skills.json 的 "disabled" 里写上它。
`

export async function materializeBuiltin(
  dir: string,
  skills: Record<string, Record<string, BuiltinFile>> = BUILTIN_SKILLS,
  digest: string = BUILTIN_DIGEST,
): Promise<{ written: boolean; names: string[] }> {
  const names = Object.keys(skills)
  const current = await readFile(join(dir, STAMP), 'utf8').catch(() => '')
  const present = new Set(await readdir(dir).catch(() => [] as string[]))
  if (current.trim() === digest && names.every((n) => present.has(n))) return { written: false, names }

  await mkdir(dir, { recursive: true })
  // 不再内置的技能删掉
  for (const name of present) {
    if (name.startsWith('.') || name === 'README.md' || name in skills) continue
    await rm(join(dir, name), { recursive: true, force: true })
  }
  for (const [name, files] of Object.entries(skills)) {
    // 先写到临时目录再替换，避免别的 leo 进程读到一半
    const tmp = join(dir, `.${name}.${process.pid}.${Date.now()}.tmp`)
    for (const [rel, f] of Object.entries(files)) {
      const target = join(tmp, rel)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, f.text)
      await chmod(target, f.mode).catch(() => {})
    }
    const dest = join(dir, name)
    await rm(dest, { recursive: true, force: true })
    await rename(tmp, dest)
  }
  await writeFile(join(dir, 'README.md'), README)
  await writeFile(join(dir, STAMP), `${digest}\n`)
  return { written: true, names }
}
