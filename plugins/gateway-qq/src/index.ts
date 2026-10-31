/**
 * leo-plugin-gateway-qq：leo 消息网关（leo-plugin-gateway ≥ 0.2.0）的 QQ 子插件。
 *
 * 注册驱动 id `qq`：gateway.json 里 `"channel": "qq"` 的账号原样可用。网关内置的 qq 驱动（0.1.x 那份）仍在，
 * 两者只能有一个生效——本插件注册后顶替内置驱动，卸载后网关自动恢复内置驱动；也可以在 gateway.json 的
 * `builtin` 里去掉 `"qq"`，只用本插件。
 *
 * 比内置驱动多了手机 QQ 扫码绑定：账号没有 appId / appSecret 时显示二维码链接，扫码后凭据存进 credentials.json 并自动连接。
 *
 * - 依赖服务 `gateway`（inject），网关先加载、后加载都可以；网关热重载时本插件自动重新注册
 * - 工具 `gateway_qq_bind`（gateway.bind，副作用）：重新扫码绑定某个 QQ 账号；聊天里的 Agent 不能调用
 * - 控制面：`POST /v1/channels/<账号>/restart {"rebind":true}` 同样触发重新绑定（网关提供）
 */
import * as qqbotConnector from '@tencent-connect/qqbot-connector'
import type { PluginDefinition, ToolDefinition, ToolOutput } from 'leo-agents'
import { z } from 'zod'
import type { GatewayLike } from './contract.js'
import { CredentialStore, type QqCredentials } from './credentials.js'
import type { QrConnector } from './qq/bind.js'
import { createQqDriver } from './qq/driver.js'

export type * from './contract.js'
export { CredentialStore, credentialKey, escapeStored, resolveStored } from './credentials.js'
export type { QqCredentials } from './credentials.js'
export { qrBind, QrBindError, type QrConnector } from './qq/bind.js'
export { createQqDriver, QqOptions, qqKeys, signQq, toInbound } from './qq/driver.js'

export const Config = z
  .object({
    /** 扫码凭据写到哪个文件；默认 leo 的 credentials.json（项目级已有该账号时写项目级，否则用户级 ~/.leo/credentials.json） */
    credentialsFile: z.string().optional(),
    /** 二维码页面显示的接入来源 */
    source: z.string().default('leo'),
    /**
     * 同时在终端打印二维码。默认 `auto`：`leo serve` 下打印（可以直接扫），交互式 leo 下不打印（会打乱界面，只提示绑定链接）
     */
    qrConsole: z.union([z.boolean(), z.literal('auto')]).default('auto'),
    /** 注册 gateway_qq_bind 工具 */
    tools: z.boolean().default(true),
  })
  .prefault({})
export type GatewayQqConfig = z.infer<typeof Config>

export interface GatewayQqPluginOptions {
  /** 测试用：替换扫码 SDK */
  connector?: QrConnector
}

/** 当前进程是不是 `leo serve`：命令行里第一个非选项参数是 serve */
export function isLeoServe(argv: readonly string[] = process.argv.slice(2)): boolean {
  return argv.find((a) => !a.startsWith('-')) === 'serve'
}

/** 等价于 leo-agents 的 toolOutput()；插件不运行时依赖 leo-agents */
const output = (out: ToolOutput): ToolOutput => Object.assign(out, { [Symbol.for('leo.toolOutput')]: true })

export function createBindTool(gateway: () => GatewayLike): ToolDefinition<{ account?: string | undefined }> {
  return {
    name: 'gateway_qq_bind',
    title: 'Re-bind QQ bot by QR code',
    description:
      'Start (or restart) QR-code binding for a QQ bot account of the leo gateway: the account disconnects and a QR link is returned; the operator scans it with mobile QQ and the new bot credentials are saved automatically. Only call it when the operator explicitly asks to (re)bind a QQ bot. Returns the QR link and account state.',
    parameters: z.object({
      account: z.string().min(1).optional().describe('Gateway account id with channel "qq"; may be omitted when there is exactly one QQ account'),
    }),
    permissions: [{ kind: 'gateway.bind', sideEffect: true }],
    async execute({ account }) {
      const gw = gateway()
      const qqAccounts = gw.accounts().filter((a) => a.channel === 'qq')
      const id = account ?? (qqAccounts.length === 1 ? qqAccounts[0]!.account : undefined)
      if (!id) return output({ content: qqAccounts.length ? `Several QQ accounts, pass "account": ${qqAccounts.map((a) => a.account).join(', ')}` : 'No QQ account in gateway.json channels.', isError: true })
      if (!qqAccounts.some((a) => a.account === id)) return output({ content: `"${id}" is not a QQ account of the gateway.`, isError: true })
      try {
        const s = await gw.restartAccount(id, { rebind: true })
        if (s.state === 'waiting_bind' && s.bindUrl) return output({ content: `Ask the operator to scan this link with mobile QQ (it refreshes automatically when it expires; current link is also in gateway_status): ${s.bindUrl}`, details: s })
        return output({ content: `Account ${id} is ${s.state}${s.error ? `: ${s.error}` : ''}.`, details: s, ...(s.state === 'failed' ? { isError: true } : {}) })
      } catch (err) {
        return output({ content: `Bind failed: ${(err as Error).message}`, isError: true })
      }
    },
  }
}

export function createGatewayQqPlugin(opts: GatewayQqPluginOptions = {}): PluginDefinition<GatewayQqConfig> {
  return {
    name: 'leo-plugin-gateway-qq',
    inject: ['gateway', 'tools'],
    config: Config,
    async apply(ctx, config) {
      const gateway = () => ctx.get('gateway' as never) as unknown as GatewayLike
      const paths = ctx.maybe('leoPaths')
      const store = CredentialStore.from({
        ...(config.credentialsFile ? { file: config.credentialsFile } : {}),
        ...(paths?.projectCredentials ? { projectCredentials: paths.projectCredentials } : {}),
        ...(paths?.userCredentials ? { userCredentials: paths.userCredentials } : {}),
      })
      const bound = new Map<string, QqCredentials>()
      const notify = (message: string, level: 'info' | 'warn' | 'error' = 'info') =>
        void ctx.emit('plugin/notice' as never, { plugin: 'gateway-qq', message, ...(level === 'info' ? {} : { level }) } as never)
      const driver = createQqDriver({
        store,
        connector: opts.connector ?? (qqbotConnector as QrConnector),
        source: config.source,
        qrConsole: config.qrConsole === 'auto' ? isLeoServe() : config.qrConsole,
        bound,
        notify,
      })

      if (config.tools) {
        await ctx.effect(() => ctx.get('tools').register(createBindTool(gateway)))
        // 聊天里的 Agent（及其子 Agent）不能自己发起重新绑定
        ctx.on('tools/guard', (p) => (p.tool.name === 'gateway_qq_bind' && gateway().sessionOfAgent?.(p.agentId) ? { deny: 'QQ binding can only be started by the operator' } : undefined))
      }

      // 最后注册驱动：注册即（重新）启动 qq 账号；卸载时网关恢复内置 qq 驱动
      try {
        await ctx.effect(() => gateway().registerChannel(driver))
      } catch (err) {
        throw new Error(`gateway-qq: ${(err as Error).message}（需要 leo-plugin-gateway ≥ 0.2.0；旧版网关请在 gateway.json 的 builtin 里去掉 "qq"）`)
      }
    },
  }
}

const plugin = createGatewayQqPlugin()
export default plugin
