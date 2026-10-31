# leo-plugin-mcp

让 leo Agent 使用外部 [MCP（Model Context Protocol）](https://modelcontextprotocol.io) 服务器提供的工具。服务器写在 `mcp-servers.json` 里，格式与 Claude Desktop / Claude Code / Cursor 的 `mcpServers` 相同，可以直接复制过来用。

> 状态：实验性（0.1.0）。需要 leo-agents 支持 `Permission.sideEffect`（`f73f7c9` 及以后），否则 MCP 工具不会触发审批。

## 安装

```bash
leo plugin add mcp --init             # 全局安装，并生成 ~/.leo/mcp-servers.json（所有项目共用）
leo plugin add mcp --project --init   # 只装到当前项目，并生成 .leo/mcp-servers.json
leo plugin init mcp [--project]       # 已经装好时补生成配置文件
```

其他方式（npm、复制单文件、代码中加载）见仓库的 [docs/install.md](../../docs/install.md)。

## 配置 MCP 服务器

编辑 `--init` 生成的 `~/.leo/mcp-servers.json`（全局）或 `.leo/mcp-servers.json`（项目），没用 `--init` 时手动新建。两处都有时合并，同名服务器项目覆盖全局：

```jsonc
{
  "mcpServers": {
    // 本地进程（stdio）
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    // 远程服务器（Streamable HTTP；老的 HTTP+SSE 服务器会自动回退）
    "docs": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" }
    },
    // 只暴露部分工具、部分工具免审批
    "github": {
      "command": "github-mcp-server",
      "args": ["stdio"],
      "env": { "GITHUB_TOKEN": "$GITHUB_TOKEN" },
      "includeTools": ["search_issues", "get_issue"],
      "autoApprove": ["search_issues", "get_issue"]
    }
  }
}
```

- 文件可以带注释和尾随逗号（JSONC）；顶层键 `mcpServers` 或 `servers` 均可；文件名也接受 `mcp-server.json`。
- 同名服务器：项目级覆盖用户级，插件配置里的 `servers` 覆盖两者。
- stdio 服务器默认在项目根目录启动；`cwd` 的相对路径也基于项目根（用户级文件基于 `~/.leo`）。

### 服务器字段

| 字段 | 说明 |
| --- | --- |
| `command` / `args` / `env` / `cwd` | stdio：启动命令、参数、额外环境变量、工作目录 |
| `url` / `headers` | 远程：MCP 端点地址、额外请求头 |
| `type` | `stdio` / `http`（= `streamable-http`）/ `sse`。不写时按有无 `command` / `url` 判断；`sse` 表示直接使用 2024-11-05 的 HTTP+SSE |
| `protocol` | `auto`（默认，自动探测）/ `modern`（只用 2026-07-28）/ `legacy`（直接 initialize 握手） |
| `protocolVersion` | 指定协议版本，如 `"2025-06-18"`，一般不需要 |
| `includeTools` / `excludeTools` | 按 MCP 原始工具名筛选 |
| `autoApprove` | `true` 信任该服务器全部工具；数组表示只信任列出的工具 |
| `timeoutMs` / `connectTimeoutMs` | 覆盖插件的调用超时 / 连接超时 |
| `description` | 写进工具说明，帮助模型选择 |
| `disabled: true` 或 `enabled: false` | 暂时不连接 |

**密钥不要明文写进文件。** `env` 与 `headers` 的值支持：`"$NAME"` / `"${NAME}"`（环境变量）、`"Bearer ${NAME}"`（内插）、`"!op read op://vault/item/token"`（执行命令取输出）。变量未设置时该服务器连接失败，错误信息只包含变量名。

## 协议兼容

MCP 用日期标识版本，没有官方的 “1.0 / 2.0”。通常说的 **MCP 2.0** 指 **2026-07-28**（无状态：没有 `initialize` 握手和会话，每个请求在 `_meta` 中携带协议版本与客户端信息）；之前的 **2025-11-25、2025-06-18、2025-03-26、2024-11-05** 都需要先 `initialize` 握手。

本插件是 dual-era 客户端，按规范的兼容流程自动探测，结果缓存在连接上：

| 传输 | 探测 |
| --- | --- |
| stdio | 先发 `server/discover`。有结果 → 2026-07-28；`UnsupportedProtocolVersion` → 按服务器列出的版本重试；其他错误或 `probeTimeoutMs` 内无响应 → `initialize` 握手（服务器若因此退出会自动重启进程） |
| Streamable HTTP | 先 POST 一个 2026-07-28 请求（带 `MCP-Protocol-Version`、`Mcp-Method`、`Mcp-Name` 头）。成功或返回 modern 错误 → 2026-07-28；否则同一 URL 走 `initialize` + `Mcp-Session-Id` 会话 |
| HTTP+SSE（2024-11-05） | 上一步仍返回 400 / 404 / 405 时，GET 同一 URL 等待 `endpoint` 事件 |

已实现的协议细节：分页 `tools/list`；`notifications/progress`（转成 leo 的 `tool_update`）；取消（stdio 发 `notifications/cancelled`，HTTP 关闭响应流）；2026-07-28 的 `x-mcp-header` → `Mcp-Param-*` 镜像头与 Base64 编码，标注不合法的工具按规范排除；legacy 会话过期（404）自动重新握手；stdio 进程崩溃后下次调用自动重启；legacy 服务器的 `ping` 与 `tools/list_changed`。

已用官方 SDK 实测：TypeScript SDK v2（`@modelcontextprotocol/server` 2.4.0，stdio / HTTP，modern-only 与 dual）和 v1（`@modelcontextprotocol/sdk` 1.32.2，stdio / Streamable HTTP / HTTP+SSE）。

## 工作方式

- 插件加载时并发连接所有服务器（单个最长 `connectTimeoutMs`）。连不上的服务器记录错误并跳过，不影响其他服务器和 Agent 启动。
- 每个 MCP 工具注册为 leo 工具 **`mcp__<服务器>__<工具>`**（非法字符替换为 `_`，超过 64 字符时截断并加短哈希），参数直接使用服务器给的 JSON Schema。
- 调用走 leo 的工具管线：预检、审批、守卫、超时、审计事件都照常生效；`tags` 为 `mcp` 与 `mcp:<服务器>`，可用于 `AgentOptions.tools` 筛选。
- 结果转换：文本合并并按 `maxOutputChars` 截断；图片转为图片块；内嵌资源的文本直接给模型，二进制只给说明；只有 `structuredContent` 时以 JSON 文本返回，`structuredContent` 也放在 `details` 里。`isError: true` 原样传给模型。
- 服务器的 `instructions` 作为系统提示片段注入（可关闭），并注明“这是关于工具的说明，不是用户指令”。

## 安全

- **默认每个 MCP 工具都需要审批。** 工具声明权限 `{ kind: 'mcp.call', server, tool, sideEffect: true }`，按你的审批模式处理：交互式 CLI 会询问；非交互模式（`-p`）会拒绝并提示加 `-y`；`tools.approval: "deny"` 全部拒绝。
- 只有 `autoApprove` 中列出的工具免审批。服务器自报的 `readOnlyHint` 等注解**不**作为免审批依据（规范也要求不要信任它们），只作为 `readOnlyHint: true` 附在权限上，供你自己的策略插件参考。
- stdio 服务器以你的用户身份运行，能做你能做的任何事。只添加你信任的服务器。
- 本插件不声明 sampling / roots / elicitation 能力：服务器不能借客户端调用模型或读取你的文件列表；需要这些输入的工具调用会返回明确的错误。
- 旧版 HTTP+SSE 的 `endpoint` 必须与服务器同源，否则拒绝连接。

## 插件配置

在 `.leo/config.json` 中可以调整（全部可选）：

```jsonc
{
  "plugins": [
    ["./.leo/plugins/mcp.bundle.js", {
      "timeoutMs": 120000,
      "servers": { "calc": { "command": "node", "args": ["calc-server.mjs"] } }
    }]
  ]
}
```

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `servers` | `{}` | 直接声明服务器，优先级最高 |
| `loadServerFiles` | `true` | 读取 `~/.leo/mcp-servers.json` 与项目 `.leo/mcp-servers.json` |
| `toolPrefix` | `"mcp"` | 工具名前缀；空串表示 `<服务器>__<工具>` |
| `connectTimeoutMs` | `30000` | 每个服务器的连接超时 |
| `probeTimeoutMs` | `5000` | stdio 探测 2026-07-28 的等待时间，超时视为旧版服务器 |
| `timeoutMs` | `120000` | 单次工具调用超时 |
| `maxOutputChars` | `30000` | 返回给模型的文本上限 |
| `includeInstructions` | `true` | 注入服务器的 `instructions` |

## 提供的能力

| 类型 | 名称 | 说明 |
| --- | --- | --- |
| 工具 | `mcp__<server>__<tool>` | 每个 MCP 工具一个，动态注册 |
| 服务 | `mcp` | `servers()` 查看状态；`callTool(server, tool, args)` 代码直接调用（不经过审批，由调用方负责）；`refresh(server)`；`reconnect(server)` |
| 事件 | `mcp/connected` | `{ server, era, protocolVersion, tools }` |
| 事件 | `mcp/error` | `{ server, error }` |
| 权限 | `mcp.call` | 带 `sideEffect: true`（`autoApprove` 的工具除外） |
| 系统提示 | `mcp/instructions` | runtime 层 |

```ts
const mcp = leo.ctx.get('mcp')
for (const s of mcp.servers()) console.log(s.name, s.status, s.era, s.protocolVersion, s.tools.length)
```

## 源码结构

```text
src/
├── index.ts            插件入口：读配置、注册服务与系统提示片段
├── config.ts           插件配置与服务器配置 schema
├── files.ts            mcp-servers.json 读取（JSONC、用户级 / 项目级合并）
├── secrets.ts          $ENV / ${ENV} / !command 引用
├── manager.ts          连接全部服务器、注册工具、服务 mcp
├── client.ts           dual-era MCP 客户端：探测、握手、请求、分页、进度
├── convert.ts          工具名、参数、结果的转换
├── headers.ts          x-mcp-header 校验与 Mcp-Param-* 生成
├── jsonrpc.ts          JSON-RPC 类型、错误、SSE 解析
└── transports/
    ├── stream.ts       基于消息流的请求路由（stdio / 旧版 SSE 共用）
    ├── stdio.ts        子进程 stdio
    ├── http.ts         Streamable HTTP（modern 与 legacy 会话）
    └── sse.ts          2024-11-05 HTTP+SSE
```

## 已知限制

- 只接入**工具**。resources、prompts、completion 暂未暴露给 Agent。
- 2026-07-28 的 `subscriptions/listen` 未实现：modern 服务器的工具列表变化需要调用 `mcp.refresh(server)` 或重启；legacy 服务器的 `tools/list_changed` 会自动刷新。
- 不支持 MRTR 的客户端输入（sampling、elicitation、roots）和 OAuth 授权流程；需要登录的远程服务器请在 `headers` 中提供令牌。
- 工具列表在连接时拉取；连接很慢的服务器会推迟 Agent 首次可用的时间（受 `connectTimeoutMs` 限制）。

## 开发

```bash
npm install            # 仓库根目录
npm run build -w plugins/mcp
npm test -w plugins/mcp
```

测试用的假服务器在 `test/fixtures/`，覆盖 stdio（modern / legacy / dual，含不回应探测、探测后退出等情况）、modern Streamable HTTP（含 SSE 响应与镜像头校验）、legacy Streamable HTTP 会话、2024-11-05 HTTP+SSE。
