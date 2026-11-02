# 更新日志

## 0.1.1 — 2026-11-02

- 默认更积极：空闲 60 分钟（原 120）后主动找，间隔 30 ~ 120 分钟（原 90 ~ 240），每天最多 10 次（原 3）。QQ 官方上限是每人每天 1000 条，可在 `speakup.json` 按需调大

## 0.1.0 — 2026-11-02

首个版本（实验性）：主动搭话。思路参考 [dsh-aurabot-qq](https://github.com/aureth-labs/dsh-aurabot-qq) 的「主动搭话」模块，改为经 leo 消息网关发送、不需要登录 QQ 小号。

- 对方一阵子没来找时，Agent 在私聊里主动找对方说几句：往原会话塞一条【系统提醒】，Agent 用自己的人设和上下文写，不想说就回 `[沉默]`；7 种由头随机换
- 追问：Agent 上一句是问句、对方 15 ~ 40 分钟没回，有一半机会轻轻追一句（每句最多一次，不占每天次数）
- 可配：目标会话（默认所有私聊；群聊需写明）、空闲时长、随机间隔、每天上限、清醒时段（可跨午夜）、时区、称呼；`speakup.json` 改完自动生效
- 回复与 Agent 发的表情图片经 `gateway.send` / `gateway.sendImage` 作为主动消息发出；发送失败记日志并提醒一次，不重试
- 每天次数等状态存在 `~/.leo/speakup.state.json`，重启不丢
- `/speakup` 查看状态，`/speakup now [会话键前缀]` 立刻找一次（需要 leo-agents ≥ 0.2.1）
- 只用网关已有接口（`sessions`、`chat`、`send`、`sendImage` 与 `gateway/message`、`gateway/turn-end`、`gateway/session-reset` 事件），不改网关和渠道驱动
