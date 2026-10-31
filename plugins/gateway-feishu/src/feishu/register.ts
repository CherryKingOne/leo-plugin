/**
 * 飞书「一键创建智能体应用」：扫码创建（或选择已有）飞书应用并拿到 App ID / App Secret。
 * https://open.feishu.cn/document/mcp_open_tools/integrating-agents-with-feishu/overview
 *
 * 与官方 Node SDK 的 `registerApp`（@larksuiteoapi/node-sdk ≥ 1.61.1）协议一致，基于 OAuth 2.0 设备授权（RFC 8628），
 * 这里直接实现，避免把整个 SDK 打进 bundle：
 *
 * 1. POST `https://accounts.feishu.cn/oauth/v1/app/registration`（表单）
 *    `action=begin&archetype=PersonalAgent&auth_method=client_secret&request_user_info=open_id`
 *    → `{ device_code, verification_uri_complete, expires_in, interval }`
 * 2. 二维码 / 链接 = verification_uri_complete + `from=sdk&source=node-sdk/<source>&tp=sdk`（可附 name / desc / avatar / createOnly）
 * 3. 每 interval 秒 POST `action=poll&device_code=...`：
 *    - `{ client_id, client_secret, user_info: { open_id, tenant_brand } }` → 成功
 *    - `error=authorization_pending` 继续；`slow_down` 间隔 +5 秒；`access_denied` / 其他错误 → 失败；
 *      `expired_token` → 链接过期（10 分钟），本实现自动重新 begin，给出新链接
 *    - `user_info.tenant_brand=lark`（国际版租户）→ 之后改用 accounts.larksuite.com 轮询（只切换一次）
 * 4. 错误应答是 HTTP 400 + JSON，同样解析
 */

export const FEISHU_ACCOUNTS = 'https://accounts.feishu.cn'
export const LARK_ACCOUNTS = 'https://accounts.larksuite.com'
const ENDPOINT = '/oauth/v1/app/registration'

export interface RegisterResult {
  appId: string
  appSecret: string
  /** 扫码用户在新应用下的 open_id */
  openId?: string
  domain: 'feishu' | 'lark'
}

export interface RegisterOptions {
  fetch: typeof fetch
  signal: AbortSignal
  /** 来源标识，拼进链接的 source 参数（node-sdk/<source>） */
  source: string
  /** 预填应用信息；name / desc 支持 {user} 占位符 */
  app?: { name?: string; desc?: string; avatar?: string[] }
  /** 只允许创建新应用（隐藏「选择已有应用」，避免覆盖已有应用的配置） */
  createOnly?: boolean
  /** 链接就绪（以及过期后刷新）时回调 */
  onUrl(url: string, expiresInSec: number): void
  onExpired?(): void
  /** 测试用：缩短轮询间隔（毫秒） */
  intervalMs?: number
  timeoutMs?: number
}

export class FeishuRegisterError extends Error {
  override name = 'FeishuRegisterError'
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

interface RegistrationResponse {
  device_code?: string
  verification_uri_complete?: string
  expires_in?: number
  interval?: number
  client_id?: string
  client_secret?: string
  user_info?: { open_id?: string; tenant_brand?: string }
  error?: string
  error_description?: string
}

async function call(o: RegisterOptions, base: string, params: Record<string, string>): Promise<RegistrationResponse> {
  const timeout = AbortSignal.timeout(o.timeoutMs ?? 15_000)
  const res = await o.fetch(`${base}${ENDPOINT}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.any([o.signal, timeout]),
  })
  const text = await res.text()
  let data: RegistrationResponse
  try {
    data = JSON.parse(text) as RegistrationResponse
  } catch {
    throw new FeishuRegisterError('bad_response', `feishu app registration: HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  if (!res.ok && !data.error) throw new FeishuRegisterError('http_error', `feishu app registration: HTTP ${res.status}`)
  return data
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new FeishuRegisterError('abort', 'registration aborted'))
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(new FeishuRegisterError('abort', 'registration aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })

export function registrationUrl(raw: string, o: Pick<RegisterOptions, 'source' | 'app' | 'createOnly'>): string {
  const url = new URL(raw)
  url.searchParams.set('from', 'sdk')
  url.searchParams.set('source', o.source ? `node-sdk/${o.source}` : 'node-sdk')
  url.searchParams.set('tp', 'sdk')
  for (const a of o.app?.avatar ?? []) url.searchParams.append('avatar', a)
  if (o.app?.name) url.searchParams.set('name', o.app.name)
  if (o.app?.desc) url.searchParams.set('desc', o.app.desc)
  if (o.createOnly) url.searchParams.set('createOnly', 'true')
  return url.toString()
}

/** 扫码创建飞书应用，直到成功、用户拒绝或 signal abort；链接过期自动刷新 */
export async function registerFeishuApp(o: RegisterOptions): Promise<RegisterResult> {
  for (;;) {
    const begin = await call(o, FEISHU_ACCOUNTS, { action: 'begin', archetype: 'PersonalAgent', auth_method: 'client_secret', request_user_info: 'open_id' })
    if (!begin.device_code || !begin.verification_uri_complete)
      throw new FeishuRegisterError(begin.error ?? 'bad_response', `feishu app registration: ${begin.error_description ?? begin.error ?? 'no device_code in response'}`)
    const expiresIn = begin.expires_in ?? 600
    o.onUrl(registrationUrl(begin.verification_uri_complete, o), expiresIn)
    const deadline = Date.now() + expiresIn * 1000
    let interval = o.intervalMs ?? (begin.interval ?? 5) * 1000
    let base = FEISHU_ACCOUNTS
    let domain: 'feishu' | 'lark' = 'feishu'
    let expired = false
    while (!expired) {
      if (Date.now() >= deadline) {
        expired = true
        break
      }
      const r = await call(o, base, { action: 'poll', device_code: begin.device_code })
      if (r.user_info?.tenant_brand === 'lark' && domain !== 'lark') {
        domain = 'lark'
        base = LARK_ACCOUNTS
        continue
      }
      if (r.client_id && r.client_secret) return { appId: r.client_id, appSecret: r.client_secret, ...(r.user_info?.open_id ? { openId: r.user_info.open_id } : {}), domain }
      switch (r.error) {
        case undefined:
        case 'authorization_pending':
          break
        case 'slow_down':
          interval += 5000
          break
        case 'expired_token':
          expired = true
          continue
        default:
          throw new FeishuRegisterError(r.error, r.error === 'access_denied' ? '用户拒绝了授权' : `${r.error}${r.error_description ? `: ${r.error_description}` : ''}`)
      }
      await sleep(interval, o.signal)
    }
    o.onExpired?.()
  }
}
