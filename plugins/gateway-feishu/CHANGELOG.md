# 更新日志

## 0.2.3 — 2026-10-31

首个版本（实验性），版本号与 leo-plugin-gateway 0.2.3 对齐。

- 飞书 / Lark 渠道驱动（id `feishu`），移植自网关内置飞书驱动：单聊、群 @；长连接（默认）或 webhook（验签、解密）。安装后顶替内置驱动，卸载后恢复。
- 飞书扫码一键创建智能体应用（OAuth 设备授权，与官方 SDK `registerApp` 同协议）：没有 `appId` / `appSecret` 时进入 `waiting_bind`，给出链接，`leo serve` 下终端直接打印二维码；链接过期自动刷新；Lark 国际版自动识别；凭据写入 `credentials.json`（权限 600）后自动连接。
- 扫码人自动成为网关管理员（需要网关 ≥ 0.2.2），私聊不需要配对码；`authorizeScanner: false` 关闭。
- 兼容 0.1.x 写法：账号里写 `appId` / `appSecret` 直接连接，不扫码；`bind: "off"` 与内置驱动行为一致。
- 重新扫码：工具 `gateway_feishu_bind`、控制面 rebind；清单声明 `purge.credentials`，`leo plugin remove gateway-feishu --purge` 一并删除扫码凭据。
