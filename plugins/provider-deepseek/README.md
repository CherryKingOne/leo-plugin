# leo-plugin-provider-deepseek

模型供应商注册层（[leo-plugin-provider](../provider)）的 **DeepSeek 子插件**，注册驱动 `deepseek`。

```bash
leo plugin add provider
leo plugin add provider-deepseek
leo auth set deepseek        # 或 export DEEPSEEK_API_KEY=sk-...
leo models                   # ● deepseek  DeepSeek  默认模型 deepseek-flash
```

不用写配置：装好并保存密钥就自动接入。模型写 `deepseek/<model>`：

| 模型 | 说明 |
| --- | --- |
| `deepseek-flash`（默认） | DeepSeek-V4.1-Flash，1M 上下文，支持视觉 |
| `deepseek-v4-pro` | DeepSeek-V4-Pro，1M 上下文 |

模型信息里的价格按高峰时段（美元 / 百万 token）用于预算估算，偏保守；以 [DeepSeek 官方价格页](https://api-docs.deepseek.com/quick_start/pricing) 为准，可在 provider.json 的 `models` 里覆盖。

## DeepSeek 特有的处理

- **思考模式 + 工具调用**：DeepSeek 默认开启思考；带工具的请求必须回传之前每一轮的 `reasoning_content`，否则返回 400。本驱动始终回传（不带工具时 DeepSeek 会忽略）。
- **旧模型名**：`deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 下线，自动改写为 `deepseek-flash` 的非思考 / 思考模式，0.1.x 的 `"model": "deepseek/deepseek-chat"` 不用改。`"legacyModels": false` 关闭改写。

## 配置（provider.json，可选）

```jsonc
{
  "providers": {
    "deepseek": {
      "thinking": "enabled",        // enabled / disabled，不写由 DeepSeek 决定（默认开启）
      "reasoningEffort": "high",    // low / high / max
      "baseURL": "https://api.deepseek.com"   // 默认值；走代理时改这里
    },
    // 第二个账号：密钥用 leo auth set deepseek-work
    "deepseek-work": { "driver": "deepseek" }
  }
}
```

单次请求也可以用 Agent 的 `providerOptions` 覆盖（例如 `{ "reasoning_effort": "max" }`），它最后合并。
