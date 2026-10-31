/**
 * 把配置写回 provider.json，保留注释与原有排版（只改动涉及的字段）：
 *
 * - 安装即填充：子插件注册驱动时，如果 provider.json 里该厂商没有条目或是 `{}`，写入驱动的 `settingsTemplate`
 *   （默认模型、思考模式、推理强度等），不动用户写过的条目
 * - 切换即同步：交互中 /model、/think、/effort（宿主 `llm/selected` 事件）后，写回顶层 `model` 与该厂商的
 *   `defaultModel` / `thinking` / `reasoningEffort`，下次启动沿用
 *
 * 写到哪：项目里有 `.leo/provider.json` 就写它，否则写 `~/.leo/provider.json`（不存在时新建）。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { CONFIG_FILE_NAME, stripJsonc } from './files.js'

type Json = string | number | boolean | null | Json[] | { [k: string]: Json }

interface ValueNode {
  start: number
  end: number
}
interface Member {
  key: string
  value: Node
}
interface ObjectNode extends ValueNode {
  type: 'object'
  members: Member[]
}
type Node = ObjectNode | (ValueNode & { type: 'value' })

/** 带位置的 JSONC 解析（只为定位对象成员；值本身不解释） */
export function parseJsoncTree(text: string): Node {
  let i = 0
  const skip = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i]!)) i++
      if (text[i] === '/' && text[i + 1] === '/') {
        while (i < text.length && text[i] !== '\n') i++
      } else if (text[i] === '/' && text[i + 1] === '*') {
        const e = text.indexOf('*/', i + 2)
        i = e < 0 ? text.length : e + 2
      } else return
    }
  }
  const str = (): string => {
    const start = i++
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
    i++
    return JSON.parse(text.slice(start, i)) as string
  }
  const value = (): Node => {
    skip()
    const start = i
    const ch = text[i]
    if (ch === '{') {
      i++
      const members: Member[] = []
      for (;;) {
        skip()
        if (text[i] === '}') {
          i++
          return { type: 'object', start, end: i, members }
        }
        if (text[i] === ',') {
          i++
          continue
        }
        if (text[i] !== '"') throw new Error(`provider.json: unexpected "${text[i] ?? 'EOF'}" at ${i}`)
        const key = str()
        skip()
        if (text[i] !== ':') throw new Error(`provider.json: expected ":" at ${i}`)
        i++
        members.push({ key, value: value() })
      }
    }
    if (ch === '[') {
      i++
      for (;;) {
        skip()
        if (text[i] === ']') {
          i++
          return { type: 'value', start, end: i }
        }
        if (text[i] === ',') {
          i++
          continue
        }
        if (i >= text.length) throw new Error('provider.json: unterminated array')
        value()
      }
    }
    if (ch === '"') {
      str()
      return { type: 'value', start, end: i }
    }
    while (i < text.length && /[^\s,\]}/]/.test(text[i]!)) i++
    if (i === start) throw new Error(`provider.json: unexpected "${ch ?? 'EOF'}" at ${i}`)
    return { type: 'value', start, end: i }
  }
  const root = value()
  if (root.type !== 'object') throw new Error('provider.json must contain a JSON object')
  return root
}

const lineIndent = (text: string, pos: number) => {
  const ls = text.lastIndexOf('\n', pos - 1) + 1
  return /^[ \t]*/.exec(text.slice(ls))![0]
}

/** 对象成员的缩进：有成员就照第一个成员，否则在对象所在行的缩进上加两格 */
const childIndent = (text: string, obj: ObjectNode) =>
  obj.members.length ? lineIndent(text, obj.members[0]!.value.start) : `${lineIndent(text, obj.start)}  `

const format = (v: Json, indent: string) => JSON.stringify(v, null, 2).replace(/\n/g, `\n${indent}`)

const splice = (text: string, start: number, end: number, insert: string) => text.slice(0, start) + insert + text.slice(end)

const findObject = (root: ObjectNode, path: string[]): ObjectNode | undefined => {
  let cur: Node | undefined = root
  for (const k of path) {
    if (cur?.type !== 'object') return undefined
    cur = cur.members.find((m) => m.key === k)?.value
  }
  return cur?.type === 'object' ? cur : undefined
}

/** 设置 path 指向的成员（path 的父对象必须已存在）；返回新文本 */
export function setJsonc(text: string, path: string[], value: Json): string {
  const root = parseJsoncTree(text) as ObjectNode
  const parent = findObject(root, path.slice(0, -1))
  if (!parent) throw new Error(`provider.json: "${path.slice(0, -1).join('.')}" is not an object`)
  const key = path.at(-1)!
  const indent = childIndent(text, parent)
  const existing = parent.members.find((m) => m.key === key)
  if (existing) return splice(text, existing.value.start, existing.value.end, format(value, lineIndent(text, existing.value.start)))
  const member = `${JSON.stringify(key)}: ${format(value, indent)}`
  if (!parent.members.length) {
    // 空对象（可能只有注释）：紧跟 { 插入；单行的 {} 展开成多行
    const inner = text.slice(parent.start + 1, parent.end - 1)
    if (!inner.includes('\n')) return splice(text, parent.start, parent.end, `{\n${indent}${member}\n${lineIndent(text, parent.start)}}`)
    return splice(text, parent.start + 1, parent.start + 1, `\n${indent}${member}`)
  }
  const last = parent.members.at(-1)!
  // 已有尾随逗号就接在逗号后面
  const after = last.value.end
  let j = after
  while (j < parent.end && /\s/.test(text[j]!)) j++
  if (text[j] === ',') return splice(text, j + 1, j + 1, `\n${indent}${member}`)
  return splice(text, after, after, `,\n${indent}${member}`)
}

/** 读当前值（解释成 JSON）；路径不存在返回 undefined */
export function getJsonc(text: string, path: string[]): unknown {
  const root = parseJsoncTree(text) as ObjectNode
  const parent = findObject(root, path.slice(0, -1))
  const m = parent?.members.find((x) => x.key === path.at(-1))
  if (!m) return undefined
  return JSON.parse(stripJsonc(text.slice(m.value.start, m.value.end)))
}

export interface PersistPaths {
  userDir: string
  projectDir?: string
}

/** 写回的文件：项目里有 provider.json 就写它，否则写用户级 */
export function targetFile(paths: PersistPaths): string {
  const project = paths.projectDir ? join(paths.projectDir, CONFIG_FILE_NAME) : undefined
  return project && existsSync(project) ? project : join(paths.userDir, CONFIG_FILE_NAME)
}

const EMPTY_FILE = '{\n  "providers": {}\n}\n'

/** 同一文件的写入串行执行（多个子插件同时注册时不会互相覆盖） */
const queues = new Map<string, Promise<unknown>>()
function update(file: string, edit: (text: string) => string): Promise<boolean> {
  const run = (queues.get(file) ?? Promise.resolve()).then(() => doUpdate(file, edit))
  const tail = run.catch(() => undefined)
  queues.set(file, tail)
  void tail.then(() => queues.get(file) === tail && queues.delete(file))
  return run
}

async function doUpdate(file: string, edit: (text: string) => string): Promise<boolean> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    text = EMPTY_FILE
  }
  if (!text.trim()) text = EMPTY_FILE
  const next = edit(text)
  if (next === text) return false
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, next)
  await rename(tmp, file)
  return true
}

const ensureEntry = (text: string, id: string): string => {
  const root = parseJsoncTree(text) as ObjectNode
  if (!findObject(root, ['providers'])) text = setJsonc(text, ['providers'], {})
  if (!findObject(parseJsoncTree(text) as ObjectNode, ['providers', id])) text = setJsonc(text, ['providers', id], {})
  return text
}

/**
 * 安装即填充：条目不存在或为 `{}` 时写入 template；用户写过字段的条目不动。
 * 只在文件已存在时写（还没有 provider.json 时不主动新建）。返回是否写了
 */
export async function scaffoldEntry(paths: PersistPaths, id: string, template: Record<string, Json>): Promise<boolean> {
  const file = targetFile(paths)
  if (!existsSync(file) || !Object.keys(template).length) return false
  return update(file, (text) => {
    const entry = findObject(parseJsoncTree(text) as ObjectNode, ['providers', id])
    if (entry && entry.members.length) return text
    let out = ensureEntry(text, id)
    for (const [k, v] of Object.entries(template)) out = setJsonc(out, ['providers', id, k], v)
    return out
  })
}

export interface SelectionWrite {
  /** `<provider>/<model>` */
  model: string
  /** 写入该厂商条目的字段（值为 undefined 的跳过） */
  fields: Record<string, Json | undefined>
  /** 是否写顶层 model */
  topModel: boolean
}

/** 切换即同步：写顶层 model 与该厂商条目的字段。返回是否写了 */
export async function persistSelection(paths: PersistPaths, w: SelectionWrite): Promise<boolean> {
  const i = w.model.indexOf('/')
  if (i <= 0) return false
  const id = w.model.slice(0, i)
  return update(targetFile(paths), (text) => {
    let out = text
    if (w.topModel) out = setJsonc(out, ['model'], w.model)
    const fields = Object.entries(w.fields).filter((e): e is [string, Json] => e[1] !== undefined)
    if (fields.length) {
      out = ensureEntry(out, id)
      for (const [k, v] of fields) out = setJsonc(out, ['providers', id, k], v)
    }
    return out
  })
}
