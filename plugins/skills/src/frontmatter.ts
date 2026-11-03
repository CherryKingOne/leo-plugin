/**
 * SKILL.md 的 YAML frontmatter（只解析技能用得到的子集，不引入 YAML 依赖）：
 *   - 顶层 `key: value`，值可以是普通字符串、'单引号' / "双引号" 字符串、true / false、数字
 *   - 块标量 `|`、`>`（以及 `|-`、`>-` 等）
 *   - 普通字符串跨行续写（缩进的下一行）
 *   - 列表、嵌套对象（如 `metadata:`、`allowed-tools:`）原样跳过，值记为 undefined
 */

export interface ParsedSkillFile {
  /** 解析出的顶层字段 */
  data: Record<string, unknown>
  /** 去掉 frontmatter 后的正文 */
  body: string
  /** 文件有没有 frontmatter */
  hasFrontmatter: boolean
}

export function splitFrontmatter(text: string): { yaml?: string; body: string } {
  const src = text.replace(/^\uFEFF/, '')
  const lines = src.split(/\r?\n/)
  if (!/^---[ \t]*$/.test(lines[0] ?? '')) return { body: src }
  for (let i = 1; i < lines.length; i++) {
    if (/^---[ \t]*$/.test(lines[i]!)) {
      return { yaml: lines.slice(1, i).join('\n'), body: lines.slice(i + 1).join('\n') }
    }
  }
  return { body: src }
}

function unquote(raw: string): string {
  const v = raw.trim()
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v) as string
    } catch {
      return v.slice(1, -1)
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'")
  return v
}

/** 去掉行尾注释（不在引号里的 ` #`） */
function stripComment(v: string): string {
  if (v.startsWith('"') || v.startsWith("'")) return v
  const i = v.search(/\s#/)
  return i >= 0 ? v.slice(0, i) : v
}

function scalar(raw: string): unknown {
  const v = stripComment(raw).trim()
  if (v === '') return ''
  if (v === 'true' || v === 'True' || v === 'TRUE') return true
  if (v === 'false' || v === 'False' || v === 'FALSE') return false
  if (v === 'null' || v === '~') return null
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
  if (v.startsWith('[') || v.startsWith('{')) return undefined
  return unquote(v)
}

export function parseYamlSubset(yaml: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const lines = yaml.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    if (/^\s/.test(line)) continue // 属于上一个键（已处理或跳过）
    const m = /^([A-Za-z0-9_.-]+)\s*:(.*)$/.exec(line)
    if (!m) continue
    const key = m[1]!
    const rest = m[2]!.trim()
    // 收集后续缩进行
    const cont: string[] = []
    let j = i + 1
    while (j < lines.length && (lines[j]!.trim() === '' || /^\s/.test(lines[j]!))) cont.push(lines[j++]!)
    while (cont.length && cont.at(-1)!.trim() === '') cont.pop()
    i = j - 1
    const block = /^([|>])([+-]?)\s*(#.*)?$/.exec(rest)
    if (block) {
      const indent = Math.min(...cont.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length))
      const body = cont.map((l) => (l.trim() ? l.slice(Number.isFinite(indent) ? indent : 0) : ''))
      let text: string
      if (block[1] === '|') text = body.join('\n')
      else {
        // 折叠：相邻非空行用空格连接，空行变成换行
        text = ''
        for (const l of body) {
          if (!l) text += '\n'
          else text += text && !text.endsWith('\n') ? ` ${l}` : l
        }
      }
      out[key] = block[2] === '+' ? `${text}\n` : block[2] === '-' ? text.replace(/\n+$/, '') : text.replace(/\n*$/, '\n').replace(/^\n$/, '')
      continue
    }
    if (rest === '') {
      // 列表或嵌套对象：不解释
      out[key] = cont.some((l) => l.trim()) ? undefined : ''
      continue
    }
    if (cont.some((l) => l.trim()) && !rest.startsWith('"') && !rest.startsWith("'")) {
      // 普通字符串跨行
      out[key] = scalar([rest, ...cont.map((l) => l.trim()).filter(Boolean)].join(' '))
      continue
    }
    if ((rest.startsWith('"') || rest.startsWith("'")) && cont.length) {
      out[key] = unquote([rest, ...cont.map((l) => l.trim())].join(' '))
      continue
    }
    out[key] = scalar(rest)
  }
  return out
}

export function parseSkillFile(text: string): ParsedSkillFile {
  const { yaml, body } = splitFrontmatter(text)
  if (yaml === undefined) return { data: {}, body, hasFrontmatter: false }
  return { data: parseYamlSubset(yaml), body, hasFrontmatter: true }
}
