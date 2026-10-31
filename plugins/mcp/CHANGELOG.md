# Changelog

## 0.1.1

- 支持 leo-agents 热加载：插件定义声明 `watch`，修改 `mcp-servers.json` 后自动重新连接，不用重启
- 安装时自动初始化配置文件模板（不再需要 `--init`）

## 0.1.0

- 配置文件模板：`mcp-servers.json`（模板随 0.1.0 补充发布，bundle 未变）

- 首个实现：把 MCP 服务器的工具注册为 leo 工具 `mcp__<server>__<tool>`，服务 `mcp`，事件 `mcp/connected` / `mcp/error`
- 服务器配置：`~/.leo/mcp-servers.json`、项目 `.leo/mcp-servers.json`（JSONC，`mcpServers` 格式兼容 Claude / Cursor）与插件配置 `servers`；`env` / `headers` 支持 `$ENV`、`${ENV}` 内插、`!command`
- 传输：stdio、Streamable HTTP、2024-11-05 HTTP+SSE（自动回退）
- 协议：dual-era，自动探测 2026-07-28（无状态）与 2025-11-25 / 2025-06-18 / 2025-03-26 / 2024-11-05（initialize 握手）
- 分页、进度、取消、x-mcp-header 镜像头、legacy 会话过期重连、stdio 崩溃重启
- 默认所有 MCP 工具需要审批（`sideEffect: true`），`autoApprove` 可按服务器 / 工具放行
