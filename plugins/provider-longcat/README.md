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

## 思考模式

按 [Chat Completion 文档](https://longcat.chat/platform/docs/zh/api/chat) 与[模型参数参考](https://longcat.chat/platform/docs/zh/api/model-params)：

- **默认开启**：每个请求都明确发送 `thinking: { "type": "enabled" | "disabled" }`，思考内容（`reasoning_content`）在 leo 里以 💭 显示
- **没有推理强度档位**：Chat Completions 不支持 `reasoning_effort`。`--effort none` / `/effort none` 等同关闭思考，其他档位不生效；要限制思考长度用 provider.json 的 `thinkingBudget`（发送为 `thinking_budget`，最大 262144）
- 调整方式，优先级从高到低：

| 方式 | 写法 |
| --- | --- |
| 交互中 | `/think on` / `/think off`（保留当前会话） |
| 命令行 | `leo --thinking off` |
| `.leo/config.json` | `"agent": { "reasoning": { "enabled": false } }` |
| `provider.json` | `"longcat": { "thinking": "disabled", "thinkingBudget": 8192 }`（只作用于 LongCat） |

## LongCat 特有的处理

- `temperature` 由服务端固定（思考 1.0、非思考 0.7），传了也会被覆盖，所以不发送
- 消息内容必须是纯文本字符串：带工具调用的助手消息内容从 `null` 改成空字符串
- 思考开启时，带工具调用的多轮请求回传之前的 `reasoning_content`；关闭思考时不传

## provider.json

```jsonc
{
  "providers": {
    "longcat": {
      "thinking": "enabled",       // 或 "disabled"、true / false；不写默认开启
      "thinkingBudget": 8192,      // 可选，思考预算
      "baseURL": "https://api.longcat.chat/openai/v1"  // 可选，走代理时改
    }
  }
}
```

需要 leo-agents ≥ 0.2.0、leo-plugin-provider ≥ 0.2.0。
