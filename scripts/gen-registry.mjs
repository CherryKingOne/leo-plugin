#!/usr/bin/env node
/**
 * 根据 plugins/<id>/leo-plugin.json 生成根目录 registry.json。
 * 用法：node scripts/gen-registry.mjs [--check]   --check 只校验是否最新（CI 用）
 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const check = process.argv.includes('--check')

const ids = (await readdir(join(root, 'plugins'), { withFileTypes: true }))
  .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
  .map((d) => d.name)
  .sort()

const plugins = []
for (const id of ids) {
  const m = JSON.parse(await readFile(join(root, 'plugins', id, 'leo-plugin.json'), 'utf8'))
  if (m.id !== id) throw new Error(`plugins/${id}/leo-plugin.json: id "${m.id}" 与目录名不一致`)
  const entry = {
    id: m.id,
    package: m.package,
    path: `plugins/${id}`,
    version: m.version,
    status: m.status,
    description: m.description,
    leo: m.leo,
  }
  if (m.release?.bundle) {
    if (m.release.version !== m.version) throw new Error(`plugins/${id}: release.version (${m.release.version}) 与 version (${m.version}) 不一致，请先运行 scripts/release.mjs ${id}`)
    entry.bundle = { url: m.release.bundle.url, sha256: m.release.bundle.sha256 }
  }
  plugins.push(entry)
}

const registry = {
  $schema: './schemas/registry.schema.json',
  description: '官方插件索引。由 scripts/gen-registry.mjs 根据 plugins/*/leo-plugin.json 生成，请勿手改。leo plugin add 读取此文件。',
  version: 1,
  plugins,
}
const text = `${JSON.stringify(registry, null, 2)}\n`
const file = join(root, 'registry.json')
if (check) {
  const current = await readFile(file, 'utf8').catch(() => '')
  if (current !== text) {
    console.error('registry.json 不是最新的，请运行 node scripts/gen-registry.mjs')
    process.exit(1)
  }
  console.log('registry.json 已是最新')
} else {
  await writeFile(file, text)
  console.log(`已生成 registry.json（${plugins.length} 个插件）`)
}
