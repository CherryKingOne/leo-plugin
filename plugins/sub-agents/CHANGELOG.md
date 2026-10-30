# Changelog

## 0.1.0

- 首个实现：`task` 工具、`subAgents` 服务、`sub-agents/started` / `sub-agents/finished` 事件
- 子 Agent 工具集强制限制在父 Agent 工具集之内（预检 + 守卫）
- 嵌套深度、全局并发、步数、超时、输出长度上限；父 turn 取消时级联取消
- 支持自定义子 Agent 配置（提示词、模型、工具、步数）与工具名
- 提供单文件 bundle，可复制到 `.leo/plugins/` 使用
