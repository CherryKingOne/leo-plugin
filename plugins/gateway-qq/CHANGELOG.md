# 更新日志

## 0.2.0 — 2026-10-31（未发布）

首个版本（实验性），版本号与 leo-plugin-gateway 0.2.0 对齐。

- QQ 官方机器人渠道驱动（id `qq`），代码移植自 leo-plugin-gateway 0.1.x 内置 QQ 驱动：单聊、群 @、频道；WebSocket 长连接（默认）或 webhook + Ed25519 签名校验。
- 安装后自动顶替网关内置的 `qq` 驱动，卸载后网关恢复内置驱动；`gateway.json` 里 `"channel": "qq"` 的账号不用改。
- 手机 QQ 扫码绑定（官方 SDK `@tencent-connect/qqbot-connector`）：账号没有 `appId` / `appSecret` 时进入 `waiting_bind`，给出二维码链接（启动提示、账号状态、`GET /v1/channels`），过期自动刷新；扫码成功后凭据写入 leo 的 `credentials.json`（`gateway/<账号>/appId`、`gateway/<账号>/appSecret`，权限 600）并自动连接；账号停止或插件卸载时取消扫码。
- 重新绑定：工具 `gateway_qq_bind`（`gateway.bind`，副作用，聊天里的 Agent 不能调用），或控制面 `POST /v1/channels/<账号>/restart {"rebind":true}`。
- `bind: "off"` 时没有凭证直接报错（与内置驱动一致）。
