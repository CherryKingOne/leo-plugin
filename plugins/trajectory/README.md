# leo-plugin-trajectory

轨迹观测：看清 Agent 每一轮到底做了什么、每一步花了多久。参考 DeepSeek Harness 的 ui-trajectory：**记录在核心会话日志里，展示是插件**——本插件只读会话日志，做成一棵树：

```text
会话
└── turn（用户输入、结束原因、耗时、用量）
    ├── step（一次模型调用：模型、token、重试 / 错误、总耗时、首 token 时间 TTFT、解码时间、输出预览）
    │   └── 工具调用（参数、结果预览、是否出错、耗时、进度）
    │       └── 子会话（sub-agents 的子 Agent、agent-team 的成员……可继续展开）
    ├── 上下文压缩记录
    └── 插件自定义记录（custom）
```

另有会话累计用量。运行中的会话通过 `session/appended` 与 `agent/event` 实时更新。

- **不注册任何工具**：不进模型上下文，零 token 成本
- **只读**：不写会话日志，不改核心
- 本机网页（单文件 HTML/JS，无外部 CDN）+ JSON API + SSE 实时推送
- `/trace` 命令：摘要、网页地址、导出、会话列表
- `trajectory` 服务：给其他插件读轨迹

## 安装

```bash
leo plugin add trajectory          # 全局安装
leo plugin add trajectory --project
```

装好后 `leo` / `leo serve` 启动时会打印一行：

```text
[trajectory] 轨迹网页 http://127.0.0.1:18791/（仅本机） · 命令 /trace
```

用浏览器打开即可。也可以手动写进 `.leo/config.json`：

```jsonc
{ "plugins": [["leo-plugin-trajectory", { "port": 18791 }]] }
```

## 宿主版本与数据完整度

| 数据 | leo-agents 0.2.1 | leo-agents ≥ 0.2.2 |
| --- | --- | --- |
| turn / step / 工具树、用量、重试、错误、压缩 | ✅ 日志 | ✅ 日志 |
| step 总耗时（含重试） | ✅ 日志事件时间 | ✅ |
| 首 token 时间（TTFT）/ 解码时间 | ⚠️ 只有插件运行期间现场测得（内存），历史会话显示“无” | ✅ 日志 `firstTokenAt` |
| 工具耗时 | ✅ 工具自报的 `durationMs`；开始时间由此推算（标 ≈ / “推算”），运行期间为现场测得 | ✅ 日志 `tool/start` / `tool/end` 精确时间 |
| 预检被拒（找不到工具、审批拒绝等）的调用 | 按错误码推断为“未执行” | ✅ 没有 `tool/start` 即未执行 |
| 子会话挂树 | sub-agents：工具结果 `details.sessionId`（持久）+ 运行时 `sub-agents/started`、进度里的 `agentId`；agent-team：结果 `details.projectId` 与会话命名 `team-<项目>-<角色>`、Leader 的 `team_assign` 参数，运行时按 Agent 状态推断 | ✅ 优先用 `session/meta`（父会话、父调用），插件传了 `sessionMeta` 才有 |
| 会话列表 | 扫描会话目录（`.leo/sessions`，即宿主的文件存储）+ 运行中的会话 | ✅ `SessionStore.list()` |

网页顶部用徽章标出当前会话的数据来源（日志 / 现场 / 推算）。内存里的现场数据最多保留 `maxLiveSessions` 个会话，进程重启后没有。

## 网页

- **左栏**：会话列表，子会话缩进在父会话下，运行中的有绿点
- **账本**：按 turn → step → 工具分组，可折叠；子会话可就地展开或“打开”；顶部搜索框过滤并高亮（工具名、参数、结果、输出）
- **时间**：每个 turn 一条时间轴：模型调用拆成 等待/重试 · TTFT · 解码，工具一条（子会话工具用另一种颜色，推算的时间半透明）；下方列出最慢的记录
- **详情**：点任意记录看用量、耗时、TTFT、输入（消息数 / 工具数 / system 长度）、输出、失败的尝试、错误、参数、结果、进度、子会话
- **实时**：SSE 推送变化，自动刷新；停在底部时跟随新内容，往上翻时不打扰，出现“↓ 有新内容”按钮；右上角“跟随”可关闭

## 命令

| 命令 | 说明 |
| --- | --- |
| `/trace` | 当前会话摘要：turn、step、工具调用、token（含子会话合计）、最慢的 3 次模型调用与 3 个工具 |
| `/trace <会话 id>` | 指定会话的摘要 |
| `/trace open` | 网页地址 |
| `/trace export [文件]` | 把当前会话轨迹（含子会话）导出为 JSON：默认 `.leo/trajectory/<会话>-<时间>.json`；指定文件时相对 `.leo/`，**只能写在 `.leo/` 之内**（`..`、外部绝对路径、指向外部的符号链接都会被拒绝） |
| `/trace list` | 最近 20 个会话 |

命令需要 leo-agents ≥ 0.2.1 的 `commands` 服务；交互式 `leo` 中可用，网关转发插件命令时也能用。

## 配置

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `server` | `true` | 是否启动网页 / API |
| `host` | `127.0.0.1` | 监听地址。监听非本机地址（如 `0.0.0.0`）**必须**设置 `token`，否则不启动 |
| `port` | `18791` | 端口（`0` 为随机）。网关默认 18790，这里错开 |
| `token` | — | 访问令牌，写引用：`"$LEO_TRAJECTORY_TOKEN"`、`"!security find-generic-password -w -s leo"`；不要写明文 |
| `maxLiveSessions` | `200` | 内存里保留现场数据的会话数（最久没动的先丢，运行中的不丢） |
| `redact` | `true` | 展示前遮住像密钥的内容（字段名含 password / secret / token / api_key / authorization / cookie 等的值，以及 `sk-…`、`ghp_…`、`Bearer …`、JWT、PEM 私钥、URL 里的密码）。只影响网页、命令和导出，**不改日志** |
| `maxPreviewChars` | `4000` | 参数、结果、输出预览的最大字符数 |
| `sessionsDir` | 按宿主配置 | 旧宿主（没有 `sessions.list()`）时扫描的会话目录；默认与 leo 相同（`.leo/sessions` 或 `config.json` 的 `sessions.dir`） |

## HTTP API

只读，全部 `GET`：

| 路径 | 说明 |
| --- | --- |
| `/` | 网页 |
| `/health` | `{ ok: true }`，不需要令牌 |
| `/api/sessions` | `{ sessions: SessionSummary[] }`，按更新时间倒序 |
| `/api/sessions/:id?depth=2` | 轨迹树 `TrajectoryTree`（`depth` 0 ~ 4，子会话展开层数），找不到返回 404 |
| `/api/stream[?session=<id>]` | SSE：`event: hello` 后持续推送 `event: update`（`{ sessionId, kind: 'event' \| 'live', type, at }`）；指定 `session` 时只推它和它的子会话；每 15 秒一行注释保活 |

数据结构见 [src/types.ts](src/types.ts)。

**安全**（与 gateway 控制面相同的规则）：

- 默认只监听 `127.0.0.1`；非本机地址没有令牌时拒绝启动（发出错误提示，插件其他功能照常）
- 设置了令牌时，除 `/health` 外都要带：`Authorization: Bearer <token>`、`x-leo-trajectory-token: <token>`，或 `?token=<token>`（给浏览器与 EventSource 用；网页读到后存进 sessionStorage 并从地址栏去掉）
- 没有令牌时只接受 `Host` 为本机名（`127.0.0.1` / `localhost` / `[::1]`）的请求，防止恶意网页借 DNS rebinding 读取会话
- 网页带严格的 CSP（`default-src 'none'`，只允许内联脚本和样式、同源请求），不加载任何外部资源
- 会话内容可能包含敏感信息：对外暴露请走 SSH 隧道 / 反向代理并设置令牌

**挂到网关控制面下**：gateway 目前没有给其他插件挂 HTTP 路由的接口（只有它内部的 webhook），所以本插件用自己的端口。需要统一入口时，用反向代理把 `/trace/` 转到 18791。

## 服务

```ts
const t = ctx.maybe('trajectory')
const tree = await t?.get(sessionId, { depth: 2 })   // TrajectoryTree | undefined
const list = await t?.list()                          // SessionSummary[]
const off = t?.subscribe((u) => console.log(u.sessionId, u.type))
t?.url()                                              // 网页地址，没启动时 undefined
```

## 让子会话挂得更准（给插件作者）

在 leo-agents ≥ 0.2.2 上创建子 Agent 时传 `sessionMeta`，轨迹会直接用日志里的 `session/meta`，进程重启后也能精确挂到发起它的那次工具调用下：

```ts
ctx.get('agentLoop').create({
  model,
  label: 'sub-agent:explorer',
  sessionMeta: { origin: 'sub-agent', parentSessionId: exec.sessionId, parentAgentId: exec.agentId, parentTurnId: exec.turnId, parentToolCallId: exec.callId },
})
```

旧宿主会忽略这个字段。

## 热加载

卸载时关闭 HTTP 服务器（包括打开的 SSE 连接）并释放端口，重新加载可用同一端口；订阅、服务、命令通过 `ctx` 注册，自动撤销。

## 已知限制

- 历史 TTFT、工具开始时间需要 leo-agents ≥ 0.2.2；0.2.1 上只有插件运行期间现场测到的
- 旧宿主上并发的多个 `task` 调用，在进度上报前短暂可能挂错调用，结果返回后以 `details.sessionId` 为准
- agent-team 的成员会话按命名约定 `team-<项目>-<角色>`（六个内置角色）识别
- 会话目录扫描读取整个 JSONL；会话很多时默认只看最近 200 个
- 只测试过 mock 模型；网页在 jsdom 里做过无头检查，没有在真实浏览器里截图验证
