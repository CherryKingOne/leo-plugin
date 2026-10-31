/** 按渠道单条上限切分长文本：优先在换行处、其次在空白处断开；按 Unicode 码点计数，不切断代理对 */
export function splitText(text: string, limit: number): string[] {
  const chars = [...text]
  if (limit <= 0 || chars.length <= limit) return text ? [text] : []
  const parts: string[] = []
  let start = 0
  while (start < chars.length) {
    let end = Math.min(start + limit, chars.length)
    if (end < chars.length) {
      const window = chars.slice(start, end)
      const nl = window.lastIndexOf('\n')
      const sp = window.lastIndexOf(' ')
      const cut = nl > limit / 2 ? nl + 1 : sp > limit / 2 ? sp + 1 : -1
      if (cut > 0) end = start + cut
    }
    const part = chars.slice(start, end).join('').replace(/^\n+/, '').replace(/\s+$/, '')
    if (part) parts.push(part)
    start = end
  }
  return parts
}

/** 用于日志的预览：截断且去掉换行 */
export const preview = (s: string, n = 60) => {
  const one = s.replace(/\s+/g, ' ')
  return one.length > n ? `${one.slice(0, n)}…` : one
}
