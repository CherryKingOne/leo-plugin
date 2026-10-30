# leo 插件开发协议

> 适用于 leo-agents ≥ 0.1.0。本协议是本仓库所有官方插件必须遵守的约定，也可以作为第三方插件的开发参考。
> 协议以 leo-agents 源码为准：`src/kernel/plugin.ts`、`src/kernel/context.ts`、`src/tools/types.ts`、`src/config/create.ts`。两者冲突时以源码为准，并请修正本文档。

关键词约定：**必须**（MUST）= 不满足不予合并；**应当**（SHOULD）= 有充分理由才可例外；**可以**（MAY）= 可选。

---

## 1. 插件是什么

leo-agents 是“一切皆插件”的底座：内核只负责**服务注册、事件分发、可撤销副作用**，模型、工具、会话、上下文、Agent Loop 本身都是插件。一个插件就是一个带 `apply(ctx, config)` 的对象（或一个函数），在 `apply` 里通过 `ctx` 注册能力。

插件被加载时内核会：

1. 用插件的 `config` schema 校验配置，失败抛 `plugin_config_invalid`。
2. 等待 `inject` 声明的服务全部就绪（未就绪时插件处于 `pending`）。
3. 调用 `apply(ctx, config)`。
4. 卸载插件、或它依赖的某个服务被替换时，自动撤销它通过 `ctx` 做过的所有注册；依赖被替换后会重新 `apply`。

## 2. 插件的导出形式

插件模块（构建产物 `dist/index.js`）**必须**是 ESM，并用以下任一方式导出插件（加载器按 `default` → `plugin` → 模块本身 的顺序查找）：

### 写法 A：插件对象（推荐）

```ts
import type { PluginDefinition } from 'leo-agents'
import { z } from 'zod'

const Config = z.object({ maxDepth: z.number().int().min(1).default(1) })

const plugin: PluginDefinition<z.infer<typeof Config>> = {
  name: 'leo-plugin-example',
  inject: ['tools'],
  config: Config,
  apply(ctx, config) {
    // 在这里注册服务、工具、事件监听
  },
}
export default plugin
```

| 字段 | 必须 | 说明 |
| --- | --- | --- |
| `name` | 是 | 插件名，官方插件**必须**等于 npm 包名（`leo-plugin-<id>`），用于日志与诊断 |
| `inject` | 否 | 依赖的服务键。全部就绪才会 `apply`；任一被替换会自动重新 `apply` |
| `config` | 否 | zod schema。**应当**为每个字段提供默认值，使插件在无配置时也能运行 |
| `apply` | 是 | 入口，可以是 async |

### 写法 B：函数插件

```ts
export default function myPlugin(ctx, config) { /* ... */ }
myPlugin.pluginName = 'leo-plugin-example'
myPlugin.inject = ['tools']
```

函数插件没有 config 校验，官方插件**应当**使用写法 A。

## 3. 运行时依赖规则

插件会以三种方式被加载（见 [docs/install.md](docs/install.md)）：npm 安装、复制单文件到 `.leo/plugins/`、代码中直接传入。为了三种方式都能工作：

1. 对 `leo-agents` **必须**只使用 `import type`，构建产物中不得出现对 `leo-agents` 的运行时 import。
   - 原因：用户可能全局安装了 `leo`，而项目里没有 `leo-agents`；复制到 `.leo/plugins/` 的单文件也解析不到它。并且插件必须与宿主共享同一个内核实例，不能自带一份。
   - `definePlugin` / `defineTool` 只是类型辅助，直接写对象并标注类型即可。
   - 需要 `toolOutput()`（设置 `isError` / `terminate`）时，使用本仓库约定的等价实现：`Object.assign(out, { [Symbol.for('leo.toolOutput')]: true })`。
2. `leo-agents` **必须**写在 `peerDependencies`（以及 `devDependencies` 用于类型），**不得**写在 `dependencies`。
3. 其他运行时依赖（如 `zod`）写在 `dependencies`。若插件支持“复制单文件”安装，构建时**必须**把这些依赖打包进单文件（`dist/<id>.bundle.js`）。
4. Node ≥ 22，纯 ESM。

## 4. Context API（插件能做的全部事情）

`apply(ctx, config)` 中的 `ctx` 是插件作用域的 Context。通过它做的注册在卸载时**自动撤销**。

| 方法 | 用途 |
| --- | --- |
| `ctx.provide(key, impl)` | 提供（或替换）一个服务 |
| `ctx.get(key)` / `ctx.has(key)` | 获取服务 / 判断是否存在 |
| `ctx.on(event, handler, { prepend? })` | 监听事件 |
| `ctx.emit / parallel / serial / bail / waterfall(event, payload)` | 按事件声明的模式发布事件 |
| `ctx.effect(setup)` | 包裹任意副作用；`setup` 返回撤销函数，卸载时调用 |
| `ctx.fork(scope)` | 派生子作用域（tenant / agentId / sessionId） |
| `ctx.logger` / `ctx.tenant` / `ctx.signal` | 日志、租户、插件生命周期信号 |

规则：

- 所有注册**必须**通过 `ctx` 完成；不通过 `ctx.provide/on` 的副作用（定时器、子进程、文件句柄、全局状态）**必须**放进 `ctx.effect()` 并返回撤销函数。
- 模块顶层**不得**有副作用（不读文件、不发请求、不启动定时器）。导入插件模块不应改变任何状态。
- 注册工具：`await ctx.effect(() => ctx.get('tools').register(tool))`。

### 4.1 内置服务

| 服务键 | 提供方 | 说明 |
| --- | --- | --- |
| `sessions` | 核心 | 只追加会话日志 |
| `llm` | 核心 | 模型调用与 Provider 注册 |
| `tools` | 核心 | 工具注册表与受控执行管线 |
| `context` | 核心 | 系统提示片段、上下文构建与压缩 |
| `agentLoop` | 核心 | 创建 / 查找 Agent，可整体替换 |
| `approval` | 可选 | 人工审批；不存在时 `ask` 决策一律拒绝 |
| `credentials` | 可选（CLI / `createLeoFromConfig` 提供） | 密钥查找，`describe()` 不返回明文 |
| `providerKinds` | 可选（同上） | 注册自定义模型协议类型 |

### 4.2 内置事件

| 事件 | 模式 | 用途 |
| --- | --- | --- |
| `llm/stream` | waterfall | 包裹每次模型调用：改写请求、替换事件流 |
| `context/transform` / `context/convert` | waterfall | 发送前改写消息（裁剪、记忆召回、RAG） |
| `tools/pre-execute` | waterfall | 工具预检：返回 allow / deny / ask |
| `tools/guard` | bail | 不可绕过的拒绝底线 |
| `tools/execute` | waterfall | 包裹实际执行（超时、限流、沙箱代理） |
| `tools/post-execute` | waterfall | 结果后处理（脱敏、截断） |
| `agent/pre-step` | waterfall | step 前检查，可停止 turn |
| `agent/turn-stopping` | serial | turn 本应结束时决定是否继续 |
| `agent/event` | emit | 所有 AgentEvent 的旁路广播 |
| `usage/recorded` | emit | 每次模型调用的用量 |
| `session/appended` | emit | 会话日志追加 |

### 4.3 声明新的服务与事件

插件新增的服务和事件**必须**用 declaration merging 声明类型，并在 README 的“提供的能力”中列出：

```ts
declare module 'leo-agents' {
  interface Services { subAgents: SubAgentService }
  interface Events { 'subagent/finished': EventDef<'emit', { id: string; text: string }> }
}
```

- 服务键用 camelCase；事件名用 `<插件 id>/<动作>`，避免与核心冲突。
- 事件的分发模式是公共契约，发布后不得更改。

## 5. 工具协议

工具定义见 leo-agents `ToolDefinition`。官方插件额外要求：

- **命名**：`^[a-zA-Z][a-zA-Z0-9_-]{0,63}$`，snake_case。核心内置工具名（`read_file`、`write_file`、`edit_file`、`list_dir`、`grep`、`bash`、`web_fetch`）为保留名，插件不得占用。
- **描述**：写给模型看：做什么、什么时候用、什么时候不要用、返回什么。
- **参数**：使用 zod schema，每个字段带 `.describe()`。
- **权限**：有副作用的工具**必须**声明 `permissions`。CLI 默认审批策略把 `fs.write`、`process.exec` 视为副作用；新的副作用类型（如 `net.post`、`agent.spawn`）**应当**在 README 中说明，并提示用户在审批配置中加入。
- **取消**：**必须**遵守 `exec.signal`，取消或超时时尽快停止并释放资源。
- **失败**：业务失败返回 `isError: true` 的结果，不要抛异常；抛异常会被记为 `tool_error`。
- **输出**：控制长度，大输出应截断并告知模型如何获取剩余部分。

## 6. 配置协议

用户在 `.leo/config.json` 中这样配置插件：

```jsonc
{
  "plugins": [
    "leo-plugin-sub-agents",                          // 使用默认配置
    ["leo-plugin-sub-agents", { "maxDepth": 1 }]     // 传入配置
  ]
}
```

- 插件配置**必须**由插件的 zod schema 校验，错误要能指出具体字段。
- 通过 `.leo/plugins/` 自动发现的插件拿到的 config 是 `undefined`，因此插件**必须**能在无配置时以安全默认值运行。
- 配置中**不得**要求明文密钥。需要密钥时：读取 `credentials` 服务（`ctx.has('credentials')` 判断），或接受 `$ENV` / `!command` 引用并在使用时解析。
- 日志、错误信息、工具输出中**不得**出现密钥明文。

## 7. 安全基线

- 默认 fail closed：缺少审批服务、权限不明、配置不完整时拒绝执行，而不是放行。
- 不绕过核心工具管线：插件内部执行别的工具时**必须**通过 `tools.executeBatch()`，使审批、守卫、审计事件照常生效。
- 不扩大权限：插件创建的子 Agent、子任务**不得**拥有超过父 Agent 的工具与权限。
- 资源有上限：任何循环、递归、并发都**必须**有可配置的上限与合理默认值。

## 8. 插件清单 `leo-plugin.json`

每个插件目录**必须**包含 `leo-plugin.json`，描述插件的元信息与安装方式，供索引生成与安装器读取。字段规范见 [docs/manifest.md](docs/manifest.md)，JSON Schema 见 [schemas/leo-plugin.schema.json](schemas/leo-plugin.schema.json)。

## 9. 目录与文件约定

```text
plugins/<id>/
├── leo-plugin.json      插件清单（必须）
├── package.json         npm 包，name = leo-plugin-<id>（必须）
├── README.md            用途、安装、配置、提供的能力、安全说明（必须）
├── CHANGELOG.md         版本记录（发布后必须）
├── tsconfig.json        继承根目录 tsconfig.base.json
├── src/
│   └── index.ts         默认导出插件
└── test/
    └── *.test.ts        至少覆盖：加载、无配置运行、卸载后注册被撤销
```

- `<id>` 用 kebab-case，与目录名、清单 `id`、包名后缀一致。
- 插件之间**不得**互相 import 源码；需要协作时通过服务与事件。

## 10. 版本与兼容

- 插件遵循 semver。清单中的 `leo` 字段声明兼容的 leo-agents 版本范围，并与 `peerDependencies.leo-agents` 保持一致。
- 改变工具名、参数、服务接口、事件载荷或配置字段语义属于破坏性变更，必须升主版本。

## 11. 合并检查清单

- [ ] 目录、清单 `id`、包名、插件 `name` 一致
- [ ] 对 `leo-agents` 只有 `import type`，且列在 `peerDependencies`
- [ ] 无配置可运行，配置有 zod 校验
- [ ] 所有注册通过 `ctx`，副作用在 `ctx.effect` 中
- [ ] 有副作用的工具声明了 `permissions`，遵守 `signal`
- [ ] 不泄露密钥，不绕过工具管线，有资源上限
- [ ] README 写明安装、配置、提供的服务/事件/工具、安全说明
- [ ] 测试通过，`registry.json` 已重新生成
