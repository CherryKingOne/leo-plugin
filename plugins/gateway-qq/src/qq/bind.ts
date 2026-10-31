/**
 * 手机 QQ 扫码绑定：官方 SDK `@tencent-connect/qqbot-connector` 的 startQrConnect（https://bot.q.qq.com/wiki/agent-qqbot/）。
 *
 * - onQrDisplayed(url)：二维码链接就绪 → 账号进入 waiting_bind，链接出现在账号状态、`GET /v1/channels` 与启动提示里；
 * - onQrExpired()：二维码过期，SDK 自动刷新并再次 onQrDisplayed（新链接再提示一次）；
 * - onSuccess(creds[])：扫码完成，返回 [{ appId, appSecret, userOpenid }]（目前只会有一个，按数组处理；userOpenid 是扫码者的 openid）；
 * - onFailure(err)：失败或被取消。
 * 账号停止 / 插件卸载时 init.signal abort → 调用 SDK 返回的 stop() 并立即结束等待。
 */
import type { ChannelInit } from '../contract.js'
import type { QqCredentials } from '../credentials.js'

/** SDK 中本插件用到的接口（测试时替换） */
export interface QrConnector {
  startQrConnect(
    callbacks: {
      onSuccess: (credentials: { appId: string; appSecret: string; userOpenid?: string }[]) => void
      onFailure: (error: Error) => void
      onQrDisplayed?: (url: string) => void
      onQrExpired?: () => void
    },
    options?: { displayQrCodeToConsole?: boolean; signal?: AbortSignal; source?: string },
  ): () => void
}

export class QrBindError extends Error {
  override name = 'QrBindError'
}

export function qrBind(
  init: Pick<ChannelInit<unknown>, 'account' | 'signal' | 'logger' | 'report'>,
  connector: QrConnector,
  opts: { source: string; qrConsole: boolean; say(message: string, level?: 'info' | 'warn' | 'error'): void },
): Promise<QqCredentials & { userOpenid?: string }> {
  return new Promise<QqCredentials & { userOpenid?: string }>((resolve, reject) => {
    if (init.signal.aborted) return reject(new QrBindError('qq: QR binding cancelled'))
    let settled = false
    let stop: (() => void) | undefined
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      init.signal.removeEventListener('abort', onAbort)
      fn()
    }
    const onAbort = () =>
      finish(() => {
        stop?.()
        reject(new QrBindError('qq: QR binding cancelled'))
      })
    init.signal.addEventListener('abort', onAbort, { once: true })

    init.logger.info({ account: init.account }, 'qq: no credentials, starting QR binding')
    stop = connector.startQrConnect(
      {
        onQrDisplayed(url) {
          if (settled) return
          init.logger.info({ account: init.account }, 'qq: QR code ready')
          if (init.report) init.report({ state: 'waiting_bind', bindUrl: url, detail: '用手机 QQ 扫码绑定 QQ 机器人' })
          else opts.say(`等待扫码绑定：用手机 QQ 扫描 ${url}`, 'warn')
        },
        onQrExpired() {
          init.logger.info({ account: init.account }, 'qq: QR code expired, refreshing')
        },
        onSuccess(list) {
          finish(() => {
            const valid = (Array.isArray(list) ? list : []).filter((c) => c && typeof c.appId === 'string' && c.appId && typeof c.appSecret === 'string' && c.appSecret)
            if (!valid.length) return reject(new QrBindError('qq: QR binding returned no credentials'))
            if (valid.length > 1) init.logger.warn({ account: init.account, count: valid.length }, 'qq: QR binding returned several bots, using the first one')
            const c = valid[0]!
            resolve({ appId: String(c.appId), appSecret: String(c.appSecret), ...(typeof c.userOpenid === 'string' && c.userOpenid ? { userOpenid: c.userOpenid } : {}) })
          })
        },
        onFailure(err) {
          finish(() => reject(new QrBindError(`qq: QR binding failed: ${err?.message ?? String(err)}`)))
        },
      },
      { displayQrCodeToConsole: opts.qrConsole, source: opts.source, signal: init.signal },
    )
  })
}
