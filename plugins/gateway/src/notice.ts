/**
 * 给用户看的启动/状态提示：通过宿主的 `plugin/notice` 事件发出，`leo serve` 和交互式 `leo` 会直接打印一行。
 * 旧版宿主没有这个事件时没人订阅，等于什么都不做（日志里仍有 logger.info）。
 */
import type { Context } from 'leo-agents'
import { networkInterfaces } from 'node:os'
import type { AccountStatus } from './types.js'

export type NoticeLevel = 'info' | 'warn' | 'error'
export type Notify = (message: string, level?: NoticeLevel) => void

export function createNotify(ctx: Context<any>): Notify & { mute(): void } {
  let muted = false
  const notify = (message: string, level: NoticeLevel = 'info') =>
    void (muted ||
    ctx.emit('plugin/notice' as never, { plugin: 'gateway', message, ...(level === 'info' ? {} : { level }) } as never))
  // 卸载时停掉提示：注销驱动会让账号回到 waiting_driver，那不是给用户看的
  return Object.assign(notify, { mute: () => void (muted = true) })
}

const WILDCARD = new Set(['0.0.0.0', '::', '0:0:0:0:0:0:0:0'])

function hostForUrl(host: string): string {
  return host.includes(':') ? `[${host}]` : host
}

/** 监听地址对应的可访问 URL：通配地址展开成本机各网卡的 IPv4 */
export function reachableBases(host: string, port: number, ifaces = networkInterfaces()): string[] {
  if (!WILDCARD.has(host)) return [`http://${hostForUrl(host)}:${port}`]
  const ips = ['127.0.0.1']
  for (const list of Object.values(ifaces)) for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) ips.push(i.address)
  return [...new Set(ips)].map((ip) => `http://${ip}:${port}`)
}

/** 展示用的主地址：通配监听时优先局域网 IP */
export function primaryBase(addr: { host: string; port: number }, ifaces = networkInterfaces()): string {
  const bases = reachableBases(addr.host, addr.port, ifaces)
  return bases.find((b) => !b.includes('127.0.0.1')) ?? bases[0]!
}

export function controlPlaneLines(addr: { host: string; port: number }, tokenSet: boolean, ifaces = networkInterfaces()): string[] {
  const bases = reachableBases(addr.host, addr.port, ifaces)
  const main = primaryBase(addr, ifaces)
  const lines = [
    WILDCARD.has(addr.host)
      ? `控制面监听 ${hostForUrl(addr.host)}:${addr.port}，可访问 ${bases.join('、')}`
      : `控制面 ${main}`,
    `  HTTP ${main}/v1 · WebSocket ${main.replace(/^http/, 'ws')}/ws · OpenAI 兼容 ${main}/v1/chat/completions`,
    tokenSet ? '  需要令牌：Authorization: Bearer <server.token>' : '  未设置令牌，只接受本机访问',
  ]
  return lines
}

/** 账号状态变化 → 一行提示；同一状态不重复提示（长轮询重连不刷屏） */
export function accountNotifier(notify: Notify, webhookBase: () => string | undefined): (s: AccountStatus) => void {
  const last = new Map<string, string>()
  return (s) => {
    const prev = last.get(s.account)
    // waiting_bind 带上 bindUrl 一起去重：二维码过期刷新后再提示一次
    const key = s.state === 'waiting_bind' ? `waiting_bind ${s.bindUrl ?? ''}` : s.state
    if (key === prev || s.state === 'starting') return
    last.set(s.account, key)
    const name = s.account === s.channel ? s.account : `${s.account}（${s.channel}）`
    switch (s.state) {
      case 'running': {
        const base = webhookBase()
        const hook = s.webhookPath ? `，webhook ${base ? `${base}${s.webhookPath}` : s.webhookPath}（平台要能从公网访问到）` : ''
        notify(`${prev === 'failed' ? '已恢复' : '已连接'} ${name}${hook}`)
        break
      }
      case 'failed':
        notify(`${name} 连接失败：${s.error ?? '未知错误'}`, 'error')
        break
      case 'waiting_driver':
        notify(`${name} 等待渠道驱动 "${s.channel}"：内置只有 telegram / feishu / qq，其他渠道需要安装对应插件`, 'warn')
        break
      case 'waiting_bind':
        notify(`${name} 等待绑定${s.detail ? `：${s.detail}` : ''}${s.bindUrl ? ` ${s.bindUrl}` : ''}`, 'warn')
        break
      case 'disabled':
        notify(`${name} 已停用（enabled=false）`)
        break
      // stopped：卸载/重启时会出现，不提示
    }
  }
}
