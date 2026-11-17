# leo-plugin-context

> **Rust rewrite**：本插件已用 Rust 重写，实现见 `src/*.rs`；构建/测试：`cargo test -p leo-plugin-context`。安装与加载见根目录 [`docs/install.md`](../../docs/install.md)。

上下文观测：看清 Agent **现在带着什么、这些东西从哪来、怎么一步步变成这样**。参考 DeepSeek Harness 的 [dsh-context](https://github.com/bowenliang123/dsh-context)（Apache-2.0）的设计，为 leo 重新实现：数据来自核心会话日志，展示是插件。

- **独立网页**（默认 `http://127.0.0.1:18792/`），与 [trajectory](../trajectory) 的轨迹网页（18791）分开
- **不注册任何工具**：不进模型上下文，零 token 成本
- **只读**：不写会话日志，不改核心
- `/context` 命令：当前会话的占用、离自动压缩多远、组成、用量与成本
- `contextInsight` 服务：给其他插件读报告

## 安装

```bash
leo plugin add context          # 全局安装
leo plugin add context --project
```

`leo` / `leo serve` 启动时会打印：

```text
[context] 上下文网页 http://127.0.0.1:18792/（仅本机） · 命令 /context
```

## 宿主版本与数据完整度

| 数据 | leo-agents 0.2.1 / 0.2.2 | leo-agents ≥ 0.2.3 |
| --- | --- | --- |
| 消息分类（用户 / 回答 / 思考 / 工具调用 / 工具结果 / 压缩摘要） | ✅ 日志 | ✅ 日志 |
| System 提示词 | ⚠️ 整体一类 | ✅ 按片段拆分，带层级与来源插件 |
| 插件注入（技能目录、人设、MCP 说明……） | ❌ 混在 System 里 | ✅ 按来源插件拆分；`context/transform` 注入的消息也计入 |
| 工具定义 | ⚠️ 推算：估算总量 − System − 消息 | ✅ 每个工具的大小 |
| 窗口 / 输出预留 / 自动压缩阈值 | ⚠️ 模型信息或底座默认值（128k / 8192 / 0.85） | ✅ 日志里记的当次值 |
| 工具耗时 | 0.2.1：工具自报；0.2.2：`tool/start` / `tool/end` | ✅ |
| 会话列表 | 0.2.1：扫描 `.leo/sessions`；0.2.2：`sessions.list()` | ✅ |

网页上用徽章标出“组成：日志 / 推算”“工具计时：日志 / 推算”。

**口径**：组成数字是本地近似 token（UTF-8 字节 / 3.5，与核心的 `estimatedTokens` 一致），用来看比例和趋势；计费以模型返回的 `usage` 为准。成本优先用厂商返回的 `costUsd`，没有时按模型价目（`ModelInfo.pricing`）推算。

## 网页

- **洞察**：活跃会话、轮次、模型请求、计费 token、估算成本、缓存命中、工具调用、活跃时长；最近 7 天用量与成本；8 周热力图；上下文组成；工具 / 技能 / 程序排行；会话卡片（点开进会话）。范围可选今天 / 7 天 / 30 天
- **会话**：左栏会话列表（子会话缩进），右侧：
  - 当前上下文：堆叠条（组成 + 剩余空间 + 输出预留，黄线为自动压缩阈值）、插件注入来源、System 片段与工具定义明细
  - 统计、Token 与成本、耗时（模型 / 工具 / 其他）
  - 上下文趋势：每次请求的组成堆叠，橙线是模型报告的输入 token，红虚线是自动压缩阈值，⇣ 标出压缩；点柱子打开浏览器
  - 上下文浏览器：选一次请求，按分类过滤、分页，点开看预览
  - 上下文事件、工具、文件活动、命令执行、技能加载、子会话
- **实时**：SSE 推送会话变化，页面合并刷新（1.5 秒内最多一次）

## 命令

| 命令 | 说明 |
| --- | --- |
| `/context` | 当前会话：模型、占用、离自动压缩多远、组成、插件注入来源、轮次 / 请求 / 工具、计费与成本，以及网页地址 |
| `/context <会话 id>` | 指定会话 |
| `/context open` | 网页地址 |
| `/context list` | 最近 10 个会话的上下文大小与计费 |

需要 leo-agents ≥ 0.2.1 的 `commands` 服务。

## 配置

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `server` | `true` | 是否启动网页 / API |
| `host` | `127.0.0.1` | 监听地址。监听非本机地址（如 Docker 里的 `0.0.0.0`）**必须**设置 `token`，否则不启动 |
| `port` | `18792` | 端口（`0` 为随机）。gateway 默认 18790、trajectory 默认 18791 |
| `token` | — | 访问令牌，写引用：`"$LEO_CONTEXT_TOKEN"`、`"!security find-generic-password -w -s leo"`；不要写明文 |
| `redact` | `true` | 预览前遮住像密钥的内容；只影响网页和命令，**不改日志** |
| `maxPreviewChars` | `2000` | 浏览器里每条预览的最大字符数 |
| `maxSessions` | `300` | 列表与洞察最多扫描的会话数（最近更新的优先） |
| `cacheSessions` | `20` | 内存里缓存完整分析结果的会话数（LRU，10 分钟过期，会话有新事件即失效） |
| `maxCommands` | `500` | 每个会话保留的命令执行记录数（最近的） |
| `sessionsDir` | 按宿主配置 | 旧宿主（没有 `sessions.list()`）时扫描的会话目录 |

```jsonc
{ "plugins": [["leo-plugin-context", { "port": 18792 }]] }
```

Docker 里运行：`{ "host": "0.0.0.0", "token": "$LEO_CONTEXT_TOKEN" }`，宿主机只映射 `127.0.0.1:18792:18792`，对外走反向代理。

## HTTP API

只读，全部 `GET`：

| 路径 | 说明 |
| --- | --- |
| `/` | 网页 |
| `/health` | `{ ok: true }`，不需要令牌 |
| `/api/overview?days=7` | 跨会话洞察 `Overview`（`days` 1 ~ 90） |
| `/api/sessions` | `{ sessions: SessionSummary[] }`，按更新时间倒序，带上下文大小与计费摘要 |
| `/api/sessions/:id` | 上下文报告 `SessionReport`，找不到返回 404 |
| `/api/sessions/:id/requests/:n` | 第 n 次请求（从 0 开始）的组成明细 `RequestDetail`；`offset`、`limit`（≤ 200）、`category` |
| `/api/stream[?session=<id>]` | SSE：`event: hello` 后推送 `event: update`（`{ sessionId, type, at }`）；每 15 秒保活 |

数据结构见 [src/types.ts](src/types.ts)。

**安全**（与 gateway、trajectory 相同的规则）：默认只监听本机；非本机地址没有令牌拒绝启动；设置令牌后除 `/health` 外都要带 `Authorization: Bearer <token>`、`x-leo-context-token: <token>` 或 `?token=<token>`（网页读到后存进 sessionStorage 并从地址栏去掉）；没有令牌时只接受本机 Host（防 DNS rebinding）；网页带严格 CSP，不加载外部资源。会话内容可能含敏感信息，对外暴露请走 SSH 隧道 / 反向代理并设置令牌。

## 服务

```ts
const c = ctx.maybe('contextInsight')
const report = await c?.report(sessionId)        // SessionReport | undefined
const detail = await c?.request(sessionId, 3)     // 第 4 次请求的明细
const overview = await c?.overview({ days: 7 })
const off = c?.subscribe((u) => console.log(u.sessionId, u.type))
c?.url()                                          // 网页地址，没启动时 undefined
```

## 与 dsh-context 的对应

| dsh-context | 本插件 |
| --- | --- |
| Context Insights 页 | 洞察 |
| Context 标签页（Stats / Token / Timing / Current / Trend / Browser / Events / File Activity / 命令执行） | 会话页同名卡片 |
| Fleet 标签页 | 子会话卡片（按 `session/meta` 的父会话）；完整的 Agent 树看 trajectory |
| `/context` 命令 | `/context` |
| Preferences（系统提示前后缀等） | 暂未提供 |

## 开发

```bash
npm run build -w plugins/context
npm test -w plugins/context
# 用 leo-agents 分支 feat/context-log 的构建验证 breakdown 路径
LEO_EXPECT_BREAKDOWN=1 LEO_AGENTS_DIST=../leo-agents/dist/index.js npm test -w plugins/context
```

修改 `src/page.html` 后运行 `npm run gen:ui`（`build` / `typecheck` 会自动运行）。
