/**
 * leo-plugin-gateway-feishu：leo 消息网关（leo-plugin-gateway ≥ 0.2.0）的飞书子插件。
 *
 * 注册驱动 id `feishu`：gateway.json 里 `"channel": "feishu"` 的账号原样可用（0.1.x 的 appId / appSecret 写法也照常工作）。
 * 网关内置的 feishu 驱动仍在，两者只能有一个生效——本插件注册后顶替内置驱动，卸载后网关自动恢复内置驱动。
 *
 * 比内置驱动多了飞书「扫码一键创建应用」：账号没有 appId / appSecret 时给出二维码（leo serve 下终端直接打印），
 * 飞书扫码确认后自动创建好机器人应用（权限、长连接事件已预置），凭据存进 credentials.json 并自动连接；扫码人自动成为网关管理员。
 *
 * - 依赖服务 `gateway`（inject），网关先加载、后加载都可以；网关热重载时本插件自动重新注册
 * - 工具 `gateway_feishu_bind`（gateway.bind，副作用）：重新扫码创建 / 绑定飞书应用；聊天里的 Agent 不能调用
 * - 控制面：`POST /v1/channels/<账号>/restart {"rebind":true}` 同样触发重新绑定（网关提供）
 */
import qrcodeTerminal from 'qrcode-terminal'
import type { PluginDefinition, ToolDefinition, ToolOutput } from 'leo-agents'
import { z } from 'zod'
import type { GatewayLike } from './contract.js'
import { type AppCredentials, CredentialStore } from './credentials.js'
import { createFeishuDriver } from './feishu/driver.js'

export type * from './contract.js'
export { CredentialStore, credentialKey, escapeStored, resolveStored } from './credentials.js'
export type { AppCredentials } from './credentials.js'
export { createFeishuDriver, decryptFeishu, extractText, FeishuOptions, signFeishu, toInbound } from './feishu/driver.js'
export { FeishuRegisterError, registerFeishuApp, registrationUrl } from './feishu/register.js'

export const Config = z
  .object({
    /** 扫码凭据写到哪个文件；默认 leo 的 credentials.json（项目级已有该账号时写项目级，否则用户级 ~/.leo/credentials.json） */
    credentialsFile: z.string().optional(),
    /** 链接上的接入来源（node-sdk/<source>） */
    source: z.string().default('leo'),
    /** 扫码页预填的应用信息（用户仍可修改）；name / desc 支持 {user} 占位符（替换为扫码人名字） */
    app: z
      .object({
        name: z.string().min(1).optional(),
        desc: z.string().min(1).optional(),
        avatar: z.array(z.string().url()).min(1).max(6).optional(),
      })
      .prefault({ name: '{user}的 leo 助手' }),
    /** 扫码页只允许创建新应用（隐藏「选择已有应用」，避免覆盖已有应用的配置） */
    createOnly: z.boolean().default(false),
    /**
     * 同时在终端打印二维码。默认 `auto`：`leo serve` 下打印（可以直接扫），交互式 leo 下不打印（会打乱界面，只提示绑定链接）
     */
    qrConsole: z.union([z.boolean(), z.literal('auto')]).default('auto'),
    /** 扫码成功后把扫码人授权为网关管理员（不用配对码）；需要网关 ≥ 0.2.2 */
    authorizeScanner: z.boolean().default(true),
    /** 注册 gateway_feishu_bind 工具 */
    tools: z.boolean().default(true),
  })
  .prefault({})
export type GatewayFeishuConfig = z.infer<typeof Config>

export interface GatewayFeishuPluginOptions {
  /** 测试用：替换终端二维码输出 */
  printQr?: (url: string) => void
  /** 测试用：缩短扫码轮询间隔（毫秒） */
  pollIntervalMs?: number
}

/** 在终端打印二维码（小号字符画） */
export function printQrToConsole(url: string): void {
  qrcodeTerminal.generate(url, { small: true }, (qr) => {
    process.stdout.write(`\n${qr}\n请使用飞书扫描上方二维码，一键创建机器人应用。\n\n`)
  })
}

/** 当前进程是不是 `leo serve`：命令行里第一个非选项参数是 serve */
export function isLeoServe(argv: readonly string[] = process.argv.slice(2)): boolean {
  return argv.find((a) => !a.startsWith('-')) === 'serve'
}

/** 等价于 leo-agents 的 toolOutput()；插件不运行时依赖 leo-agents */
const output = (out: ToolOutput): ToolOutput => Object.assign(out, { [Symbol.for('leo.toolOutput')]: true })

export function createBindTool(gateway: () => GatewayLike): ToolDefinition<{ account?: string | undefined }> {
  return {
    name: 'gateway_feishu_bind',
    title: 'Re-bind Feishu bot by QR code',
    description:
      'Start (or restart) QR-code app creation for a Feishu / Lark bot account of the leo gateway: the account disconnects and a link is returned; the operator opens or scans it with Feishu, creates (or picks) an app, and the new app credentials are saved automatically. Only call it when the operator explicitly asks to (re)bind a Feishu bot. Returns the link and account state.',
    parameters: z.object({
      account: z.string().min(1).optional().describe('Gateway account id with channel "feishu"; may be omitted when there is exactly one Feishu account'),
    }),
    permissions: [{ kind: 'gateway.bind', sideEffect: true }],
    async execute({ account }) {
      const gw = gateway()
      const accounts = gw.accounts().filter((a) => a.channel === 'feishu')
      const id = account ?? (accounts.length === 1 ? accounts[0]!.account : undefined)
      if (!id) return output({ content: accounts.length ? `Several Feishu accounts, pass "account": ${accounts.map((a) => a.account).join(', ')}` : 'No Feishu account in gateway.json channels.', isError: true })
      if (!accounts.some((a) => a.account === id)) return output({ content: `"${id}" is not a Feishu account of the gateway.`, isError: true })
      try {
        const s = await gw.restartAccount(id, { rebind: true })
        if (s.state === 'waiting_bind' && s.bindUrl) return output({ content: `Ask the operator to open or scan this link with Feishu (it refreshes automatically when it expires; current link is also in gateway_status): ${s.bindUrl}`, details: s })
        return output({ content: `Account ${id} is ${s.state}${s.error ? `: ${s.error}` : ''}.`, details: s, ...(s.state === 'failed' ? { isError: true } : {}) })
      } catch (err) {
        return output({ content: `Bind failed: ${(err as Error).message}`, isError: true })
      }
    },
  }
}

export function createGatewayFeishuPlugin(opts: GatewayFeishuPluginOptions = {}): PluginDefinition<GatewayFeishuConfig> {
  return {
    name: 'leo-plugin-gateway-feishu',
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
      const bound = new Map<string, AppCredentials>()
      const notify = (message: string, level: 'info' | 'warn' | 'error' = 'info') =>
        void ctx.emit('plugin/notice' as never, { plugin: 'gateway-feishu', message, ...(level === 'info' ? {} : { level }) } as never)
      const driver = createFeishuDriver({
        store,
        source: config.source,
        app: config.app,
        createOnly: config.createOnly,
        printQr: opts.printQr ?? printQrToConsole,
        ...(opts.pollIntervalMs ? { pollIntervalMs: opts.pollIntervalMs } : {}),
        qrConsole: config.qrConsole === 'auto' ? isLeoServe() : config.qrConsole,
        authorizeScanner: config.authorizeScanner,
        bound,
        notify,
      })

      if (config.tools) {
        await ctx.effect(() => ctx.get('tools').register(createBindTool(gateway)))
        // 聊天里的 Agent（及其子 Agent）不能自己发起重新绑定
        ctx.on('tools/guard', (p) => (p.tool.name === 'gateway_feishu_bind' && gateway().sessionOfAgent?.(p.agentId) ? { deny: 'Feishu binding can only be started by the operator' } : undefined))
      }

      // 最后注册驱动：注册即（重新）启动 feishu 账号；卸载时网关恢复内置 feishu 驱动
      try {
        await ctx.effect(() => gateway().registerChannel(driver))
      } catch (err) {
        throw new Error(`gateway-feishu: ${(err as Error).message}（需要 leo-plugin-gateway ≥ 0.2.0；旧版网关请在 gateway.json 的 builtin 里去掉 "feishu"）`)
      }
    },
  }
}

const plugin = createGatewayFeishuPlugin()
export default plugin
