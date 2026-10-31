/**
 * 扫码得到的机器人凭据存放处：leo 的 credentials.json（与 `leo auth set` 同一个文件、同一种格式），
 * 键为 `gateway/<账号>/appId`、`gateway/<账号>/appSecret`——网关的 secret() 与内置 QQ 驱动本来就读这两个键，
 * 所以重启后无论用子插件还是内置驱动都能直接连上。
 *
 * 宿主的 credentials 服务只在启动时读一次文件，所以本插件每次启动账号时自己重新读文件（项目级优先于用户级，与宿主一致）。
 * 写入：项目级文件里已经有这个账号的键时写项目级，否则写用户级；整个文件读-改-写，临时文件 + rename，权限 0600。
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveValue } from './secrets.js'

export interface QqCredentials {
  appId: string
  appSecret: string
}

export const credentialKey = (account: string, field: 'appId' | 'appSecret') => `gateway/${account}/${field}`

/** 与 leo-agents resolveSecret 相同的规则：`$$x` → `$x`，`$!x` → `!x`，`!cmd` 执行命令，`$NAME` 取环境变量，其余原样 */
export function resolveStored(raw: string): string | undefined {
  const v = raw.trim()
  if (!v) return undefined
  if (v.startsWith('$$') || v.startsWith('$!')) return v.slice(1)
  if (v.startsWith('!') || /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(v)) {
    try {
      return resolveValue(v) || undefined
    } catch {
      return undefined
    }
  }
  return v
}

/** 写入时转义，避免以 `$` / `!` 开头的值被宿主当成环境变量或命令 */
export const escapeStored = (v: string) => (v.startsWith('$') || v.startsWith('!') ? `$${v}` : v)

async function readJson(file: string): Promise<Record<string, unknown>> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
  const data = JSON.parse(text) as unknown
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${file} must be a JSON object`)
  return data as Record<string, unknown>
}

const stringOf = (v: unknown): string | undefined => (typeof v === 'string' ? v : v && typeof v === 'object' && typeof (v as { apiKey?: unknown }).apiKey === 'string' ? (v as { apiKey: string }).apiKey : undefined)

export class CredentialStore {
  /**
   * @param files 按优先级从高到低：[项目级, 用户级]；只有一个时读写都用它
   */
  constructor(readonly files: readonly string[]) {}

  static from(opts: { file?: string; projectCredentials?: string; userCredentials?: string }): CredentialStore {
    if (opts.file) return new CredentialStore([opts.file])
    const files = [opts.projectCredentials, opts.userCredentials ?? join(homedir(), '.leo', 'credentials.json')].filter((f): f is string => Boolean(f))
    return new CredentialStore(files)
  }

  /** 读一个账号的凭据；文件损坏时跳过该文件（宿主自己会报错） */
  async get(account: string): Promise<Partial<QqCredentials>> {
    const out: Partial<QqCredentials> = {}
    for (const file of this.files) {
      let data: Record<string, unknown>
      try {
        data = await readJson(file)
      } catch {
        continue
      }
      for (const field of ['appId', 'appSecret'] as const) {
        if (out[field]) continue
        const raw = stringOf(data[credentialKey(account, field)])
        const v = raw === undefined ? undefined : resolveStored(raw)
        if (v) out[field] = v
      }
    }
    return out
  }

  /** 保存凭据，返回写入的文件 */
  async save(account: string, creds: QqCredentials): Promise<string> {
    let target = this.files[this.files.length - 1]!
    for (const file of this.files.slice(0, -1)) {
      const data = await readJson(file).catch(() => ({}) as Record<string, unknown>)
      if (credentialKey(account, 'appId') in data || credentialKey(account, 'appSecret') in data) {
        target = file
        break
      }
    }
    const data = await readJson(target)
    data[credentialKey(account, 'appId')] = escapeStored(creds.appId)
    data[credentialKey(account, 'appSecret')] = escapeStored(creds.appSecret)
    await mkdir(dirname(target), { recursive: true })
    const tmp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await chmod(tmp, 0o600).catch(() => {})
    await rename(tmp, target)
    await chmod(target, 0o600).catch(() => {})
    return target
  }
}
