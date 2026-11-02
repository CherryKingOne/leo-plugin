# leo-plugin-speakup

**主动搭话**：对方一阵子没来找时，Agent 在私聊里主动找对方说几句；Agent 问了话对方没回，会轻轻追一句。

思路来自 [dsh-aurabot-qq](https://github.com/aureth-labs/dsh-aurabot-qq) 的「主动搭话」模块。不同的是：它要登录一个 QQ 小号（OneBot），本插件只用 leo 消息网关已有的接口发主动消息，QQ / 飞书 / Telegram 都能用，**不改网关和渠道驱动**。

```bash
leo plugin add gateway gateway-qq     # 消息网关（≥ 0.3.0）和渠道
leo plugin add speakup                # 本插件；生成 ~/.leo/speakup.json
leo plugin add interaction interaction-persona-whale interaction-stickers-whale   # 可选：人设与表情
leo serve
```

对方先给机器人发一条消息（会话才存在），之后就会按配置主动找他。

## 怎么工作

每分钟检查一次每个目标会话：

| 情况 | 条件 | 做什么 |
| --- | --- | --- |
| 追问 | Agent 上一句是问句，对方 `nudgeMinMinutes` ~ `nudgeMaxMinutes` 分钟没回 | 一半概率轻轻追一句（「人呢」「睡着啦？」）；每句最多追一次，不占每天次数 |
| 主动找 | 在清醒时段内，双方超过 `idleMinutes` 没来往，今天次数没满，到了随机的下次时间 | 找对方说点什么 |

「说什么」交给 Agent：插件往原会话塞一条消息

> 【系统提醒，不是小王发的消息】你已经 2 个多小时没和小王聊天了，想主动找小王说点什么。这次的由头可以是：问问对方现在在干嘛……实在不想说就只回 [沉默]。

Agent 用自己的人设、记忆和这段对话的上下文来写。回 `[沉默]` 就不发。回复（和 Agent 用 `send_sticker` 发的表情图片）经网关作为**主动消息**发到平台。

这条提醒会留在会话历史里，Agent 下次能看到自己是主动找来的。

## 配置 `speakup.json`

`~/.leo/speakup.json`（项目里的 `.leo/speakup.json` 覆盖它），改完自动生效：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `targets` | `[]` | 找谁：会话键或前缀。空 = 所有私聊；`"qq"` = 所有 QQ 私聊；`"qq:main:direct:<openid>"` = 某个人。群聊必须写出含 `:group:` 的完整前缀 |
| `idleMinutes` | `60` | 双方多久没来往才主动找 |
| `minIntervalMinutes` / `maxIntervalMinutes` | `30` / `120` | 两次主动搭话之间的随机间隔 |
| `maxPerDay` | `10` | 每个会话每天最多几次；`0` = 只追问。QQ 官方上限是每人每天 1000 条，按需调大 |
| `awakeFrom` / `awakeTo` | `9` / `23` | 清醒时段（点），可以跨午夜（`22` ~ `2`）；相等 = 全天 |
| `timezone` | 模板里是 `"Asia/Shanghai"` | 时段与「每天」按哪个时区算；空 = 系统时区 |
| `nudge` | `true` | 是否追问 |
| `nudgeMinMinutes` / `nudgeMaxMinutes` | `15` / `40` | 追问窗口 |
| `name` | `""` | 提示词里怎么称呼对方；空 = 平台昵称，没有就叫「对方」 |

会话键可以用 `/speakup` 查看。每天次数等状态存在 `~/.leo/speakup.state.json`。

## 命令（leo-agents ≥ 0.2.1）

- `/speakup`：状态（目标会话、今天次数、下次时间）
- `/speakup now [会话键前缀]`：立刻让 Agent 找一次（不看时段、空闲与次数）

在 QQ / 飞书里，网关会把这些命令转发过来。

## 平台限制

主动消息受平台规则约束，发送失败时插件记日志并提醒一次，不会重试刷屏。

- **QQ 官方机器人**：按[官方文档](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)，单聊主动消息每个好友每天最多 1000 条、每分钟 20 条；对方在机器人资料卡关掉「允许主动发送」后会发送失败。群聊需要群主打开「机器人主动在群聊内发言」。
- **飞书 / Telegram**：机器人可以给已经和它聊过的人发消息。

## 服务

`ctx.get('speakup')` 返回 `SpeakUp` 实例：`targets()`、`tick()`、`fire(session)`、`state`。
