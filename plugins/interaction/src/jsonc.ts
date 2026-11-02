/**
 * JSONC 读写（复制自 leo-plugin-provider：插件之间不互相 import，各自打成单文件）。
 * 写回时只改动涉及的字段，保留注释与原有排版。
 */
/** 去掉 JSONC 的注释与尾随逗号（字符串内容保持不变） */
export function stripJsonc(text: string): string {
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
  // 尾随逗号
  let out = ''
  for (let i = 0, inStr = false; i < src.length; i++) {
    const ch = src[i]!
    if (inStr) {
      out += ch
      if (ch === '\\') out += src[++i] ?? ''
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
      out += ch
      continue
    }
    if (ch === ',') {
      let j = i + 1
      while (j < src.length && /\s/.test(src[j]!)) j++
      if (src[j] === '}' || src[j] === ']') continue
    }
    out += ch
  }
  return out
}


export type Json = string | number | boolean | null | Json[] | { [k: string]: Json }

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

