/**
 * 插件不能运行时 import leo-agents（插件协议第 3 条），所以抛不出真正的 LeoError 实例。
 * 这里抛带 `Symbol.for('leo.error')` 标记的普通 Error：leo-agents（feat/provider-plugin 起）的 toLeoError 识别它，
 * 按同样的 code 决定重试（rate_limit / overloaded / timeout / network 重试，auth / invalid_request 不重试，
 * context_overflow 触发压缩）。
 */
export type ProviderErrorCode = 'rate_limit' | 'overloaded' | 'timeout' | 'network' | 'context_overflow' | 'auth' | 'invalid_request' | 'cancelled' | 'plugin_config_invalid' | 'internal'

export const LEO_ERROR_MARK = Symbol.for('leo.error')

export interface ProviderError extends Error {
  code: ProviderErrorCode
  status?: number
  retryAfterMs?: number
  details?: Record<string, unknown>
}

export function providerError(
  code: ProviderErrorCode,
  message: string,
  opts: { cause?: unknown; status?: number; retryAfterMs?: number; details?: Record<string, unknown> } = {},
): ProviderError {
  const err = new Error(message, opts.cause !== undefined ? { cause: opts.cause } : undefined) as ProviderError
  err.name = 'LeoError'
  err.code = code
  if (opts.status !== undefined) err.status = opts.status
  if (opts.retryAfterMs !== undefined) err.retryAfterMs = opts.retryAfterMs
  if (opts.details !== undefined) err.details = opts.details
  Object.defineProperty(err, LEO_ERROR_MARK, { value: true })
  return err
}

export function isProviderError(err: unknown): err is ProviderError {
  return err instanceof Error && (err as unknown as Record<symbol, unknown>)[LEO_ERROR_MARK] === true
}

export function isAbortError(err: unknown): boolean {
  return (
    (err instanceof Error && (err.name === 'AbortError' || (err as { code?: string }).code === 'ABORT_ERR')) ||
    (isProviderError(err) && err.code === 'cancelled')
  )
}
