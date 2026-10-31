#!/usr/bin/env node
/**
 * 发布插件的单文件版本（供 `leo plugin add <id>` 下载）：
 *   1. 构建 plugins/<id>，得到 dist/<id>.bundle.js
 *   2. 计算 sha256，提交到 bundles 分支的 <id>/<version>/<id>.bundle.js（同版本已发布且内容不同则拒绝）
 *   3. 插件声明了 init.files 时，把模板一并提交到 <id>/<version>/init/<path>（供 `leo plugin add --init` 下载）
 *   4. 把下载地址与 sha256 写回 leo-plugin.json 的 release 字段，重新生成 registry.json
 *
 * 用法：node scripts/release.mjs <id> [--push]
 * 之后提交 main 上的 leo-plugin.json 与 registry.json；--push 会同时推送 bundles 分支。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize } from 'node:path'

const REPO_RAW = 'https://raw.githubusercontent.com/CherryKingOne/leo-plugin'
const BRANCH = 'bundles'
const root = new URL('..', import.meta.url).pathname
const [id] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const push = process.argv.includes('--push')
if (!id) {
  console.error('用法：node scripts/release.mjs <id> [--push]')
  process.exit(2)
}
const sh = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim()

const dir = join(root, 'plugins', id)
const manifestFile = join(dir, 'leo-plugin.json')
const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
if (manifest.version !== pkg.version) throw new Error(`leo-plugin.json version ${manifest.version} 与 package.json ${pkg.version} 不一致`)
if (manifest.status === 'planned') throw new Error('status 为 planned 的插件不能发布')

execFileSync('npm', ['run', 'build', '-w', `plugins/${id}`], { cwd: root, stdio: 'inherit' })
const bundle = join(dir, 'dist', `${id}.bundle.js`)
const bytes = await readFile(bundle)
const sha256 = createHash('sha256').update(bytes).digest('hex')

// bundles 分支的工作树
const wt = join(root, '.release', BRANCH)
if (!existsSync(wt)) {
  const hasRemote = sh('git', ['ls-remote', '--heads', 'origin', BRANCH]) !== ''
  if (hasRemote) {
    sh('git', ['fetch', 'origin', `${BRANCH}:${BRANCH}`])
    sh('git', ['worktree', 'add', wt, BRANCH])
  } else if (sh('git', ['branch', '--list', BRANCH])) {
    sh('git', ['worktree', 'add', wt, BRANCH])
  } else {
    sh('git', ['worktree', 'add', '--orphan', '-b', BRANCH, wt])
    await writeFile(join(wt, 'README.md'), '# bundles\n\n`leo plugin add` 下载的插件单文件，由 `scripts/release.mjs` 生成。路径：`<id>/<version>/<id>.bundle.js`。已发布的版本不可修改。\n')
  }
}

const rel = `${id}/${manifest.version}/${id}.bundle.js`
const target = join(wt, rel)
const changed = []
if (existsSync(target)) {
  const existing = createHash('sha256').update(await readFile(target)).digest('hex')
  if (existing !== sha256) throw new Error(`${rel} 已发布且内容不同。已发布的版本不可修改，请先提升版本号`)
  console.log(`${rel} 已发布（内容相同），跳过`)
} else {
  await mkdir(join(wt, id, manifest.version), { recursive: true })
  await copyFile(bundle, target)
  changed.push(rel)
}

// 配置文件模板：同一版本已发布的模板不可修改（只能新增）
const initFiles = []
for (const f of manifest.init?.files ?? []) {
  if (!f.path || isAbsolute(f.path) || normalize(f.path).startsWith('..')) throw new Error(`init.files 路径不合法：${f.path}`)
  if (!f.template) throw new Error(`init.files[${f.path}] 缺少 template`)
  const src = join(dir, f.template)
  const bytes = await readFile(src)
  const sha = createHash('sha256').update(bytes).digest('hex')
  const trel = `${id}/${manifest.version}/init/${f.path}`
  const dst = join(wt, trel)
  if (existsSync(dst)) {
    const existing = createHash('sha256').update(await readFile(dst)).digest('hex')
    if (existing !== sha) throw new Error(`${trel} 已发布且内容不同。已发布的版本不可修改，请先提升版本号`)
  } else {
    await mkdir(dirname(dst), { recursive: true })
    await writeFile(dst, bytes)
    changed.push(trel)
  }
  initFiles.push({ path: f.path, url: `${REPO_RAW}/${BRANCH}/${trel}`, sha256: sha, ...(f.description ? { description: f.description } : {}) })
}

if (changed.length) {
  sh('git', ['add', '-A'], wt)
  const name = sh('git', ['config', 'user.name']) || 'leo-plugin'
  sh('git', ['-c', `user.name=${name}`, 'commit', '-m', `release ${id}@${manifest.version}${existsSync(target) && !changed.includes(rel) ? ' (init templates)' : ''}`], wt)
  console.log(`已提交到 ${BRANCH} 分支：\n  ${changed.join('\n  ')}`)
}
if (push) execFileSync('git', ['push', 'origin', BRANCH], { cwd: wt, stdio: 'inherit' })

manifest.release = { version: manifest.version, bundle: { url: `${REPO_RAW}/${BRANCH}/${rel}`, sha256 }, ...(initFiles.length ? { init: { files: initFiles } } : {}) }
await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
execFileSync('node', [join(root, 'scripts', 'gen-registry.mjs')], { stdio: 'inherit' })
console.log(`\n${id}@${manifest.version} sha256=${sha256}`)
console.log(push ? '下一步：提交并推送 main 上的 leo-plugin.json 与 registry.json' : `下一步：git -C ${wt} push origin ${BRANCH}，再提交并推送 main 上的改动`)
