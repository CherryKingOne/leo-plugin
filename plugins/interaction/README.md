# leo-plugin-interaction

leo 的**互动层**：让 Agent 有人设、会发表情包。和网关、模型供应商一样分两层：

| 层 | 插件 | 作用 |
| --- | --- | --- |
| 注册层 | `interaction`（本插件） | 提供服务 `interaction`；注入人设提示词；注册 `send_sticker` 工具与 `/persona`、`/sticker`、`/stickers` 命令 |
| 子插件 | [interaction-persona-whale](../interaction-persona-whale/) | 人设：鲸鱼娘·大肥鱼 |
| 子插件 | [interaction-stickers-whale](../interaction-stickers-whale/) | 表情包：鲸鱼娘表情 24 张 × 蓝 / 黑两套角色 |

```bash
leo plugin add interaction
leo plugin add interaction-persona-whale
leo plugin add interaction-stickers-whale
leo
```

## Agent 自动发表情

装了表情包子插件后，注册层把可用表情（id、文案、适合的语境）写进系统提示词，并注册 `send_sticker` 工具。**模型按对话语境自己决定发不发、发哪张**：打招呼、测试通过、找到根因、被问了怪问题……不需要用户要求。

- 每轮最多 `maxPerTurn` 张（默认 1），超出会被拒绝
- 工具结果里给模型的只是一句“已发送表情「测试通过！」”；给用户看的表情在结果的 `display` 里（终端字符画、图片地址），**不进模型上下文**
- 交互式 `leo` 在支持颜色的终端里直接画出表情；不支持颜色时显示 `🐋 [表情] 测试通过！`

## 人设

人设子插件注册后，当前人设的提示词作为 agent 层片段注入，排在宿主系统提示词之后，身份与语气以人设为准，工作准则与工具规则不变。提示词里的 `{{model}}`、`{{cwd}}`、`{{date}}` 每次请求时替换。

- `persona: "auto"`（默认）：用第一个安装的人设——装上人设子插件即生效
- `persona: "<id>"`：指定人设；`"off"`：不用人设

## 命令（需要 leo-agents ≥ 0.2.1）

| 命令 | 作用 |
| --- | --- |
| `/persona` | 查看已安装的人设与当前人设 |
| `/persona <id> \| off \| auto` | 切换人设，写回 `interaction.json`，新消息起生效 |
| `/stickers` | 列出你能发的表情（Agent 专属彩蛋不列出） |
| `/sticker <id> [角色]` | 你发一个表情；默认还会把它作为一条消息发给 Agent，让它接话（`userPrompt`） |

## 配置 `interaction.json`

安装时生成在 `~/.leo/interaction.json`（项目里的 `.leo/interaction.json` 覆盖它，`.leo/config.json` 的插件选项优先级最高）。修改后自动热加载。

```jsonc
{
  "persona": "auto",          // 人设 id / "auto" / "off"
  "stickers": {
    "enabled": true,          // 是否让 Agent 自动发表情
    "variant": "",            // 默认角色，如 "blue" / "black"；空 = 表情包默认
    "hidden": true,           // 是否允许 Agent 发专属彩蛋
    "maxPerTurn": 1,          // 每轮最多几张；0 = 关闭
    "display": "art",         // art = 终端字符画 + 图片；image = 只给图片；off = 只有文字
    "userPrompt": true        // /sticker 后是否让 Agent 接话
  }
}
```

## 兼容性

| leo-agents | 效果 |
| --- | --- |
| ≥ 0.2.1（`feat/commands-display` 分支） | 完整：Agent 自动发表情并在终端画出来，`/persona`、`/sticker`、`/stickers` 可用 |
| 0.2.0 | 人设与 Agent 自动发表情照常工作；终端只显示一行文字，没有斜杠命令 |

聊天平台：配合 [gateway](../gateway/) ≥ 0.3.0，Agent 发的表情以图片发到 Telegram / QQ / 飞书（QQ、飞书子插件需要 ≥ 0.3.0）；聊天里用 `/sticker` 等命令还需要 leo-agents ≥ 0.2.1。

## 写一个子插件

子插件 `inject: ['interaction']`，在 `apply` 里注册（卸载时自动撤销）。子插件之间不互相 import，把 [src/types.ts](src/types.ts) 里用到的类型抄一份即可。

```ts
export default {
  name: 'leo-plugin-interaction-persona-cat',
  inject: ['interaction'],
  async apply(ctx) {
    const reg = ctx.get('interaction')
    await ctx.effect(() => reg.registerPersona({ id: 'cat', name: '猫娘', prompt: '你是一只猫娘……由 {{model}} 驱动' }))
    await ctx.effect(() =>
      reg.registerStickerPack({
        id: 'cat',
        name: '猫猫表情',
        variants: [{ id: 'default', name: '默认' }],
        stickers: [{ id: 'nya', text: '喵～', triggers: ['打招呼'], assets: { default: { image: 'https://…/nya.png', ansi: ['…'] } } }],
      }),
    )
  },
}
```

表情 `visibility: 'agent'` 表示只有 Agent 能发（彩蛋）；`assets.<角色>.ansi` 可以是函数，用到时再生成或解压。多个表情包有同名表情时，用 `<包 id>:<表情 id>` 区分。
