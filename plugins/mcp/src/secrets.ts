/**
 * 配置值中的密钥引用（与 leo-agents 的写法一致，但插件不能运行时依赖 leo-agents，所以在此实现）：
 *   - `"$NAME"` / `"${NAME}"`   整个值取环境变量
 *   - `"!command"`              执行命令取 stdout（对接 1Password / Keychain 等），进程内缓存
 *   - `"Bearer ${NAME}"`        字符串内插环境变量
 *   - `$$` → `$`，开头的 `$!` → `!`（转义）
 * 解析失败抛错时只报变量名 / 命令，不包含任何值。
 */
import { execSync } from 'node:child_process'

const commandCache = new Map<string, string>()

export class SecretRefError extends Error {
  override name = 'SecretRefError'
}

export function resolveValue(value: string, env: NodeJS.ProcessEnv = process.env): string {
  const v = String(value)
  if (v.startsWith('$!')) return v.slice(1)
  if (v.startsWith('!')) {
    const cmd = v.slice(1).trim()
    const cached = commandCache.get(cmd)
    if (cached !== undefined) return cached
    try {
      const out = execSync(cmd, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      commandCache.set(cmd, out)
      return out
    } catch {
      throw new SecretRefError(`command failed: ${cmd}`)
    }
  }
  const whole = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(v)
  if (whole) return lookup(whole[1]!, env)
  // 内插 ${NAME}；$$ 转义为 $
  return v.replace(/\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name: string | undefined) => (name ? lookup(name, env) : '$'))
}

function lookup(name: string, env: NodeJS.ProcessEnv): string {
  const val = env[name]
  if (val === undefined || val === '') throw new SecretRefError(`environment variable ${name} is not set`)
  return val
}

export function resolveRecord(rec: Record<string, string>, env?: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(rec)) {
    try {
      out[k] = resolveValue(v, env)
    } catch (err) {
      throw new SecretRefError(`${k}: ${(err as Error).message}`)
    }
  }
  return out
}
