/** MCP 工具定义 / 结果 与 leo 工具协议之间的转换 */
import { createHash } from 'node:crypto'
import type { ContentBlock, JsonSchemaObject } from 'leo-agents'
import type { CallToolResult, McpContent } from './client.js'

const NAME_MAX = 64

/** `<prefix>__<server>__<tool>`，只含 [a-zA-Z0-9_-]，以字母开头，最长 64；过长时截断并加短哈希保证唯一 */
export function toolName(prefix: string, server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_')
  let name = [prefix, clean(server), clean(tool)].filter(Boolean).join('__')
  if (!/^[a-zA-Z]/.test(name)) name = `m_${name}`
  if (name.length > NAME_MAX) {
    const hash = createHash('sha256').update(`${server}\0${tool}`).digest('hex').slice(0, 8)
    name = `${name.slice(0, NAME_MAX - 9)}_${hash}`
  }
  return name
}

/** 规范化 inputSchema：保证顶层是 object；去掉部分模型厂商不接受的 $schema */
export function toParameters(schema: Record<string, unknown>): JsonSchemaObject {
  const { $schema: _ignored, ...rest } = schema
  const out: JsonSchemaObject = { ...rest, type: 'object' }
  if (!out.properties || typeof out.properties !== 'object') out.properties = {}
  return out
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const half = Math.floor(max / 2)
  return `${text.slice(0, half)}\n\n…[${text.length - max} characters omitted]…\n\n${text.slice(-half)}`
}

function block(c: McpContent): ContentBlock {
  switch (c.type) {
    case 'text':
      return { type: 'text', text: c.text ?? '' }
    case 'image':
      return c.data ? { type: 'image', url: `data:${c.mimeType ?? 'image/png'};base64,${c.data}`, ...(c.mimeType ? { mimeType: c.mimeType } : {}) } : { type: 'text', text: '[image]' }
    case 'audio':
      return { type: 'text', text: `[audio${c.mimeType ? ` ${c.mimeType}` : ''}, ${c.data ? Math.round((c.data.length * 3) / 4) : 0} bytes, not shown]` }
    case 'resource_link':
      return { type: 'text', text: `[resource] ${c.name ? `${c.name} ` : ''}${c.uri ?? ''}${c.mimeType ? ` (${c.mimeType})` : ''}` }
    case 'resource': {
      const r = c.resource
      if (!r) return { type: 'text', text: '[resource]' }
      if (typeof r.text === 'string') return { type: 'text', text: `[resource ${r.uri}]\n${r.text}` }
      if (r.blob && r.mimeType?.startsWith('image/')) return { type: 'image', url: `data:${r.mimeType};base64,${r.blob}`, mimeType: r.mimeType }
      return { type: 'text', text: `[resource ${r.uri}${r.mimeType ? ` (${r.mimeType})` : ''}, binary, not shown]` }
    }
    default:
      return { type: 'text', text: JSON.stringify(c) }
  }
}

/** 转为发给模型的内容；文本总长受 maxChars 限制 */
export function toContent(res: CallToolResult, maxChars: number): ContentBlock[] {
  let blocks = res.content.map(block)
  if (!blocks.length && res.structuredContent !== undefined) blocks = [{ type: 'text', text: JSON.stringify(res.structuredContent, null, 2) }]
  if (!blocks.length) blocks = [{ type: 'text', text: res.isError ? 'Tool failed without a message.' : '(no output)' }]
  // 合并相邻文本，统一截断
  const merged: ContentBlock[] = []
  for (const b of blocks) {
    const last = merged[merged.length - 1]
    if (b.type === 'text' && last?.type === 'text') last.text += `\n${b.text}`
    else merged.push(b.type === 'text' ? { ...b } : b)
  }
  let budget = maxChars
  for (const b of merged) {
    if (b.type !== 'text') continue
    b.text = clip(b.text, Math.max(200, budget))
    budget = Math.max(0, budget - b.text.length)
  }
  return merged
}
