# leo-plugin-provider-longcat

模型供应商注册层（[leo-plugin-provider](../provider)）的 **LongCat（美团）子插件**，注册驱动 `longcat`。

```bash
leo plugin add provider
leo plugin add provider-longcat
leo auth set longcat         # 或 export LONGCAT_API_KEY=...（在 https://longcat.chat/platform/api_keys 创建）
leo models longcat           # 实时列出 LongCat 的模型
```

不用写配置：装好并保存密钥就自动接入。模型写 `longcat/<model>`，例如：

```bash
leo -m longcat/LongCat-2.5-Preview
```

同时装了别的子插件（如 provider-deepseek）时，想默认用 LongCat，在 `.leo/config.json` 写 `"model": "longcat/LongCat-2.5-Preview"`。

## 模型

端点 `https://api.longcat.chat/openai/v1`（OpenAI Chat Completions 兼容）。模型列表从 [`GET /models`](https://longcat.chat/platform/docs/zh/api/models) 实时获取，上限与价格用内置信息补全；没密钥、离线或获取失败时用内置信息。2026-10-31 官方的模型：

| 模型 | 上下文 / 最大输出 | 输入 | 思考 |
| --- | --- | --- | --- |
| `LongCat-2.5-Preview`（默认） | 1048576 / 262144 | 文本 | 默认开启，可关闭 |

价格按[官方限时折扣价](https://longcat.chat/platform/docs/zh/pricing/longcat-2.5)（美元 / 百万 token：输入 0.30、缓存命中 0.006、输出 1.20）用于预算估算，可在 provider.json 的 `models` 里覆盖。

## 思考模式与思考预算

按 [Chat Completion 文档](https://longcat.chat/platform/docs/zh/api/chat) 与[模型参数参考](https://longcat.chat/platform/docs/zh/api/model-params)：

- **默认开启**：每个请求都明确发送 `thinking: { "type": "enabled" | "disabled" }`，思考内容（`reasoning_content`）在 leo 里以 💭 显示
- **推理强度 → 思考预算**：LongCat 的 Chat Completions 没有 `reasoning_effort`，插件把强度换算成 `thinking_budget`（只在思考开启时发送）：

| 强度 | thinking_budget |
| --- | --- |
| `none` | 关闭思考 |
| `low`（兼容 `minimal`） | 8192 |
| `medium` | 32768 |
| `high`（默认） | 131072 |
| `max`（兼容 `xhigh`） | 262144（上限，拉满） |

- 调整方式，优先级从高到低：

| 方式 | 写法 |
| --- | --- |
| 交互中 | `/think on` / `/think off`、`/effort max`（会同步写回 provider.json，下次启动沿用） |
| 命令行 | `leo --thinking off`、`leo --effort low`（只作用于本次） |
| `.leo/config.json` | `"agent": { "reasoning": { "enabled": true, "effort": "max" } }` |
| `provider.json` | `"longcat": { "thinking": "enabled", "reasoningEffort": "high" }`；要精确的预算写 `"thinkingBudget": 50000`（优先于 provider.json 的强度） |

## LongCat 特有的处理

- `temperature` 由服务端固定（思考 1.0、非思考 0.7），传了也会被覆盖，所以不发送
- 消息内容必须是纯文本字符串：带工具调用的助手消息内容从 `null` 改成空字符串
- 思考开启时，带工具调用的多轮请求回传之前的 `reasoning_content`；关闭思考时不传

## provider.json

装好后自动写入 `longcat` 条目（项目里有 `.leo/provider.json` 写项目的，否则写 `~/.leo/provider.json`），交互中 `/model`、`/think`、`/effort` 切换后同步更新：

```jsonc
{
  "providers": {
    "longcat": {
      "defaultModel": "LongCat-2.5-Preview",
      "thinking": "enabled",       // 或 "disabled"、true / false
      "reasoningEffort": "high",   // none / low / medium / high / max，换算成思考预算
      // "thinkingBudget": 50000,  // 可选，精确的思考预算（1 ~ 262144）
      "baseURL": "https://api.longcat.chat/openai/v1"  // 可选，走代理时改
    }
  }
}
```

需要 leo-agents ≥ 0.2.0、leo-plugin-provider ≥ 0.2.0；自动写入与同步需要 leo-plugin-provider ≥ 0.3.0 与 leo-agents main（2026-10-31 之后）。
