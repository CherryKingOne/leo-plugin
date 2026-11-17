/**
 * 展示前脱敏：把像密钥的字符串遮住。只影响网页与 /context，**不修改会话日志**。
 * 规则偏保守（宁可多遮）：
 *   - 字段名像密钥（password / secret / token / api_key / authorization / cookie / credential / private_key）→ 值整体遮住
 *   - 文本里的常见密钥格式：sk-… / ghp_… / github_pat_… / xox?-… / AKIA… / AIza… / Bearer … / JWT / PEM 私钥 / URL 里的 user:pass@
 *   - `key=value`、`"apiKey": "…"` 形式的赋值
 */

const SENSITIVE_KEY = /pass(word|wd)?|secret|token|api[-_]?key|access[-_]?key|authorization|cookie|credential|private[-_]?key|session[-_]?key/i

const PATTERNS: [RegExp, string | ((m: string, ...g: string[]) => string)][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  [/\b(sk|rk|pk)-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{16,}/g, (m) => mask(m)],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, (m) => mask(m)],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, (m) => mask(m)],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, (m) => mask(m)],
  [/\bAKIA[0-9A-Z]{16}\b/g, (m) => mask(m)],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, (m) => mask(m)],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, (m) => mask(m)],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, (_m, scheme) => `${scheme} ***`],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, (_m, head) => `${head}***@`],
  [
    /((?:["']?)[A-Za-z0-9_-]*(?:pass(?:word|wd)?|secret|token|api[-_]?key|access[-_]?key|authorization|credential|private[-_]?key)[A-Za-z0-9_-]*["']?\s*[:=]\s*["']?)([^\s"',;}&]{4,})/gi,
    (_m, head) => `${head}***`,
  ],
]

function mask(s: string): string {
  return s.length <= 8 ? '***' : `${s.slice(0, 4)}***`
}

export function redactText(s: string): string {
  let out = s
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep as never)
  return out
}

/** 深度脱敏（返回新对象）；字段名敏感时整体遮住 */
export function redactValue(v: unknown, depth = 0): unknown {
  if (depth > 20) return '[…]'
  if (typeof v === 'string') return redactText(v)
  if (Array.isArray(v)) return v.map((x) => redactValue(x, depth + 1))
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) {
      out[k] = SENSITIVE_KEY.test(k) && x !== null && x !== undefined && x !== '' ? '***' : redactValue(x, depth + 1)
    }
    return out
  }
  return v
}

/** 截断到 max 个字符，标出被截掉的长度 */
export function clip(s: string, max: number): string {
  if (max <= 0 || s.length <= max) return s
  return `${s.slice(0, max)}…[+${s.length - max} chars]`
}

export interface PreviewOptions {
  redact: boolean
  maxPreviewChars: number
}

/** 任意值 → 展示用文本（JSON、脱敏、截断） */
export function preview(v: unknown, o: PreviewOptions): string {
  let s: string
  if (typeof v === 'string') s = o.redact ? redactText(v) : v
  else {
    const val = o.redact ? redactValue(v) : v
    try {
      s = JSON.stringify(val, null, 2) ?? String(val)
    } catch {
      s = String(val)
    }
  }
  return clip(s, o.maxPreviewChars)
}
