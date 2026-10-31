# leo-plugin-provider-deepseek

模型供应商注册层（[leo-plugin-provider](../provider)）的 **DeepSeek 子插件**，注册驱动 `deepseek`。

```bash
leo plugin add provider
leo plugin add provider-deepseek
leo auth set deepseek        # 或 export DEEPSEEK_API_KEY=sk-...
leo models                   # 实时列出 DeepSeek 的真实模型及详情
```

不用写配置：装好并保存密钥就自动接入。模型写 `deepseek/<model>`。

模型列表从 DeepSeek 的 [`GET /models`](https://api-docs.deepseek.com/zh-cn/api/list-models) 实时获取（真实模型 id、展示名、上下文、最大输出、输入模态、推理强度档位），`leo models` 和交互命令 `/models` 显示，`/model <编号>` 选用；没密钥、离线或获取失败时用内置信息。2026-10-31 官方的模型：

| 模型 | 展示名 | 上下文 / 最大输出 | 输入 | 推理强度 |
| --- | --- | --- | --- | --- |
| `deepseek-flash`（默认） | DeepSeek-V4.1-Flash | 1048576 / 393216 | 文本、图片 | low / high（默认）/ max |
| `deepseek-v4-pro` | DeepSeek-V4-Pro | 1048576 / 393216 | 文本 | low / high（默认）/ max |

模型信息里的价格按高峰时段（美元 / 百万 token）用于预算估算，偏保守；以 [DeepSeek 官方价格页](https://api-docs.deepseek.com/quick_start/pricing) 为准，可在 provider.json 的 `models` 里覆盖。

## 思考模式与推理强度

按 [Chat Completions 文档](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion)：

- **思考模式默认开启**：每个请求都明确发送 `thinking: { "type": "enabled" | "disabled" }`
- **推理强度** `reasoning_effort`：`none` / `low` / `high` / `max`，默认 `high`；`none` 即关闭思考。兼容写法 `minimal` → `low`，`medium` / `xhigh` → `high`；模型不支持的档位取最接近的一档
- 调整方式（需要 leo-agents 0.2.0（main）），优先级从高到低：

| 方式 | 写法 |
| --- | --- |
| 交互中 | `/think on` / `/think off`，`/effort max`（保留当前会话） |
| 命令行 | `leo --thinking off`、`leo --effort low` |
| `.leo/config.json` | `"agent": { "reasoning": { "enabled": true, "effort": "high" } }` |
| `provider.json` | `"deepseek": { "thinking": "enabled", "reasoningEffort": "high" }`（只作用于 DeepSeek） |

## DeepSeek 特有的处理

- **思考模式 + 工具调用**：带工具的请求必须回传之前每一轮的 `reasoning_content`，否则返回 400。思考开启时始终回传，关闭时不传。
- **tool_choice**：思考模式不支持 `required` 或指定工具（400）。没有明确要求思考时，这类请求自动按非思考模式发送；明确开启了思考则直接报错提示关闭。
- **旧模型名**：`deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 下线，请求时自动改写为 `deepseek-flash` 的非思考 / 思考模式，0.1.x 的 `"model": "deepseek/deepseek-chat"` 不用改；它们只作为别名，不出现在模型列表里。`"legacyModels": false` 关闭改写。

## 配置（provider.json，可选）

```jsonc
{
  "providers": {
    "deepseek": {
      "thinking": "enabled",        // enabled / disabled（或 true / false），默认开启
      "reasoningEffort": "high",    // none / low / high / max，不写由 DeepSeek 决定（high）
      "fetchModels": true,          // 从 GET /models 实时获取模型，默认 true
      "baseURL": "https://api.deepseek.com"   // 默认值；走代理时改这里
    },
    // 第二个账号：密钥用 leo auth set deepseek-work
    "deepseek-work": { "driver": "deepseek" }
  }
}
```

单次请求也可以用 Agent 的 `providerOptions` 直接覆盖请求体（例如 `{ "reasoning_effort": "max" }`），它最后合并。
