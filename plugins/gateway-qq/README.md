# leo-plugin-gateway-qq

> 实验性 0.2.2 · 需要 [leo-plugin-gateway](../gateway/) ≥ 0.2.0

## 用途

leo 消息网关的 **QQ 子插件**：把 QQ 官方机器人（QQ 开放平台）作为渠道驱动注册进网关，并支持**手机 QQ 扫码绑定**——不用去开放平台抄 AppID / AppSecret，启动后扫一下二维码就能用。

- 驱动 id 仍是 `qq`：`gateway.json` 里 `"channel": "qq"` 的账号原样可用。
- 代码移植自网关 0.1.x 的内置 QQ 驱动：单聊、群 @、频道；WebSocket 长连接（默认，无需公网）或 webhook。
- 授权、会话、路由、审批、控制面仍由网关负责（网关是注册层，本插件只是驱动）。

## QQ 两个版本二选一

网关自带的内置 `qq` 驱动（旧版）仍然保留。两者只能有一个生效：

- **装了本插件**：本插件的驱动自动顶替内置驱动，QQ 账号改由本插件重启，启动时提示一行 `渠道 qq 改用插件提供的驱动 QQ 机器人（扫码绑定）（qq）……`。卸载本插件后网关自动恢复内置驱动。
- **建议**同时在 `gateway.json` 的 `builtin` 里去掉 `"qq"`：这样不会出现“网关先加载、内置驱动先试连一次”的情况。
- 不想用本插件：卸载即可（`leo plugin remove gateway-qq`），或者不装。

## 安装

```bash
leo plugin add gateway            # 网关（需要 0.2.0 及以上）
leo plugin add gateway-qq         # 本插件（发布后可用；未发布前用 npm / 代码方式加载，见 docs/install.md）
leo serve
```

插件选项（`.leo/config.json` 的 `plugins` 里，均可省略）：

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `qrConsole` | `"auto"` | 在终端打印二维码：`auto` 时 `leo serve` 下打印、交互式 `leo` 下不打印（会打乱界面，只提示链接）；也可写 `true` / `false` |
| `source` | `"leo"` | 二维码页面上的接入来源标识 |
| `credentialsFile` | leo 的 `credentials.json` | 扫码凭据写到哪个文件 |
| `authorizeScanner` | `true` | 扫码成功后把扫码的 QQ 号设为网关管理员，私聊不需要配对码（需要网关 ≥ 0.2.2） |
| `tools` | `true` | 注册 `gateway_qq_bind` 工具 |

```jsonc
// .leo/config.json
{ "plugins": ["leo-plugin-gateway", ["leo-plugin-gateway-qq", { "qrConsole": false }]] }
```

## 配置账号（gateway.json）

### 扫码绑定

`leo plugin add gateway`（0.2.1 起）生成的 `gateway.json` 默认就是下面这样，直接 `leo serve` 即可扫码：

```jsonc
{
  "builtin": ["telegram", "feishu"],
  "channels": {
    "qq": { "channel": "qq" }          // 不填 appId / appSecret
  },
}
```

启动后：

```text
[gateway] qq 等待绑定：用手机 QQ 扫码绑定 QQ 机器人 https://q.qq.com/qqbot/openclaw/connect.html?task_id=…&source=leo&_wv=2
```

用手机 QQ 扫码（或在手机上打开这个链接）完成绑定。二维码过期会自动刷新并再提示一次新链接；当前链接也可以在 `GET /v1/channels`（账号 `state: "waiting_bind"`、`bindUrl`）和 `gateway_status` 里看到。绑定成功后：

```text
[gateway] qq：扫码绑定成功（AppID 102xxxxx），凭据已保存到 ~/.leo/credentials.json
[gateway] qq：已授权扫码的 QQ 号为管理员（qq:<openid>），可以直接私聊机器人
[gateway] 已连接 qq
```

凭据保存在 leo 的 `credentials.json`（与 `leo auth set` 同一个文件，权限 600），键为 `gateway/<账号>/appId`、`gateway/<账号>/appSecret`；项目级 `.leo/credentials.json` 里已经有这个账号的键时写项目级，否则写用户级 `~/.leo/credentials.json`。下次启动直接连接，不再扫码；因为网关本来就读这两个键，换回内置驱动也能直接用。

### 配置凭证（与旧版相同）

```jsonc
{ "channels": { "qq": { "channel": "qq", "appId": "102xxxxx", "appSecret": "$QQ_BOT_SECRET" } } }
```

凭据优先级：本进程刚扫码得到的 > `credentials.json` 中的 `gateway/<账号>/…`（项目级 > 用户级）> 账号配置的 `appId` / `appSecret`。

### 账号字段

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `appId` / `appSecret` | — | 不填时扫码绑定；`appSecret` 写 `$ENV` / `!command` 引用 |
| `bind` | `qr` | 没有凭证时：`qr` 扫码绑定，`off` 直接报错（与内置驱动一致） |
| `mode` | `websocket` | `websocket` 长连接 / `webhook` 回调（回调地址 `<公网><server.hooksPath>/<账号>`） |
| `events` | `["c2c_group", "guild_at"]` | 长连接订阅的事件，另有 `guild_dm` |
| `sandbox` | `false` | 使用沙箱环境 |
| `requestTimeoutMs` | 15000 | |

网关的通用字段（`allowFrom`、`requireMention`、`home`、`prompt` …）照常可用。

## 重新绑定

换一个机器人、或凭据失效时：

- 让 leo 调用工具 `gateway_qq_bind`（可带 `account`；只有一个 QQ 账号时可省略），返回二维码链接；
- 或控制面：`curl -s localhost:18790/v1/channels/qq/restart -d '{"rebind":true}'`，立即返回 `{"state":"waiting_bind","bindUrl":"…"}`；
- WebSocket：`channels.restart` `{ "account": "qq", "rebind": true }`。

重新绑定会忽略已保存的凭据，扫码成功后覆盖保存。

## 提供的能力

| 类型 | 名称 | 说明 |
| --- | --- | --- |
| 渠道驱动 | `qq` | 注册到 `gateway` 服务，顶替内置 qq 驱动 |
| 工具 | `gateway_qq_bind` | 权限 `gateway.bind`（副作用，走审批）；聊天会话里的 Agent（及其子 Agent）不能调用 |
| 依赖服务 | `gateway`、`tools` | 网关先加载、后加载都可以；网关热重载时本插件自动重新注册 |

## 安全

- 凭据只写进 `credentials.json`（0600，临时文件 + rename），不出现在日志、提示、工具输出与状态里（只显示 AppID）。
- 扫码会把一个 QQ 机器人绑定到**扫码的 QQ 号**名下，并默认把这个 QQ 号授权为网关管理员（`authorizeScanner: false` 关闭）；其他人仍按 `gateway.json` 的授权规则（默认拒绝、管理员、配对）。
- 账号停止、重启、插件或网关卸载时立即取消扫码轮询。

## 兼容性与说明

- 需要 leo-plugin-gateway ≥ 0.2.0（旧版网关不支持同 id 顶替，会报“already registered”；旧版网关可从 `builtin` 去掉 `"qq"` 再用本插件，但没有 `waiting_bind` 状态，二维码链接只在提示里）。
- 没有安装网关时本插件一直等待 `gateway` 服务；leo 启动时会报 `missing services: gateway`。
- 扫码 SDK [`@tencent-connect/qqbot-connector`](https://www.npmjs.com/package/@tencent-connect/qqbot-connector) 会打包进单文件；扫码页面默认显示为“第三方机器人”。
- Node.js `>=22`。
