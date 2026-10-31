# Changelog

## 0.1.0

- `--init` 配置文件模板：示例子 Agent `agents/explorer.md`（`leo plugin add sub-agents --init`）（模板随 0.1.0 补充发布，bundle 未变）

首个发布版本（`leo plugin add sub-agents`）。

- `task` 工具、`subAgents` 服务、`sub-agents/started` / `sub-agents/finished` 事件
- 子 Agent 工具集强制限制在父 Agent 工具集之内（预检 + 守卫）
- 嵌套深度、全局并发、步数、超时、输出长度上限；父 turn 取消时级联取消
- 支持自定义子 Agent 配置（提示词、模型、工具、步数）与工具名
- 支持用 `~/.leo/agents/*.md` 与 `.leo/agents/*.md` 定义子 Agent（配置 `loadAgentFiles`）
- 进度使用 leo-agents 的 `ToolProgress` 格式，CLI 可显示子 Agent 正在调用的工具
- 子 Agent 设置 `label: sub-agent:<名字>`，CLI 审批提示显示来源
- 提供单文件 bundle，可通过 `leo plugin add sub-agents` 安装，或复制到 `.leo/plugins/` 使用
