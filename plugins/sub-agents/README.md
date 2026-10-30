# leo-plugin-sub-agents

> 状态：**experimental**（0.1.0）

让主 Agent 把一个独立的子任务（调研代码库、查资料、并行处理多个文件）交给**子 Agent** 执行。子 Agent 有自己的上下文窗口，只把最终结论返回给主 Agent，避免主对话被大量中间过程撑满。

## 安装

```bash
npm install leo-plugin-sub-agents
```

`.leo/config.json`：

```jsonc
{
  "plugins": [
    "leo-plugin-sub-agents",
    // 或带配置：
    ["leo-plugin-sub-agents", { "maxConcurrent": 4 }]
  ]
}
```

离线安装：把 `dist/sub-agents.bundle.js` 复制到 `.leo/plugins/`，会被自动发现（使用默认配置；要改配置，在 `plugins` 里写 `["./.leo/plugins/sub-agents.bundle.js", { ... }]`）。

代码中使用：

```ts
import { createLeoFromConfig } from 'leo-agents'
import subAgents from 'leo-plugin-sub-agents'

const leo = await createLeoFromConfig({ plugins: [[subAgents, { maxDepth: 1 }]] })
```

## 工作方式

1. 插件注册工具 `task`。主 Agent 调用它时传入任务说明。
2. 工具通过 `agentLoop.create()` 创建子 Agent，运行一个 turn，把子 Agent 的最终回复作为工具结果返回，然后销毁子 Agent。
3. 主 Agent 在同一个 step 里发起多个 `task` 调用时**并发**执行，全局受 `maxConcurrent` 限制，超出的排队。
4. 子 Agent 的工具调用走同一个工具注册表，**审批、守卫、审计照常生效**。

### 工具 `task`

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `description` | string | 简短标题（3 到 8 个词），用于界面显示 |
| `prompt` | string | 交给子 Agent 的完整任务说明。子 Agent 看不到主对话，必须写清背景 |
| `agent` | string，可选 | 使用哪个子 Agent 配置，默认 `general` |

- 成功：返回子 Agent 的最终回复（超过 `maxOutputChars` 截断）。
- 未完成（步数用尽、超时、出错、取消）：`isError: true`，附带已有的部分结果。
- `details`（不发给模型，供界面与审计）：`agentId`、`sessionId`、`reason`、`steps`、`usage`、`durationMs`、`truncated`。
- 进度：子 Agent 每个 step、每次工具调用通过 `tool_update` 事件上报（`{ type: 'sub_agent_step' | 'sub_agent_tool', ... }`）。

### 子 Agent 继承什么

| 项 | 规则 |
| --- | --- |
| 模型 | 配置的 `model`，否则继承父 Agent。模型相同时同时继承 `temperature`、`maxOutputTokens`、`providerOptions` |
| 系统提示 | 配置的 `systemPrompt`，否则继承父 Agent 的系统提示；末尾总会追加子 Agent 说明（自主完成、只交付最终结论） |
| 工具 | 父 Agent 工具集 ∩ 配置的 `tools`；到达 `maxDepth` 时去掉 `task` |
| 租户 | 继承父 Agent |
| 会话 | 新建独立会话，写入与主会话相同的会话存储（CLI 下即 `.leo/sessions/`），可事后回放 |

## 安全边界

- **不扩大权限**：子 Agent 的工具集 ⊆ 父 Agent 的工具集。这不只是隐藏 schema：插件在 `tools/pre-execute` 最前面和 `tools/guard` 中拒绝子 Agent 调用未授权的工具，模型“猜”工具名也调不到，也不会为越权调用弹出审批。
- **不能无限套娃**：`maxDepth` 默认 1，子 Agent 看不到 `task`。
- **有上限**：并发数、单个子 Agent 最大步数、超时都有限制。
- **可取消**：父 turn 取消时，排队和运行中的子 Agent 一起取消。
- 工具声明权限 `agent.spawn`。CLI 默认审批策略不拦截它（创建子 Agent 本身没有副作用），子 Agent 写文件、执行命令时仍会单独请求审批。

## 配置

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `maxDepth` | number (1–5) | `1` | 最大嵌套层数 |
| `maxConcurrent` | number (1–32) | `4` | 同时运行的子 Agent 上限（全局） |
| `maxSteps` | number | `30` | 单个子 Agent 每次任务的最大步数 |
| `timeoutMs` | number | `600000` | 单个子 Agent 的超时 |
| `maxOutputChars` | number | `20000` | 返回给主 Agent 的文本上限 |
| `toolName` | string | `"task"` | 工具名，与其他插件冲突时可改 |
| `agents` | object | `{}` | 子 Agent 配置，与内置 `general` 合并，同名覆盖 |

```jsonc
{
  "agents": {
    "explorer": {
      "description": "只读调研：搜索和阅读代码，回答问题",   // 必填，写进 task 工具说明
      "systemPrompt": "你是只读调研助手……",               // 可选，默认继承父 Agent
      "model": "deepseek/deepseek-chat",                   // 可选，默认继承父 Agent
      "tools": ["read_file", "list_dir", "grep"],          // 可选，默认继承父 Agent（仍受父工具集约束）
      "maxSteps": 20                                       // 可选
    }
  }
}
```

## 提供的能力

| 类型 | 名称 | 说明 |
| --- | --- | --- |
| 工具 | `task` | 委派子任务 |
| 服务 | `subAgents` | `run({ prompt, agent?, description?, parentAgentId?, signal?, onEvent? })`、`list()`、`get(agentId)`、`profiles()` |
| 事件 | `sub-agents/started` | emit，子 Agent 开始（id、配置名、深度、工具、会话） |
| 事件 | `sub-agents/finished` | emit，子 Agent 结束（停止原因、用量、步数、耗时） |

直接调用服务且不传 `parentAgentId` 时，子 Agent 可使用全部已注册工具，且必须在配置里指定 `model`。

## 源码结构

```text
src/
├── index.ts      插件入口：注册服务、工具与工具权限守卫
├── config.ts     zod 配置 schema 与内置 general 配置
├── service.ts    subAgents 服务：创建、并发控制、取消、深度与工具集计算
├── tool.ts       task 工具
└── prompt.ts     子 Agent 说明与工具描述
```

## 已知限制

- 不支持用 `.leo/agents/*.md` 定义子 Agent：插件目前拿不到项目目录，需要 `leo-agents` 先提供该信息。
- CLI 尚未渲染 `tool_update`，看不到子 Agent 的实时进度，只能看到最终结果。
- 子 Agent 的审批请求和父 Agent 共用同一个审批界面，提示里不区分来源。

## 开发

```bash
npm run build -w plugins/sub-agents     # tsc + 单文件 bundle
npm test -w plugins/sub-agents
```
