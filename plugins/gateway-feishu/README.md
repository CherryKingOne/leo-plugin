# leo-plugin-gateway-feishu

> 实验性 0.2.3 · 需要 [leo-plugin-gateway](../gateway/) ≥ 0.2.0（扫码人自动成为管理员需要 ≥ 0.2.2）

## 用途

leo 消息网关的 **飞书子插件**：把飞书 / Lark 机器人作为渠道驱动注册进网关，并支持飞书官方的**扫码一键创建智能体应用**——不用进开发者后台建应用、勾权限、配事件订阅，启动后用飞书扫一下二维码、确认创建，就能直接和机器人聊天。

- 驱动 id 仍是 `feishu`：`gateway.json` 里 `"channel": "feishu"` 的账号原样可用，0.1.x 的 `appId` / `appSecret` 写法照常工作。
- 代码移植自网关内置飞书驱动：单聊、群 @；长连接（默认，无需公网）或 webhook（验签、解密）。
- 扫码创建的应用由飞书预置了机器人能力、收发消息权限和长连接事件订阅（`im.message.receive_v1` 等），见[飞书文档](https://open.feishu.cn/document/mcp_open_tools/integrating-agents-with-feishu/overview)。
- **扫码人自动成为网关管理员**，私聊机器人不需要配对码；其他人仍按 `gateway.json` 的授权规则（默认拒绝、管理员、配对）。
- 授权、会话、路由、审批、控制面仍由网关负责。

## 安装

```bash
leo plugin add gateway            # 网关（0.2.3 起模板默认声明 feishu 账号）
leo plugin add gateway-feishu     # 本插件
leo serve
```

终端会直接打印二维码（交互式 `leo` 下只打印链接）：

```text
[gateway] feishu 等待绑定：用飞书扫码，一键创建机器人应用 https://open.feishu.cn/page/launcher?user_code=XXXX-XXXX&from=sdk&...
[gateway] feishu：扫码创建应用成功（App ID cli_xxx），凭据已保存到 ~/.leo/credentials.json
[gateway] feishu：已授权扫码人为管理员（feishu:ou_xxx），可以直接私聊机器人
[gateway] 已连接 feishu
```

- 链接 10 分钟有效、只能一个人用；过期自动换新链接。
- 扫码页可以“新建应用”或“选择已有应用”（选已有应用会给它补上所需配置）；只想新建可设 `createOnly: true`。
- Lark 国际版租户自动识别，OpenAPI 改走 `open.larksuite.com`。
- 凭据存进 leo 的 `credentials.json`：`gateway/<账号>/appId`、`gateway/<账号>/appSecret`（国际版另有 `gateway/<账号>/domain`），权限 600。再次启动直接连接，不会重复扫码。

## 飞书两个版本二选一

网关自带的内置 `feishu` 驱动仍然保留，两者只能有一个生效：

- **装了本插件**：自动顶替内置驱动，卸载后网关自动恢复内置驱动。
- 网关 0.2.3 的模板默认 `"builtin": ["telegram"]`，飞书交给本插件；用旧版 `appId` / `appSecret` 又不装本插件时，在 `builtin` 里加上 `"feishu"`。

## gateway.json 账号写法

```jsonc
"channels": {
  // 扫码创建（默认）
  "feishu": { "channel": "feishu" },

  // 0.1.x 写法：已有自建应用
  "feishu-old": { "channel": "feishu", "appId": "cli_xxx", "appSecret": "$FEISHU_APP_SECRET", "domain": "feishu" }
}
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `appId` / `appSecret` | 无 | 已有应用的凭据（支持 `$ENV` / `!command`）；不填时扫码 |
| `bind` | `"qr"` | 没有凭据时：`qr` 扫码创建，`off` 直接报错（与内置驱动一致） |
| `mode` | `"websocket"` | `websocket` 长连接 / `webhook` HTTP 回调 |
| `verificationToken` / `encryptKey` | 无 | webhook 模式用，同内置驱动 |
| `domain` | 自动 | `feishu` / `lark`；不填时按扫码结果，默认 `feishu` |

## 插件选项

`.leo/config.json` 的 `plugins` 里，均可省略：

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `qrConsole` | `"auto"` | 在终端打印二维码：`leo serve` 下打印、交互式 `leo` 下只给链接；也可写 `true` / `false` |
| `app` | `{ "name": "{user}的 leo 助手" }` | 扫码页预填的应用名称 / 描述 / 头像（`name`、`desc`、`avatar` 1–6 个 URL），`{user}` 替换为扫码人名字；用户仍可修改 |
| `createOnly` | `false` | 扫码页只允许新建应用 |
| `authorizeScanner` | `true` | 扫码人自动成为网关管理员 |
| `source` | `"leo"` | 链接上的接入来源 |
| `credentialsFile` | leo 的 `credentials.json` | 扫码凭据写到哪个文件 |
| `tools` | `true` | 注册 `gateway_feishu_bind` 工具 |

## 重新扫码

- 工具 `gateway_feishu_bind`（`gateway.bind`，副作用；聊天里的 Agent 不能调用）；
- 或控制面：`curl -s localhost:18790/v1/channels/feishu/restart -d '{"rebind":true}'`；
- 或 `leo plugin remove gateway-feishu --purge`（同时删除 `credentials.json` 里的 `gateway/feishu/*`，需要支持 purge 凭据的 leo-agents），再装一次。

## 实现说明

扫码创建应用用的是飞书 OAuth 2.0 设备授权接口（与官方 Node SDK `registerApp` 相同协议：`POST https://accounts.feishu.cn/oauth/v1/app/registration`，`begin` / `poll`），本插件直接实现，没有引入整个飞书 SDK；终端二维码用 `qrcode-terminal`。
