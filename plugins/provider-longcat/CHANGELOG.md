# 更新日志

## 0.1.0 — 未发布

首个版本：LongCat（美团）子插件，注册驱动 `longcat`（需要 leo-plugin-provider ≥ 0.2.0）。

- 默认 `https://api.longcat.chat/openai/v1`、`LONGCAT_API_KEY`、默认模型 `LongCat-2.5-Preview`（上下文 1048576、最大输出 262144，价格按官方限时折扣价）
- 模型列表从 `GET /models` 实时获取，认识模型详情格式（`context_length`、`architecture` 的输入 / 输出模态）；接口价格为人民币，不采用，沿用内置美元价
- 思考模式默认开启，每个请求明确发送 `thinking`；支持宿主统一的思考设置（`--thinking`、`/think`、`agent.reasoning`，`effort: none` 即关闭）与 provider.json 的 `thinking` / `thinkingBudget`
- 不发送服务端固定的 `temperature`；助手消息 `null` 内容改为空字符串；思考开启时回传 `reasoning_content`，关闭时去掉
