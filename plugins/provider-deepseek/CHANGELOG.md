# 更新日志

## 0.2.0 — 2026-10-31

对照 2026-10-31 的 DeepSeek 官方文档：

- 模型列表从 `GET /models` 实时获取：展示名（DeepSeek-V4.1-Flash / DeepSeek-V4-Pro）、上下文 1048576、最大输出 393216、输入模态、推理强度档位与默认档位；价格沿用内置
- 修正内置模型信息：上下文 1048576、最大输出 393216（之前写成 1,000,000 / 384,000），补上展示名、输入模态与思考能力
- 模型列表只展示官方模型；`deepseek-chat` / `deepseek-reasoner` / `deepseek-v4-flash` 等旧名字改为别名，请求时仍自动改写
- 思考模式默认开启，每个请求明确发送 `thinking`；推理强度支持 `none` / `low` / `high` / `max` 与兼容写法（minimal → low，medium / xhigh → high），并按模型支持的档位取最接近的一档
- 支持宿主统一的思考设置（leo-agents ≥ 0.3.0 的 `--thinking` / `--effort`、`/think` / `/effort`、`agent.reasoning`），优先于 provider.json
- 关闭思考时不再回传历史 `reasoning_content`；思考模式下 `tool_choice` 为 required / 指定工具时自动关闭思考（明确开启思考时报错）
- provider.json 的 `thinking` 也接受 true / false

## 0.1.0 — 2026-10-31

首个版本：DeepSeek 子插件，注册驱动 `deepseek`（需要 leo-plugin-provider ≥ 0.1.0）。

- 默认 `https://api.deepseek.com`、`DEEPSEEK_API_KEY`、默认模型 `deepseek-flash`；模型 `deepseek-flash` / `deepseek-v4-pro`（1M 上下文，价格按高峰时段用于预算）
- 思考模式下带工具的请求始终回传 `reasoning_content`（DeepSeek 要求，否则 400）
- provider.json 可设 `thinking`（enabled / disabled）与 `reasoningEffort`（low / high / max）
- 已下线的 `deepseek-chat` / `deepseek-reasoner` 自动改写为 `deepseek-flash` 的非思考 / 思考模式，0.1.x 配置不用改
