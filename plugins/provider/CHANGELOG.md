# 更新日志

## 0.3.1 — 2026-10-31

- 认识顶层 `{ code, message }` 形式的业务错误（讯飞星火等）：HTTP 错误体里读出原文与错误码；流里出现非 0 的 `code` 时报错（不再静默结束）
- 驱动新增 `errorCodes`：厂商错误码 → 错误类别（invalid_request / auth / rate_limit / overloaded / context_overflow），决定宿主是否重试
- 上下文超限识别补充中文提示（“序列过长”等）

## 0.3.0 — 2026-10-31

provider.json 跟着用的东西走：

- **安装即填充**：子插件注册驱动时，provider.json 里该厂商没有条目或是 `{}`，自动写入驱动给的默认值（默认模型、思考模式、推理强度）；用户写过字段的条目不动。驱动新增 `settingsTemplate`
- **切换即同步**：交互中 `/model` 写回顶层 `model` 与该厂商的 `defaultModel`；`/think on|off`、`/effort` 写回 `thinking` / `reasoningEffort`（只写驱动模板里有的字段），下次启动沿用。命令行 `-m`、`--effort` 只作用于本次
- 写到哪：项目里有 `.leo/provider.json` 就写它，否则写 `~/.leo/provider.json`；只改动涉及的字段，注释与排版保留；多个子插件同时注册时写入串行
- 自己写的不触发热加载（宿主 `plugin/data-written`，leo-agents 0.2.0（main））；插件配置 `persist: false` 关闭写回
- provider.json 的 `thinking` / `reasoningEffort` 反映到模型信息的默认值，状态行、`leo models` 显示的“默认”与实际请求一致
- 模板不再预置 `"deepseek": {}`，改为由已安装的子插件写入

## 0.2.0 — 2026-10-31

- 实时模型列表：`refreshModels()` 调用 `GET {baseURL}/models`，解析真实模型 id 与常见详情字段（展示名、上下文、最大输出、输入 / 输出模态、`effort` 档位、owned_by），内置信息里接口不给的字段（价格）沿用；第一次调用模型时后台获取一次。leo-agents 0.2.0（main） 的 `leo models` / `/models` 用它展示
- 新配置项 `fetchModels`（默认 true）；驱动新增 `fetchModels`、`mapModel`（解析厂商扩展字段）；`prepare` 多拿到该模型的元信息 `model`
- 宿主统一的 `request.reasoning` 交给驱动翻译；通用端点只在明确指定强度时发送 `reasoning_effort`
- 模型配置可写 `name`、`inputModalities`、`outputModalities`、`reasoning`；别名（`alias`）不出现在模型列表里

## 0.1.0 — 2026-10-31

首个版本：模型供应商注册层。需要 leo-agents ≥ 0.2.0（底座不再内置模型厂商）。

- 服务 `providers`：子插件注册驱动（`registerDriver`）与协议（`registerProtocol`），注册层统一读配置、取密钥、注册到 `llm` 服务、选默认模型；驱动注册 / 撤销、热重载都会整体重新同步
- 内置协议 `openai-compatible`（从 leo-agents 0.1.x 的 OpenAICompatibleProvider 迁移）：任意兼容端点写 `baseURL` 即可；驱动可用 `prepare` 加厂商参数
- 配置 `~/.leo/provider.json` / `.leo/provider.json`（JSONC，热加载）；`.leo/config.json` 里 0.1.x 写法的 `providers` / `model` 照常生效
- `autoDetect`：装了子插件就接入，有密钥即可用，没密钥列为不可用并提示 `leo auth set <id>`；`credentials.json` 变化自动重新探测
- 同一驱动多个账号（`"deepseek-work": { "driver": "deepseek" }`）
- `leo models` / `leo doctor` 显示每个 provider 的状态、密钥来源、由哪个子插件提供；`leo serve` 打印接入结果
- 错误带 `Symbol.for('leo.error')` 标记与 code，宿主按 code 决定重试（401 不重试，429 按 Retry-After 重试）
