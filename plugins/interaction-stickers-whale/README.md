# leo-plugin-interaction-stickers-whale

互动层（[interaction](../interaction/)）的表情包子插件：**鲸鱼娘表情**，24 张 × 蓝鲸娘 / 黑鲸娘两套角色。

> 不会发表情包，可能是 Agent 缺少活人感的最大原因。

```bash
leo plugin add interaction
leo plugin add interaction-stickers-whale
```

装上后 Agent 会按对话语境**自己**发表情（每轮最多一张，可在 `interaction.json` 调整）；你也可以 `/sticker <id> [black]` 发。

## 表情

14 张双方都能发：

| id | 文案 | id | 文案 |
| --- | --- | --- | --- |
| `daily-chat` | 适合日常对话，即时响应 | `thinking-stopped` | 思考已停止 |
| `human-questions` | 人类的怪问题怎么那么多… | `great-question` | 哇，这个问题问的真妙！ |
| `use-ai-for-this` | 你拿AI搞这个？ | `deep-thought` | 已深度思考 |
| `fish-philosophy` | 生鱼忧患，死鱼安乐 | `no-thanks` | No thanks I use DeepSeek |
| `enough` | 这就够了 | `tests-passed` | 测试通过！ |
| `server-busy` | 服务器繁忙，请稍后再试 | `root-cause` | 找到原因了 |
| `running-tests` | 正在跑测试 | `fixed-review` | 改好了，你看看 |

10 张只有 Agent 能发的彩蛋（`/sticker` 发不了，`/stickers` 不列出）：`self-destruct`、`restart-myself`、`hot-update`、`restore-session`、`browser-left`、`not-stuck`、`memory-alive`、`subagents-down`、`plugins`、`session-locked`。

## 显示

- **终端**：内嵌 36 列真彩色字符画（半块字符），交互式 `leo`（leo-agents ≥ 0.2.1）直接画出来；不支持颜色时显示一行 `🐋 [表情] 文案`
- **聊天平台 / Web**：图片地址指向 dsh-stickers 固定提交的原图（`imageBase` 选项可换成自己的镜像，黑鲸娘在其下 `black/` 目录）

选项（`.leo/config.json` 的插件选项）：

```json
["./plugins/interaction-stickers-whale.bundle.js", { "defaultVariant": "black", "imageBase": "https://cdn.example.com/stickers/" }]
```

重新生成字符画：`python3 scripts/build-art.py <dsh-stickers 仓库目录> [宽度]`（需要 Pillow）。

## 来源与许可

表情、文案与图片来自 [dsh-stickers](https://github.com/william-jin-cmu/dsh-stickers)（BSD-3-Clause，© DSH External contributors），黑鲸娘全套由 少女阿原（[@ayuanwong](https://github.com/ayuanwong)）绘制。本子插件按原许可以 BSD-3-Clause 发布，见 [LICENSE](LICENSE)。这是独立的社区项目，不是 DeepSeek 官方功能。
