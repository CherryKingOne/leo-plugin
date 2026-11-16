# Changelog

## 0.1.0（2026-11-17）

首个版本。

- 会话日志只读投影成树：会话 → turn → step（模型、用量、重试、错误、耗时、TTFT、解码时间）→ 工具调用（参数、结果预览、错误、耗时、进度）→ 子会话；压缩与 custom 记录；累计用量
- 新旧宿主都可用：leo-agents 0.2.1 上用已有事件推算（工具开始时间由自报耗时推算，TTFT 只在运行期间现场测得）；leo-agents ≥ 0.2.2（分支 `feat/trajectory-log`）直接用 `tool/start` / `tool/end`、`firstTokenAt`、`session/meta`、`sessions.list()`
- 子会话挂树：`session/meta` → 工具结果 `details`（sub-agents 的 `sessionId`、agent-team 的 `projectId`）→ 运行时捕获（`sub-agents/started`、进度里的 `agentId`、Agent 的 label / state）→ agent-team 会话命名
- 本机网页（单文件，无外部资源）：会话列表、账本（折叠、搜索）、时间线（等待 / TTFT / 解码 / 工具）、记录详情，SSE 实时跟随；JSON API；默认 `127.0.0.1:18791`，非本机地址必须设令牌，无令牌时校验 Host
- `/trace`、`/trace open`、`/trace export [文件]`（限 `.leo/` 内）、`/trace list`
- 服务 `trajectory`（get / list / subscribe / url）；不注册工具；默认脱敏
- 启动时经 `plugin/notice` 打印网页地址；热加载时关闭服务器、释放端口
