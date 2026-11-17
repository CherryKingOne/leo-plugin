# Changelog

## 0.1.0（2026-11-17）

首个版本。设计参考 DeepSeek Harness 的 [dsh-context](https://github.com/bowenliang123/dsh-context)（Apache-2.0），代码为 leo 重新实现。

- 每次模型请求的上下文组成：System 提示词、插件注入（按来源插件拆分）、工具定义、用户消息、回答、思考、工具调用、工具结果、压缩摘要（本地近似 token，与 leo-agents 的 `estimatedTokens` 同口径）
- 当前上下文：占窗口多少、离自动压缩阈值多远、输出预留；System 片段与每个工具定义的明细
- 逐请求趋势（组成堆叠 + 模型报告的输入 token）；上下文事件：压缩、丢弃最早消息、换模型、工具增减、System 片段增减、重试、出错
- 用量、缓存命中、成本（厂商返回的 `costUsd` 优先，其次按模型价目推算）、耗时（模型 / 工具 / 其他）
- 工具、文件活动、命令执行、技能加载；子会话
- 上下文浏览器：任意一次请求由哪些片段、工具、消息组成，按分类过滤、分页、展开预览（默认脱敏）
- 跨会话洞察：KPI、最近 7 天、8 周热力图、上下文组成、工具 / 技能 / 程序排行、会话卡片
- 独立网页（单文件，无外部资源）+ JSON API + SSE 实时刷新，默认 `127.0.0.1:18792`，与 trajectory 的网页分开；非本机地址必须设令牌，无令牌时校验 Host
- `/context`、`/context open`、`/context list`、`/context <会话 id>`；服务 `contextInsight`；不注册工具，不写会话日志
- 新旧宿主都可用：leo-agents ≥ 0.2.3（分支 `feat/context-log`）读 `llm/request.breakdown` 得到精确明细；更早的宿主按同口径推算并在网页上标出
