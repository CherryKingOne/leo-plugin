# 更新日志

## 0.1.0 — 2026-10-31

首个版本：模型供应商注册层。需要 leo-agents ≥ 0.2.0（底座不再内置模型厂商）。

- 服务 `providers`：子插件注册驱动（`registerDriver`）与协议（`registerProtocol`），注册层统一读配置、取密钥、注册到 `llm` 服务、选默认模型；驱动注册 / 撤销、热重载都会整体重新同步
- 内置协议 `openai-compatible`（从 leo-agents 0.1.x 的 OpenAICompatibleProvider 迁移）：任意兼容端点写 `baseURL` 即可；驱动可用 `prepare` 加厂商参数
- 配置 `~/.leo/provider.json` / `.leo/provider.json`（JSONC，热加载）；`.leo/config.json` 里 0.1.x 写法的 `providers` / `model` 照常生效
- `autoDetect`：装了子插件就接入，有密钥即可用，没密钥列为不可用并提示 `leo auth set <id>`；`credentials.json` 变化自动重新探测
- 同一驱动多个账号（`"deepseek-work": { "driver": "deepseek" }`）
- `leo models` / `leo doctor` 显示每个 provider 的状态、密钥来源、由哪个子插件提供；`leo serve` 打印接入结果
- 错误带 `Symbol.for('leo.error')` 标记与 code，宿主按 code 决定重试（401 不重试，429 按 Retry-After 重试）
