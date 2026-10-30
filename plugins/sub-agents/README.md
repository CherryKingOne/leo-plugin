# leo-plugin-sub-agents

> 状态：**设计草案，尚未实现**。下面的设计确认后再开发。

## 用途

让主 Agent 把一个独立的子任务（调研代码库、查资料、并行处理多个文件）交给**子 Agent** 执行。子 Agent 有自己的上下文窗口，只把最终结论返回给主 Agent，避免主对话被大量中间过程撑满。

## 设计草案

### 工作方式

1. 插件注册一个工具 `task`。主 Agent 调用它时传入任务说明。
2. 工具内部通过 `agentLoop.create()` 创建子 Agent，运行一个 turn，把子 Agent 的最终回复作为工具结果返回。
3. 主 Agent 在同一个 step 里发起多个 `task` 调用时，由核心工具管线**并发**执行（受 `maxConcurrent` 限制）。
4. 子 Agent 的工具调用走同一个工具注册表，**审批、守卫、审计照常生效**。

### 工具 `task`

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `description` | string | 3 到 8 个词的简短标题，用于界面显示 |
| `prompt` | string | 交给子 Agent 的完整任务说明（子 Agent 看不到主对话，必须写清背景） |
| `agent` | string，可选 | 使用哪个子 Agent 配置，默认 `general` |

返回：子 Agent 的最终回复文本（超长截断）。`details` 中附带子会话 id、用量、步数、停止原因，供界面与审计使用，不发给模型。子 Agent 未正常完成时返回 `isError: true`。

### 安全边界

- **不扩大权限**：子 Agent 的工具集 ⊆ 父 Agent 的工具集，模型默认与父 Agent 相同。
- **不能无限套娃**：`maxDepth` 默认 1，即子 Agent 看不到 `task` 工具。
- **有上限**：并发数、单个子 Agent 最大步数、超时都可配置。
- **可取消**：父 turn 取消时，所有子 Agent 一起取消。
- 工具声明权限 `agent.spawn`。CLI 默认审批策略不拦截它（创建子 Agent 本身没有副作用），子 Agent 写文件、执行命令时仍会单独请求审批。需要每次创建都确认时，把 `agent.spawn` 加入审批的副作用类型。

### 配置

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `maxDepth` | number | `1` | 最大嵌套层数 |
| `maxConcurrent` | number | `4` | 同时运行的子 Agent 上限 |
| `maxSteps` | number | `30` | 单个子 Agent 每次任务的最大步数 |
| `timeoutMs` | number | `600000` | 单个子 Agent 的超时 |
| `maxOutputChars` | number | `20000` | 返回给主 Agent 的文本上限 |
| `agents` | object | 内置 `general` | 子 Agent 配置，见下 |

`agents` 中每一项：

```jsonc
{
  "agents": {
    "explorer": {
      "description": "只读调研：搜索和阅读代码，回答问题",   // 告诉主 Agent 什么时候用它
      "systemPrompt": "你是只读调研助手……",               // 可选，默认使用通用子 Agent 提示
      "model": "deepseek/deepseek-chat",                   // 可选，默认继承父 Agent
      "tools": ["read_file", "list_dir", "grep"],          // 可选，默认继承父 Agent（仍受父工具集约束）
      "maxSteps": 20                                       // 可选
    }
  }
}
```

### 提供的能力

| 类型 | 名称 | 说明 |
| --- | --- | --- |
| 工具 | `task` | 委派子任务 |
| 服务 | `subAgents` | 代码中直接调用：`run({ prompt, agent })`、`list()` 查看运行中的子 Agent |
| 事件 | `sub-agents/started` | emit，子 Agent 开始 |
| 事件 | `sub-agents/finished` | emit，子 Agent 结束（含用量与停止原因） |

### 计划的源码结构

```text
src/
├── index.ts      插件入口：校验配置、注册服务与工具
├── config.ts     zod 配置 schema 与默认的 general 配置
├── service.ts    subAgents 服务：创建、并发控制、取消、深度追踪
├── tool.ts       task 工具定义
└── prompt.ts     默认子 Agent 提示词
test/
├── load.test.ts      无配置加载、卸载后撤销
├── task.test.ts      用 Mock Provider 跑通委派、并发、截断、错误
└── safety.test.ts    深度限制、工具子集、取消传播
```

### 待确认

1. 工具名用 `task` 还是 `delegate` / `sub_agent`？
2. 是否支持在 `.leo/agents/*.md` 中定义子 Agent（类似 Claude Code）？需要 leo-agents 向插件暴露项目目录，目前插件拿不到。
3. 子 Agent 的会话是否持久化到 `.leo/sessions/`，以便事后查看过程？

## 安装

实现后提供，格式与 [docs/install.md](../../docs/install.md) 一致。
