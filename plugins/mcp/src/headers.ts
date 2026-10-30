/**
 * MCP 2026-07-28 的 `x-mcp-header`：服务器可以在工具 inputSchema 中标注某些参数，
 * 要求客户端在 Streamable HTTP 请求中把参数值镜像到 `Mcp-Param-{Name}` 头。
 * 客户端必须支持；标注不合法的工具必须从工具列表中排除。
 */
import { encodeHeaderValue } from './transports/http.js'

export interface HeaderParam {
  /** 头名后缀：Mcp-Param-{name} */
  name: string
  /** 从参数根开始的 properties 键路径 */
  path: string[]
  type: 'string' | 'integer' | 'boolean'
}

const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const SKIP_KEYS = new Set(['properties', 'x-mcp-header', 'type', 'description', 'title', 'default', 'examples', 'enum', 'const'])

/** 解析 inputSchema 中的 x-mcp-header；不合法时抛出说明原因的错误 */
export function extractHeaderParams(schema: unknown): HeaderParam[] {
  const out: HeaderParam[] = []
  const seen = new Set<string>()

  const visit = (node: unknown, path: string[], viaProps: boolean) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const n of node) visit(n, path, false)
      return
    }
    const obj = node as Record<string, unknown>
    if ('x-mcp-header' in obj) {
      const name = obj['x-mcp-header']
      const where = path.length ? path.join('.') : '(root)'
      if (!viaProps || path.length === 0) throw new Error(`x-mcp-header at ${where} is not statically reachable through "properties"`)
      if (typeof name !== 'string' || !name || !TOKEN_RE.test(name)) throw new Error(`x-mcp-header at ${where} is not a valid header token`)
      const key = name.toLowerCase()
      if (seen.has(key)) throw new Error(`duplicate x-mcp-header "${name}"`)
      seen.add(key)
      const type = obj.type
      if (type !== 'string' && type !== 'integer' && type !== 'boolean') throw new Error(`x-mcp-header "${name}" must annotate a string, integer or boolean parameter`)
      out.push({ name, path, type })
    }
    const props = obj.properties
    if (props && typeof props === 'object' && !Array.isArray(props)) {
      for (const [k, v] of Object.entries(props)) visit(v, [...path, k], viaProps)
    }
    // 其他任何位置（items、oneOf、$defs、if/then…）出现的标注都不合法
    for (const [k, v] of Object.entries(obj)) {
      if (SKIP_KEYS.has(k)) continue
      if (v && typeof v === 'object') visit(v, path, false)
    }
  }
  visit(schema, [], true)
  return out
}

/** 按标注从调用参数中取值，生成 Mcp-Param-* 头 */
export function headerValues(params: HeaderParam[], args: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of params) {
    let v: unknown = args
    for (const k of p.path) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined
    if (v === undefined || v === null) continue
    let s: string
    if (typeof v === 'boolean') s = v ? 'true' : 'false'
    else if (typeof v === 'number') s = Number.isInteger(v) ? String(v) : String(v)
    else s = String(v)
    out[`mcp-param-${p.name.toLowerCase()}`] = encodeHeaderValue(s)
  }
  return out
}
