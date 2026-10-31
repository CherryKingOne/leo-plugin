# 更新日志

## 0.1.0 — 2026-10-31

首个版本：DeepSeek 子插件，注册驱动 `deepseek`（需要 leo-plugin-provider ≥ 0.1.0）。

- 默认 `https://api.deepseek.com`、`DEEPSEEK_API_KEY`、默认模型 `deepseek-flash`；模型 `deepseek-flash` / `deepseek-v4-pro`（1M 上下文，价格按高峰时段用于预算）
- 思考模式下带工具的请求始终回传 `reasoning_content`（DeepSeek 要求，否则 400）
- provider.json 可设 `thinking`（enabled / disabled）与 `reasoningEffort`（low / high / max）
- 已下线的 `deepseek-chat` / `deepseek-reasoner` 自动改写为 `deepseek-flash` 的非思考 / 思考模式，0.1.x 配置不用改
